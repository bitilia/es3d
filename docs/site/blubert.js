// Blubert: a small blue rag doll who lives behind the page. Drawn with ES3D.
//
// The page is a white panel on a pale field (.site on the body's background).
// The doll's canvas lies under the panel, along the bottom of the window, and
// is cleared to the field's own colour, so it cannot be seen: only the doll
// can, where he steps out past the panel's edge. Now and then he peeks out
// and waves, walks into the margin and looks around, sits down, hops, takes a
// tumble, or rises from the bottom of the window. Bring the pointer close and
// he hurries back; click next to him and he waves.
//
// site.js loads this file only when the browser is idle, the visitor has not
// asked for reduced motion, and the margin beside the panel is wide enough.
// Nothing here is needed by the page: remove the call in site.js and he is gone.
//
// ?blubert=all on any page shows every routine in turn, ?blubert=peek (or stroll,
// sit, hop, tumble, rise, thrown) one of them, again and again; ?blubert=off hides him.
//
// On the home page he also climbs up behind the top edge of the page once per
// visit, leans over it, and falls back (leanOverTop, started by home.js);
// ?blubert=lean makes him do it on every load.

import { createStage } from '../../src/render/stage.js';

const HEIGHT = 230; // canvas height in CSS pixels; one world unit is one pixel
const MIN_MARGIN = 96; // room he needs beside the panel

// --- the doll -------------------------------------------------------------------

// Pivots, in pixels: each group turns about its own origin.
const BASE = {
  body: [0, 40, 0], // hips
  legL: [-8, 0, 0],
  legR: [8, 0, 0],
  torso: [0, 0, 0],
  armL: [-18, 34, 0], // shoulders
  armR: [18, 34, 0],
  head: [0, 38, 0], // neck
  eyes: [0, 23, 18],
  stars: [0, 48, 0], // above his head
};

const DOLL = `<es3d version="1">
  <environment background="#e7f3f1" sky="#ffffff" ground="#dfeeea" intensity="0.5"/>
  <controls mode="none"/>
  <light type="directional" direction="-0.25,-0.7,-1" intensity="1.35"/>
  <light type="directional" direction="0.45,-0.15,0.5" intensity="0.4"/>
  <material id="blue" color="#0a4bff" roughness="0.55"/>
  <material id="eye" color="#0b1d4a" roughness="0.3"/>
  <material id="star" color="#ffd23f" emissive="#ffd23f" emissiveIntensity="0.4" roughness="0.5"/>
  <group id="doll">
    <group id="body" position="${BASE.body}">
      <group id="legL" position="${BASE.legL}">
        <capsule radius="6.5" height="42" position="0,-18,0" material="blue"/>
      </group>
      <group id="legR" position="${BASE.legR}">
        <capsule radius="6.5" height="42" position="0,-18,0" material="blue"/>
      </group>
      <group id="torso">
        <capsule radius="15" height="44" position="0,18,0" material="blue"/>
        <group id="armL" position="${BASE.armL}">
          <capsule radius="5.5" height="34" position="0,-13,0" material="blue"/>
        </group>
        <group id="armR" position="${BASE.armR}">
          <capsule radius="5.5" height="34" position="0,-13,0" material="blue"/>
        </group>
        <group id="head" position="${BASE.head}">
          <sphere radius="19" position="0,20,0" material="blue"/>
          <group id="eyes" position="${BASE.eyes}">
            <sphere radius="2.6" position="-6.5,0,-1" material="eye"/>
            <sphere radius="2.6" position="6.5,0,-1" material="eye"/>
          </group>
          <!-- seen only while he is dazed; parked far below the window otherwise -->
          <group id="stars" position="0,-2000,0">
            <sphere radius="3.2" position="16,0,0" material="star"/>
            <sphere radius="3.2" position="-8,0,13.9" material="star"/>
            <sphere radius="3.2" position="-8,0,-13.9" material="star"/>
          </group>
        </group>
      </group>
    </group>
  </group>
</es3d>`;

// --- matrices (column-major, as setTransforms takes them) ------------------------

const D = Math.PI / 180;

