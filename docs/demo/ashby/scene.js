// Ashby: a small medieval village, written as one ES3D document.
//
// Layout (metres, y up, the village square at the origin): a south road runs
// from the river bridge (z = 70) through the palisade gate (z = 26) into the
// square. Eight houses face the square around it; a gap to the north leads to
// the church (z = -40). A windmill stands west of the road among the fields,
// the keep sits on a hill to the north-east, and forests fill the edges.
//
// Everything is procedural: each building is a few boxes and an extruded
// roof, defined once and reused; the palisade is one log repeated around a
// circle; the forests are seeded scatters.

// Key views of the fly-through, in page order. The page pins one paragraph to
// each (data-es3d-stop), so the camera reaches view i at progress STOPS[i].
export const STOPS = [0, 0.16, 0.33, 0.5, 0.66, 0.83, 1];
const VIEWS = [
  // [eye, target]
  ['18,48,175', '0,4,10'], // over the fields, from the south
  ['4,7,94', '0,3,40'], // above the river, low over the bridge
  ['0,3.4,44', '0,2.8,10'], // before the gate
  ['-1,2.6,5', '0,6,-34'], // in the square, facing the church
  ['-1.5,5.5,-6', '0,11,-36'], // up the lane to the church, between the houses
  ['30,26,-40', '62,17,-78'], // up towards the keep
  ['-95,82,30', '5,0,-18'], // the whole village
];

const TIMES = STOPS.join(',');
const tourCamera = `
  <camera position="${VIEWS[0][0]}" target="${VIEWS[0][1]}" fov="48" aspect="1.6">
    <animate attr="position" values="${VIEWS.map((v) => v[0]).join('; ')}" keyTimes="${TIMES}" smooth="true" timeline="scroll"/>
    <animate attr="target" values="${VIEWS.map((v) => v[1]).join('; ')}" keyTimes="${TIMES}" smooth="true" timeline="scroll"/>
  </camera>
  <controls mode="scroll"/>`;

const overviewCamera = `
  <camera position="70,55,95" target="0,4,-12" fov="42" aspect="1.6"/>`;

// The houses around the square: angle from +z (degrees), building, roof.
// Gaps at 0 and 180 degrees leave room for the roads.
const RING = [
  [22.5, 'cottage', 'thatch'],
  [67.5, 'hall', 'tiles'],
  [112.5, 'cottage', 'slate'],
  [157.5, 'hall', 'thatch'],
  [202.5, 'cottage', 'tiles'],
  [247.5, 'hall', 'slate'],
  [292.5, 'cottage', 'thatch'],
  [337.5, 'longhouse', 'tiles'],
];
// Farms outside the palisade: x, z, turn, building, roof.
const FARMS = [
  [-30, 52, 15, 'longhouse', 'thatch'],
  [27, 40, -20, 'cottage', 'thatch'],
  [36, 58, 70, 'cottage', 'tiles'],
  [-38, -14, 100, 'cottage', 'slate'],
  [34, -12, -80, 'longhouse', 'thatch'],
];

const ring = RING.map(([a, b, roof]) => `
    <group rotation="0,${a},0"><use ref="${b}" position="0,0,18" rotation="0,180,0" material="${roof}"/></group>`).join('');
const farms = FARMS.map(([x, z, r, b, roof]) => `
  <use ref="${b}" position="${x},0,${z}" rotation="0,${r},0" material="${roof}"/>`).join('');

// One palisade arc: logs every 5 degrees at radius 26.
const arc = (from, count) => `
    <group rotation="0,${from},0">
      <repeat count="${count}" step="rotateY(5)">
        <cylinder radius="0.42" height="3.4" position="0,1.7,26" segments="7" material="log"/>
      </repeat>
    </group>`;

/**
 * @param {{tour?: boolean}} [opts] tour: the scroll-driven fly-through camera; otherwise a fixed overview
 */
