var e=`<!-- The Parcel gift box: the box (box), the lid (box_top), the ribbon round the sides (side_ties), the ribbon and bow on the lid (top_bowtie). Converted from the STEP files in this folder by scripts/make-parcel.mjs (npm run parcel); do not edit by hand. -->\r
<es3d version="1" unit="mm">\r
  <title>Parcel: the gift box from Shapr3D</title>\r
  <defs>\r
    <group id="box" rotation="-90,0,0">\r
      <path\r
          position="0,10,9"\r
          rotation="0,0,180"\r
          d="M10,20L-10,20L-10,0L10,0L10,20Z M-9,1L-9,19L9,19L9,1L-9,1Z"\r
          fillRule="evenodd"/>\r
      <path position="10,10,0" rotation="0,-90,180" d="M9,20L-10,20L-10,0L9,0L9,20Z"/>\r
      <path position="-10,10,0" rotation="0,90,180" d="M10,20L-9,20L-9,0L10,0L10,20Z"/>\r
      <path position="0,10,-10" rotation="180,0,0" d="M10,20L-10,20L-10,0L10,0L10,20Z"/>\r
      <path position="0,10,0" rotation="-90,0,0" d="M10,-9L10,10L-10,10L-10,-9L10,-9Z"/>\r
      <path position="0,-10,0" rotation="90,0,0" d="M10,-10L10,9L-10,9L-10,-10L10,-10Z"/>\r
      <path position="9,10,0" rotation="0,-90,0" d="M-9,-19L9,-19L9,-1L-9,-1L-9,-19Z"/>\r
      <path position="-9,10,0" rotation="0,90,0" d="M-9,-19L9,-19L9,-1L-9,-1L-9,-19Z"/>\r
      <path position="0,10,-9" d="M-9,-19L9,-19L9,-1L-9,-1L-9,-19Z"/>\r
      <path position="0,9,0" rotation="90,0,0" d="M9,-9L9,9L-9,9L-9,-9L9,-9Z"/>\r
      <path position="0,-9,0" rotation="-90,0,0" d="M9,-9L9,9L-9,9L-9,-9L9,-9Z"/>\r
    </group>\r
    <group id="box_top" rotation="-90,0,0">\r
      <extrude\r
          position="0,0,9"\r
          d="M11,11L11,1L10,1L10,-1L11,-1L11,-11L1,-11L1,-10L-1,-10L-1,-11L-11,-11L-11,-1L-10,-1L-10,1L-11,1L-11,11L-1,11L-1,10L1,10L1,11L11,11Z"\r
          depth="0.9"/>\r
    </group>\r
    <group id="side_ties" rotation="-90,0,0">\r
      <path\r
          position="11,-10,0"\r
          rotation="0,90,0"\r
          d="M-9,11L-9,9L-1,9L-1,-1L1,-1L1,9L10,9L10,11L1,11L1,21L-1,21L-1,11L-9,11Z"/>\r
      <path\r
          position="10,0,0"\r
          rotation="90,0,-90"\r
          d="M1,9L-1,9L-1,1L-10,1L-10,-1L-1,-1L-1,-10L1,-10L1,-1L10,-1L10,1L1,1L1,9Z"/>\r
      <path position="10,-1,5" rotation="0,-90,90" d="M4,-1L4,0L-4,0L-4,-1L4,-1Z"/>\r
      <path position="10,1,5" rotation="0,90,90" d="M-4,0L-4,-1L4,-1L4,0L-4,0Z"/>\r
      <path\r
          position="0,11,0"\r
          rotation="90,0,180"\r
          d="M1,1L1,9L-1,9L-1,1L-11,1L-11,-1L-1,-1L-1,-10L1,-10L1,-1L11,-1L11,1L1,1Z"/>\r
      <path\r
          position="-11,-10,0"\r
          rotation="0,-90,0"\r
          d="M9,9L9,11L1,11L1,21L-1,21L-1,11L-10,11L-10,9L-1,9L-1,-1L1,-1L1,9L9,9Z"/>\r
      <path\r
          position="-10,0,0"\r
          rotation="-90,0,-90"\r
          d="M-1,-9L1,-9L1,-1L10,-1L10,1L1,1L1,10L-1,10L-1,1L-10,1L-10,-1L-1,-1L-1,-9Z"/>\r
      <path position="-10,-1,5" rotation="0,-90,90" d="M4,0L4,1L-4,1L-4,0L4,0Z"/>\r
      <path position="-10,1,5" rotation="0,90,90" d="M-4,1L-4,0L4,0L4,1L-4,1Z"/>\r
      <path\r
          position="0,-10,0"\r
          rotation="90,0,180"\r
          d="M1,9L-1,9L-1,1L-10,1L-10,-1L-1,-1L-1,-10L1,-10L1,-1L10,-1L10,1L1,1L1,9Z"/>\r
      <path position="-1,-10,5" rotation="0,-90,0" d="M4,-1L4,0L-4,0L-4,-1L4,-1Z"/>\r
      <path position="1,-10,5" rotation="0,90,0" d="M-4,0L-4,-1L4,-1L4,0L-4,0Z"/>\r
      <path position="6,-10,-1" rotation="180,0,90" d="M9,5L-1,5L-1,-5L0,-5L0,4L9,4L9,5Z"/>\r
      <path position="1,-10,-6" rotation="0,90,0" d="M-5,-1L4,-1L4,0L-5,0L-5,-1Z"/>\r
      <path position="-1,-10,-6" rotation="0,-90,0" d="M5,0L-4,0L-4,-1L5,-1L5,0Z"/>\r
      <path position="-6,-10,-1" rotation="180,0,90" d="M-1,-5L9,-5L9,-4L0,-4L0,5L-1,5L-1,-5Z"/>\r
      <path position="-6,-10,1" rotation="0,0,-90" d="M-9,-5L1,-5L1,5L0,5L0,-4L-9,-4L-9,-5Z"/>\r
      <path position="6,-10,1" rotation="0,0,-90" d="M1,5L-9,5L-9,4L0,4L0,-5L1,-5L1,5Z"/>\r
      <path\r
          position="0,-11,0"\r
          rotation="-90,0,180"\r
          d="M-1,-9L1,-9L1,-1L11,-1L11,1L1,1L1,10L-1,10L-1,1L-11,1L-11,-1L-1,-1L-1,-9Z"/>\r
      <path\r
          position="0.5,-31.7,-10"\r
          rotation="180,0,0"\r
          d="M0.5,-21.7L0.5,-20.7L-1.5,-20.7L-1.5,-21.7L0.5,-21.7Z"/>\r
      <path\r
          position="0,10,0"\r
          rotation="-90,0,180"\r
          d="M-1,-1L-1,-9L1,-9L1,-1L10,-1L10,1L1,1L1,10L-1,10L-1,1L-10,1L-10,-1L-1,-1Z"/>\r
      <path position="1,10,-6" rotation="0,90,0" d="M4,0L4,1L-5,1L-5,0L4,0Z"/>\r
      <path position="-1,10,-6" rotation="0,-90,0" d="M-4,1L-4,0L5,0L5,1L-4,1Z"/>\r
      <path position="6,10,-1" rotation="180,0,-90" d="M-1,-5L9,-5L9,-4L0,-4L0,5L-1,5L-1,-5Z"/>\r
      <path position="-6,10,-1" rotation="180,0,-90" d="M-1,5L-1,-5L0,-5L0,4L9,4L9,5L-1,5Z"/>\r
      <path position="-6,10,1" rotation="0,0,90" d="M1,5L-9,5L-9,4L0,4L0,-5L1,-5L1,5Z"/>\r
      <path position="-1,10,5" rotation="0,-90,0" d="M-4,0L4,0L4,1L-4,1L-4,0Z"/>\r
      <path position="1,10,5" rotation="0,90,0" d="M4,1L-4,1L-4,0L4,0L4,1Z"/>\r
      <path position="6,10,1" rotation="0,0,90" d="M1,-5L1,5L0,5L0,-4L-9,-4L-9,-5L1,-5Z"/>\r
      <path\r
          position="0.5,18.7,-10"\r
          rotation="180,0,180"\r
          d="M-0.5,-8.7L1.5,-8.7L1.5,-7.7L-0.5,-7.7L-0.5,-8.7Z"/>\r
      <path position="-10,1,-6" rotation="0,90,90" d="M4,0L4,1L-5,1L-5,0L4,0Z"/>\r
      <path position="-10,-1,-6" rotation="0,-90,90" d="M5,1L-4,1L-4,0L5,0L5,1Z"/>\r
      <path\r
          position="0.5,18.7,-10"\r
          rotation="180,0,180"\r
          d="M10.5,-17.7L10.5,-19.7L11.5,-19.7L11.5,-17.7L10.5,-17.7Z"/>\r
      <path position="10,1,-6" rotation="0,90,90" d="M4,-1L4,0L-5,0L-5,-1L4,-1Z"/>\r
      <path position="10,-1,-6" rotation="0,-90,90" d="M5,0L-4,0L-4,-1L5,-1L5,0Z"/>\r
      <path\r
          position="0.5,18.7,-10"\r
          rotation="180,0,180"\r
          d="M-9.5,-19.7L-9.5,-17.7L-10.5,-17.7L-10.5,-19.7L-9.5,-19.7Z"/>\r
      <path position="0,0,9" rotation="0,0,180" d="M-1,10L1,10L1,11L-1,11L-1,10Z"/>\r
      <path position="0,0,9" rotation="0,0,180" d="M10,-1L11,-1L11,1L10,1L10,-1Z"/>\r
      <path position="0,0,9" rotation="0,0,180" d="M1,-10L-1,-10L-1,-11L1,-11L1,-10Z"/>\r
      <path position="0,0,9" rotation="0,0,180" d="M-10,-1L-10,1L-11,1L-11,-1L-10,-1Z"/>\r
    </group>\r
    <group id="top_bowtie" rotation="-90,0,0">\r
      <path\r
          position="0,0,10.9"\r
          rotation="0,0,180"\r
          d="M-0.5,-5.673623L-0.5,-3.404409L0.5,-3.404409L0.5,-5.673623L-0.5,-5.673623Z M1,-11L1,-1L11,-1L11,1L1,1L1,11L-1,11L-1,1L-11,1L-11,-1L-1,-1L-1,-11L1,-11Z M0.5,3.404409L-0.5,3.404409L-0.5,5.673623L0.5,5.673623L0.5,3.404409Z"\r
          fillRule="evenodd"/>\r
      <path position="0,10,9" rotation="0,-90,90" d="M0,-1L0.9,-1L0.9,1L0,1L0,-1Z"/>\r
      <path\r
          position="-1,10.5,9"\r
          rotation="0,90,180"\r
          d="M-1.9,9.5L-1.9,-0.5L0,-0.5L0,0.5L-0.9,0.5L-0.9,9.5L-1.9,9.5Z"/>\r
      <path position="0,11,9" rotation="0,90,90" d="M-1.9,1L-1.9,-1L0,-1L0,1L-1.9,1Z"/>\r
      <path\r
          position="1,10.5,9"\r
          rotation="0,-90,180"\r
          d="M1.9,-0.5L1.9,9.5L0.9,9.5L0.9,0.5L0,0.5L0,-0.5L1.9,-0.5Z"/>\r
      <path position="0,0,9" rotation="180,0,180" d="M-1,10L1,10L1,11L-1,11L-1,10Z"/>\r
      <path position="6,1,10.9" rotation="0,90,90" d="M0,5L0,-5L1.9,-5L1.9,-4L1,-4L1,5L0,5Z"/>\r
      <path\r
          position="0,0,9.9"\r
          rotation="180,0,0"\r
          d="M1,-1L10,-1L10,1L1,1L1,10L-1,10L-1,1L-10,1L-10,-1L-1,-1L-1,-10L1,-10L1,-1Z"/>\r
      <path position="-6,-1,10.9" rotation="0,-90,90" d="M0,-5L0,5L-1.9,5L-1.9,4L-1,4L-1,-5L0,-5Z"/>\r
      <path\r
          position="-1,-6,10.9"\r
          rotation="0,-90,0"\r
          d="M-1,5L-1,-4L-1.9,-4L-1.9,-5L0,-5L0,5L-1,5Z"/>\r
      <path position="-6,1,10.9" rotation="0,90,90" d="M1,-5L1,4L1.9,4L1.9,5L0,5L0,-5L1,-5Z"/>\r
      <path position="1,-6,10.9" rotation="0,90,0" d="M0,5L0,-5L1.9,-5L1.9,-4L1,-4L1,5L0,5Z"/>\r
      <path\r
          position="6,-1,10.9"\r
          rotation="0,-90,90"\r
          d="M-1,5L-1,-4L-1.9,-4L-1.9,-5L0,-5L0,5L-1,5Z"/>\r
      <path position="10,0,9" rotation="0,-90,0" d="M0.9,-1L0.9,1L0,1L0,-1L0.9,-1Z"/>\r
      <path position="11,0,9" rotation="0,90,0" d="M-1.9,1L-1.9,-1L0,-1L0,1L-1.9,1Z"/>\r
      <path position="0,0,9" rotation="180,0,180" d="M-10,-1L-10,1L-11,1L-11,-1L-10,-1Z"/>\r
      <path position="-10,0,9" rotation="0,90,0" d="M-0.9,1L-0.9,-1L0,-1L0,1L-0.9,1Z"/>\r
      <path position="-11,0,9" rotation="0,-90,0" d="M1.9,-1L1.9,1L0,1L0,-1L1.9,-1Z"/>\r
      <path position="0,0,9" rotation="180,0,180" d="M11,1L10,1L10,-1L11,-1L11,1Z"/>\r
      <path position="0,-10,9" rotation="0,-90,-90" d="M0.9,-1L0.9,1L0,1L0,-1L0.9,-1Z"/>\r
      <path position="0,-11,9" rotation="0,90,-90" d="M-1.9,1L-1.9,-1L0,-1L0,1L-1.9,1Z"/>\r
      <path position="0,0,9" rotation="180,0,180" d="M1,-10L-1,-10L-1,-11L1,-11L1,-10Z"/>\r
      <revolve position="-0.5,0,15" rotation="180,31.668243,90" d="M6,0L6,1" angle="31.668243"/>\r
      <revolve\r
          position="-0.5,3.678571,15"\r
          rotation="180,0,90"\r
          d="M2.321429,0L2.321429,1"\r
          angle="120.510237"/>\r
      <revolve\r
          position="-0.5,7.285534,11.482233"\r
          rotation="0,-49.065051,-90"\r
          d="M7.303909,0L7.303909,1"\r
          angle="20.817173"/>\r
      <revolve\r
          position="-0.5,-7.535534,10.87868"\r
          rotation="180,-31.697582,90"\r
          d="M7.618506,0L7.618506,1"\r
          angle="21.766174"/>\r
      <revolve\r
          position="-0.5,-4.085786,15.37868"\r
          rotation="180,-56.190068,90"\r
          d="M1.95131,0L1.95131,1"\r
          angle="135"/>\r
      <revolve position="-0.5,0,15" rotation="0,0,-90" d="M6,0L6,1" angle="31.668243"/>\r
      <revolve position="-0.5,0,15" rotation="0,-11.339379,-90" d="M7,0L7,1" angle="47.192846"/>\r
      <revolve\r
          position="-0.5,-4.085786,15.37868"\r
          rotation="180,-55.694647,90"\r
          d="M2.95131,0L2.95131,1"\r
          angle="104.547851"/>\r
      <revolve\r
          position="-0.5,-7.535534,10.87868"\r
          rotation="180,-33.853902,90"\r
          d="M8.618506,0L8.618506,1"\r
          angle="19.756575"/>\r
      <revolve\r
          position="-0.5,7.285534,11.482233"\r
          rotation="0,-49.657844,-90"\r
          d="M8.303909,0L8.303909,1"\r
          angle="19.173853"/>\r
      <revolve\r
          position="-0.5,3.678571,15"\r
          rotation="180,0,90"\r
          d="M3.321429,0L3.321429,1"\r
          angle="122.172865"/>\r
      <revolve position="-0.5,0,15" rotation="180,35.853467,90" d="M7,0L7,1" angle="35.853467"/>\r
      <path\r
          position="-0.5,0,0"\r
          rotation="90,0,-90"\r
          d="M-2.5,17A7.303909,7.303909 0 0,0 -0.85146,14.939079A1.1,1.1 0 0,1 1.053456,14.881715A7.618506,7.618506 0 0,0 3,17A1.95131,1.95131 0 0,0 6,15A6,6 0 0,0 5.106613,11.85A2,2 0 0,0 3.404409,10.9L5.673623,10.9A7,7 0 0,1 6.863358,16.37634A2.95131,2.95131 0 0,1 2.422418,17.816597A8.618506,8.618506 0 0,1 0.378203,15.679852A0.3,0.3 0 0,0 -0.129466,15.694786A8.303909,8.303909 0 0,1 -1.909992,17.811408A3.321429,3.321429 0 0,1 -7,15A7,7 0 0,1 -5.673623,10.9L-3.404409,10.9A2,2 0 0,0 -5.106613,11.85A6,6 0 0,0 -6,15A2.321429,2.321429 0 0,0 -2.5,17Z"/>\r
      <path\r
          position="0.5,0,0"\r
          rotation="-90,0,-90"\r
          d="M3,-17A7.618506,7.618506 0 0,0 1.053456,-14.881715A1.1,1.1 0 0,1 -0.85146,-14.939079A7.303909,7.303909 0 0,0 -2.5,-17A2.321429,2.321429 0 0,0 -6,-15A6,6 0 0,0 -5.106613,-11.85A2,2 0 0,0 -3.404409,-10.9L-5.673623,-10.9A7,7 0 0,1 -7,-15A3.321429,3.321429 0 0,1 -1.909992,-17.811408A8.303909,8.303909 0 0,1 -0.129466,-15.694786A0.3,0.3 0 0,0 0.378203,-15.679852A8.618506,8.618506 0 0,1 2.422418,-17.816597A2.95131,2.95131 0 0,1 6.863358,-16.37634A7,7 0 0,1 5.673623,-10.9L3.404409,-10.9A2,2 0 0,0 5.106613,-11.85A6,6 0 0,0 6,-15A1.95131,1.95131 0 0,0 3,-17Z"/>\r
      <revolve\r
          position="-0.5,-0.117539,15.459694"\r
          rotation="0,28.247878,90"\r
          d="M1.1,-1L1.1,0"\r
          angle="120.054539"/>\r
      <revolve\r
          position="-0.5,-0.129065,15.846975"\r
          rotation="0,30.483991,90"\r
          d="M0.3,-1L0.3,0"\r
          angle="115.662107"/>\r
      <revolve\r
          position="-0.5,-3.404409,12.9"\r
          rotation="0,31.668243,-90"\r
          d="M2,0L2,1"\r
          angle="58.331757"/>\r
      <revolve position="-0.5,3.404409,12.9" rotation="0,90,-90" d="M2,0L2,1" angle="58.331757"/>\r
    </group>\r
  </defs>\r
  <use ref="box"/>\r
  <use ref="box_top"/>\r
  <use ref="side_ties"/>\r
  <use ref="top_bowtie"/>\r
</es3d>\r
`,t=1.15,n=[{id:`red`,name:`Red`,swatch:`#e31c24`,detail:`Bright red paper, an ivory bow, and a bottle.`,paper:`#e31c24`,ribbon:`#f4efe6`,background:`#1e2a3a`,sky:`#31445f`,ground:`#141b27`,inside:`bottle`},{id:`blush`,name:`Blush`,swatch:`#f6ddd4`,detail:`Pale rose paper, a navy bow, and a bottle.`,paper:`#f6ddd4`,ribbon:`#102848`,background:`#c45c3c`,sky:`#f0b9a4`,ground:`#8a3828`,inside:`bottle`},{id:`ink`,name:`Ink`,swatch:`#161513`,detail:`Charcoal paper, a bronze bow, and a stone.`,paper:`#161513`,ribbon:`#8d5a00`,background:`#f7f4ee`,sky:`#fffaf3`,ground:`#e6dfd2`,inside:`gem`},{id:`sage`,name:`Sage`,swatch:`#d7e6cc`,detail:`Pale green paper, a red bow, and a small tree.`,paper:`#d7e6cc`,ribbon:`#c2412d`,background:`#121820`,sky:`#243044`,ground:`#0c1016`,inside:`plant`}],r={bottle:`
  <cylinder radius="0.13" height="0.24" position="0,0.15,0" material="liquid"/>
  <revolve d="M0,0 L0.16,0 L0.17,0.02 L0.155,0.28 L0.075,0.34 L0.068,0.42 L0,0.42 Z" material="glass"/>
  <cylinder radius="0.046" height="0.05" position="0,0.445,0" material="gold"/>`,gem:`
  <box size="0.34,0.04,0.24" position="0,0.02,0" material="velvet"/>
  <mesh smooth="0" position="0,0.13,0" material="stone"
    positions="0 0.12 0  0.08 0.01 0  0 0.01 0.08  -0.08 0.01 0  0 0.01 -0.08  0 -0.08 0"
    indices="0 2 1  0 3 2  0 4 3  0 1 4  5 1 2  5 2 3  5 3 4  5 4 1"/>`,plant:`
  <revolve d="M0,0 L0.1,0 L0.11,0.016 L0.072,0.07 L0.12,0.09 L0.11,0.15 L0,0.15 Z" material="clay"/>
  <cylinder radius="0.085" height="0.02" position="0,0.13,0" material="soil"/>
  <cylinder radius="0.008" height="0.12" position="0,0.21,0" material="stem"/>
  <cone radius="0.09" height="0.16" position="0,0.32,0" material="leaf"/>`};async function i(){let t=e.indexOf(`<defs>`)+6;return{defs:e.slice(t,e.indexOf(`</defs>`,t)).trim()}}function a(e=`red`,i){let a=n.find(t=>t.id===e)||n[0];return`<?xml version="1.0" encoding="UTF-8"?>
<es3d version="1">
  <title>Parcel ${a.name}</title>
  <environment background="${a.background}" sky="${a.sky}" ground="${a.ground}" intensity="0.75" exposure="1.08"/>
  <camera position="0.72,5.06,4.49" target="0,1.12,0" fov="32"/>
  <light type="hemisphere" color="#fff6ec" groundColor="#e4d3c0" intensity="0.28"/>
  <light type="directional" direction="-0.35,-1,-0.4" intensity="1.7" color="#fff4e8"/>
  <light type="directional" direction="0.55,-0.2,0.35" intensity="0.55" color="#d5e4f8"/>

  <material id="paper" color="${a.paper}" roughness="0.72"/>
  <material id="ribbon" color="${a.ribbon}" roughness="0.38"/>
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
    ${i.defs}
  </defs>

  <group name="box" position="0,0.68,0" scale="0.068">
    <use ref="box" material="paper"/>
    <use ref="side_ties" material="ribbon"/>
    <group position="0,9,-11">
      <animate attr="rotation" from="0,0,0" to="-78,0,0" dur="${t}s" repeat="1" easing="ease-in-out"/>
      <group position="0,-9,11">
        <use ref="box_top" material="paper"/>
        <use ref="top_bowtie" material="ribbon"/>
      </group>
    </group>
  </group>

  <group position="0,0.16,0" scale="2">
    ${r[a.inside]}
  </group>
</es3d>`}export{n as i,a as n,i as r,t};
//# sourceMappingURL=scene-CW8VxoY4.js.map