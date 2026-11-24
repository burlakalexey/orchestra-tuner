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

const saved = JSON.parse(localStorage.getItem('orchestra_tuner_v2') || '{}');
const state = {
  instrumentId: saved.instrumentId || 'chromatic',
  a4: saved.a4 || 442,
  tolerance: saved.tolerance || 2,
  accidentals: saved.accidentals || 'auto',
  isInTune: false,
  smoothedMidi: null,
  recentMidis: [],
  lastActiveTime: 0,
  targetCents: 0,
  displayCents: 0
};

function saveState() {
  localStorage.setItem('orchestra_tuner_v2', JSON.stringify({
    instrumentId: state.instrumentId,
    a4: state.a4,
    tolerance: state.tolerance,
    accidentals: state.accidentals
  }));
}

const stage = document.getElementById('stage');
const bgCurvePath = document.getElementById('bgCurvePath');
const themeMeta = document.getElementById('themeColorMeta');
const startOverlay = document.getElementById('startOverlay');
const topMetaLabel = document.getElementById('topMetaLabel');

const noteNameEl = document.getElementById('noteName');
const noteAccEl = document.getElementById('noteAccidental');
const noteOctEl = document.getElementById('noteOctave');
const directionCue = document.getElementById('directionCue');
const dotTrack = document.getElementById('dotTrack');
const pitchMarker = document.getElementById('pitchMarker');

const glassModal = document.getElementById('glassModal');
const glassBackdrop = document.getElementById('glassBackdrop');
const a4ValueEl = document.getElementById('a4Value');
const groupsContainer = document.getElementById('instrumentGroups');

for (let i = 0; i <= 20; i++) {
  const dot = document.createElement('span');
  dot.className = 'scale-dot';
  if (i === 10) dot.classList.add('center');
  else if (i === 0 || i === 5 || i === 15 || i === 20) dot.classList.add('major');
  dot.style.left = `${(i / 20) * 100}%`;
  dotTrack.appendChild(dot);
}

// Плавная анимация дуги в обе стороны (60/120 FPS)
function animateCurve() {
  state.displayCents += (state.targetCents - state.displayCents) * 0.22;
  if (Math.abs(state.displayCents) < 0.05 && state.targetCents === 0) {
    state.displayCents = 0;
  }

  const ratio = Math.max(-1, Math.min(1, state.displayCents / 50));
  const xEdge = (50 + ratio * 7).toFixed(2);
  const cx = (50 + ratio * 42).toFixed(2);
  bgCurvePath.setAttribute('d', `M ${xEdge} 0 Q ${cx} 50 ${xEdge} 100 L 100 100 L 100 0 Z`);

  requestAnimationFrame(animateCurve);
}
requestAnimationFrame(animateCurve);

let audioCtx = null;

function getInstrument() {
  return ALL_INSTRUMENTS.find((i) => i.id === state.instrumentId) || ALL_INSTRUMENTS[0];
}

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
  } catch {
    alert('Нужен доступ к микрофону для работы тюнера.');
  }
});

async function requestWakeLock() {
  if ('wakeLock' in navigator) {
    try { await navigator.wakeLock.request('screen'); } catch {}
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && startOverlay.hidden) {
    requestWakeLock();
  }
});

