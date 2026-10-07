// MaydAI relay server.
// Holds all state in memory (restart = clean slate) and relays events between
// the camera page (laptop), coordinator page (phone) and volunteer pages (phones).
require('dotenv').config({ quiet: true });
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const config = require('./config.json');
const seedVolunteers = require('./volunteers.json');

const PORT = process.env.PORT || 3000;
const MERGE_WINDOW_MS = 60 * 1000; // same type + same zone within 60s = same incident
const AI_TIMEOUT_MS = 15000; // reading the photo takes a few seconds; the alert itself never waits for it
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const MODEL_HAS_EFFORT = !MODEL.startsWith('claude-haiku'); // Haiku 4.5 takes neither effort nor server-side fallbacks

// ---------- Claude client (optional: falls back to a template if no key) ----------
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new (Anthropic.default || Anthropic)({ apiKey: process.env.ANTHROPIC_API_KEY });
}

// ---------- In-memory state ----------
const incidents = []; // newest first
const volunteers = seedVolunteers.map(v => ({ ...v, online: false, socketId: null, assignment: null }));
let incidentCounter = 1;
let volunteerCounter = 1;
let startZoneCounter = 0;

// ---------- Helpers ----------
const zone = id => config.zones[id];

function distanceMetres(a, b) {
  if (!a || !b) return null;
  const R = 6371000, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

function publicVolunteer(v) {
  const { socketId, ...rest } = v;
  return rest;
}

function candidateFor(v, incident) {
  const requires = config.incidentTypes[incident.type].requires; // in priority order
  const tier = requires.findIndex(q => v.qualifications.includes(q));
  return {
    id: v.id,
    name: v.name,
    qualifications: v.qualifications,
    zoneId: v.zoneId,
    zoneName: zone(v.zoneId)?.name,
    online: v.online,
    distance: distanceMetres(zone(v.zoneId), zone(incident.zoneId)),
    tier: tier === -1 ? 99 : tier,
    qualified: tier !== -1,
  };
}

function buildShortlist(incident) {
  return volunteers
    .filter(v => v.status === 'available')
    .map(v => candidateFor(v, incident))
    .sort((a, b) => a.tier - b.tier || (a.distance ?? 1e9) - (b.distance ?? 1e9))
    .slice(0, 3);
}

// Volunteers already assigned elsewhere who could be pulled off a less urgent job.
// 'busy' volunteers are unavailable for other reasons and never offered.
function buildBusyCandidates(incident) {
  return volunteers
    .filter(v => v.status === 'assigned' && v.assignment && v.assignment.incidentId !== incident.id)
    .map(v => ({
      ...candidateFor(v, incident),
      currentIncidentId: v.assignment.incidentId,
      currentTypeLabel: v.assignment.typeLabel,
      currentZoneName: v.assignment.zoneName,
      currentPriority: config.incidentTypes[v.assignment.type].priority,
    }))
    .sort((a, b) => b.currentPriority - a.currentPriority || a.tier - b.tier || (a.distance ?? 1e9) - (b.distance ?? 1e9))
    .slice(0, 3);
}

const isQualifiedFor = (v, incident) =>
  !!v && config.incidentTypes[incident.type].requires.some(q => v.qualifications.includes(q));

// Escalate only when nobody trained is on the incident and nobody trained is free.
function setCandidates(incident) {
  incident.shortlist = buildShortlist(incident);
  incident.busyCandidates = buildBusyCandidates(incident);
  incident.needsEscalation =
    !incident.assignments.some(a => isQualifiedFor(volunteers.find(v => v.id === a.volunteerId), incident)) &&
    !incident.shortlist.some(v => v.qualified);
}

// Takes one volunteer off an incident; reopens it if nobody is left.
function removeFromIncident(incident, volunteerId) {
  incident.assignments = incident.assignments.filter(a => a.volunteerId !== volunteerId);
  if (incident.status !== 'resolved' && incident.assignments.length === 0) incident.status = 'open';
  emitUpdate(incident);
}

// Snapshots are ~40 KB each, so updates only carry one when it changed. Clients keep the last one they got.
function emitUpdate(incident, withSnapshot = false) {
  io.emit('incident:updated', withSnapshot ? incident : { ...incident, snapshot: undefined });
}

function buildDirectionsUrl(volunteer, incident) {
  const dest = zone(incident.zoneId);
  const params = new URLSearchParams({ api: '1', destination: `${dest.lat},${dest.lng}`, travelmode: 'walking' });
  if (config.locationMode === 'simulated') {
    const origin = zone(volunteer.zoneId);
    if (origin) params.set('origin', `${origin.lat},${origin.lng}`);
  }
  // In real-GPS mode we omit origin, so Google Maps starts from the phone's location.
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function templateRecommendation(incident) {
  const label = config.incidentTypes[incident.type].label.toLowerCase();
  const actions = {
    fire: ['Send a fire warden with an extinguisher', 'Clear people from the area', 'Call 000 if it grows'],
    medical: ['Send a first aider with a kit', 'Keep access clear', 'Call an ambulance if unresponsive'],
    overcrowding: ['Send crowd control to slow entry', 'Open another exit route', 'Announce a redirect'],
  }[incident.type];
  return {
    source: 'template',
    recommendedCount: { fire: 2, medical: 1, overcrowding: 2 }[incident.type],
    summary: `Possible ${label} reported at ${incident.zoneName}.`,
    scene: null,
    actions: incident.needsEscalation ? ['No trained volunteer free: call emergency services', ...actions] : actions,
    volunteers: incident.shortlist.map(v => ({
      id: v.id,
      reason: `${v.qualifications.map(q => config.qualifications[q]).join(', ') || 'No qualifications'}; ${v.distance} m away`,
    })),
  };
}

// What Claude sees in the camera frame. Kept to a verdict and one sentence: the coordinator reads it in seconds.
const SCENE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['confirms', 'looksLike', 'insight', 'peopleNearby'],
  properties: {
    confirms: {
      type: 'string', enum: ['yes', 'no', 'unclear'],
      description: 'Does the photo show the reported incident as a real emergency happening in front of the camera?',
    },
    looksLike: { type: 'string', description: 'What it actually is, 2 to 5 words, e.g. "small bin fire", "fire on a phone screen", "stage pyrotechnics"' },
    insight: { type: 'string', description: 'One sentence, at most 18 words: the one thing in the photo that most changes what the coordinator should do' },
    peopleNearby: { type: 'string', enum: ['none', 'few', 'many', 'unclear'] },
  },
};

function recommendationSchema(withScene) {
  const properties = {
    ...(withScene && { scene: SCENE_SCHEMA }),
    summary: { type: 'string', description: 'One sentence, at most 15 words' },
    actions: { type: 'array', items: { type: 'string' }, description: '2 or 3 imperative steps, at most 8 words each' },
    volunteers: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'reason'],
        properties: { id: { type: 'string' }, reason: { type: 'string', description: 'At most 10 words' } },
      },
    },
    recommendedCount: { type: 'integer', description: '1 to 3' },
  };
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

