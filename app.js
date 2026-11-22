const ORCHESTRA_GROUPS = [
  {
    group: 'Общий',
    items: [
      { id: 'chromatic', name: 'Хроматический', tag: 'in C', transpose: 0, preferFlats: false }
    ]
  },
  {
    group: 'Струнные',
    items: [
      { id: 'violin', name: 'Скрипка', tag: 'G₃ D₄ A₄ E₅', transpose: 0, preferFlats: false },
      { id: 'viola', name: 'Альт', tag: 'C₃ G₃ D₄ A₄', transpose: 0, preferFlats: false },
      { id: 'cello', name: 'Виолончель', tag: 'C₂ G₂ D₃ A₃', transpose: 0, preferFlats: false },
      { id: 'bass', name: 'Контрабас', tag: 'E₁ A₁ D₂ G₂', transpose: 0, preferFlats: false }
    ]
  },
  {
    group: 'Деревянные духовые',
    items: [
      { id: 'flute_oboe', name: 'Флейта / Гобой / Фагот', tag: 'in C', transpose: 0, preferFlats: true },
      { id: 'clarinet_bb', name: 'Кларнет', tag: 'in B♭', transpose: 2, preferFlats: true },
      { id: 'clarinet_a', name: 'Кларнет', tag: 'in A', transpose: 3, preferFlats: false },
      { id: 'english_horn', name: 'Английский рожок', tag: 'in F', transpose: 7, preferFlats: true }
    ]
  },
  {
    group: 'Медные духовые',
    items: [
      { id: 'horn_f', name: 'Валторна', tag: 'in F', transpose: 7, preferFlats: true },
      { id: 'trumpet_bb', name: 'Труба', tag: 'in B♭', transpose: 2, preferFlats: true },
      { id: 'trombone_tuba', name: 'Тромбон / Туба', tag: 'in C', transpose: 0, preferFlats: true }
    ]
  }
];

const ALL_INSTRUMENTS = ORCHESTRA_GROUPS.flatMap((g) => g.items);

const NOTES_SHARP = [
  ['C', ''], ['C', '♯'], ['D', ''], ['D', '♯'], ['E', ''], ['F', ''],
  ['F', '♯'], ['G', ''], ['G', '♯'], ['A', ''], ['A', '♯'], ['B', '']
];

const NOTES_FLAT = [
  ['C', ''], ['D', '♭'], ['D', ''], ['E', '♭'], ['E', ''], ['F', ''],
  ['G', '♭'], ['G', ''], ['A', '♭'], ['A', ''], ['B', '♭'], ['B', '']
];

// Состояние с сохранением в localStorage
const saved = JSON.parse(localStorage.getItem('orchestra_tuner_v1') || '{}');
const state = {
  instrumentId: saved.instrumentId || 'chromatic',
  a4: saved.a4 || 442,
  tolerance: saved.tolerance || 2,
  accidentals: saved.accidentals || 'auto', // 'auto' | 'flat' | 'sharp'
  isInTune: false,
  smoothedMidi: null,
  lastActiveTime: 0,
  playingToneMidi: null
};

function saveState() {
  localStorage.setItem('orchestra_tuner_v1', JSON.stringify({
    instrumentId: state.instrumentId,
    a4: state.a4,
    tolerance: state.tolerance,
    accidentals: state.accidentals
  }));
}

// DOM элементы
const stage = document.getElementById('stage');
const startOverlay = document.getElementById('startOverlay');
const noteNameEl = document.getElementById('noteName');
const noteAccEl = document.getElementById('noteAccidental');
const noteOctEl = document.getElementById('noteOctave');
const arrowUp = document.getElementById('arrowUp');
const arrowDown = document.getElementById('arrowDown');
const pillLabel = document.getElementById('pillLabel');

const sheet = document.getElementById('settingsSheet');
const backdrop = document.getElementById('sheetBackdrop');
const a4ValueEl = document.getElementById('a4Value');
const groupsContainer = document.getElementById('instrumentGroups');

let audioCtx = null;
let oscNode = null;
let gainNode = null;

