import {
  initLogCapture,
  getCapturedLogs,
  clearCapturedLogs,
  setupDebugOverlay,
  writeToStorage,
  readFromStorage,
} from "./utils.js";
import { draw } from "./render.js";
import { generateScale, getNote, getNoteName, allNotes, midiToNote } from "./scales.js";
import { lessonPacks, getPackById, getDefaultPackId } from "./lessons.js";

let midiAccessRef = null;
let currentMidiHandler = null;
let currentMidiInputId = null;
const virtualKeyboardInputId = "computer-keyboard";
const srStorageKey = "sr-state";
const settingsStorageKey = "settings";
const activeKeyboardKeys = new Set();

const keyboardTestMap = {
  f: { hand: "left", verdict: "correct", midi: 53 },
  g: { hand: "left", verdict: "wrong", midi: 55 },
  j: { hand: "right", verdict: "correct", midi: 59 },
  h: { hand: "right", verdict: "wrong", midi: 57 },
};

const defaultSettings = {
  practiceMode: "read",
  visualMode: "notes",
  playInputSound: true,
  accuracyTarget: 90,
  timingWindow: 120,
  releaseWindow: 150,
  tempoRatio: 1,
  selectedKey: "C",
  selectedMode: "major",
  showPiano: false,
};

const state = {
  currentPackId: getDefaultPackId(),
  currentLessonIndex: 0,
  isPracticeActive: false,
  isLessonRunning: false,
  activeLesson: null,
  dynamicTempoRatio: 1,
  metronomeEnabled: false,
  transport: {
    running: false,
    bpm: 60,
    beatsPerBar: 2,
    beatDurationSec: 1,
    startPerfMs: 0,
    nextBeatAudioTime: 0,
    beatIndex: 0,
    schedulerId: null,
  },
  audioContext: null,
  wakeLock: null,
  wakeLockListenerAttached: false,
  activeMidiOutputId: null,
  midiTopologySignature: "",
  metronomeNoiseBuffer: null,
  midiPollId: null,
  isPaused: false,
  lastPauseStartedAt: 0,
  swipeStartX: null,
  swipeStartY: null,
  keyboardHandLatch: {
    left: { verdict: "pending", at: 0 },
    right: { verdict: "pending", at: 0 },
  },
  expectedRollSteps: [],
  playedRollSequence: [],
  currentStepCursor: -1,
  currentNotation: null,
  currentSteps: [],
  performanceCapture: {
    active: false,
    startMs: 0,
    endMs: 0,
    stepMs: 0,
    totalSteps: 0,
    notes: [],
    activeNotes: new Map(),
  },
  settings: { ...defaultSettings },
  refs: {},
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const normalizeMidiMessage = (message, forcedInputId = null) => {
  const rawData = message?.data;
  if (!rawData || typeof rawData[0] !== "number") {
    return null;
  }

  return {
    data: [rawData[0], rawData[1] ?? 0, rawData[2] ?? 0],
    keyboardMeta: message?.keyboardMeta || null,
    inputId: forcedInputId ?? message?.inputId ?? null,
    receivedTime: typeof message?.receivedTime === "number" ? message.receivedTime : null,
  };
};

function parseMidiMessage(message) {
  const normalized = normalizeMidiMessage(message);
  if (!normalized) {
    return null;
  }
  return {
    command: normalized.data[0] >> 4,
    channel: normalized.data[0] & 0xf,
    note: normalized.data[1],
    velocity: normalized.data[2] / 127,
    keyboardMeta: normalized.keyboardMeta,
    inputId: normalized.inputId,
    receivedTime: normalized.receivedTime,
  };
}

const keyboardEventToMidiMessage = (command, note, velocity, keyboardMeta = null) => ({
  data: [(command << 4), note, velocity],
  keyboardMeta,
});

const noteToSemitone = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

const loadSettings = () => ({ ...defaultSettings, ...(readFromStorage(settingsStorageKey) || {}) });
const saveSettings = (settings) => writeToStorage(settingsStorageKey, settings);
const loadSrState = () => readFromStorage(srStorageKey) || { lessons: {} };
const saveSrState = (sr) => writeToStorage(srStorageKey, sr);

const releaseWakeLock = async () => {
  if (!state.wakeLock) {
    return;
  }
  try {
    await state.wakeLock.release();
  } catch (error) {
    console.warn("Wake lock release failed", error);
  }
  state.wakeLock = null;
};

const requestWakeLock = async () => {
  if (!state.isPracticeActive || !navigator.wakeLock?.request) {
    return;
  }
  if (document.visibilityState !== "visible") {
    return;
  }
  if (state.wakeLock) {
    return;
  }

  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch (error) {
    console.warn("Wake lock request failed", error);
  }
};

const ensureWakeLockListener = () => {
  if (state.wakeLockListenerAttached) {
    return;
  }
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible" && state.isPracticeActive) {
      await requestWakeLock();
    } else if (document.visibilityState !== "visible") {
      await releaseWakeLock();
    }
  });
  state.wakeLockListenerAttached = true;
};

const setMidiHandler = (handler) => {
  currentMidiHandler = handler;
};

const isFromActiveInput = (message) => {
  if (currentMidiInputId === virtualKeyboardInputId) {
    return !message?.inputId;
  }
  return !!message?.inputId && message.inputId === currentMidiInputId;
};

const showPauseOverlay = () => {
  if (!state.refs.pauseOverlay) {
    return;
  }
  state.refs.pauseOverlay.classList.remove("hidden");
  state.refs.pauseOverlay.setAttribute("aria-hidden", "false");
};

const hidePauseOverlay = () => {
  if (!state.refs.pauseOverlay) {
    return;
  }
  state.refs.pauseOverlay.classList.add("hidden");
  state.refs.pauseOverlay.setAttribute("aria-hidden", "true");
};

const pauseTraining = () => {
  if (!state.isPracticeActive || state.isPaused) {
    return;
  }
  state.isPaused = true;
  state.lastPauseStartedAt = performance.now();
  showPauseOverlay();
};

const resumeTraining = () => {
  if (!state.isPaused) {
    return;
  }
  state.isPaused = false;
  hidePauseOverlay();
};

const stopTraining = () => {
  state.isPracticeActive = false;
  state.isLessonRunning = false;
  state.isPaused = false;
  hidePauseOverlay();
  setMidiHandler(null);
  setActiveScreen(state.refs.homeScreen);
  releaseWakeLock();
};

const togglePauseTraining = () => {
  if (!state.isPracticeActive) {
    return;
  }
  if (state.isPaused) {
    resumeTraining();
  } else {
    pauseTraining();
  }
};

const handleMidiMessage = (message) => {
  const normalized = normalizeMidiMessage(message);
  if (!normalized) {
    return;
  }

  const status = normalized.data[0] >> 4;
  const note = normalized.data[1];
  const velocityRaw = normalized.data[2] || 0;
  const isNoteOn = status === 9 && velocityRaw > 0;

  if (state.isPracticeActive && isNoteOn && note === 24) {
    togglePauseTraining();
    return;
  }

  if (!isFromActiveInput(normalized)) {
    return;
  }

  if (isNoteOn && state.settings.playInputSound) {
    playPerformedNote(note, velocityRaw / 127);
  }

  if (state.isPaused) {
    return;
  }

  capturePerformedInput(normalized);

  if (currentMidiHandler) {
    currentMidiHandler(normalized);
  }
};

const detachMidiListeners = () => {
  if (!midiAccessRef) {
    return;
  }
  midiAccessRef.inputs.forEach((input) => {
    input.onmidimessage = null;
  });
};

const attachAllMidiListeners = () => {
  if (!midiAccessRef) {
    return;
  }
  midiAccessRef.inputs.forEach((input) => {
    input.onmidimessage = (msg) => {
      const normalized = normalizeMidiMessage(msg, input.id);
      if (!normalized) {
        return;
      }
      handleMidiMessage(normalized);
    };
  });
};

const buildMidiTopologySignature = () => {
  if (!midiAccessRef) {
    return "";
  }
  const inputs = Array.from(midiAccessRef.inputs.values())
    .map((input) => `${input.id}:${input.state}:${input.connection}`)
    .sort()
    .join("|");
  const outputs = Array.from(midiAccessRef.outputs.values())
    .map((output) => `${output.id}:${output.state}:${output.connection}`)
    .sort()
    .join("|");
  return `${inputs}__${outputs}`;
};

const refreshMidiTopology = () => {
  const signature = buildMidiTopologySignature();
  if (signature === state.midiTopologySignature) {
    return;
  }
  state.midiTopologySignature = signature;
  refreshMidiSelection();
  attachAllMidiListeners();
  renderMidiInputOptions();
};

const getConnectedMidiInputIds = () => {
  if (!midiAccessRef) {
    return [];
  }
  return Array.from(midiAccessRef.inputs.values()).map((input) => input.id);
};