const RECOMMENDATION_SYSTEM = `You support the volunteer coordinator at a music festival. They read your answer on a phone, mid-incident, in a few seconds. Be brief, concrete and honest.

You get an incident (from a fire-detection camera model or a person), a shortlist of available volunteers already filtered by code, and sometimes a photo from the camera.

If there is a photo, fill in scene:
- Judge the scene yourself. The coloured boxes and percentages were drawn by the detection model; they are not evidence.
- Say plainly what is actually there. If the "fire" is on a phone or screen, or is a candle, a barbecue, stage pyrotechnics or lighting, say so.
- insight is the single fact in the photo that most changes the response: size or spread, how close people are, what could catch, blocked exits. If the photo is too dark, blurred or distant to tell, say that instead.
- Never describe anything you cannot see.

summary: one sentence on what matters next. Don't repeat the zone or the incident type.
actions: 2 or 3 short imperative steps that fit what the photo shows.
volunteers: shortlist ids only, best first. A volunteer is qualified when qualifiedForThisIncident is true; acceptedQualifications lists acceptable training, best first. Never say nobody qualified is available if someone is.
recommendedCount: 1 to 3 people in total, counting alreadyAssigned.
Nobody has been sent unless they are in alreadyAssigned. Never say anyone was dispatched, notified or is on the way.
If no shortlisted volunteer is qualified, you may suggest reassigning a named busy volunteer from a less urgent job (priority 1 is most urgent). If nobody suitable is available, include calling emergency services.`;

