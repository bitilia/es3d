// A bicycle in one plane. Wheels sit on z = 0; the frame is offset just
// past the tyre so the tubes leave the hubs instead of piercing the rubber.
// Chainring and cog are gears at 28:14. Spokes drop out through <lod>.

export const paints = [
  { id: 'signal', name: 'Signal', swatch: '#d84a3a', color: '#d84a3a', metallic: 0, roughness: 0.34 },
  { id: 'alloy', name: 'Alloy', swatch: '#d5dbe0', color: '#d5dbe0', metallic: 1, roughness: 0.26 },
  { id: 'night', name: 'Night', swatch: '#243044', color: '#1c2433', metallic: 0.35, roughness: 0.38 },
];

const Z = 0.058;

const tube = (from, to, radius, material = 'paint') =>
  `<line from="${from}" to="${to}" radius="${radius}" material="${material}"/>`;

const wheel = `
  <group id="wheel">
    <lod distances="5.2,8">
      <group>
        <torus radius="0.48" tube="0.032" material="tire"/>
        <torus radius="0.448" tube="0.011" material="rim"/>
        <cylinder radius="0.036" height="0.14" material="hub"/>
        <repeat count="8" step="rotateY(45)">
          <cylinder radius="0.004" height="0.86" rotation="90,0,0" material="spoke"/>
        </repeat>
      </group>
      <group>
        <torus radius="0.48" tube="0.036" material="tire"/>
        <torus radius="0.446" tube="0.014" material="rim"/>
        <cylinder radius="0.04" height="0.1" material="hub"/>
      </group>
      <torus radius="0.48" tube="0.046" material="tire"/>
    </lod>
  </group>`;

// Key views of the scroll tour, reached at the progress of each stop on the page.
export const tourStops = [0, 0.34, 0.67, 1];
const TOUR_TIMES = tourStops.join(',');
const tourCamera = `
  <camera position="2.3,1.12,4.35" target="0.9,0.55,0" fov="30" aspect="1.5">
    <animate attr="position" values="2.3,1.12,4.35; 1.45,0.62,0.95; -0.55,0.98,1.05; 1.4,2.9,10.5" keyTimes="${TOUR_TIMES}" smooth="true" timeline="scroll"/>
    <animate attr="target" values="0.9,0.55,0; 0.6,0.4,0.06; 0.05,0.5,0; 0.9,0.55,0" keyTimes="${TOUR_TIMES}" smooth="true" timeline="scroll"/>
  </camera>
  <controls mode="scroll"/>`;

/**
 * @param {string} id paint
 * @param {{tour?: boolean}} [opts] tour: a camera that follows page scroll instead of an orbit view
 */
export function bikeScene(id = 'signal', { tour = false } = {}) {
  const p = paints.find((x) => x.id === id) || paints[0];
  const z = Z;
  return `<?xml version="1.0" encoding="UTF-8"?>
<es3d version="1">
  <title>Spoke ${p.name}</title>
  <environment background="#141513" sky="#d7dee8" ground="#2a2924" intensity="0.55" exposure="1.05"/>
  ${tour ? tourCamera : '<camera position="2.3,1.12,4.35" target="0.9,0.55,0" fov="30"/>\n  <controls minDistance="1.2" maxDistance="9" collide="true"/>'}
  <light type="directional" direction="-0.35,-1,-0.45" intensity="1.7" color="#fff5ec"/>
  <light type="directional" direction="0.55,-0.25,0.45" intensity="0.45" color="#c9d6ee"/>

  <material id="paint" color="${p.color}" metallic="${p.metallic}" roughness="${p.roughness}"/>
  <material id="tire" color="#1c1c1c" roughness="0.92"/>
  <material id="rim" color="#d2d7dc" metallic="1" roughness="0.24"/>
  <material id="spoke" color="#c5ccd1" metallic="1" roughness="0.3"/>
  <material id="hub" color="#8e979e" metallic="1" roughness="0.34"/>
  <material id="steel" color="#c4ccd2" metallic="1" roughness="0.28"/>
  <material id="crank" color="#2a2e32" metallic="0.8" roughness="0.4"/>
  <material id="pedal" color="#1c1c1c" roughness="0.75"/>
  <material id="saddle" color="#2a211c" roughness="0.72"/>
  <material id="grip" color="#1a1a1a" roughness="0.7"/>

  <defs>
    ${wheel}
  </defs>

  <group position="0,0.512,0">
    <animate attr="rotation" to="0,0,-360" dur="1.15s"/>
    <use ref="wheel" rotation="90,0,0"/>
  </group>
  <group position="1.82,0.512,0">
    <animate attr="rotation" to="0,0,-360" dur="1.15s"/>
    <use ref="wheel" rotation="90,0,0"/>
  </group>

  ${tube(`0,0.512,${z}`, `0.78,0.36,${z}`, 0.012)}
  ${tube(`0,0.512,${z}`, `0.46,1,${z}`, 0.011)}
  ${tube(`0.78,0.36,${z}`, `0.46,1,${z}`, 0.016)}
  ${tube(`0.78,0.36,${z}`, `1.4,0.9,${z}`, 0.016)}
  ${tube(`0.46,1,${z}`, `1.3,1.14,${z}`, 0.014)}
  ${tube(`1.4,0.9,${z}`, `1.3,1.14,${z}`, 0.016)}
  ${tube(`1.4,0.9,${z}`, `1.82,0.512,${z}`, 0.012)}
  ${tube(`0.46,1,${z}`, `0.38,1.12,${z}`, 0.012)}
  <box size="0.26,0.04,0.1" radius="0.016" position="0.32,1.15,${z}" material="saddle"/>

  ${tube(`1.3,1.14,${z}`, `1.3,1.2,0`, 0.012, 'steel')}
  <cylinder radius="0.011" height="0.5" rotation="90,0,0" position="1.3,1.2,0" material="steel"/>
  <capsule radius="0.016" height="0.1" rotation="90,0,0" position="1.3,1.2,-0.22" material="grip"/>
  <capsule radius="0.016" height="0.1" rotation="90,0,0" position="1.3,1.2,0.22" material="grip"/>

  <group position="0.78,0.36,0.1">
    <animate attr="rotation" to="0,0,-360" dur="2.3s"/>
    <gear teeth="28" module="0.008" depth="0.012" bore="0.02" material="steel"/>
    <box size="0.32,0.016,0.012" position="0,0,0.016" material="crank"/>
    <box size="0.09,0.018,0.04" radius="0.006" position="0.15,0,0.028" material="pedal"/>
    <box size="0.09,0.018,0.04" radius="0.006" position="-0.15,0,0.028" material="pedal"/>
  </group>
  <group position="0,0.512,0.09">
    <animate attr="rotation" to="0,0,-360" dur="1.15s"/>
    <gear teeth="14" module="0.008" depth="0.01" bore="0.016" material="steel"/>
  </group>
</es3d>`;
}
