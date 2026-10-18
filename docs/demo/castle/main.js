// Lorem Ipsum: the page around the flight.
//
// The castle is one ES3D document (src/scene/castle.es3d). Its first camera is
// driven by page scroll: <controls mode="scroll"/> plus animations with
// timeline="scroll", whose keyTimes match the [data-es3d-stop] markers in
// castle/es3d/index.html. This file starts the stage, keeps the page chrome in step with
// the flight, and adds what a page needs around it: a loader, chapter
// navigation, a free-orbit mode with picking, the source drawers and a still
// for browsers that cannot draw 3D.

import { createStage, compile, parse, walk } from '../../../src/index.js';
import sceneSource from './scene/castle.es3d?raw';
import sceneUrl from './scene/castle.es3d?url';
import './plaques.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const params = new URLSearchParams(location.search);
const docEl = document.documentElement;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const phone = matchMedia('(max-width: 720px)');
const portrait = matchMedia('(orientation: portrait)');

/** Progress values of the chapter stops, in page order (see keyTimes in the scene). */
const stops = $$('[data-es3d-stop]').map((el) => Number(el.dataset.es3dStop));

// ---------------------------------------------------------------------------
// The document, adapted to the device

/**
 * Phones and low-memory devices get a thinner forest: every scatter inside the
 * "Forest" group places fewer trees. The rest of the document is untouched.
 */
function adaptToDevice(src) {
  const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
  const factor = params.has('detail') ? Number(params.get('detail')) : phone.matches || lowMemory ? 0.45 : 1;
  if (!(factor > 0 && factor < 1)) return src;
  const start = src.indexOf('<group name="Forest">');
  const end = src.indexOf('</group>', start);
  if (start < 0 || end < 0) return src;
  const forest = src.slice(start, end).replace(/count="(\d+)"/g, (_, n) => `count="${Math.max(1, Math.round(n * factor))}"`);
  return src.slice(0, start) + forest + src.slice(end);
}

/**
 * The scene carries two framings of the flight: "Flight" for landscape
 * screens and "Flight portrait" for tall ones. A reader shows the first
 * camera, so on a tall screen the portrait one is moved to the front.
 */
function framedFor(src, tall) {
  if (!tall) return src;
  const land = src.indexOf('  <camera name="Flight" ');
  const port = src.indexOf('  <camera name="Flight portrait"');
  if (land < 0 || port < land) return src;
  const portEnd = src.indexOf('</camera>', port) + '</camera>\n'.length;
  return src.slice(0, land) + src.slice(port, portEnd) + src.slice(land, port) + src.slice(portEnd);
}

/** The same world for free exploration: orbit with limits, and the camera stops at walls. */
function exploreVersion(src) {
  const scroll = '<controls mode="scroll"/>';
  if (!src.includes(scroll)) throw new Error('castle.es3d: expected <controls mode="scroll"/>');
  return src.replace(scroll, '<controls mode="orbit" minDistance="16" maxDistance="780" maxPolar="88" collide="true" targetMin="-170,10,-170" targetMax="170,230,170"/>');
}

const adapted = adaptToDevice(sceneSource);
let source = framedFor(adapted, portrait.matches);
let exploreSource = exploreVersion(source);

// ---------------------------------------------------------------------------
// Page chrome that works with or without 3D

const header = $('#site-header');
let scrollQueued = false;
const onScroll = () => {
  if (scrollQueued) return;
  scrollQueued = true;
  requestAnimationFrame(() => {
    scrollQueued = false;
    header.classList.toggle('is-scrolled', scrollY > 24);
  });
};
addEventListener('scroll', onScroll, { passive: true });
onScroll();

/** Scroll so that a section's stop marker sits in the middle of the viewport: its key view. */
function scrollToSection(section) {
  const marker = $('.stop', section);
  const target = scrollY + marker.getBoundingClientRect().top - innerHeight / 2;
  scrollTo({ top: Math.max(0, target), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

// links to a chapter fly to its key view; other in-page links (the skip
// link) keep their usual behaviour
const menu = $('#mobile-menu');
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="#"]');
  if (!link) return;
  const id = link.getAttribute('href').slice(1);
  const section = id && document.getElementById(id);
  if (!section || !$('.stop', section)) return;
  event.preventDefault();
  try {
    if (menu.matches(':popover-open')) menu.hidePopover();
  } catch {
    // no popover support: the menu button does nothing there anyway
  }
  scrollToSection(section);
  history.replaceState(null, '', `#${id}`);
});

