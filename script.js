import { setupDebugOverlay, writeToStorage, readFromStorage } from "./utils.js";
import { draw } from "./render.js";
import {
  generateScale,
  generateScaleFromDegree,
  getNote,
  getNoteName,
  scales,
  allNotes,
} from "./scales.js";

const range = (end, start) => {
  if (start === undefined) {
    start = 0;
  }
  return Array.from({ length: end - start }, (_, i) => i + start);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const doMeasure = async (measure, desc, degrees, fingerings) => {
    const key = document.getElementById("keys").value;
    const major = document.getElementById("majmin").value === "major";
    const [scale, scaleName] = generateScale(key, major ? "major" : "minor");

    let degreesTr = degrees.map((f) => f);
    const notes = (v, b) =>
      degreesTr
        .map(
          (i, index) =>
            getNote(i, scale, scaleName, b, 16) + `[id="n${v}${index + 1}"]`
        )
        .join(", ");

    if (desc) {
      degreesTr = degrees.map((f) => 5 - f);
    }
    degreesTr = degreesTr.map((f) => f + measure - 1);

    const midiAccess = await navigator.requestMIDIAccess();
    const activeNotes = new Set();

    return new Promise((resolve) => {
        // wait(500).then(resolve)
        document.getElementById("output").addEventListener(
          "click",
          () => {
            resolve();
          },
          { once: true }
        );
        const onMidiMessage = (message) => {
          const [status, note, velocity] = message.data;

          if (status === 144 && velocity > 0) {
            // Note On
            activeNotes.add(note);
          } else if (status === 128 || (status === 144 && velocity === 0)) {
            // Note Off
            activeNotes.delete(note);
          }

          const trebleNote = getNote(
            degrees[highlightedNote],
            scale,
            scaleName,
            4,
            16
          );
          const bassNote = getNote(
            degrees[highlightedNote],
            scale,
            scaleName,
            3,
            16
          );
          if (activeNotes.has(trebleNote) && activeNotes.has(bassNote)) {
            highlightedNote++;
            if (highlightedNote >= notes.length) {
              highlightedNote = 0;
              resolve();
            }
            draw(
              scaleName,
              [notes("t", 3), notes("b", 2)],
              fingerings,
              highlightedNote
            );
            activeNotes.clear();
          }
        };

        midiAccess.inputs.forEach((input) =>
          input.addEventListener("midimessage", onMidiMessage)
        );

        const highlightedNote = 0;
        draw(
          scaleName,
          [notes("t", 3), notes("b", 2)],
          fingerings,
          highlightedNote
        );
      });
}

const doLesson = async (measure, degrees, fingerings) => {

    const getContext = ()=>{
        const key = document.getElementById("keys").value;
        const major = document.getElementById("majmin").value === "major"
        const lessonIndex = currentLessonIndex;
        return {
            key,
            major,
            lessonIndex,
        }
    }
    const con= getContext();

  const measures = range(15)
    .map((f) => [f, false])
    .concat(
      range(14, 1)
        .map((f) => [f, true])
        .reverse()
    );

    // return measures.reduce((promise, [measure, desc]) => {
    //     return promise.then(() => doMeasure(measure, desc, degrees, fingerings));
    // }, Promise.resolve());
    for(let [measure, desc] of measures) {
        const currentContext = getContext();
        if (
            currentContext.key !== con.key ||
            currentContext.major !== con.major ||
            currentContext.lessonIndex !== con.lessonIndex
        ) {
            break;
        }
        await doMeasure(measure, desc, degrees, fingerings);
    }
};
var currentLessonIndex = 0;

const lessons = [
  {
    title: "Lesson 1",
    degrees: [0, 2, 3, 4, 5, 4, 3, 2],
    fingerings: [1, 2, 3, 4, 5, 4, 3, 2],
  },
  {
    title: "Lesson 2",
    degrees: [0, 2, 5, 4, 3, 4, 3, 2],
    fingerings: [1, 2, 5, 4, 3, 4, 3, 2],
  },
  {
    title: "Lesson 3",
    degrees: [0, 2, 5, 4, 3, 2, 3, 4],
    fingerings: [1, 2, 5, 4, 3, 2, 3, 4],
  },
  {
    title: "Lesson 4",
    degrees: [0, 1, 0, 2, 5, 4, 3, 2],
    fingerings: [1, 2, 1, 2, 5, 4, 3, 2],
  },
  {
    title: "Lesson 5",
    degrees: [0, 5, 4, 5, 3, 4, 2, 3],
    fingerings: [1, 5, 4, 5, 3, 4, 2, 3],
  },
  {
    title: "Lesson 6",
    degrees: [0, 5, 4, 5, 3, 5, 2, 5],
    fingerings: [1, 5, 4, 5, 3, 5, 2, 5],
  },
  {
    title: "Lesson 7",
    degrees: [0, 2, 1, 3, 2, 4, 3, 2],
    fingerings: [1, 3, 2, 4, 3, 5, 4, 3],
  },

  {
    title: "Lesson 8",
    degrees: [0, 2, 4, 5, 3, 4, 2, 3],
    fingerings: [1, 2, 4, 5, 3, 4, 2, 3],
  },
];

function beep(duration, attack, release, frequency) {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();

  // 1. Create a buffer of white noise.
  const bufferSize = (audioContext.sampleRate * duration) / 1000; // Duration in seconds
  const noiseBuffer = audioContext.createBuffer(
    1,
    bufferSize,
    audioContext.sampleRate
  );
  const output = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    output[i] = Math.random() * 2 - 1; // Fill with random values between -1 and 1
  }

  // 2. Create a buffer source to play the noise.
  const noise = audioContext.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = false; // Important: don't loop the noise

  // 3. Create a high-pass filter.
  const highPassFilter = audioContext.createBiquadFilter();
  highPassFilter.type = "highpass";
  highPassFilter.frequency.setValueAtTime(frequency, audioContext.currentTime); // Cutoff frequency

  // 4. Create a gain node for the ASR envelope.
  const gainNode = audioContext.createGain();
  gainNode.gain.setValueAtTime(0, audioContext.currentTime); // Start at zero volume

  // 5. Connect the nodes: noise -> filter -> gain -> destination
  noise.connect(highPassFilter);
  highPassFilter.connect(gainNode);
  gainNode.connect(audioContext.destination);

  // 6. ASR envelope
  gainNode.gain.linearRampToValueAtTime(
    0.2,
    audioContext.currentTime + attack / 1000
  ); // Attack
  gainNode.gain.linearRampToValueAtTime(
    0,
    audioContext.currentTime + (duration + attack) / 1000
  ); // Release

  // 7. Start and stop the noise.
  noise.start();
  noise.stop(audioContext.currentTime + (duration + attack + release) / 1000);
}

