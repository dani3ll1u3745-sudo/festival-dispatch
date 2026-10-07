// detector.js: fire and smoke detection on the live camera feed.
// Model and decoder come from webcam-fire-detector (see fire/MODEL.md). Everything runs on this laptop:
// frames go to a Web Worker running the ONNX model, never to the server. Only a confirmed fire calls
// window.reportIncident, which sends a single frame to the coordinator.
//
// Contract with camera.html:
//   reads  #cam (live <video>), #overlay (boxes), #evidence (strip canvas), #threshold (range, percent)
//   calls  window.reportIncident(event), window.reportCameraStatus(type, visible, confidence)
//   emits  'detector:update' on window, detail { phase, fire, smoke, ms, fps, error }
//          phase: loading | model-error | watching | checking | smoke | fire
//   sets   window.detector.reset() to forget the current sighting (e.g. when the camera moves zone)
import { SIZE, WINDOW, letterbox, rgbTensor, trackEvidence } from './fire/detection.mjs';

const ALERT_TYPE = 'fire'; // smoke is shown but never alerts: haze machines run at every festival stage
const CLEAR_AFTER_MS = 4000; // no fire in any frame for this long = "no longer in view"
const STATUS_EVERY_MS = 5000; // "still in view" heartbeat to the coordinator while fire stays visible
const FOLLOWUP_MS = 15000; // a second photo this long after the alert lets the AI judge whether it's spreading
const MIN_INTERVAL_MS = 120; // at most ~8 analysed frames a second
const STALL_MS = 10000; // no result for this long: restart the model

const $ = id => document.getElementById(id);
const video = $('cam'), overlay = $('overlay'), strip = $('evidence'), thresholdInput = $('threshold');
const octx = overlay.getContext('2d');
const input = document.createElement('canvas');
input.width = input.height = SIZE;
const inputCtx = input.getContext('2d', { willReadFrequently: true });

let worker, ready = false, frameId = 0, current = 0, lastVideoTime = -1, lastResultAt = 0;
let evidence = { frames: [] }, boxes = [];
// The current fire, once confirmed: { visible, lastSeenAt, lastStatusAt, incidentId, alertedAt, followupSent }.
// incidentId is null while the report is unacknowledged or after its incident was closed.
let sighting = null;
let state = { phase: 'loading', fire: null, smoke: null, ms: null, fps: null, error: null };

function publish(patch) {
  state = { ...state, ...patch };
  window.dispatchEvent(new CustomEvent('detector:update', { detail: state }));
}

// ---------- Model ----------
function startWorker() {
  worker?.terminate();
  ready = false;
  worker = new Worker(new URL('./fire/worker.mjs', import.meta.url), { type: 'module' });
  worker.onerror = e => fail(`The fire model could not start. ${e.message || ''}`);
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') {
      ready = true;
      lastResultAt = performance.now();
      publish({ phase: 'watching', error: null });
      capture();
    } else if (data.type === 'result') onResult(data);
    else if (data.type === 'error') fail(data.message);
  };
  worker.postMessage({ type: 'init' });
}

function fail(message) {
  ready = false;
  publish({ phase: 'model-error', error: message });
  clearTimeout(fail.retry);
  fail.retry = setTimeout(startWorker, 3000);
}

// One frame in flight at a time keeps latency and memory bounded.
function capture() {
  if (!ready) return;
  if (video.readyState < 2 || video.currentTime === lastVideoTime) {
    if (video.readyState < 2) lastResultAt = performance.now(); // no camera yet is not a stall
    setTimeout(capture, 50);
    return;
  }
  lastVideoTime = video.currentTime;
  const transform = letterbox(video.videoWidth, video.videoHeight);
  if (overlay.width !== transform.width || overlay.height !== transform.height) {
    overlay.width = transform.width;
    overlay.height = transform.height;
  }
  inputCtx.fillStyle = 'rgb(114,114,114)';
  inputCtx.fillRect(0, 0, SIZE, SIZE);
  inputCtx.drawImage(video, transform.padX, transform.padY, transform.resizedWidth, transform.resizedHeight);
  const pixels = rgbTensor(inputCtx.getImageData(0, 0, SIZE, SIZE).data);
  current = ++frameId;
  worker.postMessage(
    { type: 'frame', pixels, transform, threshold: Number(thresholdInput.value) / 100, frame: current, minIntervalMs: MIN_INTERVAL_MS },
    [pixels.buffer]
  );
}

setInterval(() => {
  if (ready && performance.now() - lastResultAt > STALL_MS) fail('Detection stopped responding. Restarting the model.');
}, 1000);

