// Unit tests for public/fire/detection.mjs. Run: npm run test:detection
import test from 'node:test';
import assert from 'node:assert/strict';
import { letterbox, decode, trackEvidence } from '../public/fire/detection.mjs';

test('letterbox centres a wide frame', () => {
  const t = letterbox(1280, 720, 640);
  assert.equal(t.resizedWidth, 640);
  assert.equal(t.resizedHeight, 360);
  assert.equal(t.padY, 140);
});

test('decodes raw [1, 6, N] output back to frame pixels', () => {
  const t = letterbox(1280, 720, 640);
  // One candidate: centre (320, 320), 64 × 64, fire 0.9, smoke 0.1.
  const data = Float32Array.from([320, 320, 64, 64, 0.9, 0.1]);
  const [box] = decode(data, [1, 6, 1], t, 0.5);
  assert.equal(box.label, 'fire');
  assert.ok(Math.abs(box.x1 - 576) < 1e-6 && Math.abs(box.y1 - 296) < 1e-6);
  assert.equal(decode(data, [1, 6, 1], t, 0.95).length, 0);
});

test('decodes end-to-end [1, N, 6] output with the model\'s class order', () => {
  const t = letterbox(640, 640, 640);
  const data = Float32Array.from([
    10, 10, 50, 50, 0.8, 1, //   class 1
    60, 60, 90, 90, 0.3, 0, //   below threshold
    0, 0, 0, 0, 0, 0,       //   padding row
  ]);
  const boxes = decode(data, [1, 3, 6], t, 0.4, ['smoke', 'fire']);
  assert.deepEqual(boxes.map(b => [b.label, b.x1, b.x2]), [['fire', 10, 50]]);
});

test('rejects unknown output layouts', () => {
  assert.throws(() => decode(new Float32Array(84 * 3), [1, 84, 3], letterbox(640, 640, 640)), /Unsupported/);
});

// Feeds one result per `stepMs`; fireAt(i) says whether frame i had fire. Returns the time it confirmed, or null.
function run(fireAt, frames, stepMs = 100) {
  let evidence = { frames: [] };
  for (let i = 0; i < frames; i++) {
    const boxes = fireAt(i) ? [{ label: 'fire', score: 0.7 }] : [];
    evidence = trackEvidence(evidence.frames, boxes, i * stepMs);
    if (evidence.fire.confirmed) return i * stepMs;
  }
  return null;
}

test('a steady fire confirms in under a second', () => {
  assert.equal(run(() => true, 30), 800);
});

test('a fire the model only catches in half the frames still confirms', () => {
  const at = run(i => i % 2 === 0, 40);
  assert.ok(at !== null && at <= 1200, `confirmed at ${at}`);
});

test('a short flash of stage lighting does not confirm', () => {
  assert.equal(run(i => i >= 5 && i < 11, 40), null); // 0.6 s of "fire"
});

test('scattered single-frame false positives do not confirm', () => {
  assert.equal(run(i => i % 5 === 0, 60), null); // 1 frame in 5
});