function getMedianMidi(val) {
  state.recentMidis.push(val);
  if (state.recentMidis.length > 3) state.recentMidis.shift();
  const sorted = [...state.recentMidis].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function handleFrequency(freq) {
  const now = performance.now();
  if (!freq) {
    if (now - state.lastActiveTime > 150) state.recentMidis = [];
    if (now - state.lastActiveTime > 650) setIdle();
    return;
  }

  state.lastActiveTime = now;
  const inst = getInstrument();
  const concertMidi = 69 + 12 * Math.log2(freq / state.a4);
  const writtenMidi = concertMidi + inst.transpose;
  const stableMidi = getMedianMidi(writtenMidi);

  if (state.smoothedMidi === null || Math.abs(stableMidi - state.smoothedMidi) > 0.45) {
    state.smoothedMidi = stableMidi;
    state.isInTune = false;
  } else {
    state.smoothedMidi = state.smoothedMidi * 0.6 + stableMidi * 0.4;
  }

  const nearestMidi = Math.round(state.smoothedMidi);
  const cents = (state.smoothedMidi - nearestMidi) * 100;

  const enterTol = state.tolerance;
  const exitTol = state.tolerance * 1.45;
  if (!state.isInTune && Math.abs(cents) <= enterTol) {
    state.isInTune = true;
    if (navigator.vibrate) navigator.vibrate(14);
  } else if (state.isInTune && Math.abs(cents) > exitTol) {
    state.isInTune = false;
  }

  renderPitch(nearestMidi, cents);
}

function setIdle() {
  state.isInTune = false;
  state.smoothedMidi = null;
  state.recentMidis = [];
  state.targetCents = 0;
  stage.className = 'stage state-idle';
  themeMeta.setAttribute('content', '#e5e5ea');
  noteNameEl.textContent = '—';
  noteAccEl.textContent = '';
  noteOctEl.textContent = '';
  directionCue.textContent = '';
  pitchMarker.classList.remove('active');
}

function renderPitch(midi, cents) {
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

  const clamped = Math.max(-50, Math.min(50, cents));
  const percent = ((clamped + 50) / 100) * 100;
  pitchMarker.style.left = `${percent}%`;
  pitchMarker.classList.add('active');

  if (state.isInTune) {
    stage.classList.add('in-tune');
    themeMeta.setAttribute('content', '#30d158');
    directionCue.textContent = 'В ноте';
    state.targetCents = 0;
  } else {
    stage.classList.remove('in-tune');
    themeMeta.setAttribute('content', '#e5e5ea');
    directionCue.textContent = cents < 0 ? '← Ниже' : 'Выше →';
    state.targetCents = clamped;
  }
}

function renderSettings() {
  const inst = getInstrument();
  const a4Str = state.a4.toFixed(1).replace('.0', '');
  topMetaLabel.textContent = inst.id === 'chromatic'
    ? `${a4Str} Hz`
    : `${a4Str} Hz · ${inst.name}${inst.tag !== 'in C' ? ' ' + inst.tag : ''}`;

  a4ValueEl.textContent = `${state.a4.toFixed(1)} Hz`;

  document.querySelectorAll('.m-chip').forEach((c) => {
    c.classList.toggle('active', Number(c.dataset.a4) === state.a4);
  });
  document.querySelectorAll('[data-tol]').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.tol) === state.tolerance);
  });
  document.querySelectorAll('[data-acc]').forEach((b) => {
    b.classList.toggle('active', b.dataset.acc === state.accidentals);
  });

  groupsContainer.innerHTML = ORCHESTRA_GROUPS.map((g) => `
    <div class="glass-section">
      <div class="glass-section-title">${g.group}</div>
      <div class="inst-list">
        ${g.items.map((item) => `
          <button class="inst-row ${item.id === state.instrumentId ? 'active' : ''}" data-inst="${item.id}" type="button">
            <span>${item.name}<span class="inst-sub">${item.tag}</span></span>
            <span class="m-radio" aria-hidden="true"></span>
          </button>
        `).join('')}
      </div>
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

function openModal() {
  glassModal.classList.add('open');
  glassModal.setAttribute('aria-hidden', 'false');
}

function closeModal() {
  glassModal.classList.remove('open');
  glassModal.setAttribute('aria-hidden', 'true');
}

document.getElementById('openSettingsBtn').addEventListener('click', openModal);
document.getElementById('topMetaBtn').addEventListener('click', openModal);
document.getElementById('closeSettingsBtn').addEventListener('click', closeModal);
glassBackdrop.addEventListener('click', closeModal);

document.getElementById('a4Minus').addEventListener('click', () => {
  state.a4 = Math.max(410, Math.round((state.a4 - 0.5) * 10) / 10);
  saveState(); renderSettings();
});
document.getElementById('a4Plus').addEventListener('click', () => {
  state.a4 = Math.min(466, Math.round((state.a4 + 0.5) * 10) / 10);
  saveState(); renderSettings();
});

document.querySelectorAll('.m-chip').forEach((c) => c.addEventListener('click', () => {
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

renderSettings();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    window.location.reload();
  });
}
