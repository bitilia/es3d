import { createStage } from '../stage.js';
import { giftScene, loadGift, wraps, LID_DUR } from './scene.js';

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const detail = document.querySelector('#detail');
const toggle = document.querySelector('#toggle');
const swatches = document.querySelector('#swatches');
const hint = document.querySelector('#hint');

let wrap = 'red';
let mode = 'closed';

const view = document.querySelector('.view');
const stage = await createStage(document.querySelector('#view'), {
  playing: false,
  orbitSpeed: 0.2,
  onPick(hit) {
    if (hit && hit.names.includes('box')) setMode(mode === 'open' || mode === 'opening' ? 'closing' : 'opening');
  },
  onFrame(dt) {
    // the button already says what the next click does, so the DOM changes only on clicks
    if (mode === 'opening') {
      stage.time = Math.min(LID_DUR, stage.time + dt);
      if (stage.time >= LID_DUR - 1e-3) mode = 'open';
    } else if (mode === 'closing') {
      stage.time = Math.max(0, stage.time - dt);
      if (stage.time <= 1e-3) mode = 'closed';
    }
  },
});

hint.textContent = `${stage.kind === 'webgpu' ? 'WebGPU' : 'WebGL2'} · drag to turn · scroll to zoom · click the box`;
const models = await loadGift();
showWrap(false);

function paintToggle() {
  const open = mode === 'open' || mode === 'opening';
  toggle.textContent = open ? 'Close the box' : 'Open the box';
  toggle.setAttribute('aria-pressed', open ? 'true' : 'false');
}

function setMode(next) {
  if (reduced) {
    mode = next === 'opening' || next === 'open' ? 'open' : 'closed';
    stage.time = mode === 'open' ? LID_DUR : 0;
  } else {
    mode = next;
  }
  paintToggle();
}

toggle.addEventListener('click', () => {
  setMode(mode === 'open' || mode === 'opening' ? 'closing' : 'opening');
});

for (const w of wraps) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'swatch';
  b.style.setProperty('--swatch', w.swatch);
  b.style.setProperty('--ribbon', w.ribbon);
  b.title = w.name;
  b.setAttribute('aria-label', w.name);
  b.setAttribute('aria-pressed', w.id === wrap ? 'true' : 'false');
  b.addEventListener('click', () => {
    wrap = w.id;
    for (const el of swatches.children) el.setAttribute('aria-pressed', el === b ? 'true' : 'false');
    showWrap(true);
  });
  swatches.append(b);
}

function showWrap(keepCamera) {
  const w = wraps.find((x) => x.id === wrap) || wraps[0];
  detail.textContent = w.detail;
  view.style.background = w.background;
  stage.show(giftScene(wrap, models), keepCamera ? { keepCamera: true, time: stage.time } : undefined);
}

paintToggle();
