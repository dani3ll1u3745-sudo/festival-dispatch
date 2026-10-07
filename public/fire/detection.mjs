export const SIZE = 320;
export const LABELS = ['fire', 'smoke'];

export function letterbox(width, height) {
  const scale = Math.min(SIZE / width, SIZE / height);
  const resizedWidth = Math.round(width * scale);
  const resizedHeight = Math.round(height * scale);
  return { width, height, scaleX: resizedWidth / width, scaleY: resizedHeight / height,
    resizedWidth, resizedHeight, padX: Math.floor((SIZE - resizedWidth) / 2), padY: Math.floor((SIZE - resizedHeight) / 2) };
}

export function rgbTensor(rgba) {
  const pixels = SIZE * SIZE;
  const data = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    data[i] = rgba[i * 4] / 255;
    data[i + pixels] = rgba[i * 4 + 1] / 255;
    data[i + 2 * pixels] = rgba[i * 4 + 2] / 255;
  }
  return data;
}

export function iou(a, b) {
  const intersection = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)) * Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const union = (a.x2-a.x1)*(a.y2-a.y1) + (b.x2-b.x1)*(b.y2-b.y1) - intersection;
  return union > 0 ? intersection / union : 0;
}

// This pinned model outputs [1, 6, 2100]: centre x/y, width/height, fire, smoke.
export function decode(data, dims, transform, threshold = 0.5) {
  if (dims.length !== 3 || dims[0] !== 1 || dims[1] !== 6 || data.length !== dims[1] * dims[2]) {
    throw new Error(`Unsupported model output: ${dims.join(' × ')}`);
  }
  const count = dims[2];
  const boxes = [];
  const { width, height, scaleX, scaleY, padX, padY } = transform;
  for (let i = 0; i < count; i++) {
    const classId = data[4 * count + i] >= data[5 * count + i] ? 0 : 1;
    const score = data[(4 + classId) * count + i];
    if (!Number.isFinite(score) || score < threshold) continue;
    const cx = data[i], cy = data[count + i], w = data[2 * count + i], h = data[3 * count + i];
    const box = { label: LABELS[classId], score,
      x1: Math.max(0, (cx - w/2 - padX) / scaleX), y1: Math.max(0, (cy - h/2 - padY) / scaleY),
      x2: Math.min(width, (cx + w/2 - padX) / scaleX), y2: Math.min(height, (cy + h/2 - padY) / scaleY) };
    if ([box.x1, box.y1, box.x2, box.y2].every(Number.isFinite) && box.x2 > box.x1 && box.y2 > box.y1) boxes.push(box);
  }
  boxes.sort((a,b) => b.score - a.score);
  const selected = [];
  for (const box of boxes) {
    if (!selected.some(other => box.label === other.label && iou(box, other) > 0.45)) selected.push(box);
    if (selected.length === 30) break;
  }
  return selected;
}

// Confirmation is per class: alternating fire/smoke frames cannot confirm one another.
export function updateEvidence(previous, boxes, now, required = 3) {
  const fresh = previous && now - previous.time < 2000;
  const counts = Object.fromEntries(LABELS.map(label => [label, boxes.some(b => b.label === label) ? (fresh ? previous.counts[label] : 0) + 1 : 0]));
  return { time: now, counts, confirmed: LABELS.filter(label => counts[label] >= required) };
}

// MaydAI camera: time-window confirmation. A class is confirmed when it appears in at least `ratio`
// of the frames analysed in the last `windowMs`, and in at least `minFrames` of them. Unlike a
// consecutive-frame count, this does not depend on the frame rate, and a flicker of stage
// lighting lasting a few frames is not enough.
export const WINDOW = { windowMs: 3000, ratio: 0.6, minFrames: 4 };

export function trackEvidence(frames, boxes, now, { windowMs, ratio, minFrames } = WINDOW) {
  const frame = { time: now };
  for (const label of LABELS) frame[label] = Math.max(0, ...boxes.filter(b => b.label === label).map(b => b.score));
  const recent = [...frames.filter(f => now - f.time < windowMs), frame];
  const summary = { frames: recent };
  for (const label of LABELS) {
    const hits = recent.filter(f => f[label] > 0).length;
    const needed = Math.max(minFrames, Math.ceil(ratio * recent.length));
    summary[label] = { hits, total: recent.length, needed, score: frame[label],
      progress: Math.min(1, hits / needed), confirmed: hits >= needed };
  }
  return summary;
}
