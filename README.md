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
- With `ANTHROPIC_API_KEY` set, Claude (Opus 5.5 by default, override with `CLAUDE_MODEL`) reads every incident: the photo if there is one, the volunteer's description, the site notes and conditions in `config.json`, recent incidents and who is free. It reads each one with the whole event in view: other open incidents and who is on them, who is free where, repeated reports in one area, the headliner and the weather. The coordinator's card shows a verdict on the photo, one line of insight, and **two ranked options**, each with a plan of up to 5 actions. A new text or voice report merged into an incident makes the AI read it again. The camera sends a second photo 15 seconds later so the AI can say whether a fire is growing.

## Options and plans

The card spells out the recommended option with its steps; the other option (for example "Mark as false alarm" when the fire is on a phone screen) is one tap away under **Switch**. Each option's plan runs in one tap, or step by step with **Do**. The AI can only propose these actions; the server checks each one when it's proposed and again when it runs, and one failing doesn't stop the others:

- **Send** an available volunteer, with a briefing that goes to their phone word for word
- **Pull** a volunteer off a less urgent incident (never ticked by default)
- **Message volunteers at a zone**, shown on their phones
- **Open a linked incident**, e.g. a medical incident for people hurt at a fire
- **Call 000**: suggested by the AI, but always placed by a person
- **Mark as false alarm**: closes the incident (asks first)

The AI is told never to ask volunteers to chase, confront or detain anyone: they look, talk calmly and bring in security.

The coordinator can untick a step, swap the volunteer, change the zone or type, or edit any message before running. Without a key, the card shows the same plan built from standard steps. Site notes (extinguishers, exits, gas shut-offs) and conditions live in `config.json`; edit them for a real venue.
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
