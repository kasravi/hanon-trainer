import { setupDebugOverlay, writeToStorage, readFromStorage } from "./utils.js";
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
    beatDurationSec: 1,
    startPerfMs: 0,
    nextBeatAudioTime: 0,
    beatIndex: 0,
    schedulerId: null,
  },
  audioContext: null,
  settings: { ...defaultSettings },
  refs: {},
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseMidiMessage(message) {
  return {
    command: message.data[0] >> 4,
    channel: message.data[0] & 0xf,
    note: message.data[1],
    velocity: message.data[2] / 127,
    keyboardMeta: message.keyboardMeta || null,
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

const setMidiHandler = (handler) => {
  currentMidiHandler = handler;
};

const handleMidiMessage = (message) => {
  if (currentMidiHandler) {
    currentMidiHandler(message);
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

const attachSelectedMidiListener = () => {
  if (!midiAccessRef || currentMidiInputId === virtualKeyboardInputId) {
    return;
  }
  const input = midiAccessRef.inputs.get(currentMidiInputId);
  if (input) {
    input.onmidimessage = (msg) => handleMidiMessage(msg);
  }
};

const setActiveMidiInput = (inputId) => {
  currentMidiInputId = inputId;
  writeToStorage("midi-input-id", inputId);
  detachMidiListeners();
  attachSelectedMidiListener();
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
};

const setupComputerKeyboardInput = () => {
  document.addEventListener("keydown", (event) => {
    if (currentMidiInputId !== virtualKeyboardInputId || event.repeat) {
      return;
    }
    const key = event.key.toLowerCase();
    const config = keyboardTestMap[key];
    if (!config || activeKeyboardKeys.has(key)) {
      return;
    }
    activeKeyboardKeys.add(key);
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

const scheduleClick = (ctx, atTimeSec, accent) => {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = accent ? 880 : 660;
  gain.gain.setValueAtTime(0.0001, atTimeSec);
  gain.gain.exponentialRampToValueAtTime(0.08, atTimeSec + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, atTimeSec + 0.07);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(atTimeSec);
  osc.stop(atTimeSec + 0.08);
};

const midiToFrequency = (midiNumber) => 440 * Math.pow(2, (midiNumber - 69) / 12);

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

const startTransport = (bpm) => {
  const ctx = getAudioContext();
  stopTransport();

  const beatDurationSec = 60 / bpm;
  const startLeadSec = 0.08;

  state.transport.running = true;
  state.transport.bpm = bpm;
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
        scheduleClick(ctx, beatAudioTime, beatIndex % 4 === 0);
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

const markPianoKeys = (step) => {
  const piano = document.getElementById("pianoKeys");
  if (!piano) {
    return;
  }
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

    draw(notation.scaleName, [notation.treble, notation.bass], steps.map((s) => s.fingering), index, "pending");
    markPianoKeys(steps[index]);
    const atTimeSec = ctx.currentTime + 0.01;
    const durationSec = Math.max(0.12, (stepMs / 1000) * 0.85);
    schedulePianoNote(ctx, notation.expected[index]?.leftMidi, atTimeSec, durationSec, 0.55);
    schedulePianoNote(ctx, notation.expected[index]?.rightMidi, atTimeSec, durationSec, 0.6);
    onsetMs += stepMs;
  }
};

const runSingleStep = ({ expected, stepIndex, notation, steps, bpm, stepStart, noteStates, noteHints }) => {
  const timingWindow = Number(state.settings.timingWindow);
  const releaseWindow = Number(state.settings.releaseWindow);
  const stepMs = 60000 / bpm / 2;
  const releaseState = { left: false, right: false };

  return new Promise((resolve) => {
    const hand = { left: "pending", right: "pending" };
    let pressureHits = 0;
    let firstOnsetDeltaMs = null;
    let firstVelocity = null;
    let stepFailed = false;

    const timeoutDelay = Math.max(0, stepMs - (performance.now() - stepStart));

    const timeout = setTimeout(() => {
      setMidiHandler(null);
      const onsetDelta = firstOnsetDeltaMs ?? timeoutDelay;
      const timingBad = Math.abs(onsetDelta) > timingWindow;
      const releaseBad = !(releaseState.left && releaseState.right);
      const velocityBad = firstVelocity != null && firstVelocity < 0.35;
      const hintParts = [];

      if (timingBad) {
        hintParts.push(onsetDelta > 0 ? `⏱+${Math.round(onsetDelta)}` : `⏱${Math.round(onsetDelta)}`);
      }
      if (velocityBad) {
        hintParts.push("🔉");
      }
      if (releaseBad) {
        hintParts.push("⟂");
      }

      if (stepFailed || hand.left !== "correct" || hand.right !== "correct") {
        noteStates[stepIndex] = "wrong";
        if (!hintParts.length) {
          hintParts.push("✗note");
        }
        noteHints[stepIndex] = hintParts.join(" ");
        updatePracticeFeedback(`Step ${stepIndex + 1}: ${noteHints[stepIndex]}`, "bad");
      } else {
        noteStates[stepIndex] = "correct";
        noteHints[stepIndex] = hintParts.join(" ");
      }

      draw(
        notation.scaleName,
        [notation.treble, notation.bass],
        steps.map((s) => s.fingering),
        stepIndex,
        noteStates[stepIndex],
        noteStates,
        noteHints
      );
      resolve({
        ok: noteStates[stepIndex] === "correct" && !timingBad,
        noteHits: noteStates[stepIndex] === "correct" ? 2 : [hand.left, hand.right].filter((v) => v === "correct").length,
        noteTotal: 2,
        onsetHit: timingBad ? 0 : 1,
        pressureHit: velocityBad ? 0 : pressureHits > 0 ? 1 : 0,
        releaseHit: releaseBad ? 0 : 1,
      });
    }, timeoutDelay);

    setMidiHandler((rawMessage) => {
      const { command, note, velocity, keyboardMeta } = parseMidiMessage(rawMessage);
      if (command !== 8 && command !== 9) {
        return;
      }

      if (currentMidiInputId === virtualKeyboardInputId && keyboardMeta) {
        if (command === 9 && velocity > 0) {
          playPerformedNote(note, velocity);
          hand[keyboardMeta.hand] = keyboardMeta.verdict;
          pressureHits += 1;
          if (firstOnsetDeltaMs == null) {
            firstOnsetDeltaMs = performance.now() - stepStart;
          }
          firstVelocity = velocity;
          updatePracticeFeedback(`${keyboardMeta.hand} hand: ${keyboardMeta.verdict}`, keyboardMeta.verdict === "correct" ? "good" : "bad");
        } else {
          releaseState[keyboardMeta.hand] = true;
        }
      } else {
        const noteName = midiToNote(note, notation.scaleName);
        if (command === 9 && velocity > 0) {
          playPerformedNote(note, velocity);
          const matchedRight = noteName === expected.right;
          const matchedLeft = noteName === expected.left;
          const noteHand = note >= 60 ? "right" : "left";
          if (matchedRight) {
            hand.right = "correct";
          } else if (matchedLeft) {
            hand.left = "correct";
          } else {
            hand[noteHand] = "wrong";
          }
          pressureHits += velocity >= 0.35 ? 1 : 0;
          if (firstOnsetDeltaMs == null) {
            firstOnsetDeltaMs = performance.now() - stepStart;
          }
          firstVelocity = velocity;
          updatePracticeFeedback(`Played ${noteName}`, matchedLeft || matchedRight ? "good" : "bad");
        } else {
          const noteHand = note >= 60 ? "right" : "left";
          releaseState[noteHand] = true;
        }
      }

      if (hand.left === "wrong" || hand.right === "wrong") {
        stepFailed = true;
        noteStates[stepIndex] = "wrong";
        draw(
          notation.scaleName,
          [notation.treble, notation.bass],
          steps.map((s) => s.fingering),
          stepIndex,
          "wrong",
          noteStates,
          noteHints
        );
        return;
      }

      if (hand.left === "correct" && hand.right === "correct") {
        noteStates[stepIndex] = stepFailed ? "wrong" : "correct";
        draw(
          notation.scaleName,
          [notation.treble, notation.bass],
          steps.map((s) => s.fingering),
          stepIndex,
          noteStates[stepIndex],
          noteStates,
          noteHints
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
  const noteStates = steps.map(() => "pending");
  const noteHints = steps.map(() => "");

  for (let index = 0; index < steps.length; index++) {
    const waitMs = stepOnsetMs - performance.now();
    if (waitMs > 0) {
      await wait(waitMs);
    }

    draw(
      notation.scaleName,
      [notation.treble, notation.bass],
      steps.map((s) => s.fingering),
      index,
      "pending",
      noteStates,
      noteHints
    );
    markPianoKeys(steps[index]);
    const stepStart = performance.now();
    const result = await runSingleStep({
      expected: notation.expected[index],
      stepIndex: index,
      notation,
      steps,
      bpm,
      stepStart,
      noteStates,
      noteHints,
    });
    metrics.noteHits += result.noteHits;
    metrics.noteTotal += result.noteTotal;
    metrics.onsetHits += result.onsetHit;
    metrics.pressureHits += result.pressureHit;
    metrics.releaseHits += result.releaseHit;
    if (!result.ok) {
      metrics.mistakes += 1;
    }
    stepOnsetMs = stepStart + stepMs;
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
  let done = false;
  let lastSummary = null;
  const targetTempoRatio = state.settings.tempoRatio;
  const tempoRecoveryStep = 0.2;

  while (!done && state.isPracticeActive) {
    const baseTempo = lesson.baseTempo || lesson.tempo || 60;
    const effectiveBpm = Math.max(20, baseTempo * state.dynamicTempoRatio);
    updateTempoLabel(effectiveBpm, state.dynamicTempoRatio);
    startTransport(effectiveBpm);

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
};

const renderMidiInputOptions = () => {
  const select = state.refs.midiInputSelect;
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
};

const syncSettingsToUI = () => {
  state.refs.practiceMode.value = state.settings.practiceMode;
  state.refs.accuracyTarget.value = state.settings.accuracyTarget;
  state.refs.timingWindow.value = state.settings.timingWindow;
  state.refs.releaseWindow.value = state.settings.releaseWindow;
  state.refs.tempoRatio.value = state.settings.tempoRatio;
  state.refs.tempoRatioValue.textContent = `${Number(state.settings.tempoRatio).toFixed(2)}x`;
  state.refs.majmin.value = state.settings.selectedMode;
  state.refs.showPianoToggle.checked = state.settings.showPiano;
  applyShowPiano();
};

const main = async () => {
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
    lessonMenuButton: document.getElementById("lessonMenuButton"),
    settingsButton: document.getElementById("settingsButton"),
    lessonMenu: document.getElementById("lessonMenu"),
    settingsPanel: document.getElementById("settingsPanel"),
    sheetBackdrop: document.getElementById("sheetBackdrop"),
    closeLessonMenu: document.getElementById("closeLessonMenu"),
    closeSettings: document.getElementById("closeSettings"),
    lessonPackList: document.getElementById("lessonPackList"),
    currentPackLabel: document.getElementById("currentPackLabel"),
    lessonTitle: document.getElementById("lessonTitle"),
    practiceMode: document.getElementById("practiceMode"),
    accuracyTarget: document.getElementById("accuracyTarget"),
    timingWindow: document.getElementById("timingWindow"),
    releaseWindow: document.getElementById("releaseWindow"),
    midiInputSelect: document.getElementById("midiInputSelect"),
    allKeys: document.getElementById("allKeys"),
    majmin: document.getElementById("majmin"),
    showPianoToggle: document.getElementById("showPianoToggle"),
    nextButton: document.getElementById("nextButton"),
    startMetronome: document.getElementById("startMetronome"),
    showStatsButton: document.getElementById("showStatsButton"),
    statsList: document.getElementById("statsList"),
    playFeedback: document.getElementById("playFeedback"),
    tempoDot: document.getElementById("tempoDot"),
    tempoLabel: document.getElementById("tempoLabel"),
    tempoRatio: document.getElementById("tempoRatio"),
    tempoRatioValue: document.getElementById("tempoRatioValue"),
    pianoKeysContainer: document.getElementById("pianoKeysContainer"),
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

  const hideAllSheets = () => {
    [state.refs.lessonMenu, state.refs.settingsPanel].forEach((sheet) => {
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
    setActiveScreen(state.refs.practiceScreen);
    await nextLesson(true);
  });

  state.refs.nextButton.addEventListener("click", async () => {
    await nextLesson();
  });

  state.refs.lessonMenuButton.addEventListener("click", () => showSheet(state.refs.lessonMenu));
  state.refs.settingsButton.addEventListener("click", () => showSheet(state.refs.settingsPanel));
  state.refs.closeLessonMenu.addEventListener("click", hideAllSheets);
  state.refs.closeSettings.addEventListener("click", hideAllSheets);
  state.refs.sheetBackdrop.addEventListener("click", hideAllSheets);

  state.refs.practiceMode.addEventListener("change", (event) => {
    state.settings.practiceMode = event.target.value;
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

  state.refs.startMetronome.addEventListener("click", () => {
    state.metronomeEnabled = !state.metronomeEnabled;
    if (!state.metronomeEnabled) {
      state.refs.startMetronome.textContent = "Start Metronome";
      return;
    }

    if (!state.transport.running) {
      const baseTempo = state.activeLesson?.baseTempo || state.activeLesson?.tempo || 60;
      const bpm = baseTempo * (state.dynamicTempoRatio || state.settings.tempoRatio || 1);
      startTransport(bpm);
    }

    state.refs.startMetronome.textContent = "Stop Metronome";
  });

  state.refs.showStatsButton.addEventListener("click", () => {
    renderStats();
    hideAllSheets();
    setActiveScreen(state.refs.statsScreen);
  });

  state.refs.backFromStats.addEventListener("click", () => {
    setActiveScreen(state.isPracticeActive ? state.refs.practiceScreen : state.refs.homeScreen);
  });

  const piano = document.createElement("custom-piano-keys");
  piano.setAttribute("id", "pianoKeys");
  piano.setAttribute("oct-count", 5);
  piano.setAttribute("height", 50);
  state.refs.pianoKeysContainer.appendChild(piano);
  applyShowPiano();

  const initialTempo = 60;
  updateTempoLabel(initialTempo, state.settings.tempoRatio || 1);
  startTransport(initialTempo);
};

document.addEventListener("DOMContentLoaded", main);
