// Home page. The spinning logo is not a picture. It is rendered live from
// the ES3D source printed further down the same page.
//
// The page opens with the flat SVG logo, so nothing waits for the renderer.
// The renderer is loaded once the logo is on screen and the page has
// settled, or at once when someone reaches for the logo. When its first
// frame is drawn, the live logo fades in over the flat one.

const box = document.getElementById('logo3d');
const source = document.getElementById('logo-source');
const counter = document.getElementById('tri-counter');
const backendNote = document.getElementById('logo-backend');

function showCount(n) {
  const digits = String(Math.floor(n)).padStart(10, '0');
  counter.replaceChildren(
    ...[...digits].map((d) => {
      const b = document.createElement('b');
      b.textContent = d;
      return b;
    }),
  );
}

/** Call `start` once: when the box is on screen and the browser is idle, or on first touch. */
function whenWanted(el, start) {
  let started = false;
  const go = () => {
    if (started) return;
    started = true;
    io?.disconnect();
    start();
  };
  for (const type of ['pointerenter', 'pointerdown', 'focusin']) el.addEventListener(type, go, { once: true, passive: true });
  const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 200));
  const settled = (fn) => (document.readyState === 'complete' ? fn() : addEventListener('load', fn, { once: true }));
  const io =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) settled(() => idle(go));
        }, { rootMargin: '200px' })
      : null;
  if (io) io.observe(el);
  else settled(() => idle(go));
}

async function startLogo() {
  const live = document.createElement('div');
  live.className = 'logo-live';
  box.append(live);
  const { createViewer } = await import('./viewer.js');
  const viewer = await createViewer(live, { interactive: true });
  const res = viewer.load(source.textContent);
  if (!res.ok) throw new Error(res.diagnostics.length ? res.diagnostics[0].message : 'the logo did not compile');
  if (backendNote) backendNote.textContent = viewer.kind;
  if (counter) setInterval(() => showCount(viewer.trianglesDrawn), 500);
  // fade in once there is a picture to show
  const reveal = () => (viewer.trianglesDrawn > 0 ? box.classList.add('live') : requestAnimationFrame(reveal));
  reveal();
  const spin = viewer.playing;
  box.addEventListener('pointerenter', () => {
    viewer.playing = false;
  });
  box.addEventListener('pointerleave', () => {
    viewer.playing = spin;
  });
  // a mouse that started the load is already over the logo (a finger has
  // lifted by now, so a touch screen is left spinning)
  if (matchMedia('(hover: hover)').matches && box.matches(':hover')) viewer.playing = false;
}

if (box && source) {
  whenWanted(box, () =>
    startLogo().catch((e) => {
      // the flat logo stays in place
      box.querySelector('.logo-live')?.remove();
      if (backendNote) backendNote.textContent = `nothing: this browser has neither WebGPU nor WebGL2 (${e.message})`;
    }),
  );
}