const clip = (s, n) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

async function getRecommendation(incident) {
  const fallback = templateRecommendation(incident);
  if (!anthropic) return fallback;

  const payload = {
    incident: {
      type: incident.type,
      zone: incident.zoneName,
      detectedBy: incident.sources,
      modelConfidence: incident.confidence,
      note: incident.note || null,
      acceptedQualifications: config.incidentTypes[incident.type].requires.map(q => config.qualifications[q]),
    },
    shortlist: incident.shortlist.map(v => ({
      id: v.id,
      name: v.name,
      qualifications: v.qualifications.map(q => config.qualifications[q]),
      qualifiedForThisIncident: v.qualified,
      currentZone: v.zoneName,
      distanceMetres: v.distance,
    })),
    busyCandidates: incident.busyCandidates.map(v => ({
      id: v.id,
      name: v.name,
      qualifications: v.qualifications.map(q => config.qualifications[q]),
      qualifiedForThisIncident: v.qualified,
      currentZone: v.zoneName,
      distanceMetres: v.distance,
      currentJob: `${v.currentTypeLabel} at ${v.currentZoneName}`,
      currentJobPriority: v.currentPriority,
    })),
    alreadyAssigned: incident.assignments.map(a => ({
      name: a.name,
      qualifications: (volunteers.find(v => v.id === a.volunteerId)?.qualifications || []).map(q => config.qualifications[q]),
    })),
    needsEscalation: incident.needsEscalation,
  };

  // The snapshot is a JPEG data URL from the camera page.
  const photo = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(incident.snapshot || '');
  const content = [
    ...(photo ? [{ type: 'image', source: { type: 'base64', media_type: photo[1], data: photo[2] } }] : []),
    { type: 'text', text: JSON.stringify(payload) },
  ];
  const params = {
    model: MODEL,
    max_tokens: 4000,
    system: RECOMMENDATION_SYSTEM,
    messages: [{ role: 'user', content }],
    output_config: {
      format: { type: 'json_schema', schema: recommendationSchema(!!photo) },
      ...(MODEL_HAS_EFFORT && { effort: 'low' }),
    },
  };
  const options = { timeout: AI_TIMEOUT_MS, maxRetries: 0 };

  try {
    // Server-side fallbacks rerun the request on another model if this one declines; Haiku doesn't take them.
    const resp = MODEL_HAS_EFFORT
      ? await anthropic.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, options)
      : await anthropic.messages.create(params, options);
    if (resp.stop_reason === 'refusal') throw new Error('AI declined');
    if (resp.stop_reason === 'max_tokens') throw new Error('AI ran out of tokens');
    const parsed = JSON.parse(resp.content.filter(b => b.type === 'text').map(b => b.text).join(''));

    const validIds = new Set(incident.shortlist.map(v => v.id));
    const vols = parsed.volunteers.filter(v => validIds.has(v.id)).map(v => ({ id: v.id, reason: clip(v.reason, 90) }));
    const count = Number.isInteger(parsed.recommendedCount)
      ? Math.min(3, Math.max(1, parsed.recommendedCount)) : fallback.recommendedCount;
    const s = parsed.scene;
    const scene = s && s.insight ? {
      confirms: s.confirms,
      looksLike: clip(s.looksLike, 40),
      insight: clip(s.insight, 160),
      peopleNearby: s.peopleNearby,
    } : null;
    return {
      source: 'ai',
      recommendedCount: count,
      summary: clip(parsed.summary, 160),
      scene,
      actions: parsed.actions.slice(0, 3).map(a => clip(a, 80)),
      volunteers: vols,
    };
  } catch (err) {
    console.warn('[ai] falling back to template:', err.message);
    return fallback;
  }
}

