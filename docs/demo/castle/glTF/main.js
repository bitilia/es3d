// Lorem Ipsum, the glTF version: the same page around the same flight, drawn
// from castle.glb with three.js instead of from castle.es3d with ES3D.
//
// castle.glb is exported from castle.es3d by scripts/export-gltf.mjs, and
// ./stage.js draws it. The page chrome below is src/main.js's, less what only
// a text format offers (the source drawers, compiling for numbers without a
// GPU), so the two pages can be compared side by side.

import { createGltfStage } from './stage.js';
import sceneUrl from '../scene/castle.glb?url';
import '../plaques.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const params = new URLSearchParams(location.search);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const phone = matchMedia('(max-width: 720px)');
const portrait = matchMedia('(orientation: portrait)');
const docEl = document.documentElement;

/** Progress values of the chapter stops, in page order (see keyTimes in the scene). */
const stops = $$('[data-es3d-stop]').map((el) => Number(el.dataset.es3dStop));

/** Phones and low-memory devices get a thinner forest, as on the ES3D page. */
function detailFactor() {
  const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
  return params.has('detail') ? Number(params.get('detail')) : phone.matches || lowMemory ? 0.45 : 1;
}

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

const tour = $('#tour');
function pageProgress() {
  const r = tour.getBoundingClientRect();
  const range = r.height - innerHeight;
  return range > 0 ? Math.min(1, Math.max(0, -r.top / range)) : 0;
}

// progress is set on the two bars that draw it, not on the root (see src/main.js)
const progressBars = $$('.progress-line span, .rail-track span');
let shownProgress = -1;
function showProgress(p) {
  if (Math.abs(p - shownProgress) < 0.0005) return;
  shownProgress = p;
  const value = p.toFixed(4);
  for (const bar of progressBars) bar.style.setProperty('--progress', value);
  updateRail(p);
}

new IntersectionObserver(([entry]) => document.body.classList.toggle('past-tour', entry.isIntersecting), { rootMargin: '0px 0px -40% 0px' }).observe($('.made-of'));

// download the scene as the page loads it
const download = $('#download-scene');
download.href = sceneUrl;

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

async function start() {
  const canvas = $('#world');
  try {
    stage = await createGltfStage(canvas, {
      url: sceneUrl,
      scroll: tour,
      detail: detailFactor(),
      tall: portrait.matches,
      // Same cap as the ES3D page: 2 device pixels per CSS pixel, 1.5 on a phone.
      maxPixelRatio: phone.matches ? 1.5 : 2,
      onFrame,
      onPick,
    });
  } catch (err) {
    return noStage(err);
  }
  if (params.has('debug')) window.__stage = stage;
  fillLedger();
  portrait.addEventListener('change', () => stage.setFraming(portrait.matches));
  dismissLoader();
}

let ledgerClock = 0;
function onFrame(dt, api) {
  if (!exploring) showProgress(api.progress);
  ledgerClock += dt;
  if (ledgerClock > 0.5) {
    ledgerClock = 0;
    setStat('triangles', api.stats.triangles.toLocaleString('en'));
  }
}

function noStage(err) {
  console.warn('3D unavailable:', err);
  document.body.classList.add('no-3d');
  const note = $('#no-3d-note');
  note.hidden = false;
  $('button', note).addEventListener('click', () => (note.hidden = true));
  dismissLoader();
  setStat('triangles', 'None');
  setStat('backend', 'A still image');
  const sync = () => showProgress(pageProgress());
  addEventListener('scroll', sync, { passive: true });
  sync();
}

// ---------------------------------------------------------------------------
// Ledger: live numbers about the file and this frame

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

async function fillLedger() {
  setStat('instances', stage.instances.toLocaleString('en'));
  setStat('geometries', stage.gltf.parser.json.meshes.length.toLocaleString('en'));
  setStat('compile', String(Math.round(stage.load.parseMs)), 'ms');
  setStat('backend', 'WebGL2 · three.js');
  let size = stage.load.bytes;
  if (typeof CompressionStream === 'function') {
    const res = await fetch(sceneUrl);
    const stream = res.body.pipeThrough(new CompressionStream('gzip'));
    size = (await new Response(stream).arrayBuffer()).byteLength;
  }
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
  stage.explore(true);
  $('#explore-exit').focus({ preventScroll: true });
}

function exitExplore() {
  if (!exploring) return;
  exploring = false;
  pickLabel.classList.remove('is-visible');
  hud.hidden = true;
  stage.explore(false);
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

const escapeHtml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

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
