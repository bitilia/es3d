// The 404 page's "404", drawn by ES3D: three outlines extruded with a bevel,
// in the logo's colours, rocking gently. The text "404" is in the page until
// the renderer is ready, and stays there where it cannot start.

const DIGIT_FOUR = 'M 40 0 L 52 0 L 52 25 L 62 25 L 62 37 L 52 37 L 52 100 L 38 100 L 0 37 L 0 25 L 40 25 Z M 40 37 L 40 79 L 15 37 Z';
const DIGIT_ZERO = 'M 31 0 A 31 50 0 1 0 31 100 A 31 50 0 1 0 31 0 Z M 31 14 A 16 36 0 1 1 31 86 A 16 36 0 1 1 31 14 Z';

const SCENE = `<es3d version="1">
  <environment background="#ffffff" sky="#ffffff" ground="#f4f7f6" intensity="0.72"/>
  <camera position="0,0,330" target="0,0,0" fov="30" aspect="2.6" fit="contain"/>
  <controls mode="none"/>
  <light type="directional" direction="-0.25,-0.7,-1" intensity="1.35"/>
  <light type="directional" direction="0.45,-0.15,0.5" intensity="0.4"/>
  <group id="sign">
    <animate attr="rotation" values="-8,-14,0; -4,14,0; -8,-14,0" dur="7s" smooth="true"/>
    <group position="-109,-50,0">
      <extrude d="${DIGIT_FOUR}" fillRule="evenodd" depth="18" bevel="2.5" center="true" color="#ff751f"/>
      <extrude d="${DIGIT_ZERO}" fillRule="evenodd" depth="18" bevel="2.5" center="true" position="77,0,0" color="#004aad"/>
      <extrude d="${DIGIT_FOUR}" fillRule="evenodd" depth="18" bevel="2.5" center="true" position="156,0,0" color="#00bf63"/>
    </group>
  </group>
</es3d>`;

const box = document.querySelector('.nf-sign');
const canvas = box && box.querySelector('canvas');
if (canvas) {
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  import('../../src/render/stage.js')
    .then(({ createStage }) => createStage(canvas, { interactive: false, autoOrbit: false, playing: !reduced, geometryStore: false }))
    .then((stage) => {
      const result = stage.show(SCENE);
      if (result.ok) requestAnimationFrame(() => requestAnimationFrame(() => box.classList.add('drawn')));
    })
    .catch(() => {});
}
