// Spell plaques (the .btn buttons and the .tile links of the format chooser):
// a light follows the pointer across the face, and a press casts a ring of
// light from where it landed (from the middle for a key press). The look is in
// style.css; this only aims the light and starts the ring.

const PLAQUE = '.btn, .tile';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

function aim(button, x, y) {
  const r = button.getBoundingClientRect();
  button.style.setProperty('--mx', `${x === undefined ? r.width / 2 : x - r.left}px`);
  button.style.setProperty('--my', `${y === undefined ? r.height / 2 : y - r.top}px`);
}
function cast(button) {
  if (reducedMotion.matches) return;
  button.classList.remove('is-casting');
  void button.offsetWidth; // restart the ring if it is still spreading
  button.classList.add('is-casting');
}
document.addEventListener(
  'pointermove',
  (event) => {
    const button = event.target.closest?.(PLAQUE);
    if (button) aim(button, event.clientX, event.clientY);
  },
  { passive: true },
);
document.addEventListener(
  'pointerdown',
  (event) => {
    const button = event.target.closest?.(PLAQUE);
    if (!button) return;
    aim(button, event.clientX, event.clientY);
    cast(button);
  },
  { passive: true },
);
document.addEventListener('click', (event) => {
  const button = event.target.closest?.(PLAQUE);
  if (!button || event.detail !== 0) return; // detail 0: Enter or Space
  aim(button);
  cast(button);
});
document.addEventListener('animationend', (event) => {
  if (event.animationName === 'cast') event.target.classList.remove('is-casting');
});