const findBestMidiOutputForInput = () => {
  if (!midiAccessRef || !currentMidiInputId || currentMidiInputId === virtualKeyboardInputId) {
    return null;
  }

  const outputs = Array.from(midiAccessRef.outputs.values());
  if (!outputs.length) {
    return null;
  }

  const selectedInput = midiAccessRef.inputs.get(currentMidiInputId);
  const normalizedInputName = (selectedInput?.name || "").trim().toLowerCase();

  if (normalizedInputName) {
    const exact = outputs.find((output) => (output.name || "").trim().toLowerCase() === normalizedInputName);
    if (exact) {
      return exact;
    }

    const partial = outputs.find((output) => {
      const name = (output.name || "").trim().toLowerCase();
      return name && (name.includes(normalizedInputName) || normalizedInputName.includes(name));
    });
    if (partial) {
      return partial;
    }
  }

  return outputs[0] || null;
};

const syncActiveMidiOutput = () => {
  const output = findBestMidiOutputForInput();
  state.activeMidiOutputId = output?.id || null;
};

const getActiveMidiOutput = () => {
  if (!midiAccessRef || !state.activeMidiOutputId) {
    return null;
  }
  return midiAccessRef.outputs.get(state.activeMidiOutputId) || null;
};

const safeSendMidi = (output, bytes, atMs) => {
  if (!output) {
    return false;
  }
  try {
    if (typeof atMs === "number") {
      output.send(bytes, atMs);
    } else {
      output.send(bytes);
    }
    return true;
  } catch (error) {
    console.warn("MIDI output send failed", error);
    state.activeMidiOutputId = null;
    return false;
  }
};

const refreshMidiSelection = () => {
  const ids = getConnectedMidiInputIds();
  const hasSelected = currentMidiInputId && ids.includes(currentMidiInputId);
  if (!hasSelected && currentMidiInputId !== virtualKeyboardInputId) {
    currentMidiInputId = ids[0] || virtualKeyboardInputId;
    writeToStorage("midi-input-id", currentMidiInputId);
  }
  syncActiveMidiOutput();
};

const setActiveMidiInput = (inputId) => {
  currentMidiInputId = inputId;
  writeToStorage("midi-input-id", inputId);
  attachAllMidiListeners();
  syncActiveMidiOutput();
  if (state.refs?.midiInputSelect) {
    state.refs.midiInputSelect.value = inputId;
  }
};

const setupMidiAccess = async () => {
  if (!navigator.requestMIDIAccess) {
    return;
  }
  midiAccessRef = await navigator.requestMIDIAccess();
  const storedInput = readFromStorage("midi-input-id");
  const firstInput = midiAccessRef.inputs.values().next().value;
  const fallbackInput = firstInput ? firstInput.id : virtualKeyboardInputId;
  const selected = storedInput && midiAccessRef.inputs.has(storedInput) ? storedInput : fallbackInput;
  setActiveMidiInput(selected);
  syncActiveMidiOutput();
  state.midiTopologySignature = buildMidiTopologySignature();

  midiAccessRef.onstatechange = () => {
    refreshMidiTopology();
  };

  if (state.midiPollId) {
    clearInterval(state.midiPollId);
  }
  state.midiPollId = setInterval(() => {
    refreshMidiTopology();
  }, 2500);
};

const setupComputerKeyboardInput = () => {
  document.addEventListener("keydown", (event) => {
    if (currentMidiInputId !== virtualKeyboardInputId) {
      return;
    }
    const key = event.key.toLowerCase();
    const config = keyboardTestMap[key];
    if (!config || activeKeyboardKeys.has(key)) {
      return;
    }
    activeKeyboardKeys.add(key);
    state.keyboardHandLatch[config.hand] = {
      verdict: config.verdict,
      at: performance.now(),
    };
    handleMidiMessage(keyboardEventToMidiMessage(9, config.midi, 96, config));
  });

  document.addEventListener("keyup", (event) => {
    if (currentMidiInputId !== virtualKeyboardInputId) {
      return;
    }
    const key = event.key.toLowerCase();
    const config = keyboardTestMap[key];
    if (!config || !activeKeyboardKeys.has(key)) {
      return;
    }
    activeKeyboardKeys.delete(key);
    handleMidiMessage(keyboardEventToMidiMessage(8, config.midi, 0, config));
  });
};

const getAudioContext = () => {
  if (!state.audioContext) {
    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (state.audioContext.state === "suspended") {
    state.audioContext.resume();
  }
  return state.audioContext;
};

const getMetronomeNoiseBuffer = (ctx) => {
  if (state.metronomeNoiseBuffer && state.metronomeNoiseBuffer.sampleRate === ctx.sampleRate) {
    return state.metronomeNoiseBuffer;
  }
  const durationSec = 0.09;
  const frameCount = Math.floor(ctx.sampleRate * durationSec);
  const buffer = ctx.createBuffer(1, frameCount, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < frameCount; index++) {
    data[index] = Math.random() * 2 - 1;
  }
  state.metronomeNoiseBuffer = buffer;
  return buffer;
};

const scheduleClick = (ctx, atTimeSec, accent) => {
  const output = getActiveMidiOutput();
  if (output) {
    const now = performance.now();
    const delayMs = Math.max(0, (atTimeSec - ctx.currentTime) * 1000);
    const when = now + delayMs;
    const drumNote = accent ? 37 : 42;
    const velocity = accent ? 112 : 82;
    const onSent = safeSendMidi(output, [0x99, drumNote, velocity], when);
    const offSent = safeSendMidi(output, [0x89, drumNote, 0], when + 55);
    if (onSent && offSent) {
      return;
    }
  }

  const noise = ctx.createBufferSource();
  noise.buffer = getMetronomeNoiseBuffer(ctx);
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(accent ? 2600 : 1700, atTimeSec);
  filter.Q.setValueAtTime(7, atTimeSec);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, atTimeSec);
  gain.gain.exponentialRampToValueAtTime(accent ? 0.12 : 0.07, atTimeSec + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, atTimeSec + 0.055);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  noise.start(atTimeSec);
  noise.stop(atTimeSec + 0.06);
};

const midiToFrequency = (midiNumber) => 440 * Math.pow(2, (midiNumber - 69) / 12);

const midiToLabel = (midiNumber) => {
  if (midiNumber == null) {
    return "?";
  }
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(midiNumber / 12) - 1;
  return `${names[midiNumber % 12]}${octave} (${midiNumber})`;
};

const startPerformanceCapture = (stepMs, totalSteps) => {
  state.performanceCapture = {
    active: true,
    startMs: performance.now(),
    endMs: 0,
    stepMs,
    totalSteps,
    notes: [],
    activeNotes: new Map(),
  };
};

const stopPerformanceCapture = () => {
  const capture = state.performanceCapture;
  if (!capture.active) {
    return;
  }
  const endMs = performance.now();
  const relativeEnd = endMs - capture.startMs;
  capture.activeNotes.forEach((active, midi) => {
    capture.notes.push({
      midi,
      startMs: active.startMs,
      endMs: Math.max(active.startMs + 10, relativeEnd),
      handHint: active.handHint || null,
    });
  });
  capture.activeNotes.clear();
  capture.endMs = endMs;
  capture.active = false;
};

const getCapturedNotesSnapshot = () => {
  const capture = state.performanceCapture;
  const nowRelative = performance.now() - capture.startMs;
  const notes = capture.notes.map((n) => ({ ...n }));
  capture.activeNotes.forEach((active, midi) => {
    notes.push({
      midi,
      startMs: active.startMs,
      endMs: Math.max(active.startMs + 10, nowRelative),
      handHint: active.handHint || null,
    });
  });
  return notes;
};

const decomposeUnits = (units) => {
  const result = [];
  let remaining = Math.max(0, Math.floor(units));
  const chunks = [8, 4, 2, 1];
  while (remaining > 0) {
    const chunk = chunks.find((c) => c <= remaining) || 1;
    result.push(chunk);
    remaining -= chunk;
  }
  return result;
};

const unitsToDuration = (units) => {
  if (units >= 8) return "2";
  if (units >= 4) return "4";
  if (units >= 2) return "8";
  return "16";
};

const buildHandStaffSequence = (slots, scaleName, restToken) => {
  const tokens = [];
  let cursor = 0;
  while (cursor < slots.length) {
    const current = slots[cursor];
    let runLength = 1;
    while (cursor + runLength < slots.length && slots[cursor + runLength] === current) {
      runLength += 1;
    }
    const chunks = decomposeUnits(runLength);
    chunks.forEach((chunk) => {
      const duration = unitsToDuration(chunk);
      if (current == null) {
        tokens.push(`${restToken}/${duration}/r`);
      } else {
        tokens.push(`${midiToNote(current, scaleName)}/${duration}`);
      }
    });
    cursor += runLength;
  }
  if (!tokens.length) {
    tokens.push(`${restToken}/4/r`);
  }
  return tokens.join(", ");
};

