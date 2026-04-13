const { Factory, EasyScore, System, Registry } = Vex.Flow;
const VF = Vex.Flow;


const draw = (scaleName, notes, fingerings, hl, currentStepState = "pending", noteStates = [], noteHints = [])=> {

    // console.log("Drawing scale:", scaleName, notes, fingerings, hl);
    document.getElementById("output").innerHTML = ""
    const signture = "2/4"

    const registry = new Registry();
    Registry.enableDefaultRegistry(registry);
    const id = (id) => registry.getElementById(id);
    const concat = (a, b) => a.concat(b);

    let firstSystem = true;
    let x = 110;
    let y = 20;
    let initWidth = 350

    const vf = new Factory({
    renderer: { elementId: 'output', width: 550, height: 300 },
    });

    
  

    function appendSystem(width) {
        if(firstSystem) {
            firstSystem = false;
            x += width;
        }
      const system = vf.System({ x, y, width, spaceBetweenStaves: 10 });
      x += width;
      return system;
    }

    const score = vf.EasyScore({ throwOnError: true });
    score.set({ time: '2/4'});
    let system = vf.System({x,y,width:initWidth, spaceBetweenStaves: 10});

    const trebleVoice = score.voice(score.beam(score.notes(notes[0], {stem: 'up'})));
    const bassVoice = score.voice(score.beam(score.notes(notes[1], {stem: 'down', clef: 'bass'})));

    trebleVoice.setStrict(false);
    bassVoice.setStrict(false);

    system.addStave({
        voices: [trebleVoice]
      }).addClef('treble').addKeySignature(scaleName).addTimeSignature(signture)
      
      system.addStave({
        voices: [bassVoice]
      }).addClef('bass').addKeySignature(scaleName).addTimeSignature(signture);
      
      system.addConnector('brace');
  system.addConnector('singleRight');
  system.addConnector('singleLeft');

  fingerings.forEach((fingering, i) => {
    const noteId = `nt${i+1}`;
    const bassId = `nb${i+1}`;
    
    if(!id(noteId)) {
        console.error(`Note ID or Bass ID is undefined for index ${noteId}`);
        return;
    }
    id(noteId).addModifier(0, vf.Fingering({ number: fingering, position: 'above' }));
    id(bassId).addModifier(0, vf.Fingering({ number: 6-fingering, position: 'below' }));

    const hintText = noteHints[i];
    if (hintText) {
      const annotation = new VF.Annotation(hintText)
        .setVerticalJustification(VF.Annotation.VerticalJustify.TOP)
        .setFont("Arial", 12, "normal");
      id(noteId).addModifier(0, annotation);
    }

    const state = noteStates[i];
    if (state === "correct") {
      id(noteId).setStyle({ fillStyle: "green", strokeStyle: "green" });
      id(bassId).setStyle({ fillStyle: "green", strokeStyle: "green" });
    }
    if (state === "wrong") {
      id(noteId).setStyle({ fillStyle: "red", strokeStyle: "red" });
      id(bassId).setStyle({ fillStyle: "red", strokeStyle: "red" });
    }
  })

  if(hl!=null){
  let color = "blue";
  if (currentStepState === "correct") {
    color = "green";
  } else if (currentStepState === "wrong") {
    color = "red";
  }
  id(`nt${hl+1}`).setStyle({fillStyle: color, strokeStyle: color})
  id(`nb${hl+1}`).setStyle({fillStyle: color, strokeStyle: color})
  }
//   console.log(id('n1'));
//    id('nb1').addModifier(0,vf.Fingering({ number: '5', position: 'above' }))
//    id('nt1').setStyle({fillStyle: "blue", strokeStyle: "blue"});

    //   system = appendSystem(stave.width)

      

    //   system.addStave({
    //     voices: [
    //         //score.voice(score.beam(score.notes(notes, {stem: 'up'})))
    //         score.voice([score.beam(score.notes(notes, {stem: 'up'})),score.beam(score.notes(notes, {stem: 'up'}))].reduce(concat))
    //     ]
    //   })
      
    //   system.addStave({
    //     voices: [
    //       score.voice(score.notes('C2/4, C2/4', {clef: 'bass', stem: 'down'})),
    //       //score.voice([score.beam(score.notes(notes, {stem: 'up'})),score.beam(score.notes(notes, {stem: 'up'}))].reduce(concat))
    //     ]
    //   })
      
    //   system.addConnector('singleRight');

    vf.draw();
}

export { draw };