export function villageScene({ tour = false } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<es3d version="1">
  <title>Ashby</title>
  <environment background="#b8d3e6" sky="#dbe8f4" ground="#6f7d46" intensity="0.55" exposure="1.05"/>
  ${tour ? tourCamera : overviewCamera}
  <light type="directional" direction="-0.45,-0.85,-0.3" intensity="1.9" color="#ffe6c2"/>
  <light type="directional" direction="0.6,-0.35,0.5" intensity="0.35" color="#c6d8f0"/>

  <material id="grass" color="#7d9a4a" roughness="1"/>
  <material id="dirt" color="#a08566" roughness="1"/>
  <material id="water" color="#4f7f98" roughness="0.15" metallic="0.1"/>
  <material id="plaster" color="#e9dfc9" roughness="0.9"/>
  <material id="timber" color="#4a3324" roughness="0.8"/>
  <material id="stone" color="#9a958a" roughness="0.95"/>
  <material id="darkstone" color="#7d786f" roughness="0.95"/>
  <material id="window" color="#2d3036" roughness="0.3"/>
  <material id="thatch" color="#b8934f" roughness="1"/>
  <material id="tiles" color="#9f4b32" roughness="0.8"/>
  <material id="slate" color="#596169" roughness="0.7"/>
  <material id="log" color="#6b4a30" roughness="0.95"/>
  <material id="bark" color="#5a3f2b" roughness="1"/>
  <material id="pine" color="#2f5a35" roughness="0.9"/>
  <material id="oak" color="#5d8a3a" roughness="0.9"/>
  <material id="wheat" map="stripes(16,#dcb85c,#c39a43)" roughness="1"/>
  <material id="barley" map="stripes(14,#9fae55,#87994a)" roughness="1"/>
  <material id="awning-red" map="stripes(6,#b0402e,#efe4cf)" roughness="0.9"/>
  <material id="awning-blue" map="stripes(6,#3c5a86,#efe4cf)" roughness="0.9"/>
  <material id="sail" color="#e8dfcc" roughness="0.9" doubleSided="true"/>

  <defs>
    <!-- buildings: walls and trim carry their own materials; the roof takes the use's material -->
    <group id="cottage">
      <box size="5,3,6" position="0,1.5,0" material="plaster"/>
      <extrude d="M-3.1,0 L3.1,0 L0,2.6 Z" depth="6.8" center="true" position="0,3,0"/>
      <box size="1.1,1.9,0.12" position="0,0.95,3.02" material="timber"/>
      <box size="0.8,0.7,0.1" position="-1.6,1.9,3.02" material="window"/>
      <box size="0.8,0.7,0.1" position="1.6,1.9,3.02" material="window"/>
      <box size="0.7,1.8,0.7" position="1.4,4.6,-1.6" material="stone"/>
    </group>
    <group id="hall">
      <box size="6,5.2,7" position="0,2.6,0" material="plaster"/>
      <box size="6.08,0.28,7.08" position="0,2.6,0" material="timber"/>
      <repeat count="2" step="translate(5.8,0,0)">
        <repeat count="2" step="translate(0,0,6.8)">
          <box size="0.3,5.2,0.3" position="-2.9,2.6,-3.4" material="timber"/>
        </repeat>
      </repeat>
      <extrude d="M-3.6,0 L3.6,0 L0,3.2 Z" depth="7.8" center="true" position="0,5.2,0"/>
      <box size="1.3,2.2,0.12" position="0,1.1,3.52" material="timber"/>
      <box size="0.9,0.8,0.1" position="-1.8,3.9,3.52" material="window"/>
      <box size="0.9,0.8,0.1" position="1.8,3.9,3.52" material="window"/>
      <box size="0.9,0.8,0.1" position="-1.8,1.4,3.52" material="window"/>
    </group>
    <group id="longhouse">
      <box size="5.5,2.8,11" position="0,1.4,0" material="plaster"/>
      <extrude d="M-3.4,0 L3.4,0 L0,3 Z" depth="11.8" center="true" position="0,2.8,0"/>
      <box size="1.2,2,0.12" position="0,1,5.52" material="timber"/>
      <box size="0.8,0.7,0.1" position="2.77,1.7,2" rotation="0,90,0" material="window"/>
      <box size="0.8,0.7,0.1" position="2.77,1.7,-2" rotation="0,90,0" material="window"/>
    </group>
    <group id="stall">
      <box size="3,0.9,1.4" position="0,0.45,0" material="timber"/>
      <repeat count="2" step="translate(2.8,0,0)">
        <box size="0.12,2.4,0.12" position="-1.4,1.2,-0.6" material="timber"/>
      </repeat>
      <box size="3.4,0.08,2.2" position="0,2.45,0.25" rotation="12,0,0"/>
    </group>
    <!-- trees: canonical meshes shared by every copy; each scatter copy gets its own scale and turn -->
    <group id="pinetree">
      <cylinder radius="0.25" height="1.6" position="0,0.8,0" material="bark"/>
      <cone radius="1.6" height="3.6" position="0,3.1,0" material="pine"/>
      <cone radius="1.1" height="2.6" position="0,4.7,0" material="pine"/>
    </group>
    <group id="oaktree">
      <cylinder radius="0.3" height="2.2" position="0,1.1,0" material="bark"/>
      <sphere radius="1.9" position="0,3.6,0" scale="1,0.85,1" material="oak"/>
    </group>
  </defs>

  <!-- land: road and river are lines with a width, flattened onto the ground -->
  <plane size="420,420" material="grass"/>
  <group position="0,0.05,0" scale="1,0.02,1">
    <polyline points="0,0,140 2,0,120 -2,0,96 0,0,70 1,0,45 0,0,26 0,0,0 0,0,-34" smooth="true" radius="1.8" material="dirt"/>
    <polyline points="0,0,0 22,0,-30 42,0,-52 56,0,-66" smooth="true" radius="1.2" material="dirt"/>
  </group>
  <group position="0,0.03,0" scale="1,0.02,1">
    <polyline points="-210,0,80 -120,0,72 -60,0,63 0,0,70 60,0,79 120,0,70 210,0,76" smooth="true" radius="5" material="water"/>
  </group>
  <plane size="16,16" position="0,0.04,0" rotation="0,45,0" material="dirt"/>

  <!-- fields in strips on both sides of the road -->
  <plane size="28,20" position="-24,0.02,42" rotation="0,90,0" material="wheat"/>
  <plane size="22,18" position="20,0.02,47" material="barley"/>
  <plane size="34,22" position="-28,0.02,96" rotation="0,90,0" material="barley"/>
  <plane size="30,24" position="26,0.02,100" material="wheat"/>

  <!-- the bridge -->
  <group position="0,0,70">
    <box size="5,0.6,15" position="0,0.6,0" material="stone"/>
    <box size="0.5,0.8,15" position="-2.3,1.3,0" material="stone"/>
    <box size="0.5,0.8,15" position="2.3,1.3,0" material="stone"/>
  </group>

  <!-- the palisade, with gaps for the south gate and the church lane -->
  <group>
    ${arc(10, 33)}
    ${arc(190, 33)}
  </group>
  <group position="0,0,26">
    <cylinder radius="2" height="8" position="-4.5,4,0" material="log"/>
    <cylinder radius="2" height="8" position="4.5,4,0" material="log"/>
    <cone radius="2.6" height="3" position="-4.5,9.5,0" segments="8" material="thatch"/>
    <cone radius="2.6" height="3" position="4.5,9.5,0" segments="8" material="thatch"/>
    <box size="7,0.9,1.4" position="0,6.6,0" material="timber"/>
  </group>

  <!-- the square: houses facing in, a well and the market -->
  <group>${ring}
  </group>
  <group position="4,0,-3">
    <cylinder radius="1.25" height="1" position="0,0.5,0" material="stone"/>
    <cylinder radius="1" height="0.1" position="0,0.85,0" material="water"/>
    <box size="0.18,2.4,0.18" position="-1.05,1.2,0" material="timber"/>
    <box size="0.18,2.4,0.18" position="1.05,1.2,0" material="timber"/>
    <extrude d="M-1.6,0 L1.6,0 L0,1 Z" depth="1.6" center="true" position="0,2.4,0" material="thatch"/>
  </group>
  <use ref="stall" position="-6,0,-4" rotation="0,60,0" material="awning-red"/>
  <use ref="stall" position="-7,0,2" rotation="0,95,0" material="awning-blue"/>
  <use ref="stall" position="6,0,5" rotation="0,-110,0" material="awning-red"/>

  <!-- the church -->
  <group position="0,0,-42">
    <box size="9,7,16" position="0,3.5,-2" material="stone"/>
    <extrude d="M-5.2,0 L5.2,0 L0,4.4 Z" depth="16.8" center="true" position="0,7,-2" material="slate"/>
    <box size="4.6,15,4.6" position="0,7.5,8.3" material="darkstone"/>
    <cone radius="3.6" height="8" segments="4" rotation="0,45,0" position="0,19,8.3" material="slate"/>
    <box size="1.6,3,0.14" position="0,1.5,10.65" material="timber"/>
    <box size="1,1.8,0.12" position="0,11,10.65" material="window"/>
  </group>

  <!-- farms outside the walls -->${farms}

  <!-- the mill: its sails turn -->
  <group position="-46,0,24" rotation="0,30,0">
    <cylinder radius="2.8" radiusTop="1.9" height="9" position="0,4.5,0" material="plaster"/>
    <cone radius="2.4" height="2.6" position="0,10.3,0" material="thatch"/>
    <box size="1,1.8,0.12" position="0,0.9,2.7" material="timber"/>
    <group position="0,8,2.6">
      <animate attr="rotation" to="0,0,-360" dur="16s"/>
      <cylinder radius="0.35" height="0.8" rotation="90,0,0" material="timber"/>
      <repeat count="4" step="rotateZ(90)">
        <box size="0.25,7,0.2" position="0,3.6,0.3" material="timber"/>
        <box size="1.3,5,0.04" position="0.75,4.1,0.3" material="sail"/>
      </repeat>
    </group>
  </group>

  <!-- the keep on its hill -->
  <group position="62,0,-78">
    <sphere radius="1" position="0,-1,0" scale="36,12.5,32" material="grass"/>
    <group position="0,9.8,0">
      <box size="10,15,10" position="0,7.5,0" material="stone"/>
      <repeat count="4" step="rotateY(90)">
        <repeat count="5" step="translate(2,0,0)">
          <box size="1,1.2,1" position="-4,15.6,4.5" material="stone"/>
        </repeat>
      </repeat>
      <repeat count="4" step="rotateY(90)">
        <cylinder radius="2.2" height="11" position="9,5.5,9" material="darkstone"/>
        <cone radius="2.9" height="4.2" position="9,13.1,9" segments="10" material="slate"/>
        <box size="16,6.5,1.2" position="0,3.25,9" material="darkstone"/>
      </repeat>
    </group>
  </group>

  <!-- woods: seeded scatters, so every reader grows the same trees -->
  <group position="-82,0,-52">
    <scatter count="260" radius="44" seed="3" randomScale="0.7..1.35" randomRotation="0,0..360,0"><use ref="pinetree"/></scatter>
    <scatter count="70" radius="40" seed="8" randomScale="0.8..1.2" randomRotation="0,0..360,0"><use ref="oaktree"/></scatter>
  </group>
  <group position="96,0,8">
    <scatter count="150" radius="32" seed="12" randomScale="0.7..1.3" randomRotation="0,0..360,0"><use ref="pinetree"/></scatter>
    <scatter count="50" radius="30" seed="5" randomScale="0.8..1.2" randomRotation="0,0..360,0"><use ref="oaktree"/></scatter>
  </group>
  <group position="-70,0,128">
    <scatter count="110" radius="30" seed="21" randomScale="0.8..1.3" randomRotation="0,0..360,0"><use ref="oaktree"/></scatter>
  </group>
  <group position="20,0,-120">
    <scatter count="180" radius="40" seed="31" randomScale="0.7..1.3" randomRotation="0,0..360,0"><use ref="pinetree"/></scatter>
  </group>
</es3d>`;
}