const buildPlayedLayerNotation = (scaleName, totalSteps) => {
  const capture = state.performanceCapture;
  const slotsLeft = Array.from({ length: totalSteps }, () => null);
  const slotsRight = Array.from({ length: totalSteps }, () => null);
  const slotStartLeft = Array.from({ length: totalSteps }, () => -Infinity);
  const slotStartRight = Array.from({ length: totalSteps }, () => -Infinity);
  const stepMs = capture.stepMs || 1;
  const notes = getCapturedNotesSnapshot();

  notes.forEach((note) => {
    const startSlot = Math.max(0, Math.floor(note.startMs / stepMs));
    const endSlot = Math.min(totalSteps - 1, Math.ceil(note.endMs / stepMs) - 1);
    if (endSlot < startSlot) {
      return;
    }
    const hand = note.handHint || (note.midi >= 58 ? "right" : "left");
    for (let slot = startSlot; slot <= endSlot; slot++) {
      if (hand === "right") {
        if (note.startMs >= slotStartRight[slot]) {
          slotStartRight[slot] = note.startMs;
          slotsRight[slot] = note.midi;
        }
      } else {
        if (note.startMs >= slotStartLeft[slot]) {
          slotStartLeft[slot] = note.startMs;
          slotsLeft[slot] = note.midi;
        }
      }
    }
  });

  return {
    treble: buildHandStaffSequence(slotsRight, scaleName, "B4"),
    bass: buildHandStaffSequence(slotsLeft, scaleName, "D3"),
  };
};

const buildPlayedRollSequence = (totalSteps) => {
  const capture = state.performanceCapture;
  const stepMs = capture.stepMs || 1;
  return getCapturedNotesSnapshot()
    .map((note) => {
      const t = Math.max(0, note.startMs / stepMs);
      const g = Math.max(0.1, (note.endMs - note.startMs) / stepMs);
      return { t, g, n: note.midi };
    })
    .filter((event) => event.t <= totalSteps + 0.5);
};

const capturePerformedInput = (message) => {
  const capture = state.performanceCapture;
  if (!capture.active) {
    return;
  }

  const status = message?.data?.[0] >> 4;
  const note = message?.data?.[1];
  const velocityRaw = message?.data?.[2] || 0;
  if (status !== 8 && status !== 9) {
    return;
  }

  const isNoteOn = status === 9 && velocityRaw > 0;
  const nowRelative = performance.now() - capture.startMs;
  const keyboardHand = message?.keyboardMeta?.hand || null;

  if (isNoteOn) {
    if (!capture.activeNotes.has(note)) {
      capture.activeNotes.set(note, {
        startMs: Math.max(0, nowRelative),
        handHint: keyboardHand,
      });
    }
  } else {
    const active = capture.activeNotes.get(note);
    if (active) {
      capture.notes.push({
        midi: note,
        startMs: active.startMs,
        endMs: Math.max(active.startMs + 10, nowRelative),
        handHint: active.handHint || keyboardHand,
      });
      capture.activeNotes.delete(note);
    }
  }

  const totalSteps = capture.totalSteps || 1;
  state.playedRollSequence = buildPlayedRollSequence(totalSteps);
  if (state.currentNotation && state.currentSteps.length) {
    const playedNotation = buildPlayedLayerNotation(state.currentNotation.scaleName, state.currentSteps.length);
    renderStaffLayers(
      state.currentNotation,
      state.currentSteps,
      Math.max(0, state.currentStepCursor),
      "pending",
      [],
      [],
      playedNotation
    );
    renderPianoRoll(state.expectedRollSteps, state.currentStepCursor);
  }
};

const noteNameWithOctaveToMidi = (noteName, octave) => {
  const semitone = noteToSemitone[noteName];
  if (semitone === undefined) {
    return null;
  }
  return 12 * (octave + 1) + semitone;
};

const schedulePianoNote = (ctx, midiNumber, atTimeSec, durationSec = 0.22, velocity = 0.55) => {
  if (midiNumber == null) {
    return;
  }

  const output = getActiveMidiOutput();
  if (output) {
    const now = performance.now();
    const delayMs = Math.max(0, (atTimeSec - ctx.currentTime) * 1000);
    const when = now + delayMs;
    const velocityInt = Math.max(1, Math.min(127, Math.round(velocity * 127)));
    const onSent = safeSendMidi(output, [0x90, midiNumber, velocityInt], when);
    const offSent = safeSendMidi(output, [0x80, midiNumber, 0], when + Math.max(60, durationSec * 1000));
    if (onSent && offSent) {
      return;
    }
  }

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = "sine";
  osc.frequency.setValueAtTime(midiToFrequency(midiNumber), atTimeSec);

  gain.gain.setValueAtTime(0.0001, atTimeSec);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.001, velocity * 0.12), atTimeSec + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, atTimeSec + durationSec);

  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(atTimeSec);
  osc.stop(atTimeSec + durationSec + 0.02);
};

const playPerformedNote = (midiNumber, velocity = 0.7) => {
  if (!state.settings.playInputSound) {
    return;
  }
  const ctx = getAudioContext();
  const now = ctx.currentTime + 0.002;
  schedulePianoNote(ctx, midiNumber, now, 0.18, Math.max(0.2, velocity));
};

const pulseTempoDot = () => {
  const dot = state.refs.tempoDot;
  if (!dot) {
    return;
  }
  dot.classList.add("active");
  setTimeout(() => dot.classList.remove("active"), 90);
};

const stopTransport = () => {
  if (state.transport.schedulerId) {
    clearInterval(state.transport.schedulerId);
  }
  state.transport.running = false;
  state.transport.schedulerId = null;
};

const startTransport = (bpm, beatsPerBar = 2) => {
  const ctx = getAudioContext();
  stopTransport();

  const beatDurationSec = 60 / bpm;
  const startLeadSec = 0.08;

  state.transport.running = true;
  state.transport.bpm = bpm;
  state.transport.beatsPerBar = Math.max(1, Number(beatsPerBar) || 2);
  state.transport.beatDurationSec = beatDurationSec;
  state.transport.nextBeatAudioTime = ctx.currentTime + startLeadSec;
  state.transport.beatIndex = 0;
  state.transport.startPerfMs = performance.now() + startLeadSec * 1000;

  const lookAheadMs = 25;
  const scheduleAheadSec = 0.12;

  state.transport.schedulerId = setInterval(() => {
    const nowSec = ctx.currentTime;
    while (state.transport.nextBeatAudioTime < nowSec + scheduleAheadSec) {
      const beatAudioTime = state.transport.nextBeatAudioTime;
      const beatIndex = state.transport.beatIndex;
      const beatPerfMs = state.transport.startPerfMs + beatIndex * beatDurationSec * 1000;

      if (state.metronomeEnabled) {
        scheduleClick(ctx, beatAudioTime, beatIndex % state.transport.beatsPerBar === 0);
      }

      const visualDelay = Math.max(0, beatPerfMs - performance.now());
      setTimeout(() => {
        if (state.transport.running) {
          pulseTempoDot();
        }
      }, visualDelay);

      state.transport.beatIndex += 1;
      state.transport.nextBeatAudioTime += beatDurationSec;
    }
  }, lookAheadMs);
};

const alignToGridMs = (stepMs) => {
  const now = performance.now();
  if (!state.transport.running || !stepMs) {
    return now;
  }
  const elapsed = now - state.transport.startPerfMs;
  const stepsFromStart = Math.ceil(elapsed / stepMs);
  return state.transport.startPerfMs + Math.max(0, stepsFromStart) * stepMs;
};

const getLessonsForPack = () => getPackById(state.currentPackId)?.lessons || [];

const normalizeLessonSteps = (lesson) => {
  if (Array.isArray(lesson.steps) && lesson.steps.length) {
    return lesson.steps.map((step, index) => ({
      degree: step.degree ?? step.rightDegree ?? 0,
      leftDegree: step.leftDegree ?? step.degree ?? step.rightDegree ?? 0,
      fingering: step.fingering ?? 1,
      id: step.id || `${lesson.id}-${index}`,
    }));
  }

  if (Array.isArray(lesson.degrees) && lesson.degrees.length) {
    return lesson.degrees.map((degree, index) => ({
      degree,
      leftDegree: degree,
      fingering: lesson.fingerings?.[index] || 1,
      id: `${lesson.id}-${index}`,
    }));
  }

  return [];
};

const getCurrentScale = () => {
  const key = state.settings.selectedKey;
  const mode = state.settings.selectedMode;
  return generateScale(key, mode === "major" ? "major" : "minor");
};

