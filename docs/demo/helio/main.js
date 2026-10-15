import { createStage } from '../stage.js';
import { roomScene, lamps, metals } from './scene.js';

const blurb = document.querySelector('#blurb');
const lampRow = document.querySelector('#lamps');
const finishRow = document.querySelector('#finishes');
const hint = document.querySelector('#hint');

let metal = 'brass';
let lamp = 'all';
let follow = false;
let goal = lamps[0];

const stage = await createStage(document.querySelector('#view'), {
  playing: true,
  autoOrbit: false,
  onInteract() {
    follow = false;
  },
  onPick(hit) {
    const id = hit && lamps.some((l) => l.id === hit.names[0]) ? hit.names[0] : 'all';
    select(id);
  },
  onFrame(dt) {
    if (!follow) return;
    const k = 1 - Math.exp(-dt * 3.2);
    const c = stage.camera;
    for (let i = 0; i < 3; i++) {
      c.position[i] += (goal.position[i] - c.position[i]) * k;
      c.target[i] += (goal.target[i] - c.target[i]) * k;
    }
    c.fov += (goal.fov - c.fov) * k;
  },
});

hint.textContent = `${stage.kind === 'webgpu' ? 'WebGPU' : 'WebGL2'} · drag to look · click a lamp`;
stage.show(roomScene(metal));

function select(id) {
  lamp = id;
  goal = lamps.find((l) => l.id === id) || lamps[0];
  follow = true;
  blurb.textContent = goal.text;
  for (const el of lampRow.children) el.setAttribute('aria-pressed', el.dataset.id === id ? 'true' : 'false');
}

for (const l of lamps) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'lamp';
  b.dataset.id = l.id;
  b.textContent = l.name;
  b.setAttribute('aria-pressed', l.id === lamp ? 'true' : 'false');
  b.addEventListener('click', () => select(l.id));
  lampRow.append(b);
}

for (const m of metals) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'finish';
  b.textContent = m.name;
  b.setAttribute('aria-pressed', m.id === metal ? 'true' : 'false');
  b.addEventListener('click', () => {
    metal = m.id;
    for (const el of finishRow.children) el.setAttribute('aria-pressed', el === b ? 'true' : 'false');
    stage.show(roomScene(metal), { keepCamera: true, time: stage.time });
  });
  finishRow.append(b);
}
