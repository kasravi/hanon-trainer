const scales = {
    major: "W-W-H-W-W-W-H",
    minor: "W-H-W-W-H-W-W",
    chromatic: "W-H-W-H-W-H-W-H-W-H-W-H",
    pentatonic: "W-W-WH-W-WH",
    blues: "W-H-W-H-WH-WH",
    melodicMinor: "W-H-W-W-W-H-W",
    harmonicMinor: "W-H-W-W-H-WH-H",
    melodicMinorAscending: "W-H-W-W-W-W-H",
    melodicMinorDescending: "W-W-H-W-W-H-W",
}

const notesWA = ['C', 'C#/Db', 'D', 'D#/Eb', 'E', 'F', 'F#/Gb', 'G', 'G#/Ab', 'A', 'A#/Bb', 'B'];
const notes = ['C', 'C/D', 'D', 'D/E', 'E', 'F', 'F/G', 'G', 'G/A', 'A', 'A/B', 'B'];
const allNotes = ['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const intervals = {
    W: 2,
    H: 1,
    WH: 3,
};

const flatSclaes = [ 'F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb',
    "Dm", "Gm", "Cm", "Fm", "Bbm", "Ebm"];
function generateScale(root, scaleType) {
    if (!scales[scaleType]) {
        throw new Error(`Scale type "${scaleType}" is not defined.`);
    }

    const pattern = scales[scaleType].split("-");
    const scale = [];
    let currentNoteIndex = notesWA.findIndex(f=>f.includes(root));

    if (currentNoteIndex === -1) {
        throw new Error(`Root note "${root}" is not a valid note.`);
    }

    scale.push(notes[currentNoteIndex]);

    for (const interval of pattern) {
        const step = intervals[interval];
        currentNoteIndex = (currentNoteIndex + step) % notes.length;
        scale.push(notes[currentNoteIndex]);
    }

    let scaleName;
    if (scaleType === 'major') {
        scaleName = root;
    } else if (scaleType === 'minor') {
        scaleName = `${root}m`;
    } else {
        scaleName = null;
    }

    return [scale, scaleName];
}

function generateScaleFromDegree(degree=0, scaleType='major') {
    return generateScale(notes[degree % notes.length], scaleType);

}


function getNoteName(degree, scale, scaleName){
    degree = ((degree + 8*(scale.length - 1)) % (scale.length - 1));
    
    let note = scale[degree];

    if (note.includes('/')) {
        if(flatSclaes.includes(scaleName)) {
            return note.split('/')[1];
        }
        return note.split('/')[0];
    }

    return note;
}

function getNote(degree, scale,scaleName, octave, duration = '4') {
    octave += Math.floor(degree / (scale.length-1));
    const noteName = getNoteName(degree, scale, scaleName);
    return `${noteName}${octave}/${duration}`;
}

export {
    generateScale,
    generateScaleFromDegree,
    getNote,
    getNoteName,
    scales,
    notes,
    allNotes
};