// ---------- Core: incoming incident reports ----------
function handleReport(raw = {}) {
  const type = raw.type;
  if (!config.incidentTypes[type]) return { error: `Unknown incident type "${type}"` };
  const zoneId = zone(raw.zoneId) ? raw.zoneId : config.cameraZoneId;
  const source = raw.source === 'volunteer' ? 'volunteer' : 'camera';
  const now = Date.now();
  const confidence = typeof raw.confidence === 'number' ? raw.confidence : source === 'volunteer' ? 1 : null;
  const automatic = source === 'camera' && !raw.manual;

  // An automatic camera sighting joins any open incident of the same type in the same zone, however
  // old: a fire that drops out of view and comes back is still the same fire.
  const existing = incidents.find(
    i => i.type === type && i.zoneId === zoneId && i.status !== 'resolved' && (automatic || now - i.lastSeen < MERGE_WINDOW_MS)
  );
  const camera = automatic ? { visible: true, lastSeenAt: now, changedAt: now } : null;

  if (existing) {
    existing.lastSeen = now;
    existing.reportCount += 1;
    if (!existing.sources.includes(source)) existing.sources.push(source);
    let newSnapshot = false;
    if (confidence != null && (existing.confidence == null || confidence > existing.confidence)) {
      existing.confidence = confidence;
      if (raw.snapshot) { existing.snapshot = raw.snapshot; newSnapshot = true; }
    }
    if (!existing.snapshot && raw.snapshot) { existing.snapshot = raw.snapshot; newSnapshot = true; }
    if (raw.note) existing.note = raw.note;
    if (camera) existing.camera = existing.camera?.visible ? { ...existing.camera, lastSeenAt: now } : camera;
    emitUpdate(existing, newSnapshot);
    return { id: existing.id, merged: true };
  }

  const incident = {
    id: `inc-${incidentCounter++}`,
    type,
    typeLabel: config.incidentTypes[type].label,
    zoneId,
    zoneName: zone(zoneId).name,
    sources: [source],
    reporterId: raw.reporterId || null,
    confidence,
    snapshot: raw.snapshot || null,
    note: raw.note || null,
    createdAt: now,
    lastSeen: now,
    reportCount: 1,
    status: 'open', // open (nobody assigned) <-> dispatched (1+ assigned) -> resolved
    outcome: null, // once resolved: 'resolved' or 'false_alarm'
    camera, // automatic camera incidents: { visible, lastSeenAt, changedAt }, kept current by camera:status
    assignments: [], // { volunteerId, name, status: sent -> accepted -> arrived, assignedAt }
    shortlist: [],
    busyCandidates: [],
    needsEscalation: false,
    recommendation: null,
  };
  setCandidates(incident);
  incidents.unshift(incident);
  console.log(`[incident] ${incident.id} ${type} at ${incident.zoneName} via ${source}`);
  io.emit('incident:new', incident);

  getRecommendation(incident).then(rec => {
    incident.recommendation = rec;
    emitUpdate(incident);
  });

  return { id: incident.id, merged: false };
}

// Refreshes every unresolved incident, so more people can be added to one that already has someone.
function refreshOpenShortlists() {
  incidents
    .filter(i => i.status !== 'resolved')
    .forEach(i => {
      setCandidates(i);
      emitUpdate(i);
    });
}

const broadcastVolunteers = () => io.emit('volunteers:updated', volunteers.map(publicVolunteer));

// ---------- HTTP ----------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/config', (req, res) => {
  res.json({ ...config, publicUrl: process.env.PUBLIC_URL || null, aiEnabled: !!anthropic });
});

// HTTP alternative to the socket event, e.g. for a Python detector.
app.post('/api/incident', (req, res) => {
  const result = handleReport(req.body);
  res.status(result.error ? 400 : 200).json(result);
});

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