// chapter rail: the stop nearest to the camera's progress is the current
// step; the header and phone menus mark the same chapter where they list it
const railLinks = $$('.rail a');
const chapterIds = railLinks.map((a) => a.getAttribute('href').slice(1));
const menuLinks = $$('.site-nav a, .mobile-menu-list a');
let currentStep = -1;
function updateRail(progress) {
  let best = 0;
  for (let i = 1; i < stops.length; i++) if (Math.abs(stops[i] - progress) < Math.abs(stops[best] - progress)) best = i;
  if (best === currentStep) return;
  currentStep = best;
  railLinks.forEach((a, i) => (i === best ? a.setAttribute('aria-current', 'step') : a.removeAttribute('aria-current')));
  const href = `#${chapterIds[best]}`;
  menuLinks.forEach((a) => (a.getAttribute('href') === href ? a.setAttribute('aria-current', 'location') : a.removeAttribute('aria-current')));
}

// without a stage, progress follows the page scroll through the tour
const tour = $('#tour');
function pageProgress() {
  const r = tour.getBoundingClientRect();
  const range = r.height - innerHeight;
  return range > 0 ? Math.min(1, Math.max(0, -r.top / range)) : 0;
}

// Progress is set on the two bars that draw it. Set on the root, an
// inherited custom property would restyle the whole page on every frame
// of scrolling.
const progressBars = $$('.progress-line span, .rail-track span');
let shownProgress = -1;
function showProgress(p) {
  if (Math.abs(p - shownProgress) < 0.0005) return;
  shownProgress = p;
  const value = p.toFixed(4);
  for (const bar of progressBars) bar.style.setProperty('--progress', value);
  updateRail(p);
}

// the chapter rail bows out once the flight is over
new IntersectionObserver(([entry]) => document.body.classList.toggle('past-tour', entry.isIntersecting), { rootMargin: '0px 0px -40% 0px' }).observe($('.made-of'));

// download the scene exactly as written; inside a frame, where downloads are
// often blocked, offer to copy it instead
const download = $('#download-scene');
download.href = sceneUrl;
if (window.self !== window.top) {
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = download.className;
  copy.innerHTML = download.innerHTML.replace('Download the scene', 'Copy the scene');
  copy.querySelector('use').setAttribute('href', '#i-code');
  download.replaceWith(copy);
  copy.addEventListener('click', async () => {
    const label = copy.lastChild;
    try {
      await navigator.clipboard.writeText(sceneSource);
      label.textContent = 'Copied castle.es3d';
    } catch {
      label.textContent = 'Copy blocked here';
    }
    setTimeout(() => (label.textContent = 'Copy the scene'), 2400);
  });
}

// ---------------------------------------------------------------------------
// Source drawers: each chapter shows the ES3D that builds what is on screen,
// sliced from the document by element name or id, comments and all.

const sourceDoc = parse(sceneSource);

function findElements(names) {
  const wanted = new Set(names);
  const found = [];
  walk(sourceDoc.root, (el) => {
    if (el.type !== 'element') return false;
    const key = el.attr('name') ?? el.attr('id');
    if (key !== undefined && wanted.has(key)) {
      found.push(el);
      return false;
    }
    return undefined;
  });
  return found.sort((a, b) => a.start - b.start);
}

/** The element's text as written, with its own indentation removed. */
function sourceText(el) {
  const lineStart = sceneSource.lastIndexOf('\n', el.start - 1) + 1;
  const lines = sceneSource.slice(lineStart, el.end).split('\n');
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
  return lines.map((l) => l.slice(indent)).join('\n');
}

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function highlight(xml) {
  return xml
    .split(/(<!--[\s\S]*?-->)/)
    .map((part) => {
      if (part.startsWith('<!--')) return `<span class="tok-c">${escapeHtml(part)}</span>`;
      return escapeHtml(part).replace(/(&lt;\/?[\w-]+)|([\w:-]+)=("[^"]*")|(\/?&gt;)/g, (m, tag, name, value, close) => {
        if (tag) return `<span class="tok-t">${tag}</span>`;
        if (name) return `<span class="tok-a">${name}</span>=<span class="tok-v">${value}</span>`;
        return `<span class="tok-t">${close}</span>`;
      });
    })
    .join('');
}

