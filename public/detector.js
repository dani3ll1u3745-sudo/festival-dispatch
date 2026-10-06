// detector.js: owned by the detection teammate. Nothing else in the project edits this file.
//
// What you have available on the camera page:
//   document.getElementById('cam')      the <video> element with the live webcam feed
//   document.getElementById('overlay')  a <canvas> on top of the video: draw boxes here
//                                       (size it to the video first; it is included in snapshots)
//   window.getCameraFrame()             current frame (+ overlay) as a small JPEG data URL
//   window.reportIncident(event)        send a detection to the platform
//
// reportIncident takes:
//   { type: 'fire' | 'overcrowding' | 'medical', confidence: 0..1, note?: string }
// The camera zone, timestamp and snapshot are filled in automatically.
// Draw your bounding box on the overlay BEFORE calling it, so the box appears in the snapshot.
//
// The server merges repeat reports of the same type in the same zone within 60 s,
// so calling it every second while a flame is visible is fine.
//
// Prefer Python? POST the same JSON to /api/incident instead, e.g.
//   requests.post("http://localhost:3000/api/incident", json={"type": "fire", "confidence": 0.9, "zoneId": "main-stage"})
//
// Suggested shape (replace with the real model + colour check):
//
// (function () {
//   const video = document.getElementById('cam');
//   const overlay = document.getElementById('overlay');
//   const history = [];                       // last 5 frames: true if flame seen
//   setInterval(async () => {
//     if (!video.videoWidth) return;
//     overlay.width = video.videoWidth; overlay.height = video.videoHeight;
//     const result = await detectFlame(video); // -> { found, confidence, box: {x, y, w, h} }
//     history.push(result.found); if (history.length > 5) history.shift();
//     const ctx = overlay.getContext('2d');
//     ctx.clearRect(0, 0, overlay.width, overlay.height);
//     if (result.found) { ctx.strokeStyle = '#f2d21b'; ctx.lineWidth = 6; ctx.strokeRect(result.box.x, result.box.y, result.box.w, result.box.h); }
//     if (history.filter(Boolean).length >= 3) reportIncident({ type: 'fire', confidence: result.confidence });
//   }, 150);
// })();
