var e=[{id:`brass`,name:`Brass`,swatch:`#c6a15b`,color:`#c6a15b`,roughness:.3},{id:`ink`,name:`Blackened`,swatch:`#2a2724`,color:`#2c2926`,roughness:.42},{id:`nickel`,name:`Nickel`,swatch:`#d5d8dc`,color:`#d8dbdf`,roughness:.22}],t=[{id:`all`,name:`The room`,text:`Mira, a pendant, and Keel. Each shade has a light inside it.`,position:[.15,1.25,4.4],target:[.15,.72,0],fov:34},{id:`mira`,name:`Mira`,text:`A foot, a stem, and a paper shade.`,position:[-.35,.62,1.45],target:[-1.05,.42,0],fov:28},{id:`pendant`,name:`Pendant`,text:`A cone on a cord. The bulb is the light.`,position:[.75,1.35,1.7],target:[.1,1.2,0],fov:28},{id:`keel`,name:`Keel`,text:`A stem, one arm, and a shade at the end.`,position:[2.05,.85,1.7],target:[1.35,.55,0],fov:28}];function n(t=`brass`){let n=e.find(e=>e.id===t)||e[0];return`<?xml version="1.0" encoding="UTF-8"?>
<es3d version="1">
  <title>Helio ${n.name}</title>
  <environment background="#110f0d" sky="#3a322c" ground="#1a1614" intensity="0.18" exposure="1"/>
  <camera position="0.15,1.25,4.4" target="0.15,0.72,0" fov="34"/>
  <light type="hemisphere" color="#ffe0c2" groundColor="#2a211c" intensity="0.22"/>
  <light type="directional" direction="-0.35,-1,-0.4" intensity="0.18" color="#ffe8d4"/>

  <material id="metal" color="${n.color}" metallic="1" roughness="${n.roughness}"/>
  <material id="shade" color="#f4eadc" roughness="0.9" doubleSided="true"/>
  <material id="cord" color="#2a2420" roughness="0.85"/>
  <material id="bulb" color="#fff6ea" roughness="0.08" emissive="#ffd2a4" emissiveIntensity="0.6"/>
  <material id="table" color="#6a5140" roughness="0.78"/>
  <box size="3.6,0.08,1.2" position="0.15,0.04,-0.05" material="table"/>

  <group name="mira" position="-1.05,0,0">
    <cylinder radius="0.11" height="0.05" position="0,0.105,0" material="metal"/>
    <cylinder radius="0.012" height="0.28" position="0,0.27,0" material="metal"/>
    <cone radius="0.2" height="0.16" position="0,0.48,0" caps="false" material="shade"/>
    <sphere radius="0.04" position="0,0.44,0" material="bulb"/>
    <light type="point" position="0,0.44,0" color="#ffc896" intensity="0.7" range="3.2"/>
  </group>

  <group name="pendant" position="0.1,2.15,0">
    <animate attr="rotation" from="0,0,-1.6" to="0,0,1.6" dur="5s" alternate="true" easing="ease-in-out"/>
    <cylinder radius="0.004" height="0.72" position="0,-0.36,0" material="cord"/>
    <cone radius="0.24" height="0.18" position="0,-0.82,0" caps="false" material="shade"/>
    <sphere radius="0.045" position="0,-0.86,0" material="bulb"/>
    <light type="point" position="0,-0.86,0" color="#ffc896" intensity="0.75" range="3.6"/>
  </group>

  <group name="keel" position="1.15,0,0">
    <box size="0.28,0.02,0.16" position="0,0.09,0" material="metal"/>
    <cylinder radius="0.012" height="0.62" position="0,0.41,0" material="metal"/>
    <line from="0,0.72,0" to="0.42,0.58,0" radius="0.011" material="metal"/>
    <cone radius="0.16" height="0.13" position="0.42,0.5,0" caps="false" material="shade"/>
    <sphere radius="0.035" position="0.42,0.47,0" material="bulb"/>
    <light type="point" position="0.42,0.47,0" color="#ffc896" intensity="0.6" range="3"/>
  </group>
</es3d>`}export{e as n,n as r,t};
//# sourceMappingURL=scene-CKKD5cBA.js.map