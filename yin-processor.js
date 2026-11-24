class YinPitchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.M = 4096; // Размер FFT (хватает до ~28 Гц)
    this.W = 2048; // Окно YIN
    this.hopSize = 1024; // ~47 замеров в секунду
    this.ring = new Float32Array(this.M);
    this.frame = new Float32Array(this.M);
    this.re = new Float32Array(this.M);
    this.im = new Float32Array(this.M);
    this.reCorr = new Float32Array(this.M);
    this.imCorr = new Float32Array(this.M);
    this.yinBuffer = new Float32Array(this.W);

    this.bitRev = new Uint16Array(this.M);
    this.cosTable = new Float32Array(this.M >> 1);
    this.sinTable = new Float32Array(this.M >> 1);
    this.initFftTables();

    this.writeIndex = 0;
    this.samplesSinceHop = 0;
    this.noiseGate = 0.008;
  }

  initFftTables() {
    const M = this.M;
    const bits = Math.log2(M);
    for (let i = 0; i < M; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) {
        if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      }
      this.bitRev[i] = r;
    }
    for (let k = 0; k < M >> 1; k++) {
      const angle = (2 * Math.PI * k) / M;
      this.cosTable[k] = Math.cos(angle);
      this.sinTable[k] = Math.sin(angle);
    }
  }

  fft(re, im, inverse) {
    const M = this.M;
    for (let i = 0; i < M; i++) {
      const j = this.bitRev[i];
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let size = 2; size <= M; size <<= 1) {
      const half = size >> 1;
      const step = M / size;
      for (let i = 0; i < M; i += size) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const wr = this.cosTable[k];
          const wi = inverse ? this.sinTable[k] : -this.sinTable[k];
          const idx1 = i + j;
          const idx2 = idx1 + half;
          const tr = re[idx2] * wr - im[idx2] * wi;
          const ti = re[idx2] * wi + im[idx2] * wr;
          re[idx2] = re[idx1] - tr;
          im[idx2] = im[idx1] - ti;
          re[idx1] += tr;
          im[idx1] += ti;
        }
      }
    }

    if (inverse) {
      const invM = 1 / M;
      for (let i = 0; i < M; i++) {
        re[i] *= invM;
        im[i] *= invM;
      }
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];
    for (let i = 0; i < channel.length; i++) {
      this.ring[this.writeIndex] = channel[i];
      this.writeIndex = (this.writeIndex + 1) % this.M;
      this.samplesSinceHop++;

      if (this.samplesSinceHop >= this.hopSize) {
        this.samplesSinceHop = 0;
        this.analyze();
      }
    }
    return true;
  }

  analyze() {
    const M = this.M;
    const W = this.W;

    // 1. Читаем буфер и убираем постоянное смещение (DC offset)
    let mean = 0;
    for (let i = 0; i < M; i++) {
      const val = this.ring[(this.writeIndex + i) % M];
      this.frame[i] = val;
      mean += val;
    }
    mean /= M;

    let sumSq = 0;
    for (let i = 0; i < M; i++) {
      const v = this.frame[i] - mean;
      this.frame[i] = v;
      sumSq += v * v;
    }

    const rms = Math.sqrt(sumSq / M);
    if (rms < this.noiseGate) {
      this.port.postMessage({ frequency: null });
      return;
    }

    // 2. Быстрая автокорреляция через один комплексный FFT
    for (let i = 0; i < W; i++) {
      this.re[i] = this.frame[i];
      this.im[i] = this.frame[i];
    }
    for (let i = W; i < M; i++) {
      this.re[i] = 0;
      this.im[i] = this.frame[i];
    }

    this.fft(this.re, this.im, false);

    this.reCorr[0] = this.re[0] * this.im[0];
    this.imCorr[0] = 0;
    for (let k = 1; k < M; k++) {
      const kp = M - k;
      const ar = (this.re[k] + this.re[kp]) * 0.5;
      const ai = (this.im[k] - this.im[kp]) * 0.5;
      const br = (this.im[k] + this.im[kp]) * 0.5;
      const bi = (this.re[kp] - this.re[k]) * 0.5;
      this.reCorr[k] = ar * br + ai * bi;
      this.imCorr[k] = ar * bi - ai * br;
    }

    this.fft(this.reCorr, this.imCorr, true);

    // 3. Функция разности YIN и кумулятивная нормализация
    const tauMin = Math.max(2, Math.floor(sampleRate / 4300));
    const tauMax = Math.min(W - 1, Math.ceil(sampleRate / 26));

    let e0 = 0;
    for (let j = 0; j < W; j++) {
      e0 += this.frame[j] * this.frame[j];
    }
    let eTau = e0;

    this.yinBuffer[0] = 1;
    let runningSum = 0;
    let globalMinTau = -1;
    let globalMinVal = 10;

    for (let tau = 1; tau <= tauMax; tau++) {
      const oldV = this.frame[tau - 1];
      const newV = this.frame[tau - 1 + W];
      eTau += newV * newV - oldV * oldV;

      const diffSum = Math.max(0, e0 + eTau - 2 * this.reCorr[tau]);
      runningSum += diffSum;
      const cmnd = runningSum > 0 ? (diffSum * tau) / runningSum : 1;
      this.yinBuffer[tau] = cmnd;

      if (tau >= tauMin && cmnd < globalMinVal) {
        globalMinVal = cmnd;
        globalMinTau = tau;
      }
    }

    // Если сигнал слишком шумный/переход между нотами — отбрасываем кадр
    if (globalMinTau === -1 || globalMinVal > 0.24) {
      this.port.postMessage({ frequency: null });
      return;
    }

    // 4. Защита от октавных ошибок: ищем первый чистый минимум (< 0.10), иначе берём глобальный
    let tauEstimate = -1;
    for (let tau = tauMin; tau < tauMax; tau++) {
      if (this.yinBuffer[tau] < 0.10) {
        while (tau + 1 <= tauMax && this.yinBuffer[tau + 1] < this.yinBuffer[tau]) {
          tau++;
        }
        tauEstimate = tau;
        break;
      }
    }
    if (tauEstimate === -1) {
      tauEstimate = globalMinTau;
    }

    // 5. Параболическая интерполяция
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
