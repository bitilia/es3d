import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OrbitControls } from '../src/render/orbit-controls.js';

function element() {
  return { style: {}, addEventListener() {}, removeEventListener() {} };
}

test('touch-action follows enabled however it is set', () => {
  const el = element();
  const controls = new OrbitControls(el, {});
  assert.equal(el.style.touchAction, 'none');

  // the stage with interactive: false: configure() first, then switch dragging off
  controls.configure(null, {});
  assert.equal(el.style.touchAction, 'none');
  controls.enabled = false;
  assert.equal(controls.enabled, false);
  assert.equal(el.style.touchAction, 'auto');

  controls.enabled = true;
  assert.equal(el.style.touchAction, 'none');

  controls.configure({ mode: 'fixed' }, {});
  assert.equal(controls.enabled, false);
  assert.equal(el.style.touchAction, 'auto');

  controls.configure({ mode: 'fixed' }, { ignoreMode: true });
  assert.equal(el.style.touchAction, 'none');
});
