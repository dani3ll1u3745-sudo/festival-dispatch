// Pre- and post-processing for the fire model. The model's input size, class order and output format
// come from models/model.json (see MODEL.md), so a different YOLO export can be dropped in.
export const LABELS = ['fire', 'smoke'];

export function letterbox(width, height, size) {
  const scale = Math.min(size / width, size / height);
  const resizedWidth = Math.round(width * scale);
  const resizedHeight = Math.round(height * scale);
  return { width, height, size, scaleX: resizedWidth / width, scaleY: resizedHeight / height,
    resizedWidth, resizedHeight, padX: Math.floor((size - resizedWidth) / 2), padY: Math.floor((size - resizedHeight) / 2) };
}

export function rgbTensor(rgba, size) {
  const pixels = size * size;
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

// Two YOLO output layouts:
//   [1, 4 + classes, N]  raw (YOLOv8/11): centre x/y, width/height, then one score per class; needs NMS
//   [1, N, 6]            end-to-end (YOLO26): x1, y1, x2, y2, score, class id; already de-duplicated
// Coordinates are in letterboxed input pixels and are mapped back to the video frame.
// labels: the model's class names in id order, e.g. ['fire', 'smoke'].
export function decode(data, dims, transform, threshold = 0.5, labels = LABELS) {
  if (dims.length !== 3 || dims[0] !== 1 || data.length !== dims[1] * dims[2]) throw new Error(`Unsupported model output: ${dims.join(' × ')}`);
  const raw = dims[1] === 4 + labels.length;
  const endToEnd = !raw && dims[2] === 6;
  if (!raw && !endToEnd) throw new Error(`Unsupported model output: ${dims.join(' × ')}`);
  const { width, height, scaleX, scaleY, padX, padY } = transform;
  const boxes = [];
  const add = (label, score, x1, y1, x2, y2) => {
    if (!label || !Number.isFinite(score) || score < threshold) return;
    const box = { label, score,
      x1: Math.max(0, (x1 - padX) / scaleX), y1: Math.max(0, (y1 - padY) / scaleY),
      x2: Math.min(width, (x2 - padX) / scaleX), y2: Math.min(height, (y2 - padY) / scaleY) };
    if ([box.x1, box.y1, box.x2, box.y2].every(Number.isFinite) && box.x2 > box.x1 && box.y2 > box.y1) boxes.push(box);
  };
  if (endToEnd) {
    for (let i = 0; i < dims[1]; i++) {
      const r = i * 6;
      add(labels[Math.round(data[r + 5])], data[r + 4], data[r], data[r + 1], data[r + 2], data[r + 3]);
    }
  } else {
    const count = dims[2];
    for (let i = 0; i < count; i++) {
      let classId = 0;
      for (let c = 1; c < labels.length; c++) if (data[(4 + c) * count + i] > data[(4 + classId) * count + i]) classId = c;
      const cx = data[i], cy = data[count + i], w = data[2 * count + i], h = data[3 * count + i];
      add(labels[classId], data[(4 + classId) * count + i], cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
    }
  }
  boxes.sort((a, b) => b.score - a.score);
  const selected = [];
  for (const box of boxes) {
    if (!selected.some(other => box.label === other.label && iou(box, other) > 0.45)) selected.push(box);
    if (selected.length === 30) break;
  }
  return selected;
}

// MaydAI camera: time-window confirmation, per class. A class is confirmed when, within the last
// `windowMs`, it appears in at least `ratio` of the analysed frames (and at least `minFrames` of them),
// and those sightings span at least `minSpanMs`. The span, not a frame count, is what rejects a
// flash of stage lighting, so the rule does not depend on the frame rate. The ratio is deliberately
// below one half: a real fire is often missed in some frames (smoke, motion blur, flame shape
// changing), and an intermittent fire must still confirm.
export const WINDOW = { windowMs: 2500, ratio: 0.4, minFrames: 3, minSpanMs: 800 };

export function trackEvidence(frames, boxes, now, { windowMs, ratio, minFrames, minSpanMs } = WINDOW) {
  const frame = { time: now };
  for (const label of LABELS) frame[label] = Math.max(0, ...boxes.filter(b => b.label === label).map(b => b.score));
  const recent = [...frames.filter(f => now - f.time < windowMs), frame];
  const summary = { frames: recent };
  for (const label of LABELS) {
    const seen = recent.filter(f => f[label] > 0);
    const hits = seen.length;
    const needed = Math.max(minFrames, Math.ceil(ratio * recent.length));
    const span = hits ? seen.at(-1).time - seen[0].time : 0;
    summary[label] = { hits, total: recent.length, needed, span, score: frame[label],
      progress: Math.min(1, hits / needed, span / minSpanMs), confirmed: hits >= needed && span >= minSpanMs };
  }
  return summary;
}
