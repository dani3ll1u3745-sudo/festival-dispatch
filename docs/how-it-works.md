# How MaydAI works

Technical details behind the [README](../README.md).

## Camera fire detection

The camera page runs a fire and smoke model (YOLO26n trained on the FASDD dataset; see [`public/fire/MODEL.md`](../public/fire/MODEL.md) for its source and benchmark) entirely in the browser, on the laptop's GPU through WebGPU when available. Video never leaves the laptop. Only a confirmed fire sends an alert, with one frame, to the coordinator.

- Fire must persist for 0.8 s, in at least 40% of the frames checked over the last 2.5 s (minimum 3), before it alerts. A real fire typically alerts about a second after it appears; a flash of stage lighting doesn't. The strip under the video shows each checked frame.
- The confidence slider defaults to 30%, the best balance in the benchmark (95% of test fires found, 1 false alarm in 95 non-fire scenes).
- Smoke is shown but never alerts, because stages use haze machines.
- While the fire stays in view, the coordinator's card says "Camera still sees fire". When it leaves view for 4 seconds, it says the view is clear. The coordinator decides when to resolve.
- **False alarm** and **Mark resolved** close the incident and stand volunteers down. Neither silences the camera: if it still sees fire, or sees it again later, the coordinator gets a new alert within about 5 seconds.
- The camera sends a second photo 15 seconds after the alert, so the AI can say whether a fire is growing.
- Any device with a camera can be an extra camera: open `camera.html?zone=gate-a` on a phone through the ngrok link. It downloads about 32 MB of model and runtime files first.

The model is an experimental baseline, not a certified fire detector. Rehearse in the room's lighting and set the confidence slider from that.

### Simulated footage

Demo clips (or **Play a video file…**, or a video dropped on the picture) play in place of the webcam, looping like a CCTV feed, and go through exactly the same detection, confirmation and alerting. A picked file never leaves the laptop. The coordinator's card says "Camera (simulated footage)".

Chrome pauses video in a hidden tab or a fully covered window, so keep the camera page visible while footage plays.

Demo clips live in `public/footage/`. Any MP4 or WebM there appears in the **Demo clips** list, titled from `clips.json` (otherwise from the file name).

## AI recommendations

With `ANTHROPIC_API_KEY` set, Claude (Opus 5.5 by default, override with `CLAUDE_MODEL`) reads every incident: the photo if there is one, the volunteer's words, the site notes and conditions in `config.json`, recent incidents and who is free. It reads each one with the whole event in view: other open incidents and who is on them, who is free where, repeated reports in one area, the headliner and the weather.

The coordinator's card shows a verdict on the photo, one line of insight, and **two ranked options**, each with a plan of up to 5 actions. A new text or voice report merged into an incident makes the AI read it again. Without a key, the card shows the same kind of plan built from standard steps.

What the AI gets for each read, besides the incident itself:

- **Volunteers' reports, oldest first, with how long ago each was sent.** A report from someone who had already arrived is marked on scene, so first-hand reports outweigh the camera.
- **Other incidents, open or closed in the last 90 minutes:** how each was reported, what its camera photo showed, how it ended, and its case note. This is how a repeat at the same camera after a false alarm gets spotted as a likely prank.
- **Its previous advice for this incident,** so it changes course only when new information justifies it, and says what changed.

`AI_PLAN_EFFORT` in `.env` sets how hard it thinks: `medium` (default, about 15 s per plan) or `low` (about 9 s, similar advice in testing).

### What volunteers are told

Each volunteer the plan sends gets a briefing (what and where), 2 to 4 steps on how to do the job using the site facts (which extinguisher, which exit, which technique), and a safety line on when to pull back. Only the recommended option carries AI-written steps, which keeps the plan fast; anyone sent from the other option, or by hand, gets standard steps for that type of incident. Their phone also shows the camera's photo (or the newest volunteer photo) and the zone's site notes.

### Options and plans

The card spells out the recommended option with its steps; the other option (for example "Mark as false alarm" when the fire is on a phone screen) is one tap away under **Switch**. Each plan runs in one tap, or step by step with **Do**. The AI can only propose these actions; the server checks each one when it's proposed and again when it runs, and one failing doesn't stop the others:

- **Send** an available volunteer, with a briefing that goes to their phone word for word
- **Pull** a volunteer off a less urgent incident (never ticked by default)
- **Message volunteers at a zone**, shown on their phones
- **Open a linked incident**, e.g. a medical incident for people hurt at a fire
- **Call 000**: suggested by the AI, but always placed by a person
- **Mark as false alarm**: closes the incident (asks first)

The AI is told never to ask volunteers to chase, confront or detain anyone: they look, talk calmly and bring in security.

The coordinator can untick a step, swap the volunteer, change the zone or type, or edit any message before running. Site notes (extinguishers, exits, gas shut-offs) and conditions live in `config.json`; edit them for a real venue.

### Replies from the scene

A volunteer on a job replies from the assignment screen or the main page: **Sorted**, **Need more help**, or an update in their own words (voice or text, and photos can be added). A reply is stored as a report on that incident, marked as a reply, so transcription, photos and the AI's re-read work as for any report.

- The coordinator hears an alert (three beeps when help is needed), sees the newest reply in a callout under the track, and the AI re-reads the incident.
- **Need more help:** the AI works out what's needed from the volunteer's words, their training, the site facts and what else is going on, and makes its recommended option act on it.
- **Sorted:** the AI recommends closing it as handled (a `resolve` step), unless something contradicts it, such as the camera still seeing flames. **Mark resolved** also turns green.
- Without the AI, the standard plan closes the case on a "sorted" reply, and sends more people on "need more help".

## Timeline and case notes

Every incident keeps a timeline of what happened and when: reported, AI advice, who was sent, on the way, arrived, stood down, camera cleared, messages sent, closed. The coordinator's card shows it under **Timeline**.

When an incident closes (**Mark resolved** or **False alarm**), it moves to the **Case notes** tab and a note is written in the background, usually within 5 seconds: a 2 to 3 sentence summary, the key timings (open for, first person sent, first arrival), what went well, what to improve and lessons for next time. With a key, the AI writes it from the timeline and the incident record, using only facts in that record; without one, the summary is built from the record alone. **Copy note** copies it as plain text for a debrief document. Closed cases' summaries also feed the AI's view of recent incidents.

## Voice reports

Volunteers' voice clips are transcribed on the server with the open-source Whisper model (no key needed; it downloads once, about 500 MB). Until it's ready, or if it can't load, phones transcribe in the browser instead. Settings in `.env.example`: `WHISPER_MODEL`, `LOCAL_TRANSCRIPTION=off`, or a hosted service with `OPENAI_API_KEY` or `DEEPGRAM_API_KEY`.

## Where things live

- `server.js`: relay server, in-memory state, shortlist, AI recommendation, dispatch
- `config.json`: festival zones (real coordinates), camera zone, volunteer start zones, qualifications
- `volunteers.json`: pre-loaded demo volunteers
- `public/detector.js`: runs the model on the camera feed, confirms over time, calls `reportIncident` and `reportCameraStatus`
- `public/fire/`: model (`models/model.json` names it), ONNX runtime, worker and decoder. `scripts/export-fire-model.py` rebuilds the model
- `public/footage/`: demo clips for the camera page
- `POST /api/incident`: HTTP alternative for a Python detector

Restarting the server clears all incidents and joined volunteers.

## Tests

```bash
npm run test:detection   # fire decoder and confirmation rule
npm start                # then, in a second terminal:
npm run test:flow        # the whole flow, without browsers
```
