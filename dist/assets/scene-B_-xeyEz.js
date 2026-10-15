var e=[{id:`signal`,name:`Signal`,swatch:`#d84a3a`,color:`#d84a3a`,metallic:0,roughness:.34},{id:`alloy`,name:`Alloy`,swatch:`#d5dbe0`,color:`#d5dbe0`,metallic:1,roughness:.26},{id:`night`,name:`Night`,swatch:`#243044`,color:`#1c2433`,metallic:.35,roughness:.38}],t=.058,n=(e,t,n,r=`paint`)=>`<line from="${e}" to="${t}" radius="${n}" material="${r}"/>`,r=`
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
  </group>`,i=[0,.34,.67,1].join(`,`),a=`
  <camera position="2.3,1.12,4.35" target="0.9,0.55,0" fov="30" aspect="1.5">
    <animate attr="position" values="2.3,1.12,4.35; 1.45,0.62,0.95; -0.55,0.98,1.05; 1.4,2.9,10.5" keyTimes="${i}" smooth="true" timeline="scroll"/>
    <animate attr="target" values="0.9,0.55,0; 0.6,0.4,0.06; 0.05,0.5,0; 0.9,0.55,0" keyTimes="${i}" smooth="true" timeline="scroll"/>
  </camera>
  <controls mode="scroll"/>`;function o(i=`signal`,{tour:o=!1}={}){let s=e.find(e=>e.id===i)||e[0],c=t;return`<?xml version="1.0" encoding="UTF-8"?>
<es3d version="1">
  <title>Spoke ${s.name}</title>
  <environment background="#141513" sky="#d7dee8" ground="#2a2924" intensity="0.55" exposure="1.05"/>
  ${o?a:`<camera position="2.3,1.12,4.35" target="0.9,0.55,0" fov="30"/>
  <controls minDistance="1.2" maxDistance="9" collide="true"/>`}
  <light type="directional" direction="-0.35,-1,-0.45" intensity="1.7" color="#fff5ec"/>
  <light type="directional" direction="0.55,-0.25,0.45" intensity="0.45" color="#c9d6ee"/>

  <material id="paint" color="${s.color}" metallic="${s.metallic}" roughness="${s.roughness}"/>
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
    ${r}
  </defs>

  <group position="0,0.512,0">
    <animate attr="rotation" to="0,0,-360" dur="1.15s"/>
    <use ref="wheel" rotation="90,0,0"/>
  </group>
  <group position="1.82,0.512,0">
    <animate attr="rotation" to="0,0,-360" dur="1.15s"/>
    <use ref="wheel" rotation="90,0,0"/>
  </group>

  ${n(`0,0.512,${c}`,`0.78,0.36,${c}`,.012)}
  ${n(`0,0.512,${c}`,`0.46,1,${c}`,.011)}
  ${n(`0.78,0.36,${c}`,`0.46,1,${c}`,.016)}
  ${n(`0.78,0.36,${c}`,`1.4,0.9,${c}`,.016)}
  ${n(`0.46,1,${c}`,`1.3,1.14,${c}`,.014)}
  ${n(`1.4,0.9,${c}`,`1.3,1.14,${c}`,.016)}
  ${n(`1.4,0.9,${c}`,`1.82,0.512,${c}`,.012)}
  ${n(`0.46,1,${c}`,`0.38,1.12,${c}`,.012)}
  <box size="0.26,0.04,0.1" radius="0.016" position="0.32,1.15,${c}" material="saddle"/>

  ${n(`1.3,1.14,${c}`,`1.3,1.2,0`,.012,`steel`)}
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
</es3d>`}export{e as n,o as t};
//# sourceMappingURL=scene-B_-xeyEz.js.map