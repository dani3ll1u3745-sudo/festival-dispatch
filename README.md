# MaydAI

**AI-assisted incident reporting and volunteer dispatch for music festivals.**
Affinda AI Innovation Challenge demo.

- **Reports come in from anywhere.** Volunteers report by voice, text or photo, and cameras spot fires on their own.
- **AI turns each report into a plan.** It reads the report with the whole event in view (who's free, what else is happening) and suggests ranked options.
- **The coordinator acts in one tap.** The right volunteer gets a briefing on their phone straight away, with steps to follow, a safety line and a photo of the scene.
- **Every case leaves a note.** When an incident closes, a short case note is written for the debrief.

## The three screens

| Screen | Who uses it | What it does |
|---|---|---|
| **Coordinator** | The person running the event | Sees every incident with the AI's plan, sends volunteers, and keeps a case note of every closed case |
| **Volunteer** | Staff on the ground, on their phone | Reports problems and receives assignments with step-by-step guidance |
| **Camera** | A laptop or phone pointed at an area | Watches for fire and reports it automatically |

---

## Get it running

About 10 minutes. Everything runs on one computer, including the volunteer screen. To use real phones, add ngrok afterwards ([see below](#use-real-phones-as-volunteers-ngrok)).

**You need:**
- **Google Chrome** (or Microsoft Edge)
- **Node.js 20 or newer**: download the **LTS** version from [nodejs.org](https://nodejs.org) and install it with the default options
- **An Anthropic API key** for the AI: get one at [console.anthropic.com](https://console.anthropic.com)
- About **1.5 GB** of free disk space and an internet connection

### 1. Download the code

On this GitHub page, click the green **Code** button, then **Download ZIP**. Unzip it somewhere easy to find, such as your Desktop.

<sub>Using git? `git clone https://github.com/dani3ll1u3745-sudo/festival-dispatch.git`</sub>

### 2. Open a terminal in that folder

- **Windows:** open the folder in File Explorer, click the address bar, type `cmd` and press Enter.
- **Mac:** open the **Terminal** app, type `cd ` (with a space), drag the folder into the window, and press Enter.

### 3. Add your API key

Create your settings file and open it:

- **Windows:** `copy .env.example .env` then `notepad .env`
- **Mac:** `cp .env.example .env` then `open -e .env`

Paste your key after `ANTHROPIC_API_KEY=` (no spaces or quotes), then save and close.
Never share or commit this file: it's already kept out of git.

> **No key?** MaydAI still runs as a reporting and dispatch system, but plans come from fixed templates instead of the AI. You can add a key later: stop MaydAI with **Ctrl + C**, do this step, then start it again.

### 4. Install and start

Type each line and press Enter:

```bash
npm install
npm start
```

When you see `MaydAI running on http://localhost:3000`, it's ready.
**Keep this window open**: closing it stops MaydAI.

> The first start also downloads a voice-recognition model in the background (about 2 minutes, once). Everything else works straight away.

The startup message should say `AI recommendations: on`. If it says `off`, check your key in `.env`.

### 5. Open the screens

Open each link in Chrome, ideally in separate windows side by side:

| Screen | Link | First step |
|---|---|---|
| Coordinator | [localhost:3000/coordinator.html](http://localhost:3000/coordinator.html) | Click **Start shift** |
| Volunteer | [localhost:3000/volunteer.html](http://localhost:3000/volunteer.html) | Enter a name, tick a training, click **Join and turn on alerts** |
| Camera | [localhost:3000/camera.html](http://localhost:3000/camera.html) | Allow the camera, or skip it: the demo clips work without one |

---

## Try it

About 10 minutes. Keep the camera window visible: Chrome pauses video in hidden windows.

### Scenario 1: a camera spots a fire

1. On the **Camera** screen, under **Demo clips**, click **Fire growing slowly at backstage**.
2. Watch it turn amber (**Possible fire**), then red (**Fire confirmed**) about a second after the fire takes hold.
3. On the **Coordinator** screen, an alert arrives with the photo, the AI's read of it, and a ranked plan.
4. Click **Run … actions**. Your **Volunteer** screen shows the assignment: what's happening, step-by-step what to do, how to stay safe, the camera's photo, and where the extinguishers and exits are.
5. Tap **I'm on my way**, then **I've arrived**. The same progress track fills on both the phone and the coordinator's card.
6. Reply from the scene. Tap **Need more help**, or tap **Add a voice or text update** and say what's going on (e.g. *"It's spread to the truck's awning, I need another person"*). The coordinator hears an alert, sees your words, and the AI updates the plan with the help you need.
7. Tap **Sorted** when it's under control. The AI suggests closing it, unless something contradicts you (for example, the camera still sees flames).
8. Close it, then open the **Case notes** tab. A short note on the case appears within seconds: timings, what went well, what to improve and what to do next time.

### Scenario 2: a volunteer reports something

1. On the **Volunteer** screen, tap the microphone and describe a problem, or type it.
   For example: *"Someone fainted near the bar. They're breathing but not responding."*
2. Tap **Report medical**.
3. On the **Coordinator** screen, the report arrives as an incident with a plan to act on.

### Scenario 3: try to fool the camera

This one needs the AI (step 3) and a webcam.

1. On the **Camera** screen, click **Back to live camera** if a clip is playing, and allow the webcam.
2. Search for a photo of a fire on your phone and hold it up to the webcam. Make sure its reasonably visible to the camera, and tilt the phone to avoid glare.
3. Play with **Confidence needed** on the right:
   - **Lower** (e.g. 15%): catches more, including small or partly hidden flames, but raises more false alarms.
   - **Higher** (e.g. 60%): only alerts when the model is very sure.
   - Watch the boxes and percentages change. The fire has to stay in view for about a second before it alerts.
4. Once it alerts, read the card on the **Coordinator** screen. The AI looks at the photo itself and should spot that the fire is **on a phone screen**. It will usually suggest sending someone to find the person and tell security, with **False alarm** as the alternative.
5. Click **False alarm**, put the phone away, and wait for a few seconds.
6. Hold the photo up again. This opens a new incident, and the AI also reads the earlier false alarm. It should connect the two, for example as **a repeat prank at the same camera**, and be more confident it isn't real.

> The AI writes a fresh judgement each time, so the exact wording varies.

### Also try

- Add a photo to your report from the volunteer screen.
- Report the same thing twice within a minute: it becomes one incident with two reports.
- Untick a step, swap the volunteer or edit a message on the coordinator's plan before running it.

---

## Optional extras

### Use real phones as volunteers (ngrok)

The volunteer screen works on the same computer, but the real experience is on a phone: reporting by voice from the crowd and getting assignments in your pocket. Phones can't open `localhost`, so ngrok gives your computer a secure public link.

1. Sign up for free at [ngrok.com](https://ngrok.com).
2. Install it:
   - **Windows:** `winget install ngrok.ngrok`
   - **Mac:** `brew install ngrok`
3. Connect your account. Copy the `ngrok config add-authtoken …` command from your ngrok dashboard and run it.
4. In the dashboard, open **Domains** and copy your free domain.
5. In a **second** terminal (keep MaydAI running), start the link:
   ```bash
   ngrok http 3000 --url=https://YOUR-DOMAIN.ngrok-free.app
   ```
6. Put the same link in your settings file (`.env`, from step 3) as `PUBLIC_URL=https://YOUR-DOMAIN.ngrok-free.app`, then restart MaydAI.
7. On the **Camera** screen, open **Volunteer sign-up QR code** and scan it with a phone. Tap **Visit Site** on ngrok's warning page.

If the link isn't working, the camera screen says so under the QR code.

### Have your own footage?

On the **Camera** screen, click **Play a video file…**, or drop a video onto the picture. It plays as if it were a live camera. To add it to the **Demo clips** list, put the MP4 in `public/footage/`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `node` or `npm` is "not recognized" / "not found" | Install Node.js, then **close and reopen** the terminal |
| `EADDRINUSE` (port 3000 is in use) | In `.env`, set `PORT=3001`, then use `localhost:3001` |
| Plans aren't from the AI | No key or a mistyped one: check `.env`, then restart |
| AI plans take 15 seconds or more | In `.env`, set `AI_PLAN_EFFORT=low`, then restart. Plans arrive in about 9 seconds with similar advice |
| The camera is blocked | Click the camera icon in Chrome's address bar and allow it, or use the demo clips |
| A demo clip doesn't move | Make sure the camera window isn't hidden behind another window |
| You want a clean start | Press **Ctrl + C**, then `npm start`. This clears all incidents and volunteers |

## Learn more

- [How it works](docs/how-it-works.md): detection, AI plans, voice reports, file layout and tests
- [Fire model](public/fire/MODEL.md): where the model comes from and how it was benchmarked