const prepareNotation = (steps) => {
  const [scale, scaleName] = getCurrentScale();
  const treble = steps
    .map((step, index) => `${getNote(step.degree + 1, scale, scaleName, 4, 16)}[id="nt${index + 1}"]`)
    .join(", ");
  const bass = steps
    .map((step, index) => `${getNote(step.leftDegree + 1, scale, scaleName, 3, 16)}[id="nb${index + 1}"]`)
    .join(", ");
  const expected = steps.map((step) => ({
    right: getNote(step.degree + 1, scale, scaleName, 4, 16).split("/")[0],
    left: getNote(step.leftDegree + 1, scale, scaleName, 3, 16).split("/")[0],
    rightMidi: noteNameWithOctaveToMidi(getNoteName(step.degree + 1, scale, scaleName), 4),
    leftMidi: noteNameWithOctaveToMidi(getNoteName(step.leftDegree + 1, scale, scaleName), 3),
  }));
  return { scaleName, treble, bass, expected };
};

const getLessonBeatsPerBar = (lesson) => {
  const signature = `${lesson?.timeSignature || "2/4"}`;
  const [numeratorRaw] = signature.split("/");
  const numerator = Number(numeratorRaw);
  return Number.isFinite(numerator) && numerator > 0 ? numerator : 2;
};

const updatePracticeFeedback = (text, tone = "neutral") => {
  if (!state.refs.playFeedback) {
    return;
  }
  state.refs.playFeedback.textContent = text;
  if (tone === "good") {
    state.refs.playFeedback.style.color = "green";
  } else if (tone === "bad") {
    state.refs.playFeedback.style.color = "red";
  } else {
    state.refs.playFeedback.style.color = "";
  }
};

const updateTempoLabel = (bpm, ratio) => {
  if (state.refs.tempoLabel) {
    state.refs.tempoLabel.textContent = `Tempo ${Math.round(bpm)} BPM (${ratio.toFixed(2)}x)`;
  }
  if (state.refs.tempoRatioValue) {
    state.refs.tempoRatioValue.textContent = `${ratio.toFixed(2)}x`;
  }
};

const applyVisualMode = () => {
  const isPianoRoll = state.settings.visualMode === "piano-roll";
  if (state.refs.scoreViewport) {
    state.refs.scoreViewport.classList.toggle("hidden", isPianoRoll);
  }
  if (state.refs.pianoRollViewport) {
    state.refs.pianoRollViewport.classList.toggle("hidden", !isPianoRoll);
  }
};

const renderStaffLayers = (
  notation,
  steps,
  index,
  currentState = "pending",
  noteStates = [],
  noteHints = [],
  playedLayerNotation = null
) => {
  const fingerings = steps.map((s) => s.fingering);
  draw(
    notation.scaleName,
    [notation.treble, notation.bass],
    fingerings,
    index,
    "pending",
    [],
    [],
    { elementId: "outputExpected", showFingerings: true, showHints: false }
  );

  draw(
    notation.scaleName,
    [playedLayerNotation?.treble || notation.treble, playedLayerNotation?.bass || notation.bass],
    playedLayerNotation ? [] : fingerings,
    playedLayerNotation ? null : index,
    playedLayerNotation ? "pending" : currentState,
    playedLayerNotation ? [] : noteStates,
    playedLayerNotation ? [] : noteHints,
    { elementId: "outputPlayed", showFingerings: false, showHints: false }
  );
};

const renderPianoRoll = (steps, currentIndex = -1) => {
  if (!state.refs.pianoRollExpected || !state.refs.pianoRollPlayed) {
    return;
  }
  const expectedRoll = state.refs.pianoRollExpected;
  const playedRoll = state.refs.pianoRollPlayed;
  const total = Math.max(steps.length, 1);

  if (currentIndex < 0) {
    expectedRoll.sequence = [];
    steps.forEach((step, index) => {
      expectedRoll.sequence.push({ t: index, g: 1, n: step.rightMidi || 60 });
      expectedRoll.sequence.push({ t: index, g: 1, n: step.leftMidi || 48 });
    });
    expectedRoll.setAttribute("timebase", String(total));
    expectedRoll.setAttribute("xrange", String(Math.max(16, total + 4)));
    expectedRoll.setAttribute("markend", String(total));
    if (typeof expectedRoll.redraw === "function") {
      expectedRoll.redraw();
    }

  }

  playedRoll.sequence = Array.isArray(state.playedRollSequence) ? [...state.playedRollSequence] : [];
  playedRoll.setAttribute("timebase", String(total));
  playedRoll.setAttribute("xrange", String(Math.max(16, total + 4)));
  playedRoll.setAttribute("markend", String(total));
  if (typeof playedRoll.redraw === "function") {
    playedRoll.redraw();
  }

  if (typeof expectedRoll.locate === "function") {
    expectedRoll.locate(Math.max(0, currentIndex));
  } else {
    expectedRoll.setAttribute("cursor", String(Math.max(0, currentIndex)));
  }

  if (typeof playedRoll.locate === "function") {
    playedRoll.locate(Math.max(0, currentIndex));
  } else {
    playedRoll.setAttribute("cursor", String(Math.max(0, currentIndex)));
  }
};

const markPianoKeys = (step, color = "#3c6df0") => {
  const piano = document.getElementById("pianoKeys");
  if (!piano) {
    return;
  }
  piano.setAttribute("mark-color", color);
  const [scale, scaleName] = getCurrentScale();
  const rightNoteName = getNoteName(step.degree + 1, scale, scaleName);
  const leftNoteName = getNoteName(step.leftDegree + 1, scale, scaleName);
  const rightIndex = allNotes.indexOf(rightNoteName.replace("b", "#"));
  const leftIndex = allNotes.indexOf(leftNoteName.replace("b", "#"));
  if (rightIndex >= 0 && leftIndex >= 0) {
    piano.setAttribute("marked-keys", `${leftIndex + 13} ${rightIndex + 25}`);
  }
};

const playDemo = async (steps, notation, bpm) => {
  const ctx = getAudioContext();
  const stepMs = 60000 / bpm / 2;
  let onsetMs = alignToGridMs(stepMs);

  for (let index = 0; index < steps.length; index++) {
    const waitMs = onsetMs - performance.now();
    if (waitMs > 0) {
      await wait(waitMs);
    }

    renderPianoRoll(state.expectedRollSteps, index);
    const playedNotation = buildPlayedLayerNotation(notation.scaleName, steps.length);
    renderStaffLayers(notation, steps, index, "pending", [], [], playedNotation);
    markPianoKeys(steps[index], "#3c6df0");
    const atTimeSec = ctx.currentTime + 0.01;
    const durationSec = Math.max(0.12, (stepMs / 1000) * 0.85);
    schedulePianoNote(ctx, notation.expected[index]?.leftMidi, atTimeSec, durationSec, 0.55);
    schedulePianoNote(ctx, notation.expected[index]?.rightMidi, atTimeSec, durationSec, 0.6);
    onsetMs += stepMs;
  }
};

const describeTiming = (deltaMs, timingWindow) => {
  if (deltaMs == null) {
    return "";
  }
  const absDelta = Math.abs(deltaMs);
  if (absDelta <= timingWindow * 0.4) {
    return "⏱ on";
  }
  if (deltaMs < -timingWindow * 1.5) {
    return "⏱ very early";
  }
  if (deltaMs < -timingWindow) {
    return "⏱ early";
  }
  if (deltaMs > timingWindow * 1.5) {
    return "⏱ very late";
  }
  if (deltaMs > timingWindow) {
    return "⏱ late";
  }
  return "";
};

const describeVelocity = (velocity) => {
  if (velocity == null) {
    return "";
  }
  if (velocity < 0.2) {
    return "🔉 very soft";
  }
  if (velocity < 0.35) {
    return "🔉 soft";
  }
  if (velocity > 0.92) {
    return "🔊 hard";
  }
  return "";
};

