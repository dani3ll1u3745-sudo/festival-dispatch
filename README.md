# MaydAI

Camera-based incident detection and volunteer dispatch for music festivals (Affinda AI Innovation Challenge demo).

## Run it

```bash
npm install
cp .env.example .env        # then add your ANTHROPIC_API_KEY (optional: works without it)
npm start
```

Open on the laptop:
- Camera: http://localhost:3000/camera.html
- Coordinator: http://localhost:3000/coordinator.html
- Volunteer: http://localhost:3000/volunteer.html

## Phones

Phones need an HTTPS link to the laptop. With ngrok:

```bash
ngrok http 3000 --url=https://YOUR-STATIC-DOMAIN.ngrok-free.app
```

Put that URL in `.env` as `PUBLIC_URL` so the QR code on the camera page points to it, then restart the server.

## Test the whole flow without browsers

```bash
npm start            # in one terminal
npm run test:flow    # in another
```

## Where things live

- `server.js`: relay server, in-memory state, shortlist, AI recommendation, dispatch
- `config.json`: festival zones (real coordinates), camera zone, volunteer start zones, qualifications
- `volunteers.json`: pre-loaded demo volunteers
- `public/detector.js`: detection code (owned by the detection teammate; calls `reportIncident`)
- `POST /api/incident`: HTTP alternative for a Python detector

Restarting the server clears all incidents and joined volunteers.