/** T(p) · Ry · Rx · Rz · S(k, k·sy, k) */
function pose(p, rx = 0, ry = 0, rz = 0, sy = 1, k = 1) {
  const [cx, sx, cy, sy_, cz, sz] = [Math.cos(rx * D), Math.sin(rx * D), Math.cos(ry * D), Math.sin(ry * D), Math.cos(rz * D), Math.sin(rz * D)];
  // R = Ry * Rx * Rz
  const m00 = cy * cz + sy_ * sx * sz, m01 = -cy * sz + sy_ * sx * cz, m02 = sy_ * cx;
  const m10 = cx * sz, m11 = cx * cz, m12 = -sx;
  const m20 = -sy_ * cz + cy * sx * sz, m21 = sy_ * sz + cy * sx * cz, m22 = cy * cx;
  return [m00 * k, m10 * k, m20 * k, 0, m01 * sy * k, m11 * sy * k, m21 * sy * k, 0, m02 * k, m12 * k, m22 * k, 0, p[0], p[1], p[2], 1];
}

// --- timing helpers ---------------------------------------------------------------

const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (u) => u * u * (3 - 2 * u);
const lerp = (a, b, u) => a + (b - a) * u;
const rand = (a, b) => a + Math.random() * (b - a);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

/** The doll's pose: where he is and how every joint is turned (degrees). */
function restPose() {
  // spin turns him about his hips (a throw); stars > 0 shows the stars circling a dazed head
  return { x: 0, y: -400, lean: 0, face: 0, bob: 0, spin: 0, legL: 0, legR: 0, armL: 0, armR: 0, armLx: 0, armRx: 0, headX: 0, headY: 0, headZ: 0, sit: 0, blink: 1, stars: 0, starTurn: 0 };
}

/**
 * A routine is a list of steps. Each step lasts `dur` seconds and sets the
 * pose from `u`, its progress 0..1, and the pose it started from. A step's
 * start(from) runs once, before its first frame (a walk measures its way).
 */
function run(steps) {
  let i = 0;
  let t = 0;
  let from = null;
  return (p, dt) => {
    while (i < steps.length) {
      const s = steps[i];
      if (!from) {
        from = { ...p };
        if (s.start) s.start(from);
      }
      t += dt;
      dt = 0;
      const u = s.dur > 0 ? clamp(t / s.dur) : 1;
      s.set(p, u, from, t);
      if (u < 1) return true;
      t = 0;
      from = null;
      i++;
    }
    return false;
  };
}

/** Blend the listed pose values towards `to` (a value or a function of the start pose). */
const to = (dur, target, ease = smooth) => ({
  dur,
  set(p, u, from) {
    const e = ease(u);
    for (const [k, v] of Object.entries(target)) p[k] = lerp(from[k], typeof v === 'function' ? v(from) : v, e);
  },
});

const wait = (dur) => ({ dur, set() {} });

/** Walk to x at `speed` px/s, turned towards it, legs and arms swinging. */
const walk = (target, speed = 52) => {
  let goal = 0;
  let dir = 1;
  return {
    dur: 0,
    start(from) {
      goal = typeof target === 'function' ? target() : target;
      dir = Math.sign(goal - from.x) || 1;
      this.dur = Math.abs(goal - from.x) / speed;
    },
    set(p, u, from, t) {
      p.x = lerp(from.x, goal, u);
      const phase = t * 9;
      const swing = Math.sin(phase) * 26 * (u < 1 ? 1 : 0);
      p.face = lerp(from.face, 62 * dir, clamp(t * 4));
      p.legL = swing;
      p.legR = -swing;
      p.armLx = -swing * 0.8;
      p.armRx = swing * 0.8;
      p.armL = -8;
      p.armR = 8;
      p.bob = Math.abs(Math.sin(phase)) * 2.2;
      p.headZ = Math.sin(phase * 0.5) * 3;
    },
  };
};

const stand = (dur = 0.35) => to(dur, { face: 0, legL: 0, legR: 0, armLx: 0, armRx: 0, armL: 0, armR: 0, bob: 0, headZ: 0 });

/** Wave the arm on side `s` (+1 right, -1 left) `n` times. */
const wave = (s, n = 3) => ({
  dur: 0.4 + n * 0.42,
  set(p, u, from, t) {
    const key = s > 0 ? 'armR' : 'armL';
    const up = smooth(clamp(t / 0.35));
    // a right arm swings out and up with a positive turn about z, a left one with a negative
    p[key] = s * (150 * up + Math.sin(Math.max(0, t - 0.35) * 15) * 22 * up);
    p.headZ = s * -6 * up;
  },
});

const lower = (s) => to(0.35, { [s > 0 ? 'armR' : 'armL']: 0, headZ: 0 });