function getInstrument() {
  return ALL_INSTRUMENTS.find((i) => i.id === state.instrumentId) || ALL_INSTRUMENTS[0];
}

// Инициализация аудио и Wake Lock
startOverlay.addEventListener('click', async () => {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') await audioCtx.resume();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    });

    await audioCtx.audioWorklet.addModule('./yin-processor.js');
    const source = audioCtx.createMediaStreamSource(stream);
    const yinNode = new AudioWorkletNode(audioCtx, 'yin-pitch-processor');

    yinNode.port.onmessage = (e) => handleFrequency(e.data.frequency);
    source.connect(yinNode);

    startOverlay.hidden = true;
    requestWakeLock();
  } catch (err) {
    alert('Нужен доступ к микрофону для работы тюнера.');
  }
});

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { await navigator.wakeLock.request('screen'); } catch {}
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !startOverlay.hidden === false) {
    requestWakeLock();
  }
});

// Обработка распознанной частоты
function handleFrequency(freq) {
  if (state.playingToneMidi !== null) return; // Не слушаем свой же камертон

  const now = performance.now();
  if (!freq) {
    if (now - state.lastActiveTime > 700) {
      setIdle();
    }
    return;
  }

  state.lastActiveTime = now;
  const inst = getInstrument();
  const concertMidi = 69 + 12 * Math.log2(freq / state.a4);
  const writtenMidi = concertMidi + inst.transpose;

  // Мягкое EMA-сглаживание (резкий сброс при смене ноты)
  if (state.smoothedMidi === null || Math.abs(writtenMidi - state.smoothedMidi) > 0.8) {
    state.smoothedMidi = writtenMidi;
  } else {
    state.smoothedMidi = state.smoothedMidi * 0.65 + writtenMidi * 0.35;
  }

  const nearestMidi = Math.round(state.smoothedMidi);
  const cents = (state.smoothedMidi - nearestMidi) * 100;

  // Гистерезис зелёного экрана (защита от мерцания)
  const enterTol = state.tolerance;
  const exitTol = state.tolerance * 1.45;
  const wasInTune = state.isInTune;

  if (!wasInTune && Math.abs(cents) <= enterTol) {
    state.isInTune = true;
    if (navigator.vibrate) navigator.vibrate(14);
  } else if (wasInTune && Math.abs(cents) > exitTol) {
    state.isInTune = false;
  }

  renderNote(nearestMidi, cents);
}

function setIdle() {
  state.isInTune = false;
  state.smoothedMidi = null;
  stage.className = 'stage state-idle';
  noteNameEl.textContent = '—';
  noteAccEl.textContent = '';
  noteOctEl.textContent = '';
  arrowUp.classList.remove('visible');
  arrowDown.classList.remove('visible');
}

function renderNote(midi, cents) {
  const inst = getInstrument();
  const useFlats = state.accidentals === 'flat' || (state.accidentals === 'auto' && inst.preferFlats);
  const table = useFlats ? NOTES_FLAT : NOTES_SHARP;

  const idx = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const [letter, acc] = table[idx];

  noteNameEl.textContent = letter;
  noteAccEl.textContent = acc;
  noteOctEl.textContent = octave;

  stage.classList.remove('state-idle');

  if (state.isInTune) {
    stage.classList.add('in-tune');
    arrowUp.classList.remove('visible');
    arrowDown.classList.remove('visible');
  } else {
    stage.classList.remove('in-tune');
    if (cents < 0) {
      // Низит -> стрелка снизу вверх (подтянуть)
      arrowUp.classList.add('visible');
      arrowDown.classList.remove('visible');
    } else {
      // Высит -> стрелка сверху вниз (опустить)
      arrowDown.classList.add('visible');
      arrowUp.classList.remove('visible');
    }
  }
}