const runSingleStep = ({
  expected,
  step,
  stepIndex,
  notation,
  steps,
  bpm,
  stepStart,
  expectedOnsetMs = null,
  noteStates,
  noteHints,
  waitForBarStart = false,
}) => {
  const timingWindow = Number(state.settings.timingWindow);
  const releaseWindow = Number(state.settings.releaseWindow);
  const stepMs = 60000 / bpm / 2;
  const releaseState = { left: false, right: false };

  return new Promise((resolve) => {
    const hand = { left: "pending", right: "pending" };
    const handVelocity = { left: null, right: null };
    const handOnsetDelta = { left: null, right: null };
    const handReleaseDelta = { left: null, right: null };
    let stepFailed = false;

    let effectiveStepStart = typeof expectedOnsetMs === "number" ? expectedOnsetMs : stepStart;
    let timeout = null;
    let pauseAnchor = null;
    const receivedEvents = [];
    const onsetTargetMs = state.settings.practiceMode === "imitation" && stepIndex === 0 ? stepMs : 0;

    console.log(`[Step ${stepIndex + 1}] EXPECTED`, {
      right: { name: expected.right, midi: expected.rightMidi, label: midiToLabel(expected.rightMidi) },
      left: { name: expected.left, midi: expected.leftMidi, label: midiToLabel(expected.leftMidi) },
      bpm,
      stepMs,
      onsetTargetMs,
      timingWindow,
      releaseWindow,
      mode: state.settings.practiceMode,
      input: currentMidiInputId,
    });

    if (currentMidiInputId === virtualKeyboardInputId) {
      const latchWindowMs = 140;
      const now = performance.now();
      ["left", "right"].forEach((handName) => {
        const latch = state.keyboardHandLatch[handName];
        if (now - latch.at <= latchWindowMs && latch.verdict !== "pending") {
          hand[handName] = latch.verdict;
        }
      });
    }

    const finalizeStep = () => {
      if (state.isPaused) {
        if (pauseAnchor == null) {
          pauseAnchor = performance.now();
        }
        timeout = setTimeout(finalizeStep, 80);
        return;
      }

      if (pauseAnchor != null) {
        const pausedDuration = performance.now() - pauseAnchor;
        effectiveStepStart += pausedDuration;
        pauseAnchor = null;
      }

      setMidiHandler(null);

      const now = performance.now();
      const handResult = ["left", "right"].reduce(
        (acc, handName) => {
          const isMissed = hand[handName] === "pending";
          const isWrong = hand[handName] === "wrong";
          const adjustedOnsetDelta =
            handOnsetDelta[handName] == null ? null : handOnsetDelta[handName] - onsetTargetMs;
          const timingText = describeTiming(adjustedOnsetDelta, timingWindow);
          const velocityText = describeVelocity(handVelocity[handName]);
          const releaseDelta = handReleaseDelta[handName];
          const releaseText =
            releaseDelta == null || releaseDelta > stepMs + releaseWindow
              ? "⟂ release"
              : "";

          const hints = [];
          if (isMissed) {
            hints.push("∅ missed");
          }
          if (timingText && !isMissed) {
            hints.push(timingText);
          }
          if (velocityText && !isMissed) {
            hints.push(velocityText);
          }
          if (releaseText && !isMissed) {
            hints.push(releaseText);
          }
          if (isWrong) {
            hints.push("✗note");
          }

          const badTiming = adjustedOnsetDelta != null && Math.abs(adjustedOnsetDelta) > timingWindow;
          const badVelocity = handVelocity[handName] != null && handVelocity[handName] < 0.35;
          const badRelease = releaseDelta == null || releaseDelta > stepMs + releaseWindow;
          const isCorrect = !isMissed && !isWrong;
          const ok = isCorrect && !badTiming && !badVelocity && !badRelease;

          acc.noteHits += isCorrect ? 1 : 0;
          acc.onsetHit += !badTiming && isCorrect ? 1 : 0;
          acc.pressureHit += !badVelocity && isCorrect ? 1 : 0;
          acc.releaseHit += !badRelease && isCorrect ? 1 : 0;
          acc.ok = acc.ok && ok;

          acc.states[handName] = isMissed ? "missed" : isWrong ? "wrong" : "correct";
          acc.hints[handName] = hints.join(" ");
          return acc;
        },
        {
          noteHits: 0,
          onsetHit: 0,
          pressureHit: 0,
          releaseHit: 0,
          ok: !stepFailed,
          states: { left: "pending", right: "pending" },
          hints: { left: "", right: "" },
        }
      );

      noteStates[stepIndex] = handResult.states;
      noteHints[stepIndex] = handResult.hints;

      const noteOnlyOk = handResult.states.left === "correct" && handResult.states.right === "correct";
      const feedbackParts = [handResult.hints.right, handResult.hints.left].filter(Boolean);
      if (feedbackParts.length) {
        updatePracticeFeedback(`Step ${stepIndex + 1}: ${feedbackParts.join(" | ")}`, handResult.ok ? "good" : "bad");
      }

      console.log(`[Step ${stepIndex + 1}] RESULT`, {
        receivedEvents,
        handState: hand,
        handOnsetDelta,
        adjustedHandOnsetDelta: {
          left: handOnsetDelta.left == null ? null : handOnsetDelta.left - onsetTargetMs,
          right: handOnsetDelta.right == null ? null : handOnsetDelta.right - onsetTargetMs,
        },
        onsetTargetMs,
        handVelocity,
        handReleaseDelta,
        gradedStates: handResult.states,
        gradedHints: handResult.hints,
        scores: {
          noteHits: handResult.noteHits,
          onsetHit: handResult.onsetHit,
          pressureHit: handResult.pressureHit,
          releaseHit: handResult.releaseHit,
          noteOnlyOk,
          ok: handResult.ok,
        },
      });

      const pianoColor = handResult.ok ? "#22c55e" : "#ef4444";
      markPianoKeys(step, pianoColor);

      const playedNotation = buildPlayedLayerNotation(notation.scaleName, steps.length);
      renderStaffLayers(
        notation,
        steps,
        stepIndex,
        handResult.ok ? "correct" : "wrong",
        noteStates,
        noteHints,
        playedNotation
      );

      resolve({
        ok: currentMidiInputId === virtualKeyboardInputId ? noteOnlyOk : handResult.ok,
        noteOnlyOk,
        noteHits: handResult.noteHits,
        noteTotal: 2,
        onsetHit: handResult.onsetHit,
        pressureHit: handResult.pressureHit,
        releaseHit: handResult.releaseHit,
      });
    };

    const scheduleFinalize = () => {
      if (timeout) {
        clearTimeout(timeout);
      }
      const timeoutDelay = Math.max(0, stepMs - (performance.now() - effectiveStepStart));
      timeout = setTimeout(finalizeStep, timeoutDelay);
    };

    if (!waitForBarStart) {
      scheduleFinalize();
    }

    setMidiHandler((rawMessage) => {
      const parsed = parseMidiMessage(rawMessage);
      if (!parsed) {
        return;
      }
      const { command, note, velocity, keyboardMeta, receivedTime } = parsed;
      if (command !== 8 && command !== 9) {
        return;
      }

      const eventTime = typeof receivedTime === "number" ? receivedTime : performance.now();
      if (eventTime < effectiveStepStart - 5) {
        return;
      }

      const isNoteOn = command === 9 && velocity > 0;
      if (waitForBarStart && isNoteOn && hand.left === "pending" && hand.right === "pending") {
        effectiveStepStart = eventTime;
        scheduleFinalize();
      }

      if (waitForBarStart && !timeout) {
        return;
      }

      if (currentMidiInputId === virtualKeyboardInputId && keyboardMeta) {
        if (isNoteOn) {
          receivedEvents.push({
            atMs: Math.round(performance.now()),
            type: "on",
            hand: keyboardMeta.hand,
            verdict: keyboardMeta.verdict,
            note,
            label: midiToLabel(note),
            velocity,
          });
          hand[keyboardMeta.hand] = keyboardMeta.verdict;
          handOnsetDelta[keyboardMeta.hand] = eventTime - effectiveStepStart;
          handVelocity[keyboardMeta.hand] = velocity;
          if (hand[keyboardMeta.hand] !== "correct") {
            stepFailed = true;
          }
          updatePracticeFeedback(`${keyboardMeta.hand} hand: ${keyboardMeta.verdict}`, keyboardMeta.verdict === "correct" ? "good" : "bad");
        } else {
          if (handOnsetDelta[keyboardMeta.hand] != null) {
            receivedEvents.push({
              atMs: Math.round(performance.now()),
              type: "off",
              hand: keyboardMeta.hand,
              note,
              label: midiToLabel(note),
            });
            releaseState[keyboardMeta.hand] = true;
            handReleaseDelta[keyboardMeta.hand] = eventTime - effectiveStepStart;
          }
        }
      } else {
        const noteName = midiToNote(note, notation.scaleName);
        if (isNoteOn) {
          receivedEvents.push({
            atMs: Math.round(performance.now()),
            type: "on",
            note,
            label: midiToLabel(note),
            noteName,
            velocity,
          });
          const matchedRight = note === expected.rightMidi;
          const matchedLeft = note === expected.leftMidi;

          let noteHand = null;
          if (matchedRight) {
            hand.right = "correct";
            noteHand = "right";
          } else if (matchedLeft) {
            hand.left = "correct";
            noteHand = "left";
          } else {
            const proximityRight = Math.abs(note - expected.rightMidi);
            const proximityLeft = Math.abs(note - expected.leftMidi);
            noteHand = proximityLeft <= proximityRight ? "left" : "right";
            hand[noteHand] = "wrong";
            stepFailed = true;
          }
          if (noteHand) {
            handOnsetDelta[noteHand] = eventTime - effectiveStepStart;
            handVelocity[noteHand] = velocity;
            const delta = handOnsetDelta[noteHand];
          }
          updatePracticeFeedback(`Played ${noteName}`, matchedLeft || matchedRight ? "good" : "bad");
        } else {
          const noteHand = Math.abs(note - expected.leftMidi) <= Math.abs(note - expected.rightMidi) ? "left" : "right";
          if (handOnsetDelta[noteHand] != null) {
            receivedEvents.push({
              atMs: Math.round(performance.now()),
              type: "off",
              note,
              label: midiToLabel(note),
              noteName,
            });
            releaseState[noteHand] = true;
            handReleaseDelta[noteHand] = eventTime - effectiveStepStart;
          }
        }
      }

      if (hand.left === "correct" && hand.right === "correct") {
        noteStates[stepIndex] = {
          left: hand.left,
          right: hand.right,
        };
        markPianoKeys(step, stepFailed ? "#ef4444" : "#22c55e");
        const playedNotation = buildPlayedLayerNotation(notation.scaleName, steps.length);
        renderStaffLayers(
          notation,
          steps,
          stepIndex,
          stepFailed ? "wrong" : "correct",
          noteStates,
          noteHints,
          playedNotation
        );
      }
    });
  });
};