// ---------- Sockets ----------
io.on('connection', socket => {
  socket.emit('state', { incidents, volunteers: volunteers.map(publicVolunteer), config });

  socket.on('incident:report', (data, ack) => {
    const result = handleReport(data);
    if (typeof ack === 'function') ack(result);
  });

  socket.on('volunteer:join', ({ name, qualifications } = {}, ack) => {
    const startZones = config.volunteerStartZones;
    const v = {
      id: `vol-${volunteerCounter++}`,
      name: String(name || 'Volunteer').slice(0, 40),
      qualifications: (qualifications || []).filter(q => config.qualifications[q]),
      zoneId: startZones[startZoneCounter++ % startZones.length],
      status: 'available',
      online: true,
      socketId: socket.id,
      assignment: null,
    };
    volunteers.push(v);
    socket.data.volunteerId = v.id;
    console.log(`[volunteer] ${v.name} joined at ${zone(v.zoneId).name}`);
    if (typeof ack === 'function') ack({ volunteer: publicVolunteer(v) });
    broadcastVolunteers();
    refreshOpenShortlists();
  });

  // Called by a volunteer page on (re)connect so a locked/reloaded phone recovers.
  socket.on('volunteer:hello', ({ id } = {}, ack) => {
    const v = volunteers.find(x => x.id === id);
    if (!v) return typeof ack === 'function' && ack({ volunteer: null });
    v.socketId = socket.id;
    v.online = true;
    socket.data.volunteerId = v.id;
    if (typeof ack === 'function') ack({ volunteer: publicVolunteer(v) });
    broadcastVolunteers();
  });

  // Volunteer ends their shift: free any open assignment and drop them from the roster.
  socket.on('volunteer:leave', ({ id } = {}) => {
    const v = volunteers.find(x => x.id === id);
    if (!v || String(v.id).startsWith('seed-')) return;
    const inc = incidents.find(i => i.status !== 'resolved' && i.assignments.some(a => a.volunteerId === v.id));
    if (inc) removeFromIncident(inc, v.id);
    volunteers.splice(volunteers.indexOf(v), 1);
    console.log(`[volunteer] ${v.name} left`);
    broadcastVolunteers();
    refreshOpenShortlists();
  });

  socket.on('dispatch', ({ incidentId, volunteerId } = {}, ack) => {
    const inc = incidents.find(i => i.id === incidentId);
    const v = volunteers.find(x => x.id === volunteerId);
    if (!inc || !v) return typeof ack === 'function' && ack({ error: 'Incident or volunteer not found' });
    if (inc.assignments.some(a => a.volunteerId === v.id)) {
      return typeof ack === 'function' && ack({ error: 'Already assigned to this incident' });
    }

    // If this volunteer is being pulled off another incident, take them off that one.
    const oldId = v.assignment?.incidentId;
    if (oldId && oldId !== inc.id) {
      const oldInc = incidents.find(i => i.id === oldId);
      if (oldInc) removeFromIncident(oldInc, v.id);
      if (v.socketId) io.to(v.socketId).emit('assignment:cancelled', { incidentId: oldId, reassigned: true });
    }

    inc.status = 'dispatched';
    inc.assignments.push({ volunteerId: v.id, name: v.name, status: 'sent', assignedAt: Date.now() });
    v.status = 'assigned';
    v.assignment = {
      incidentId: inc.id,
      type: inc.type,
      typeLabel: inc.typeLabel,
      zoneName: inc.zoneName,
      fromZoneName: zone(v.zoneId).name,
      summary: inc.recommendation?.summary || null,
      directionsUrl: buildDirectionsUrl(v, inc),
      status: 'sent',
    };
    console.log(`[dispatch] ${v.name} -> ${inc.id}`);
    if (v.socketId) io.to(v.socketId).emit('assignment', v.assignment);
    emitUpdate(inc);
    broadcastVolunteers();
    if (typeof ack === 'function') ack({ ok: true, delivered: !!v.socketId });
    refreshOpenShortlists(); // other open incidents now see this volunteer as busy
  });

  socket.on('assignment:respond', ({ incidentId, status } = {}) => {
    const inc = incidents.find(i => i.id === incidentId);
    const v = volunteers.find(x => x.id === socket.data.volunteerId);
    const entry = inc?.assignments.find(a => a.volunteerId === v?.id);
    if (!entry || !['accepted', 'arrived'].includes(status)) return;
    entry.status = status;
    if (v.assignment) v.assignment.status = status;
    emitUpdate(inc);
    broadcastVolunteers();
  });

  // Coordinator stands one volunteer down; anyone else on the incident stays.
  socket.on('incident:unassign', ({ incidentId, volunteerId } = {}) => {
    const inc = incidents.find(i => i.id === incidentId);
    const v = volunteers.find(x => x.id === volunteerId);
    if (!inc || !inc.assignments.some(a => a.volunteerId === volunteerId)) return;
    removeFromIncident(inc, volunteerId);
    if (v) {
      v.status = 'available';
      v.assignment = null;
      if (v.socketId) io.to(v.socketId).emit('assignment:cancelled', { incidentId, standDown: true });
    }
    broadcastVolunteers();
    refreshOpenShortlists();
  });

  // outcome is 'resolved' or 'false_alarm'. Both free the volunteers. Neither silences the camera:
  // if it still sees fire, the next sighting raises a new alert.
  function closeIncident(incidentId, outcome) {
    const inc = incidents.find(i => i.id === incidentId);
    if (!inc || inc.status === 'resolved') return;
    inc.status = 'resolved';
    inc.outcome = outcome;
    inc.resolvedAt = Date.now();
    const falseAlarm = outcome === 'false_alarm';
    for (const a of inc.assignments) {
      const v = volunteers.find(x => x.id === a.volunteerId);
      if (!v) continue;
      v.status = 'available';
      v.assignment = null;
      if (v.socketId) io.to(v.socketId).emit('assignment:cancelled', { incidentId, resolved: !falseAlarm, falseAlarm });
    }
    console.log(`[incident] ${inc.id} closed as ${outcome}`);
    emitUpdate(inc);
    broadcastVolunteers();
    refreshOpenShortlists();
  }
  socket.on('incident:resolve', ({ incidentId } = {}) => closeIncident(incidentId, 'resolved'));
  socket.on('incident:dismiss', ({ incidentId } = {}) => closeIncident(incidentId, 'false_alarm'));

  // Live "is it still in view?" from the camera, so the coordinator can see whether a fire is still burning.
  socket.on('camera:status', ({ type, zoneId, visible, confidence } = {}) => {
    const inc = incidents.find(i => i.type === type && i.zoneId === zoneId && i.status !== 'resolved' && i.camera);
    if (!inc) return;
    const now = Date.now();
    const changed = inc.camera.visible !== !!visible;
    inc.camera = { visible: !!visible, lastSeenAt: visible ? now : inc.camera.lastSeenAt, changedAt: changed ? now : inc.camera.changedAt };
    if (visible) inc.lastSeen = now;
    if (typeof confidence === 'number' && confidence > (inc.confidence ?? 0)) inc.confidence = confidence;
    emitUpdate(inc);
  });

  socket.on('disconnect', () => {
    const v = volunteers.find(x => x.socketId === socket.id);
    if (v) {
      v.online = false;
      v.socketId = null;
      broadcastVolunteers();
    }
  });
});

server.listen(PORT, () => {
  console.log(`MaydAI running on http://localhost:${PORT}`);
  console.log(`  Camera:      http://localhost:${PORT}/camera.html`);
  console.log(`  Coordinator: http://localhost:${PORT}/coordinator.html`);
  console.log(`  Volunteer:   http://localhost:${PORT}/volunteer.html`);
  console.log(`  AI recommendations: ${anthropic ? `on (${MODEL})` : 'off (no ANTHROPIC_API_KEY, using template)'}`);
});
