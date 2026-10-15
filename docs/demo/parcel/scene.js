// The Shapr3D gift box: body, lid, side ribbon and bow. The STEP converter
// wrote its solids as ES3D shapes (an extrusion, flat faces and revolves) in
// models/parcel.es3d (npm run parcel); the scene uses them as definitions.
// Millimetres are scaled to the shop. The lid and bow hinge on the back edge.
// Each wrap pairs paper, ribbon and room so the three stay distinct.

import parts from './models/parcel.es3d?raw';

export const LID_DUR = 1.15;

export const wraps = [
  {
    id: 'red',
    name: 'Red',
    swatch: '#e31c24',
    detail: 'Bright red paper, an ivory bow, and a bottle.',
    paper: '#e31c24',
    ribbon: '#f4efe6',
    background: '#1e2a3a',
    sky: '#31445f',
    ground: '#141b27',
    inside: 'bottle',
  },
  {
    id: 'blush',
    name: 'Blush',
    swatch: '#f6ddd4',
    detail: 'Pale rose paper, a navy bow, and a bottle.',
    paper: '#f6ddd4',
    ribbon: '#102848',
    background: '#c45c3c',
    sky: '#f0b9a4',
    ground: '#8a3828',
    inside: 'bottle',
  },
  {
    id: 'ink',
    name: 'Ink',
    swatch: '#161513',
    detail: 'Charcoal paper, a bronze bow, and a stone.',
    paper: '#161513',
    ribbon: '#8d5a00',
    background: '#f7f4ee',
    sky: '#fffaf3',
    ground: '#e6dfd2',
    inside: 'gem',
  },
  {
    id: 'sage',
    name: 'Sage',
    swatch: '#d7e6cc',
    detail: 'Pale green paper, a red bow, and a small tree.',
    paper: '#d7e6cc',
    ribbon: '#c2412d',
    background: '#121820',
    sky: '#243044',
    ground: '#0c1016',
    inside: 'plant',
  },
];

const bottle = `
  <cylinder radius="0.13" height="0.24" position="0,0.15,0" material="liquid"/>
  <revolve d="M0,0 L0.16,0 L0.17,0.02 L0.155,0.28 L0.075,0.34 L0.068,0.42 L0,0.42 Z" material="glass"/>
  <cylinder radius="0.046" height="0.05" position="0,0.445,0" material="gold"/>`;

const gem = `
  <box size="0.34,0.04,0.24" position="0,0.02,0" material="velvet"/>
  <mesh smooth="0" position="0,0.13,0" material="stone"
    positions="0 0.12 0  0.08 0.01 0  0 0.01 0.08  -0.08 0.01 0  0 0.01 -0.08  0 -0.08 0"
    indices="0 2 1  0 3 2  0 4 3  0 1 4  5 1 2  5 2 3  5 3 4  5 4 1"/>`;

const plant = `
  <revolve d="M0,0 L0.1,0 L0.11,0.016 L0.072,0.07 L0.12,0.09 L0.11,0.15 L0,0.15 Z" material="clay"/>
  <cylinder radius="0.085" height="0.02" position="0,0.13,0" material="soil"/>
  <cylinder radius="0.008" height="0.12" position="0,0.21,0" material="stem"/>
  <cone radius="0.09" height="0.16" position="0,0.32,0" material="leaf"/>`;

const insides = { bottle, gem, plant };

/** The part definitions: the inside of parcel.es3d's <defs>. */
export async function loadGift() {
  const from = parts.indexOf('<defs>') + '<defs>'.length;
  return { defs: parts.slice(from, parts.indexOf('</defs>', from)).trim() };
}

export function giftScene(id = 'red', models) {
  const w = wraps.find((x) => x.id === id) || wraps[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<es3d version="1">
  <title>Parcel ${w.name}</title>
  <environment background="${w.background}" sky="${w.sky}" ground="${w.ground}" intensity="0.75" exposure="1.08"/>
  <camera position="0.72,5.06,4.49" target="0,1.12,0" fov="32"/>
  <light type="hemisphere" color="#fff6ec" groundColor="#e4d3c0" intensity="0.28"/>
  <light type="directional" direction="-0.35,-1,-0.4" intensity="1.7" color="#fff4e8"/>
  <light type="directional" direction="0.55,-0.2,0.35" intensity="0.55" color="#d5e4f8"/>

  <material id="paper" color="${w.paper}" roughness="0.72"/>
  <material id="ribbon" color="${w.ribbon}" roughness="0.38"/>
  <material id="gold" color="#e4c56d" metallic="1" roughness="0.28"/>
  <material id="glass" color="#8ec9ba" roughness="0.06" opacity="0.62" doubleSided="true"/>
  <material id="liquid" color="#c43d58" roughness="0.2" opacity="1"/>
  <material id="velvet" color="#5c2436" roughness="0.95"/>
  <material id="stone" color="#d7f3ec" roughness="0.06" opacity="0.88" doubleSided="true"/>
  <material id="clay" color="#c46a4a" roughness="0.78"/>
  <material id="soil" color="#3a2a1e" roughness="1"/>
  <material id="stem" color="#3e4a32" roughness="0.8"/>
  <material id="leaf" color="#2f6b45" roughness="0.7"/>

  <defs>
    ${models.defs}
  </defs>

  <group name="box" position="0,0.68,0" scale="0.068">
    <use ref="box" material="paper"/>
    <use ref="side_ties" material="ribbon"/>
    <group position="0,9,-11">
      <animate attr="rotation" from="0,0,0" to="-78,0,0" dur="${LID_DUR}s" repeat="1" easing="ease-in-out"/>
      <group position="0,-9,11">
        <use ref="box_top" material="paper"/>
        <use ref="top_bowtie" material="ribbon"/>
      </group>
    </group>
  </group>

  <group position="0,0.16,0" scale="2">
    ${insides[w.inside]}
  </group>
</es3d>`;
}