const look = (dur = 2.2) => ({
  dur,
  set(p, u) {
    p.headY = Math.sin(u * Math.PI * 2) * 38;
    p.headX = -Math.sin(u * Math.PI) * 8;
  },
});

const hop = (height = 34) => ({
  dur: 0.55,
  set(p, u, from) {
    const air = Math.sin(u * Math.PI);
    p.y = from.y + air * height;
    p.armL = -70 * air;
    p.armR = 70 * air;
    p.legL = p.legR = -18 * air;
    p.bob = -3 * Math.sin(u * Math.PI * 2);
  },
});

// --- the stage ----------------------------------------------------------------------

/**
 * Start the doll. Resolves to a function that removes him.
 * @param {{only?: string}} [opts] only: a routine name to repeat, or 'all' for each in turn
 */
export async function startBlubert(opts = {}) {
  const panel = document.querySelector('.site');
  if (!panel) return () => {};
  const box = document.createElement('div');
  box.className = 'blubert';
  box.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  box.append(canvas);
  document.body.append(box);

  const p = restPose();
  let routine = null;
  const showcase = opts.only || null;
  let next = 0;
  let idleUntil = performance.now() + (showcase ? 800 : rand(3000, 7000));
  let blinkAt = performance.now() + rand(1500, 4000);
  let side = 1;
  let pointer = { x: -1e4, y: -1e4 };
  let dirty = true;
  let floor = 0;

  const stage = await createStage(canvas, {
    background: true,
    interactive: false,
    geometryStore: false,
    changeBudget: 2,
    onFrame: (dt) => frame(dt),
  });
  stage.show(DOLL);
  const cam = stage.camera;
  cam.type = 'orthographic';
  cam.fit = 'height';
  cam.orthoHeight = HEIGHT;
  cam.position = [0, HEIGHT / 2, 600];
  cam.target = [0, HEIGHT / 2, 0];
  cam.up = [0, 1, 0];
  cam.near = 1;
  cam.far = 1500;

  // where things are on screen, in the doll's units (pixels from the window's centre)
  const layout = () => {
    const r = panel.getBoundingClientRect();
    const w = window.innerWidth;
    return {
      left: r.left - w / 2,
      right: r.right - w / 2,
      margin: Math.min(r.left, w - r.right),
      // at the end of the page the panel stops above the window's bottom edge:
      // he stands on that edge then, so he is hidden behind the panel whole
      floor: Math.max(0, window.innerHeight - r.bottom),
      covered: r.bottom >= window.innerHeight - 2,
      w,
    };
  };
  const edge = (L, s) => (s > 0 ? L.right : L.left);
  const behind = (L, s) => edge(L, s) - s * 46;
  const out = (L, s) => edge(L, s) + s * Math.min(L.margin * 0.5, 120);

  const routines = {
    // leans out past the edge, waves, leans back
    peek(L, s) {
      const x0 = edge(L, s) - s * 18;
      return run([
        to(0, { x: x0, y: 0, face: 0, lean: 0 }),
        to(0.7, { lean: -s * 24, headZ: -s * 10 }),
        wait(0.25),
        wave(s, 3),
        lower(s),
        wait(0.4),
        to(0.6, { lean: 0, headZ: 0 }),
        to(0, { y: -400 }),
      ]);
    },
    // walks into the margin, looks around, waves, walks back
    stroll(L, s) {
      return run([
        to(0, { x: behind(L, s), y: 0, lean: 0 }),
        walk(() => out(layout(), s)),
        stand(),
        look(2.4),
        wave(s, 2),
        lower(s),
        walk(() => behind(layout(), s)),
        stand(0.1),
        to(0, { y: -400 }),
      ]);
    },
    // walks out and sits down at the bottom of the window, swinging his legs
    sit(L, s) {
      return run([
        to(0, { x: behind(L, s), y: 0, lean: 0 }),
        walk(() => out(layout(), s)),
        stand(),
        to(0.6, { sit: 1, y: -24, legL: -82, legR: -82, armL: -20, armR: 20 }),
        {
          dur: 3.2,
          set(q, u, from, t) {
            q.legL = -82 + Math.sin(t * 5) * 14;
            q.legR = -82 - Math.sin(t * 5) * 14;
            q.headX = -12 + Math.sin(t * 1.3) * 4;
            q.headY = Math.sin(t * 0.9) * 18;
          },
        },
        to(0.5, { sit: 0, y: 0, legL: 0, legR: 0, armL: 0, armR: 0, headX: 0, headY: 0 }),
        walk(() => behind(layout(), s)),
        stand(0.1),
        to(0, { y: -400 }),
      ]);
    },
    // walks out and hops twice
    hop(L, s) {
      return run([
        to(0, { x: behind(L, s), y: 0, lean: 0 }),
        walk(() => out(layout(), s)),
        stand(),
        hop(),
        wait(0.15),
        hop(42),
        wait(0.3),
        wave(s, 2),
        lower(s),
        walk(() => behind(layout(), s), 70),
        stand(0.1),
        to(0, { y: -400 }),
      ]);
    },
    // walks out, trips over, lies there for a moment, gets up and dusts off
    tumble(L, s) {
      return run([
        to(0, { x: behind(L, s), y: 0, lean: 0 }),
        walk(() => out(layout(), s), 64),
        to(0.35, { lean: -s * 92, y: 8, armL: -60, armR: 60, legL: 20, legR: -10, face: 0 }, (u) => u * u),
        to(0.18, { y: 0 }),
        wait(1.1),
        to(0.8, { lean: 0, armL: 0, armR: 0, legL: 0, legR: 0 }),
        { dur: 0.9, set(q, u, from, t) { q.armRx = Math.sin(t * 18) * 25; q.armR = -30; q.armL = 10; } },
        to(0.25, { armRx: 0, armR: 0, armL: 0 }),
        look(1.4),
        walk(() => behind(layout(), s)),
        stand(0.1),
        to(0, { y: -400 }),
      ]);
    },
    // flung out from behind the middle of the page: he flies over the panel's
    // edge, spinning and flailing, lands in a heap, gets up dazed with stars
    // circling his head, shakes it off and runs back
    thrown(L, s) {
      const x0 = behind(L, s) - s * 160;
      return run([
        to(0, { x: x0, y: 0, lean: 0, face: 0, spin: 0 }),
        {
          dur: 1.05,
          start(from) {
            this.x1 = out(layout(), s);
          },
          set(q, u, from, t) {
            q.x = lerp(from.x, this.x1, u);
            // an arc that ends with him lying on his side (hips 16 px off the ground)
            q.y = lerp(0, -24, u) + 4 * 92 * u * (1 - u);
            q.spin = -s * 450 * u; // a turn and a quarter: he lands on his side
            q.armL = -95 + Math.sin(t * 24) * 45;
            q.armR = 95 + Math.sin(t * 24 + 1.3) * 45;
            q.legL = Math.sin(t * 19) * 45;
            q.legR = -Math.sin(t * 19) * 45;
            q.headZ = Math.sin(t * 17) * 20;
          },
        },
        // the same pose, written as a quarter turn
        to(0, { spin: -s * 90, armL: -30, armR: 30, legL: 15, legR: -10, headZ: 0 }),
        to(0.16, { y: -12 }, (u) => 1 - (1 - u) * (1 - u)),
        to(0.18, { y: -24 }, (u) => u * u),
        wait(0.9),
        to(0.75, { spin: 0, y: 0, armL: 0, armR: 0, legL: 0, legR: 0 }),
        // dazed: he sways, his head rolls, and stars go round
        {
          dur: 2.8,
          set(q, u, from, t) {
            const fade = Math.min(1, t * 3, (2.8 - t) * 3);
            q.stars = fade;
            q.starTurn = t * 260;
            q.lean = Math.sin(t * 2.6) * 7 * fade;
            q.headZ = Math.sin(t * 5) * 15 * fade;
            q.headX = Math.cos(t * 5) * 9 * fade;
            q.armL = -10 + Math.sin(t * 2.6) * 8;
            q.armR = 10 + Math.sin(t * 2.6) * 8;
          },
        },
        to(0.1, { stars: 0, lean: 0, headX: 0, headZ: 0, armL: 0, armR: 0 }),
        // shakes it off
        { dur: 0.5, set(q, u) { q.headY = Math.sin(u * Math.PI * 6) * 28 * (1 - u); } },
        walk(() => behind(layout(), s), 165),
        stand(0.05),
        to(0, { y: -400 }),
      ]);
    },
    // rises from below the window in the margin, waves, sinks again
    rise(L, s) {
      return run([
        to(0, { x: out(L, s), y: -150, lean: 0, face: 0 }),
        to(1.1, { y: 0 }),
        look(1.6),
        wave(-s, 3),
        lower(-s),
        to(0.9, { y: -150 }, (u) => u * u),
        to(0, { y: -400 }),
      ]);
    },
  };

  // he hurries back behind the panel
  const flee = () =>
    run([
      to(0.15, { sit: 0, y: 0, lean: 0, spin: 0, stars: 0, legL: 0, legR: 0, headX: 0, headY: 0 }),
      hop(22),
      walk(() => behind(layout(), side), 150),
      stand(0.05),
      to(0, { y: -400 }),
    ]);

  const begin = () => {
    const L = layout();
    if (L.margin < MIN_MARGIN) return;
    side = Math.random() < 0.5 ? -1 : 1;
    // rising from below the window needs the panel to reach the window's edge
    const all = Object.keys(routines).filter((n) => n !== 'rise' || L.covered);
    let names = L.covered ? ['peek', 'peek', 'stroll', 'stroll', 'sit', 'hop', 'tumble', 'thrown', 'rise'] : all;
    if (showcase === 'all') names = [all[next++ % all.length]];
    else if (routines[showcase] && (showcase !== 'rise' || L.covered)) names = [showcase];
    floor = L.floor;
    routine = routines[pick(names)](L, side);
  };

  const apply = () => {
    stage.setTransforms([
      ['doll', pose([p.x, p.y + floor, 0], 0, p.face, p.lean)],
      ['body', pose([BASE.body[0], BASE.body[1] + p.bob, 0], 0, 0, p.spin)],
      ['legL', pose(BASE.legL, p.legL)],
      ['legR', pose(BASE.legR, p.legR)],
      ['armL', pose(BASE.armL, p.armLx, 0, p.armL)],
      ['armR', pose(BASE.armR, p.armRx, 0, p.armR)],
      ['head', pose(BASE.head, p.headX, p.headY, p.headZ)],
      ['eyes', pose(BASE.eyes, 0, 0, 0, p.blink)],
      ['stars', p.stars > 0.01 ? pose([BASE.stars[0], BASE.stars[1] + (1 - p.stars) * 12, 0], 0, p.starTurn) : pose([0, -2000, 0])],
    ]);
  };

  function frame(dt) {
    const now = performance.now();
    // follow the panel's bottom edge while the page scrolls
    if (routine || p.y > -100) {
      const f = layout().floor;
      if (f !== floor) {
        floor = f;
        dirty = true;
      }
    }
    if (!routine && now > idleUntil) begin();
    if (routine) {
      // too close: back behind the panel
      const L = layout();
      const sx = p.x + L.w / 2;
      const sy = window.innerHeight - (p.y + floor + 60);
      if (p.y > -60 && Math.hypot(pointer.x - sx, pointer.y - sy) < 85 && !routine.fleeing) {
        routine = flee();
        routine.fleeing = true;
      }
      if (!routine(p, dt)) {
        routine = null;
        idleUntil = now + (showcase ? 1200 : rand(9000, 22000));
      }
      dirty = true;
    }
    // a blink now and then, while he is in view
    if (p.y > -100 && now > blinkAt) {
      const k = (now - blinkAt) / 140;
      p.blink = k < 1 ? 1 - Math.sin(k * Math.PI) * 0.9 : 1;
      if (k >= 1) blinkAt = now + rand(2000, 5000);
      dirty = true;
    }
    if (dirty) {
      apply();
      dirty = false;
    }
  }

  const onMove = (e) => {
    pointer = { x: e.clientX, y: e.clientY };
  };
  const onClick = (e) => {
    if (routine && !routine.fleeing) return;
    const L = layout();
    const sx = p.x + L.w / 2;
    if (p.y > -60 && Math.abs(e.clientX - sx) < 60 && e.clientY > window.innerHeight - floor - 160 && e.clientY < window.innerHeight - floor) {
      routine = run([hop(30), wave(side, 2), lower(side), walk(() => behind(layout(), side)), stand(0.1), to(0, { y: -400 })]);
    }
  };
  addEventListener('pointermove', onMove, { passive: true });
  addEventListener('click', onClick);
  apply();

  return () => {
    removeEventListener('pointermove', onMove);
    removeEventListener('click', onClick);
    stage.dispose();
    box.remove();
  };
}