const runUserAttempt = async (steps, notation, bpm) => {
  const metrics = {
    noteHits: 0,
    noteTotal: 0,
    onsetHits: 0,
    pressureHits: 0,
    releaseHits: 0,
    stepCount: steps.length,
    mistakes: 0,
  };

  const stepMs = 60000 / bpm / 2;
  let stepOnsetMs = alignToGridMs(stepMs);
  const noteStates = steps.map(() => ({ left: "pending", right: "pending" }));
  const noteHints = steps.map(() => ({ left: "", right: "" }));
  startPerformanceCapture(stepMs, steps.length);

  try {
    for (let index = 0; index < steps.length; index++) {
      state.currentStepCursor = index;
      while (state.isPaused) {
        await wait(80);
      }

      const waitMs = stepOnsetMs - performance.now();
      if (waitMs > 0) {
        await wait(waitMs);
      }

      renderPianoRoll(state.expectedRollSteps, index);
      const playedNotation = buildPlayedLayerNotation(notation.scaleName, steps.length);
      renderStaffLayers(notation, steps, index, "pending", noteStates, noteHints, playedNotation);
      updateScoreAutoScroll(index, steps.length);
      markPianoKeys(steps[index], "#3c6df0");
      const stepStart = performance.now();
      const result = await runSingleStep({
        expected: notation.expected[index],
        step: steps[index],
        stepIndex: index,
        notation,
        steps,
        bpm,
        stepStart,
        expectedOnsetMs: stepOnsetMs,
        noteStates,
        noteHints,
        waitForBarStart: state.settings.practiceMode === "read" && index === 0,
      });
      metrics.noteHits += result.noteHits;
      metrics.noteTotal += result.noteTotal;
      metrics.onsetHits += result.onsetHit;
      metrics.pressureHits += result.pressureHit;
      metrics.releaseHits += result.releaseHit;
      if (!result.ok) {
        metrics.mistakes += 1;
      }
      stepOnsetMs += stepMs;
    }
  } finally {
    stopPerformanceCapture();
    state.playedRollSequence = buildPlayedRollSequence(steps.length);
    renderPianoRoll(state.expectedRollSteps, state.currentStepCursor);
    const playedNotation = buildPlayedLayerNotation(notation.scaleName, steps.length);
    renderStaffLayers(notation, steps, state.currentStepCursor, "pending", noteStates, noteHints, playedNotation);
  }

  const accuracy = metrics.noteTotal ? (metrics.noteHits / metrics.noteTotal) * 100 : 0;
  const onsetAccuracy = metrics.stepCount ? (metrics.onsetHits / metrics.stepCount) * 100 : 0;
  const pressureAccuracy = metrics.stepCount ? (metrics.pressureHits / metrics.stepCount) * 100 : 0;
  const releaseAccuracy = metrics.stepCount ? (metrics.releaseHits / metrics.stepCount) * 100 : 0;
  const notePass =
    metrics.mistakes === 0 &&
    accuracy >= state.settings.accuracyTarget;

  const timingPass = onsetAccuracy >= 60 && pressureAccuracy >= 40 && releaseAccuracy >= 40;
  const passed = currentMidiInputId === virtualKeyboardInputId ? notePass : notePass && timingPass;

  return {
    passed,
    accuracy,
    onsetAccuracy,
    pressureAccuracy,
    releaseAccuracy,
    mistakes: metrics.mistakes,
    noteHints,
  };
};

const updateScoreAutoScroll = (index, total) => {
  const viewport = document.getElementById("scoreViewport");
  const output = document.getElementById("outputExpected");
  if (!viewport || !output || total <= 1) {
    return;
  }
  const maxScroll = Math.max(0, output.scrollWidth - viewport.clientWidth);
  const ratio = Math.min(1, Math.max(0, index / (total - 1)));
  output.style.transform = `translateX(${-maxScroll * ratio}px)`;
};

const updateSpacedRepetition = (lessonId, summary) => {
  const sr = loadSrState();
  const current = sr.lessons?.[lessonId] || {
    intervalDays: 0,
    attempts: 0,
    successes: 0,
  };
  const passed = summary.passed;
  const intervalDays = passed
    ? current.intervalDays > 0
      ? Math.min(current.intervalDays * 1.7, 21)
      : 1
    : 0.2;

  sr.lessons = {
    ...sr.lessons,
    [lessonId]: {
      ...current,
      attempts: current.attempts + 1,
      playedCount: (current.playedCount || 0) + 1,
      successes: current.successes + (passed ? 1 : 0),
      lastAccuracy: summary.accuracy,
      lastOnset: summary.onsetAccuracy,
      lastPressure: summary.pressureAccuracy,
      lastRelease: summary.releaseAccuracy,
      intervalDays,
      lastPlayedAt: Date.now(),
      dueAt: Date.now() + intervalDays * 24 * 60 * 60 * 1000,
    },
  };

  saveSrState(sr);
  renderStats();
};

const formatDueTime = (dueAt) => {
  if (!dueAt) {
    return "now";
  }
  const diff = dueAt - Date.now();
  if (diff <= 0) {
    return "now";
  }
  const hours = Math.round(diff / (60 * 60 * 1000));
  if (hours < 24) {
    return `${hours}h`;
  }
  return `${Math.round(hours / 24)}d`;
};

const formatDateTime = (timestamp) => {
  if (!timestamp) {
    return "-";
  }
  return new Date(timestamp).toLocaleString();
};

const renderStats = () => {
  const statsList = state.refs.statsList;
  if (!statsList) {
    return;
  }
  const sr = loadSrState();
  const lessons = getLessonsForPack();
  statsList.innerHTML = "";

  lessons.forEach((lesson) => {
    const stat = sr.lessons?.[lesson.id];
    const item = document.createElement("div");
    item.className = "stats-item";
    const attempts = stat?.attempts || 0;
    const successes = stat?.successes || 0;
    const playedCount = stat?.playedCount || attempts;
    const successRate = attempts ? Math.round((successes / attempts) * 100) : 0;
    const dueRelative = formatDueTime(stat?.dueAt);
    const dueExact = formatDateTime(stat?.dueAt);
    const lastPlayed = formatDateTime(stat?.lastPlayedAt);

    item.innerHTML = `
      <div><strong>${lesson.title}</strong></div>
      <div>Played: ${playedCount} • Success: ${successRate}% • Last acc: ${Math.round(stat?.lastAccuracy || 0)}%</div>
      <div>Next due: ${dueRelative} (${dueExact})</div>
      <div>Last played: ${lastPlayed}</div>
    `;
    statsList.appendChild(item);
  });
};

const pickNextLesson = (noIncrement = false) => {
  const lessons = getLessonsForPack();
  if (!lessons.length) {
    return null;
  }

  if (!noIncrement) {
    state.currentLessonIndex = (state.currentLessonIndex + 1) % lessons.length;
  }

  const sr = loadSrState();
  const due = lessons.filter((lesson) => (sr.lessons?.[lesson.id]?.dueAt || 0) <= Date.now());
  if (due.length) {
    return due[0];
  }

  return lessons[state.currentLessonIndex];
};

