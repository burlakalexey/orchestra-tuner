class YinPitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 4096; // Хватает до ~28 Гц (контрабас, туба, литавры)
    this.hopSize = 2048;
    this.ring = new Float32Array(this.bufferSize);
    this.frame = new Float32Array(this.bufferSize);
    this.yinBuffer = new Float32Array(this.bufferSize / 2);
    this.writeIndex = 0;
    this.samplesSinceHop = 0;
    this.noiseGate = 0.008;
    this.yinThreshold = 0.16;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.ring[this.writeIndex] = channel[i];
      this.writeIndex = (this.writeIndex + 1) % this.bufferSize;
      this.samplesSinceHop++;

      if (this.samplesSinceHop >= this.hopSize) {
        this.samplesSinceHop = 0;
        this.analyze();
      }
    }
    return true;
  }

  analyze() {
    const N = this.bufferSize;
    const halfN = N >> 1;

    // Разворачиваем кольцевой буфер + считаем громкость (RMS)
    let sumSq = 0;
    for (let i = 0; i < N; i++) {
      const val = this.ring[(this.writeIndex + i) % N];
      this.frame[i] = val;
      sumSq += val * val;
    }

    const rms = Math.sqrt(sumSq / N);
    if (rms < this.noiseGate) {
      this.port.postMessage({ frequency: null });
      return;
    }

    // Диапазон оркестровых частот: ~27 Гц (A0) .. ~4200 Гц (C8)
    const tauMin = Math.max(2, Math.floor(sampleRate / 4300));
    const tauMax = Math.min(halfN - 1, Math.ceil(sampleRate / 26));

    // 1. Функция разности + кумулятивная нормализация (YIN)
    this.yinBuffer[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let diffSum = 0;
      for (let j = 0; j < halfN; j++) {
        const delta = this.frame[j] - this.frame[j + tau];
        diffSum += delta * delta;
      }
      runningSum += diffSum;
      this.yinBuffer[tau] = runningSum > 0 ? (diffSum * tau) / runningSum : 1;
    }

    // 2. Поиск первого локального минимума ниже порога
    let tauEstimate = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (this.yinBuffer[tau] < this.yinThreshold) {
        while (tau + 1 <= tauMax && this.yinBuffer[tau + 1] < this.yinBuffer[tau]) {
          tau++;
        }
        tauEstimate = tau;
        break;
      }
    }

    if (tauEstimate === -1) {
      this.port.postMessage({ frequency: null });
      return;
    }

    // 3. Параболическая интерполяция для субсэмпловой точности
    let betterTau = tauEstimate;
    if (tauEstimate > tauMin && tauEstimate < tauMax) {
      const s0 = this.yinBuffer[tauEstimate - 1];
      const s1 = this.yinBuffer[tauEstimate];
      const s2 = this.yinBuffer[tauEstimate + 1];
      const denom = 2 * (s0 - 2 * s1 + s2);
      if (Math.abs(denom) > 1e-9) {
        const shift = Math.max(-0.5, Math.min(0.5, (s0 - s2) / denom));
        betterTau = tauEstimate + shift;
      }
    }

    this.port.postMessage({ frequency: sampleRate / betterTau });
  }
}

registerProcessor('yin-pitch-processor', YinPitchProcessor);