// --- over the top of the page (home page) -------------------------------------------

const TOP_HEIGHT = 150; // canvas height in CSS pixels, from the top of the window
const TOP_SCALE = 0.6; // smaller: the gap above the page is about 32 px

/**
 * Blubert climbs up behind the top edge of the page, rests his arms on it,
 * leans over and looks around, then loses his grip and falls back with his
 * hands flailing. The canvas lies under the page panel along the top of the
 * window, so only what rises above the edge shows. Once per visit, most of
 * the time, and only while the page is scrolled to the top.
 * @param {{force?: boolean}} [opts] force: every load (?blubert=lean)
 */
export async function leanOverTop(opts = {}) {
  const param = new URLSearchParams(location.search).get('blubert');
  if (param === 'off') return;
  const force = opts.force || param === 'lean';
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!force) {
    if (reduced) return;
    let seen = false;
    try {
      seen = sessionStorage.getItem('es3d-blubert-top') === '1';
      sessionStorage.setItem('es3d-blubert-top', '1');
    } catch {
      // no storage: he may lean over again on the next load
    }
    if (seen || Math.random() > 0.85) return;
  }
  const panel = document.querySelector('.site');
  if (!panel || window.scrollY > 4 || panel.getBoundingClientRect().top < 16) return;

  const box = document.createElement('div');
  box.className = 'blubert blubert-top';
  box.setAttribute('aria-hidden', 'true');
  const canvas = document.createElement('canvas');
  box.append(canvas);
  document.body.append(box);

  const K = TOP_SCALE;
  const p = restPose();
  let x = 0;
  let finished = false;
  // y is his feet, measured from the page's top edge; his shoulders sit at 70 units
  const reach = -70 * K;
  const routine = run([
    to(0, { y: -170, armL: 0, armR: 0 }),
    wait(0.2),
    // up behind the edge, arms reaching for it
    to(0.6, { y: reach, armL: -168, armR: 168, headX: -6 }, (u) => 1 - (1 - u) * (1 - u)),
    // leans over and looks around the page
    {
      dur: 2.6,
      set(q, u, from, t) {
        q.y = reach + Math.sin(t * 2.2) * 1.2;
        q.headY = Math.sin(t * 1.7) * 32;
        q.headX = -10 - Math.max(0, Math.sin(t * 1.1)) * 10;
        q.lean = Math.sin(t * 1.3) * 4;
      },
    },
    // the grip slips...
    to(0.22, { y: reach + 4, headX: 8, headY: 0, lean: 0 }),
    // ...and he falls back, hands flailing above the edge
    {
      dur: 0.95,
      set(q, u, from, t) {
        q.y = from.y - 300 * u * u;
        q.armL = -168 + Math.sin(t * 32) * 42;
        q.armR = 168 + Math.sin(t * 32 + 1.4) * 42;
        q.headZ = Math.sin(t * 21) * 18;
        q.lean = Math.sin(t * 9) * 12;
      },
    },
  ]);

  const stage = await createStage(canvas, {
    background: true,
    interactive: false,
    geometryStore: false,
    onFrame: (dt) => {
      if (finished) return;
      const r = panel.getBoundingClientRect();
      // scrolled away from the top: he drops out of sight
      if (r.top < 8) p.y = -400;
      x = r.left + r.width * 0.7 - window.innerWidth / 2;
      const going = routine(p, dt);
      const edge = TOP_HEIGHT - r.top;
      stage.setTransforms([
        ['doll', pose([x, edge + p.y, 0], 0, p.face, p.lean, 1, K)],
        ['body', pose([BASE.body[0], BASE.body[1] + p.bob, 0], 0, 0, p.spin)],
        ['legL', pose(BASE.legL, p.legL)],
        ['legR', pose(BASE.legR, p.legR)],
        ['armL', pose(BASE.armL, p.armLx, 0, p.armL)],
        ['armR', pose(BASE.armR, p.armRx, 0, p.armR)],
        ['head', pose(BASE.head, p.headX, p.headY, p.headZ)],
        ['eyes', pose(BASE.eyes, 0, 0, 0, p.blink)],
        ['stars', pose([0, -2000, 0])],
      ]);
      if (!going || p.y < -350) {
        finished = true;
        // done: give back the canvas and its GPU context
        setTimeout(() => {
          stage.dispose();
          box.remove();
        }, 50);
      }
    },
  });
  stage.show(DOLL);
  const cam = stage.camera;
  cam.type = 'orthographic';
  cam.fit = 'height';
  cam.orthoHeight = TOP_HEIGHT;
  cam.position = [0, TOP_HEIGHT / 2, 600];
  cam.target = [0, TOP_HEIGHT / 2, 0];
  cam.up = [0, 1, 0];
  cam.near = 1;
  cam.far = 1500;
}
