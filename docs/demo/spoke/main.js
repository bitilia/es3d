import { createStage } from '../stage.js';
import { bikeScene, paints } from './scene.js';

const hint = document.querySelector('#hint');
const row = document.querySelector('#paints');
let paint = 'signal';

const stage = await createStage(document.querySelector('#view'), {
  playing: true,
  orbitSpeed: 0.16,
});
hint.textContent = `${stage.kind === 'webgpu' ? 'WebGPU' : 'WebGL2'} · drag to turn · scroll out for a simpler wheel`;
stage.show(bikeScene(paint));

// The tour below: the same bicycle with a camera that follows page scroll.
const tour = await createStage(document.querySelector('#tour-view'), {
  playing: true,
  scroll: document.querySelector('#tour'),
});
tour.show(bikeScene(paint, { tour: true }));

for (const p of paints) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'paint';
  b.style.setProperty('--swatch', p.swatch);
  b.setAttribute('aria-pressed', p.id === paint ? 'true' : 'false');
  const dot = document.createElement('i');
  b.append(dot, document.createTextNode(p.name));
  b.addEventListener('click', () => {
    paint = p.id;
    for (const el of row.children) el.setAttribute('aria-pressed', el === b ? 'true' : 'false');
    stage.show(bikeScene(paint), { keepCamera: true, time: stage.time });
    tour.show(bikeScene(paint, { tour: true }), { time: tour.time });
  });
  row.append(b);
}
