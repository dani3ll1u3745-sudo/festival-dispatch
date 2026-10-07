# MaydAI

Camera-based incident detection and volunteer dispatch for music festivals (Affinda AI Innovation Challenge demo).

## Run it

```bash
npm install
cp .env.example .env        # then add your ANTHROPIC_API_KEY (optional: works without it)
npm start
```

Open on the laptop:
- Camera: http://localhost:3000/camera.html (add `?zone=food-court` etc. to place a camera elsewhere)
- Coordinator: http://localhost:3000/coordinator.html
- Volunteer: http://localhost:3000/volunteer.html

## Phones

Phones need an HTTPS link to the laptop. With ngrok:

```bash
ngrok http 3000 --url=https://YOUR-STATIC-DOMAIN.ngrok-free.app
```

Put that URL in `.env` as `PUBLIC_URL` so the QR code on the camera page points to it, then restart the server.

## Fire detection on the camera page

The camera page runs a fire and smoke model (from `webcam-fire-detector`, see `public/fire/MODEL.md`) on the live webcam, entirely in the browser. Video never leaves the laptop. Only a confirmed fire sends an alert, with one frame, to the coordinator.

- Fire must appear in at least 60% of the frames checked over 3 seconds (minimum 4) before it alerts. The strip under the video shows each checked frame.
- Smoke is shown but never alerts, because stages use haze machines.
- With `ANTHROPIC_API_KEY` set, Claude (Opus 5.5 by default, override with `CLAUDE_MODEL`) looks at the alert photo. The coordinator's card shows a one-line verdict and insight, for example "Fire on a phone screen: the flames are an image on a handheld phone", plus 2 or 3 steps. It arrives a few seconds after the alert and never holds it up or hides it. Without a key, the card shows standard steps instead. The photo is the only image that leaves the laptop.
- While the fire stays in view, the coordinator's card says "Camera still sees fire". When it leaves view for 4 seconds, it says the view is clear. The coordinator decides when to resolve.
- **False alarm** and **Mark resolved** (coordinator) close the incident and stand volunteers down. Neither silences the camera: if it still sees fire, or sees it again later, the coordinator gets a new alert within about 5 seconds.
- Any device with a camera can be an extra camera: open `camera.html?zone=gate-a` on a phone through the ngrok link. It downloads about 23 MB of model files first.
- Keep the camera page in its own window. Detection keeps running in a background tab, but slower.

For a demo, point the webcam at fire footage on a phone (fill the frame, avoid glare) or a small real flame where that's allowed. Rehearse in the room's lighting and set the confidence slider from that. The model is an experimental baseline, not a certified fire detector.

## Test the whole flow without browsers

```bash
npm start            # in one terminal
npm run test:flow    # in another
```

## Where things live

- `server.js`: relay server, in-memory state, shortlist, AI recommendation, dispatch
- `config.json`: festival zones (real coordinates), camera zone, volunteer start zones, qualifications
- `volunteers.json`: pre-loaded demo volunteers
- `public/detector.js`: runs the model on the live feed, confirms over time, calls `reportIncident` and `reportCameraStatus`
- `public/fire/`: model, ONNX runtime, worker and decoder copied from `webcam-fire-detector`
- `POST /api/incident`: HTTP alternative for a Python detector

Restarting the server clears all incidents and joined volunteers.
