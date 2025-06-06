import { setupDebugOverlay, writeToStorage, readFromStorage } from "./utils.js";
import { draw } from "./render.js";
import { generateScale, getNoteIndex, getNote, getNoteName, allNotes } from "./scales.js";
import { lessons } from "./lessons.js";

const range = (end, start) => {
  if (start === undefined) {
    start = 0;
  }
  return Array.from({ length: end - start }, (_, i) => i + start);
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const doMeasure = async (measure, desc, degrees, fingerings) => {
  const key = document.getElementById("allKeys").value;
  const major = document.getElementById("majmin").value === "major";
  const [scale, scaleName] = generateScale(key, major ? "major" : "minor");

  let degreesTr = degrees.map((f) => f);
  const notes = (v, b) => degreesTr.map((i, index) => getNote(i+1, scale, scaleName, b, 16) + `[id="n${v}${index + 1}"]`).join(", ");

  if (desc) {
    degreesTr = degrees.map((f) => 5 - f);
  }
  degreesTr = degreesTr.map((f) => f + measure - 1);
  let highlightedNote = -1;
  let activeNotes = new Set();

  const moveNoteForward = (resolve, notes) => {
    highlightedNote++;
    if (highlightedNote >= degreesTr.length) {
      highlightedNote = -1;
      resolve();
      return;
    }
    draw(scaleName, [notes("t", 3), notes("b", 2)], fingerings, highlightedNote);
    let k = document.getElementById("pianoKeys");
    let index = getNoteIndex(getNoteName(degreesTr[highlightedNote]+1, scale, scaleName));
    let octave = Math.floor((degreesTr[highlightedNote]+1)/7);
    k.setAttribute("marked-keys", `${index + octave *12 + 1} ${index+ octave *12 + 13}`);

    activeNotes.clear();
  };
  try {
    const midiAccess = await navigator.requestMIDIAccess();

    return new Promise((resolve) => {
      // wait(500).then(resolve)
      document.getElementById("output").addEventListener(
        "click",
        () => {
          resolve();
        },
        { once: true }
      );
      document.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        moveNoteForward(resolve, notes);
      });
      const onMidiMessage = (message) => {
        const [status, note, velocity] = message.data;

        if (status === 144 && velocity > 0) {
          // Note On
          activeNotes.add(note);
        } else if (status === 128 || (status === 144 && velocity === 0)) {
          // Note Off
          activeNotes.delete(note);
        } else {
            return;
        }
        
        const trebleNote = getNote(degrees[highlightedNote], scale, scaleName, 4, 16);
        const bassNote = getNote(degrees[highlightedNote], scale, scaleName, 3, 16);
        
        console.log("Active Notes:", activeNotes, "Treble Note:", trebleNote, "Bass Note:", bassNote, "Message" ,message.data);
        if (activeNotes.has(trebleNote) && activeNotes.has(bassNote)) {
          moveNoteForward();
        }
      };

      midiAccess.inputs.forEach((input) => input.addEventListener("midimessage", onMidiMessage));

      //draw(scaleName, [notes("t", 3), notes("b", 2)], fingerings, highlightedNote);
      moveNoteForward(resolve, notes);
    });
  } catch (error) {
    console.error("Error during MIDI access:", error);
    alert("MIDI access failed. Please ensure your MIDI device is connected.");
    return;
  }
};

const doLesson = async (measure, degrees, fingerings) => {
  const getContext = () => {
    const key = document.getElementById("allKeys").value;
    const major = document.getElementById("majmin").value === "major";
    const lessonIndex = currentLessonIndex;
    return {
      key,
      major,
      lessonIndex,
    };
  };
  const con = getContext();

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
  for (let [measure, desc] of measures) {
    const currentContext = getContext();
    if (currentContext.key !== con.key || currentContext.major !== con.major || currentContext.lessonIndex !== con.lessonIndex) {
      break;
    }
    await doMeasure(measure, desc, degrees, fingerings);
  }
};
var currentLessonIndex = 0;



function beep(duration, attack, release, frequency) {
  const audioContext = new (window.AudioContext || window.webkitAudioContext)();

  // 1. Create a buffer of white noise.
  const bufferSize = (audioContext.sampleRate * duration) / 1000; // Duration in seconds
  const noiseBuffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
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
  gainNode.gain.linearRampToValueAtTime(0.2, audioContext.currentTime + attack / 1000); // Attack
  gainNode.gain.linearRampToValueAtTime(0, audioContext.currentTime + (duration + attack) / 1000); // Release

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
  next();
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

  const keysSelect = document.getElementById("allKeys");
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

  document.getElementById("majmin").addEventListener("change", () => next(true));
  document.getElementById("allKeys").addEventListener("change", () => next(true));
  document.getElementById("nextButton").addEventListener("click", () => next());

  document.getElementById("showKeys").addEventListener("click", () => {
    const pianoKeysContainer = document.getElementById("pianoKeysContainer");
    if (!pianoKeysContainer.style.display || pianoKeysContainer.style.display === "none") {
      pianoKeysContainer.style.display = "flex";
      document.getElementById("showKeys").textContent = "Hide Hide";
    } else {
      pianoKeysContainer.style.display = "none";
      document.getElementById("showKeys").textContent = "Show Piano";
    }
  });

  var pianokeys = document.createElement("custom-piano-keys");
  pianokeys.setAttribute("id", "pianoKeys");
  pianokeys.setAttribute("oct-count", 5);
  pianokeys.setAttribute("height", 50);

  document.getElementById("pianoKeysContainer").appendChild(pianokeys);
  
//   document.getElementById("pianoKeysContainer").style.display = "flex";
//   document.getElementById("allKeys").value = "G" //TODO: it doesn't work for other keys than C

  next(true);
};

document.addEventListener("DOMContentLoaded", main);