// ---------- Results ----------
function onResult(data) {
  const now = performance.now();
  const fps = 1000 / Math.max(1, now - lastResultAt);
  lastResultAt = now;
  boxes = data.frame === current ? data.boxes : []; // drop a frame analysed with an old threshold
  evidence = trackEvidence(evidence.frames, boxes, now);
  const { fire, smoke } = evidence;
  drawBoxes();
  drawStrip(now);

  const fireInFrame = fire.score > 0;
  if (fireInFrame && sighting) sighting.lastSeenAt = now;

  if (fire.confirmed && !sighting?.visible) {
    // New sighting: boxes are already on the overlay, so they appear in the snapshot.
    sighting = { visible: true, lastSeenAt: now, lastStatusAt: now, incidentId: null, alertedAt: now, followupSent: false };
    sendReport(fire);
  } else if (sighting?.visible) {
    if (!fireInFrame && now - sighting.lastSeenAt > CLEAR_AFTER_MS) {
      sighting.visible = false;
      window.reportCameraStatus(ALERT_TYPE, false);
    } else if (fireInFrame && now - sighting.lastStatusAt > STATUS_EVERY_MS) {
      sighting.lastStatusAt = now;
      // Without an open incident (closed, or never acknowledged) report it as a new sighting.
      // The first heartbeat after FOLLOWUP_MS carries a photo, once per incident.
      const followup = sighting.incidentId && !sighting.followupSent && now - sighting.alertedAt > FOLLOWUP_MS;
      if (followup) sighting.followupSent = true;
      if (sighting.incidentId) window.reportCameraStatus(ALERT_TYPE, true, fire.score, followup);
      else sendReport(fire);
    }
  }

  const phase = sighting?.visible ? 'fire' : fire.hits ? 'checking' : smoke.hits ? 'smoke' : 'watching';
  publish({ phase, fire, smoke, ms: data.ms, fps });
  capture();
}

function sendReport(fire) {
  const s = sighting;
  window.reportIncident({
    type: ALERT_TYPE,
    confidence: Math.max(...evidence.frames.map(f => f.fire)),
    note: `Seen in ${fire.hits} of ${fire.total} frames over ${WINDOW.windowMs / 1000} seconds`,
  }).then(ack => {
    if (s !== sighting) return;
    if (ack?.id && ack.id !== s.incidentId && !ack.merged) { s.alertedAt = performance.now(); s.followupSent = false; } // a new incident
    s.incidentId = ack?.id || null;
  });
}

function drawBoxes() {
  octx.clearRect(0, 0, overlay.width, overlay.height);
  const scale = Math.max(1, overlay.width / 800);
  octx.font = `600 ${15 * scale}px Inter, system-ui, sans-serif`;
  octx.lineWidth = 3 * scale;
  for (const box of boxes) {
    const color = box.label === 'fire' ? '#ff6a45' : '#c9d2dc';
    const w = box.x2 - box.x1, h = box.y2 - box.y1;
    octx.strokeStyle = color;
    octx.strokeRect(box.x1, box.y1, w, h);
    const text = `${box.label === 'fire' ? 'Fire' : 'Smoke'} ${Math.round(box.score * 100)}%`;
    const labelW = octx.measureText(text).width + 14 * scale, labelH = 24 * scale;
    const lx = Math.max(0, Math.min(box.x1, overlay.width - labelW)), ly = Math.max(0, box.y1 - labelH);
    octx.fillStyle = color;
    octx.fillRect(lx, ly, labelW, labelH);
    octx.fillStyle = '#1a1f29';
    octx.fillText(text, lx + 7 * scale, ly + 17 * scale);
  }
}

// One mark per analysed frame over the confirmation window, newest on the right.
function drawStrip(now) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(strip.clientWidth * dpr), h = Math.round(strip.clientHeight * dpr);
  if (!w || !h) return;
  if (strip.width !== w || strip.height !== h) { strip.width = w; strip.height = h; }
  const css = getComputedStyle(strip);
  const ctx = strip.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  const bar = Math.max(2 * dpr, Math.min(6 * dpr, w / 40));
  for (const f of evidence.frames) {
    const x = (1 - (now - f.time) / WINDOW.windowMs) * (w - bar);
    const score = f.fire || f.smoke;
    ctx.fillStyle = css.getPropertyValue(f.fire ? '--bar-fire' : f.smoke ? '--bar-smoke' : '--bar-none').trim();
    const barH = score ? h * (0.35 + 0.65 * score) : 3 * dpr;
    ctx.fillRect(x, h - barH, bar, barH);
  }
}

// ---------- Controls ----------
function reset() {
  if (sighting?.visible) window.reportCameraStatus(ALERT_TYPE, false);
  sighting = null;
  evidence = { frames: [] };
  boxes = [];
  current = ++frameId; // ignore the frame already in flight
  drawBoxes();
  drawStrip(performance.now());
  if (ready) publish({ phase: 'watching', fire: null, smoke: null });
}

thresholdInput.addEventListener('input', () => {
  evidence = { frames: [] };
  boxes = [];
  current = ++frameId;
  drawBoxes();
});

// The coordinator closed an incident: if the fire is still in view, the next heartbeat reports it again.
function incidentClosed(id) {
  if (sighting?.incidentId === id) sighting.incidentId = null;
}

window.detector = { reset, incidentClosed };
publish({ phase: 'loading' });
startWorker();