const bytes = (n) => (n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`);

for (const details of $$('details[data-source]')) {
  details.addEventListener(
    'toggle',
    () => {
      const els = findElements(details.dataset.source.split(','));
      const text = els.map(sourceText).join('\n\n');
      const code = $('code', details);
      code.innerHTML = highlight(text);
      const meta = document.createElement('span');
      meta.className = 'meta';
      const lines = text.split('\n').length;
      meta.textContent = `${lines} lines · ${bytes(new TextEncoder().encode(text).length)} · from castle.es3d`;
      code.closest('pre').after(meta);
    },
    { once: true },
  );
}

// ---------------------------------------------------------------------------
// Loader

const loader = $('#loader');
function dismissLoader() {
  if (loader.classList.contains('is-done')) return;
  loader.classList.add('is-done');
  loader.setAttribute('aria-busy', 'false');
  document.body.classList.add('is-ready');
}

// ---------------------------------------------------------------------------
// The stage

let stage = null;
let exploring = false;
let exploreOpener = null;

// The tour never drags the camera, so the stage's orbit controls hold no
// listeners until someone explores. Their wheel listener is non-passive
// (it zooms), and on a full-screen canvas it would make every scroll of the
// page wait for the main thread while it draws the world: the text and
// buttons would stutter as they scroll. The handler names are those of the
// pinned @es3d/es3d 1.0.1 OrbitControls.
const CONTROL_EVENTS = [
  ['pointerdown', '_down'],
  ['pointermove', '_move'],
  ['pointerup', '_up'],
  ['pointercancel', '_up'],
  ['wheel', '_wheel', { passive: false }],
  ['contextmenu', '_ctx'],
  ['dblclick', '_dbl'],
];
function listenForControls(on) {
  const controls = stage.controls;
  for (const [type, key, options] of CONTROL_EVENTS) {
    if (typeof controls[key] !== 'function') continue;
    if (on) controls.el.addEventListener(type, controls[key], options);
    else controls.el.removeEventListener(type, controls[key]);
  }
}

async function start() {
  const canvas = $('#world');
  try {
    stage = await createStage(canvas, {
      scroll: tour,
      autoOrbit: false,
      backend: params.get('backend') || 'auto',
      onFrame,
      onPick,
      onError: (message) => console.error(message),
    });
  } catch (err) {
    return noStage(err);
  }
  listenForControls(false);
  // Same cap as the glTF page. The renderer default is 2; phones draw at 1.5.
  stage.renderer.options.maxPixelRatio = phone.matches ? 1.5 : 2;
  const result = stage.show(source);
  if (!result.ok) return noStage(new Error('castle.es3d did not compile'));
  if (params.has('debug')) window.__stage = stage;
  fillLedger(result, stage.kind === 'webgpu' ? 'WebGPU' : 'WebGL2');
  // turning a phone or tablet swaps the framing; the geometry is reused, so this is instant
  portrait.addEventListener('change', () => {
    source = framedFor(adapted, portrait.matches);
    exploreSource = exploreVersion(source);
    stage.show(exploring ? exploreSource : source);
  });
  setTimeout(dismissLoader, 12000); // never keep the page waiting on a slow GPU
}

let readyFrames = 0;
let ledgerClock = 0;
function onFrame(dt, api) {
  if (!exploring) showProgress(api.progress);
  // the veil lifts once the first view is drawn at full detail
  const s = api.renderer.stats;
  if (!loader.classList.contains('is-done')) {
    readyFrames = s.drawCalls > 0 && !s.refining ? readyFrames + 1 : 0;
    if (readyFrames >= 3) dismissLoader();
  }
  ledgerClock += dt;
  if (ledgerClock > 0.5) {
    ledgerClock = 0;
    setStat('triangles', s.triangles.toLocaleString('en'));
  }
}

function noStage(err) {
  console.warn('3D unavailable:', err);
  document.body.classList.add('no-3d');
  const note = $('#no-3d-note');
  note.hidden = false;
  $('button', note).addEventListener('click', () => (note.hidden = true));
  dismissLoader();
  // the document still compiles without a GPU, so its numbers are still true
  const result = compile(source);
  if (result.ok) fillLedger(result, 'A still image');
  setStat('triangles', 'None');
  const sync = () => showProgress(pageProgress());
  addEventListener('scroll', sync, { passive: true });
  sync();
}

// ---------------------------------------------------------------------------
// Ledger: live numbers about the document and this frame

function setStat(name, value, unit) {
  const el = $(`[data-stat="${name}"]`);
  if (!el) return;
  el.textContent = value;
  if (unit) {
    const small = document.createElement('small');
    small.textContent = unit;
    el.append(small);
  }
}

async function fillLedger(result, backend) {
  const { scene, timings } = result;
  setStat('instances', scene.count.toLocaleString('en'));
  setStat('geometries', scene.geometries.length.toLocaleString('en'));
  setStat('compile', String(Math.round(timings.parse + timings.build + timings.flatten)), 'ms');
  setStat('backend', backend);
  const raw = new TextEncoder().encode(sceneSource).length;
  let packed = null;
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([sceneSource]).stream().pipeThrough(new CompressionStream('gzip'));
    packed = (await new Response(stream).arrayBuffer()).byteLength;
  }
  const size = packed || raw;
  setStat('gzip', (size / 1024).toFixed(1), 'KB');
}

// ---------------------------------------------------------------------------
// Free exploration

const hud = $('#explore-hud');
const pickLabel = $('#pick-label');
let pointer = { x: 0, y: 0 };

function enterExplore(opener) {
  if (!stage || exploring) return;
  exploring = true;
  // from the phone menu, focus comes back to the menu button, not into the closed menu
  const fromMenu = opener && menu.contains(opener);
  exploreOpener = fromMenu ? $('.menu-button') : opener || null;
  try {
    if (menu.matches(':popover-open')) menu.hidePopover();
  } catch {
    // no popover support
  }
  document.body.classList.add('exploring');
  docEl.style.overflow = 'hidden';
  hud.hidden = false;
  stage.show(exploreSource);
  listenForControls(true);
  $('#explore-exit').focus({ preventScroll: true });
}

function exitExplore() {
  if (!exploring) return;
  exploring = false;
  pickLabel.classList.remove('is-visible');
  hud.hidden = true;
  listenForControls(false);
  stage.show(source);
  document.body.classList.remove('exploring');
  docEl.style.overflow = '';
  if (exploreOpener) exploreOpener.focus({ preventScroll: true });
}

for (const button of $$('[data-explore]')) button.addEventListener('click', () => enterExplore(button));
$('#explore-exit').addEventListener('click', exitExplore);
addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && exploring) exitExplore();
});
addEventListener(
  'pointerup',
  (event) => {
    pointer = { x: event.clientX, y: event.clientY };
  },
  { capture: true, passive: true },
);

/** "slabLit" -> "Slab lit"; names written for people pass through unchanged. */
const humanName = (n) => {
  const s = String(n).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

let pickTimer = 0;
function onPick(hit) {
  if (!exploring) return;
  clearTimeout(pickTimer);
  if (!hit || !hit.names.length) {
    pickLabel.classList.remove('is-visible');
    return;
  }
  const [first, ...rest] = hit.names.filter((n) => n !== 'Aetherhold').map(humanName);
  pickLabel.innerHTML = `<b>${escapeHtml(first || 'Aetherhold')}</b>${rest.length ? ` <span>· ${escapeHtml(rest.slice(0, 2).join(' · '))}</span>` : ''}`;
  const x = Math.min(innerWidth - 140, Math.max(140, pointer.x));
  pickLabel.style.left = `${x}px`;
  pickLabel.style.top = `${Math.max(60, pointer.y)}px`;
  pickLabel.classList.add('is-visible');
  pickTimer = setTimeout(() => pickLabel.classList.remove('is-visible'), 2600);
}

start();