const startMetronome = (bpm) => {
  const interval = 60000 / bpm; // Calculate interval in milliseconds
  let count = 0;

  const playTick = () => {
    if (count === 0) {
      beep(50, 10, 10, 440); // Play a tick sound
    } else {
      beep(50, 10, 10, 880); // Play a different sound for the other beats
    }
    count++;
    if (count >= 4) {
      count = 0;
    }
  };

  const metronomeInterval = setInterval(playTick, interval);

  return () => clearInterval(metronomeInterval); // Return a function to stop the metronome
};

const startLesson = async (lessonIndex) => {
  const lesson = lessons[lessonIndex];
  const { degrees, fingerings } = lesson;
  document.getElementById("lessonTitle").innerText = lesson.title;
  await doLesson(lessonIndex, degrees, fingerings);
};

var next = (no_increment = false) => {
  if (!no_increment) {
    currentLessonIndex++;
    if (currentLessonIndex >= lessons.length) {
      currentLessonIndex = 0;
    }
  }
  startLesson(currentLessonIndex);
};

const main = async () => {
  setupDebugOverlay();

  const keysSelect = document.getElementById("keys");
  allNotes.forEach((note, index) => {
    const option = document.createElement("option");
    option.value = note;
    option.textContent = note;
    keysSelect.appendChild(option);
  });

  let stopMetronome = null;
  document.getElementById("startMetronome").addEventListener("click", () => {
    if (stopMetronome) {
      stopMetronome();
      stopMetronome = null;
      document.getElementById("startMetronome").textContent = "Start Metronome";
    } else {
      const bpm = parseInt(document.getElementById("tempoInput").value, 10);
      if (isNaN(bpm) || bpm <= 0) {
        alert("Please enter a valid BPM.");
        return;
      }
      writeToStorage("bpm", bpm);
      stopMetronome = startMetronome(bpm);
      document.getElementById("startMetronome").textContent = "Stop Metronome";
    }
  });

  document
    .getElementById("majmin")
    .addEventListener("change", () => next(true));
  document.getElementById("keys").addEventListener("change", () => next(true));
  document.getElementById("nextButton").addEventListener("click", ()=>next());

  next(true);
};

document.addEventListener("DOMContentLoaded", main);
