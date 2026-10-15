import { createStage } from './stage.js';
import { villageScene } from './ashby/scene.js';
import { giftScene, loadGift } from './parcel/scene.js';
import { bikeScene } from './spoke/scene.js';
import { roomScene } from './helio/scene.js';

// The size lines are in the HTML already (docs/site/sizes.json); this only draws the previews.
const jobs = [
  ['#ashby-view', villageScene(), { playing: true, orbitSpeed: 0.06 }],
  ['#parcel-view', loadGift().then((models) => giftScene('red', models)), { playing: false, orbitSpeed: 0.18 }],
  ['#spoke-view', bikeScene('signal'), { playing: true, orbitSpeed: 0.15 }],
  ['#helio-view', roomScene('brass'), { playing: true, orbitSpeed: 0.12 }],
];

for (const [sel, source, opts] of jobs) {
  const canvas = document.querySelector(sel);
  Promise.all([createStage(canvas, { ...opts, interactive: false }), Promise.resolve(source)])
    .then(([stage, doc]) => stage.show(doc))
    .catch((err) => console.error(err));
}