// Камертон через OscillatorNode (безопасно для микрофона на iOS)
function toggleTone(midi, btn) {
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();

  document.querySelectorAll('.tone-btn').forEach((b) => b.classList.remove('active'));

  if (state.playingToneMidi === midi) {
    stopTone();
    return;
  }

  stopTone();
  state.playingToneMidi = midi;
  btn.classList.add('active');
  setIdle();

  const freq = state.a4 * Math.pow(2, (midi - 69) / 12);
  oscNode = audioCtx.createOscillator();
  gainNode = audioCtx.createGain();
  oscNode.type = 'triangle';
  oscNode.frequency.setValueAtTime(freq, audioCtx.currentTime);

  gainNode.gain.setValueAtTime(0.0001, audioCtx.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.04);

  oscNode.connect(gainNode);
  gainNode.connect(audioCtx.destination);
  oscNode.start();
}

function stopTone() {
  state.playingToneMidi = null;
  if (oscNode && gainNode && audioCtx) {
    const now = audioCtx.currentTime;
    gainNode.gain.setValueAtTime(gainNode.gain.value, now);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + 0.04);
    oscNode.stop(now + 0.05);
    oscNode = null;
    gainNode = null;
  }
}

// UI Настроек
function renderSettings() {
  const inst = getInstrument();
  pillLabel.textContent = `${inst.name}${inst.tag !== 'in C' ? ' ' + inst.tag : ''} · ${state.a4.toFixed(1).replace('.0', '')} Гц`;
  a4ValueEl.textContent = `${state.a4.toFixed(1)} Гц`;

  document.querySelectorAll('.chip').forEach((c) => {
    c.classList.toggle('active', Number(c.dataset.a4) === state.a4);
  });
  document.querySelectorAll('[data-tol]').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.tol) === state.tolerance);
  });
  document.querySelectorAll('[data-acc]').forEach((b) => {
    b.classList.toggle('active', b.dataset.acc === state.accidentals);
  });

  groupsContainer.innerHTML = ORCHESTRA_GROUPS.map((g) => `
    <div class="group-title">${g.group}</div>
    <div class="card">
      ${g.items.map((item) => `
        <button class="row inst-row" data-inst="${item.id}" type="button">
          <span>${item.name}<span class="inst-sub">${item.tag}</span></span>
          ${item.id === state.instrumentId ? '<span class="checkmark">✓</span>' : ''}
        </button>
      `).join('')}
    </div>
  `).join('');

  groupsContainer.querySelectorAll('.inst-row').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.instrumentId = btn.dataset.inst;
      saveState();
      renderSettings();
    });
  });
}

function openSheet() {
  backdrop.hidden = false;
  sheet.classList.add('open');
  sheet.setAttribute('aria-hidden', 'false');
}

function closeSheet() {
  stopTone();
  document.querySelectorAll('.tone-btn').forEach((b) => b.classList.remove('active'));
  backdrop.hidden = true;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
}

document.getElementById('openSettingsBtn').addEventListener('click', openSheet);
document.getElementById('closeSettingsBtn').addEventListener('click', closeSheet);
backdrop.addEventListener('click', closeSheet);

document.getElementById('a4Minus').addEventListener('click', () => {
  state.a4 = Math.max(410, Math.round((state.a4 - 0.5) * 10) / 10);
  saveState(); renderSettings();
});
document.getElementById('a4Plus').addEventListener('click', () => {
  state.a4 = Math.min(466, Math.round((state.a4 + 0.5) * 10) / 10);
  saveState(); renderSettings();
});

document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
  state.a4 = Number(c.dataset.a4);
  saveState(); renderSettings();
}));

document.querySelectorAll('[data-tol]').forEach((b) => b.addEventListener('click', () => {
  state.tolerance = Number(b.dataset.tol);
  saveState(); renderSettings();
}));

document.querySelectorAll('[data-acc]').forEach((b) => b.addEventListener('click', () => {
  state.accidentals = b.dataset.acc;
  saveState(); renderSettings();
}));

document.querySelectorAll('.tone-btn').forEach((b) => b.addEventListener('click', () => {
  toggleTone(Number(b.dataset.midi), b);
}));

renderSettings();

// Регистрация офлайн PWA Service Worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}