const runLesson = async (lesson) => {
  if (!lesson || !state.isPracticeActive) {
    return;
  }
  state.isLessonRunning = true;
  state.activeLesson = lesson;
  state.dynamicTempoRatio = state.settings.tempoRatio;
  state.refs.lessonTitle.textContent = lesson.title;

  const steps = normalizeLessonSteps(lesson);
  if (!steps.length) {
    updatePracticeFeedback("This lesson has no playable steps", "bad");
    state.isLessonRunning = false;
    return;
  }

  const notation = prepareNotation(steps);
  state.currentNotation = notation;
  state.currentSteps = steps;
  state.currentStepCursor = -1;
  const rollSteps = steps.map((step, index) => ({
    ...step,
    rightMidi: notation.expected[index]?.rightMidi,
    leftMidi: notation.expected[index]?.leftMidi,
  }));
  state.expectedRollSteps = rollSteps;
  state.playedRollSequence = [];
  renderPianoRoll(state.expectedRollSteps, -1);
  let done = false;
  let lastSummary = null;
  const targetTempoRatio = state.settings.tempoRatio;
  const tempoRecoveryStep = 0.2;

  while (!done && state.isPracticeActive) {
    const baseTempo = lesson.baseTempo || lesson.tempo || 60;
    const effectiveBpm = Math.max(20, baseTempo * state.dynamicTempoRatio);
    const beatsPerBar = getLessonBeatsPerBar(lesson);
    updateTempoLabel(effectiveBpm, state.dynamicTempoRatio);
    startTransport(effectiveBpm, beatsPerBar);

    if (state.settings.practiceMode === "imitation") {
      updatePracticeFeedback("Listen and watch first", "neutral");
      await playDemo(steps, notation, effectiveBpm);
      await wait(140);
    }

    updatePracticeFeedback("Your turn", "neutral");
    const summary = await runUserAttempt(steps, notation, effectiveBpm);
    lastSummary = summary;

    if (summary.passed) {
      if (state.dynamicTempoRatio < targetTempoRatio - 0.001) {
        const nextRatio = Math.min(targetTempoRatio, state.dynamicTempoRatio + tempoRecoveryStep);
        updatePracticeFeedback(
          `Good. Tempo recovery ${state.dynamicTempoRatio.toFixed(2)}x → ${nextRatio.toFixed(2)}x`,
          "good"
        );
        state.dynamicTempoRatio = nextRatio;
        await wait(220);
      } else {
        updatePracticeFeedback("Great. Full drill passed at target tempo.", "good");
        done = true;
      }
    } else {
      const reasons = [];
      if (summary.accuracy < state.settings.accuracyTarget) {
        reasons.push(`notes ${Math.round(summary.accuracy)}%`);
      }
      if (currentMidiInputId !== virtualKeyboardInputId) {
        if (summary.onsetAccuracy < 60) {
          reasons.push(`onset ${Math.round(summary.onsetAccuracy)}%`);
        }
        if (summary.pressureAccuracy < 40) {
          reasons.push(`pressure ${Math.round(summary.pressureAccuracy)}%`);
        }
        if (summary.releaseAccuracy < 40) {
          reasons.push(`release ${Math.round(summary.releaseAccuracy)}%`);
        }
      }
      const hintPreview = (summary.noteHints || []).filter(Boolean).slice(0, 2).join(" | ");
      const reasonText = reasons.length ? reasons.join(", ") : "step hints";
      updatePracticeFeedback(`Will repeat next bar. Issue: ${reasonText}${hintPreview ? ` (${hintPreview})` : ""}`, "bad");
      if (summary.mistakes >= 1) {
        state.dynamicTempoRatio = Math.max(0.25, state.dynamicTempoRatio * 0.85);
      }
      await wait(200);
    }
  }

  if (lastSummary) {
    updateSpacedRepetition(lesson.id, lastSummary);
  }

  state.isLessonRunning = false;
};

const nextLesson = async (noIncrement = false) => {
  if (state.isLessonRunning) {
    return;
  }
  const lesson = pickNextLesson(noIncrement);
  await runLesson(lesson);
};

const setActiveScreen = (screen) => {
  [state.refs.homeScreen, state.refs.practiceScreen, state.refs.statsScreen].forEach((s) => s.classList.remove("active"));
  screen.classList.add("active");

  if (screen === state.refs.practiceScreen) {
    document.body.classList.add("training-active");
  } else {
    document.body.classList.remove("training-active");
  }
};

const renderMidiInputOptions = () => {
  const select = state.refs?.midiInputSelect;
  if (!select) {
    return;
  }
  select.innerHTML = "";
  const keyboardOption = document.createElement("option");
  keyboardOption.value = virtualKeyboardInputId;
  keyboardOption.textContent = "Computer Keyboard (F/J=correct, G/H=wrong)";
  select.appendChild(keyboardOption);

  if (midiAccessRef) {
    midiAccessRef.inputs.forEach((input) => {
      const option = document.createElement("option");
      option.value = input.id;
      option.textContent = input.name || `MIDI Input ${input.id}`;
      select.appendChild(option);
    });
  }

  if (!currentMidiInputId) {
    currentMidiInputId = virtualKeyboardInputId;
  }
  select.value = currentMidiInputId;
};

const renderLessonPacks = () => {
  state.refs.lessonPackList.innerHTML = "";
  lessonPacks.forEach((pack) => {
    const card = document.createElement("div");
    card.className = "pack-card";
    const title = document.createElement("div");
    title.textContent = pack.title;
    const desc = document.createElement("div");
    desc.textContent = pack.description;
    const button = document.createElement("button");
    button.textContent = state.currentPackId === pack.id ? "Selected" : "Select";
    button.disabled = state.currentPackId === pack.id;
    button.addEventListener("click", () => {
      state.currentPackId = pack.id;
      state.currentLessonIndex = 0;
      writeToStorage("pack-id", state.currentPackId);
      state.refs.currentPackLabel.textContent = `Pack: ${pack.title}`;
      renderLessonPacks();
      renderStats();
    });
    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(button);
    state.refs.lessonPackList.appendChild(card);
  });
};

const applyShowPiano = () => {
  state.refs.pianoKeysContainer.style.display = state.settings.showPiano ? "flex" : "none";
  state.refs.practiceScreen.classList.toggle("with-piano", !!state.settings.showPiano);
};

const syncSettingsToUI = () => {
  state.refs.practiceMode.value = state.settings.practiceMode;
  state.refs.visualMode.value = state.settings.visualMode;
  state.refs.playInputSoundToggle.checked = !!state.settings.playInputSound;
  state.refs.accuracyTarget.value = state.settings.accuracyTarget;
  state.refs.timingWindow.value = state.settings.timingWindow;
  state.refs.releaseWindow.value = state.settings.releaseWindow;
  state.refs.tempoRatio.value = state.settings.tempoRatio;
  state.refs.tempoRatioValue.textContent = `${Number(state.settings.tempoRatio).toFixed(2)}x`;
  state.refs.majmin.value = state.settings.selectedMode;
  state.refs.showPianoToggle.checked = state.settings.showPiano;
  applyShowPiano();
  applyVisualMode();
};

const formatLogTime = (timestamp) => {
  try {
    return new Date(timestamp).toLocaleTimeString();
  } catch (error) {
    return "--:--:--";
  }
};

const renderLogsPanel = () => {
  if (!state.refs.logsOutput || !state.refs.logsMeta) {
    return;
  }
  const logs = getCapturedLogs();
  state.refs.logsMeta.textContent = `${logs.length} events captured`;
  if (!logs.length) {
    state.refs.logsOutput.textContent = "No logs yet";
    return;
  }

  const content = logs
    .map((entry) => `[${formatLogTime(entry.ts)}] [${entry.type}] ${entry.message}`)
    .join("\n\n");
  state.refs.logsOutput.textContent = content;
  state.refs.logsOutput.scrollTop = state.refs.logsOutput.scrollHeight;
};

