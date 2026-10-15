import { createStage } from '../stage.js';
import { villageScene } from './scene.js';
import { writeHandoff } from '../../site/handoff.js';

const source = villageScene({ tour: true });
const bar = document.querySelector('#progress');

const fill = (name, text) => {
  for (const el of document.querySelectorAll(`[data-stat="${name}"]`)) el.textContent = text;
};

let shownProgress = -1;
let shownTriangles = -1;
const stage = await createStage(document.querySelector('#view'), {
  playing: true,
  scroll: document.querySelector('#tour'),
  onFrame(dt, s) {
    // the page only changes when the numbers do, not every frame
    if (s.progress !== shownProgress) {
      shownProgress = s.progress;
      bar.style.transform = `scaleX(${shownProgress})`;
    }
    const tris = s.renderer.stats.triangles || 0;
    if (shownProgress > 0.9 && tris !== shownTriangles) {
      shownTriangles = tris;
      fill('triangles', tris.toLocaleString('en-US'));
    }
  },
});

// file sizes are in the HTML (docs/site/sizes.json); only the live counts are filled in here
const result = stage.show(source);
if (result.ok) fill('instances', result.scene.count.toLocaleString('en-US'));

document.querySelector('#open-studio').addEventListener('click', () => {
  // Studio opens the handed-over document; without storage, fall back to an empty Studio
  const ok = writeHandoff('ashby.es3d', source);
  location.href = ok ? '../../studio/?handoff' : '../../studio/';
});