const main = async () => {
  initLogCapture({ maxEntries: 1200 });
  setupDebugOverlay();
  await setupMidiAccess();
  setupComputerKeyboardInput();

  state.settings = loadSettings();
  state.currentPackId = readFromStorage("pack-id") || state.currentPackId;

  state.refs = {
    startButton: document.getElementById("startButton"),
    homeScreen: document.getElementById("homeScreen"),
    practiceScreen: document.getElementById("practiceScreen"),
    statsScreen: document.getElementById("statsScreen"),
    backFromStats: document.getElementById("backFromStats"),
    pauseOverlay: document.getElementById("pauseOverlay"),
    resumeTrainingButton: document.getElementById("resumeTrainingButton"),
    stopTrainingButton: document.getElementById("stopTrainingButton"),
    lessonMenuButton: document.getElementById("lessonMenuButton"),
    settingsButton: document.getElementById("settingsButton"),
    lessonMenu: document.getElementById("lessonMenu"),
    settingsPanel: document.getElementById("settingsPanel"),
    logsPanel: document.getElementById("logsPanel"),
    sheetBackdrop: document.getElementById("sheetBackdrop"),
    closeLessonMenu: document.getElementById("closeLessonMenu"),
    closeSettings: document.getElementById("closeSettings"),
    closeLogs: document.getElementById("closeLogs"),
    lessonPackList: document.getElementById("lessonPackList"),
    currentPackLabel: document.getElementById("currentPackLabel"),
    lessonTitle: document.getElementById("lessonTitle"),
    practiceMode: document.getElementById("practiceMode"),
    visualMode: document.getElementById("visualMode"),
    accuracyTarget: document.getElementById("accuracyTarget"),
    timingWindow: document.getElementById("timingWindow"),
    releaseWindow: document.getElementById("releaseWindow"),
    midiInputSelect: document.getElementById("midiInputSelect"),
    playInputSoundToggle: document.getElementById("playInputSoundToggle"),
    allKeys: document.getElementById("allKeys"),
    majmin: document.getElementById("majmin"),
    showPianoToggle: document.getElementById("showPianoToggle"),
    nextButton: document.getElementById("nextButton"),
    startMetronome: document.getElementById("startMetronome"),
    showStatsButton: document.getElementById("showStatsButton"),
    showLogsButton: document.getElementById("showLogsButton"),
    refreshLogsButton: document.getElementById("refreshLogsButton"),
    clearLogsButton: document.getElementById("clearLogsButton"),
    copyLogsButton: document.getElementById("copyLogsButton"),
    logsOutput: document.getElementById("logsOutput"),
    logsMeta: document.getElementById("logsMeta"),
    statsList: document.getElementById("statsList"),
    playFeedback: document.getElementById("playFeedback"),
    tempoDot: document.getElementById("tempoDot"),
    tempoLabel: document.getElementById("tempoLabel"),
    tempoRatio: document.getElementById("tempoRatio"),
    tempoRatioValue: document.getElementById("tempoRatioValue"),
    pianoKeysContainer: document.getElementById("pianoKeysContainer"),
    scoreViewport: document.getElementById("scoreViewport"),
    pianoRollViewport: document.getElementById("pianoRollViewport"),
    pianoRollExpected: document.getElementById("pianoRollExpected"),
    pianoRollPlayed: document.getElementById("pianoRollPlayed"),
  };

  allNotes.forEach((note) => {
    const option = document.createElement("option");
    option.value = note;
    option.textContent = note;
    state.refs.allKeys.appendChild(option);
  });

  if (allNotes.includes(state.settings.selectedKey)) {
    state.refs.allKeys.value = state.settings.selectedKey;
  }

  const showSheet = (sheet) => {
    sheet.classList.remove("hidden");
    sheet.classList.add("visible");
    state.refs.sheetBackdrop.classList.remove("hidden");
    state.refs.sheetBackdrop.classList.add("visible");
  };

  const openMenuSheet = () => showSheet(state.refs.settingsPanel);
  const openLessonsSheet = () => showSheet(state.refs.lessonMenu);

  const hideAllSheets = () => {
    [state.refs.lessonMenu, state.refs.settingsPanel, state.refs.logsPanel].forEach((sheet) => {
      sheet.classList.remove("visible");
      sheet.classList.add("hidden");
    });
    state.refs.sheetBackdrop.classList.remove("visible");
    state.refs.sheetBackdrop.classList.add("hidden");
  };

  renderMidiInputOptions();
  syncSettingsToUI();
  renderLessonPacks();
  renderStats();

  const pack = getPackById(state.currentPackId);
  if (pack) {
    state.refs.currentPackLabel.textContent = `Pack: ${pack.title}`;
  }

  state.refs.startButton.addEventListener("click", async () => {
    state.isPracticeActive = true;
    await requestWakeLock();
    setActiveScreen(state.refs.practiceScreen);
    await nextLesson(true);
  });

  state.refs.nextButton.addEventListener("click", async () => {
    await nextLesson();
  });

  state.refs.lessonMenuButton.addEventListener("click", () => openLessonsSheet());
  state.refs.settingsButton.addEventListener("click", () => openMenuSheet());
  state.refs.closeLessonMenu.addEventListener("click", hideAllSheets);
  state.refs.closeSettings.addEventListener("click", hideAllSheets);
  state.refs.closeLogs.addEventListener("click", hideAllSheets);
  state.refs.sheetBackdrop.addEventListener("click", hideAllSheets);

  state.refs.practiceMode.addEventListener("change", (event) => {
    state.settings.practiceMode = event.target.value;
    saveSettings(state.settings);
  });

  state.refs.visualMode.addEventListener("change", (event) => {
    state.settings.visualMode = event.target.value;
    applyVisualMode();
    saveSettings(state.settings);
  });

  state.refs.accuracyTarget.addEventListener("change", (event) => {
    state.settings.accuracyTarget = Number(event.target.value) || defaultSettings.accuracyTarget;
    saveSettings(state.settings);
  });

  state.refs.timingWindow.addEventListener("change", (event) => {
    state.settings.timingWindow = Number(event.target.value) || defaultSettings.timingWindow;
    saveSettings(state.settings);
  });

  state.refs.releaseWindow.addEventListener("change", (event) => {
    state.settings.releaseWindow = Number(event.target.value) || defaultSettings.releaseWindow;
    saveSettings(state.settings);
  });

  state.refs.tempoRatio.addEventListener("input", (event) => {
    state.settings.tempoRatio = Number(event.target.value);
    state.refs.tempoRatioValue.textContent = `${state.settings.tempoRatio.toFixed(2)}x`;
    saveSettings(state.settings);

    if (state.activeLesson) {
      const baseTempo = state.activeLesson.baseTempo || state.activeLesson.tempo || 60;
      updateTempoLabel(baseTempo * state.settings.tempoRatio, state.settings.tempoRatio);
    }
  });

  state.refs.allKeys.addEventListener("change", (event) => {
    state.settings.selectedKey = event.target.value;
    saveSettings(state.settings);
  });

  state.refs.majmin.addEventListener("change", (event) => {
    state.settings.selectedMode = event.target.value;
    saveSettings(state.settings);
  });

  state.refs.showPianoToggle.addEventListener("change", (event) => {
    state.settings.showPiano = event.target.checked;
    applyShowPiano();
    saveSettings(state.settings);
  });

  state.refs.midiInputSelect.addEventListener("change", (event) => {
    setActiveMidiInput(event.target.value);
  });

  state.refs.playInputSoundToggle.addEventListener("change", (event) => {
    state.settings.playInputSound = event.target.checked;
    saveSettings(state.settings);
  });

  state.refs.startMetronome.addEventListener("click", () => {
    state.metronomeEnabled = !state.metronomeEnabled;
    if (!state.metronomeEnabled) {
      state.refs.startMetronome.textContent = "Start Metronome";
      return;
    }

    if (!state.transport.running) {
      const baseTempo = state.activeLesson?.baseTempo || state.activeLesson?.tempo || 60;
      const bpm = baseTempo * (state.dynamicTempoRatio || state.settings.tempoRatio || 1);
      const beatsPerBar = getLessonBeatsPerBar(state.activeLesson);
      startTransport(bpm, beatsPerBar);
    }

    state.refs.startMetronome.textContent = "Stop Metronome";
  });

  state.refs.showStatsButton.addEventListener("click", () => {
    renderStats();
    hideAllSheets();
    setActiveScreen(state.refs.statsScreen);
  });

  state.refs.showLogsButton.addEventListener("click", () => {
    renderLogsPanel();
    showSheet(state.refs.logsPanel);
  });

  state.refs.refreshLogsButton.addEventListener("click", () => {
    renderLogsPanel();
  });

  state.refs.clearLogsButton.addEventListener("click", () => {
    clearCapturedLogs();
    renderLogsPanel();
  });

  state.refs.copyLogsButton.addEventListener("click", async () => {
    const text = state.refs.logsOutput?.textContent || "";
    if (!text || text === "No logs yet") {
      updatePracticeFeedback("No logs to copy", "neutral");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      updatePracticeFeedback("Logs copied", "good");
    } catch (error) {
      updatePracticeFeedback("Copy failed (browser blocked clipboard)", "bad");
      console.error("Copy logs failed", error);
    }
  });

  state.refs.backFromStats.addEventListener("click", () => {
    setActiveScreen(state.isPracticeActive ? state.refs.practiceScreen : state.refs.homeScreen);
  });

  state.refs.resumeTrainingButton.addEventListener("click", () => resumeTraining());
  state.refs.stopTrainingButton.addEventListener("click", () => stopTraining());

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      togglePauseTraining();
    }
  });

  state.refs.practiceScreen.addEventListener(
    "touchstart",
    (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch) {
        return;
      }
      state.swipeStartX = touch.clientX;
      state.swipeStartY = touch.clientY;
    },
    { passive: true }
  );

  state.refs.practiceScreen.addEventListener(
    "touchend",
    (event) => {
      const touch = event.changedTouches?.[0];
      if (!touch || state.swipeStartX == null || state.swipeStartY == null || !state.isPracticeActive) {
        return;
      }

      const dx = touch.clientX - state.swipeStartX;
      const dy = touch.clientY - state.swipeStartY;
      state.swipeStartX = null;
      state.swipeStartY = null;

      const targetEl = event.target;
      if (targetEl?.closest?.("button, input, select, option, label")) {
        return;
      }

      const isHorizontalSwipe = Math.abs(dx) >= 70 && Math.abs(dx) > Math.abs(dy);

      if (!isHorizontalSwipe) {
        togglePauseTraining();
        return;
      }

      if (dx > 0) {
        openMenuSheet();
      } else {
        openLessonsSheet();
      }
    },
    { passive: true }
  );

  const piano = document.createElement("custom-piano-keys");
  piano.setAttribute("id", "pianoKeys");
  piano.setAttribute("oct-count", 5);
  piano.setAttribute("height", 50);
  state.refs.pianoKeysContainer.appendChild(piano);
  applyShowPiano();

  const initialTempo = 60;
  ensureWakeLockListener();
  updateTempoLabel(initialTempo, state.settings.tempoRatio || 1);
  startTransport(initialTempo);
};

document.addEventListener("DOMContentLoaded", main);
