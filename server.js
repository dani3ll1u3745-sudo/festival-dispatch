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
const AI_TIMEOUT_MS = 8000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

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
  io.emit('incident:updated', incident);
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
    fire: ['Send a fire warden with an extinguisher', 'Clear people from the immediate area', 'Call emergency services if the fire grows'],
    medical: ['Send a first aider with a kit', 'Keep the area clear for access', 'Call an ambulance if the person is unresponsive'],
    overcrowding: ['Send crowd control to slow entry', 'Open an alternative exit route', 'Make an announcement to redirect the crowd'],
  }[incident.type];
  return {
    source: 'template',
    recommendedCount: { fire: 2, medical: 1, overcrowding: 2 }[incident.type],
    summary: `Possible ${label} reported at ${incident.zoneName}.`,
    actions: incident.needsEscalation ? ['No trained volunteer is free: call emergency services', ...actions] : actions,
    volunteers: incident.shortlist.map(v => ({
      id: v.id,
      reason: `${v.qualifications.map(q => config.qualifications[q]).join(', ') || 'No qualifications'}; ${v.distance} m away`,
    })),
  };
}

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('AI timeout')), ms))]);
}

async function getRecommendation(incident) {
  const fallback = templateRecommendation(incident);
  if (!anthropic) return fallback;

  const payload = {
    incident: {
      type: incident.type,
      zone: incident.zoneName,
      detectedBy: incident.sources,
      confidence: incident.confidence,
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

  const system =
    'You assist a volunteer coordinator at a music festival. Given an incident and a shortlist of available ' +
    'volunteers (already filtered by code), respond with ONLY a JSON object, no markdown, in this shape: ' +
    '{"summary": "max 2 short sentences", "actions": ["3 short imperative actions"], ' +
    '"volunteers": [{"id": "volunteer id from the shortlist", "reason": "max 12 words"}], ' +
    '"recommendedCount": 1}. ' +
    'recommendedCount is an integer from 1 to 3: how many volunteers to send in total, counting anyone in ' +
    'alreadyAssigned. Rank volunteers best first. Only use ids from the shortlist. Be calm and practical. ' +
    'Incident priority: 1 is most urgent. ' +
    'A volunteer is qualified if qualifiedForThisIncident is true. acceptedQualifications lists acceptable training ' +
    'in priority order (first is best). Never say no qualified volunteers are available if any shortlisted ' +
    'volunteer has qualifiedForThisIncident true. ' +
    'If no shortlisted volunteer is qualified, you may recommend reassigning a busy volunteer from a less urgent ' +
    'incident, naming them and their current job. If no suitable volunteer is available at all, include calling ' +
    'emergency services in the actions.';

  try {
    const resp = await withTimeout(
      anthropic.messages.create({
        model: MODEL,
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: JSON.stringify(payload) }],
      }),
      AI_TIMEOUT_MS
    );
    const text = resp.content.filter(b => b.type === 'text').map(b => b.text).join('');
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    const validIds = new Set(incident.shortlist.map(v => v.id));
    const vols = (parsed.volunteers || []).filter(v => validIds.has(v.id));
    if (typeof parsed.summary !== 'string' || !Array.isArray(parsed.actions)) throw new Error('Bad AI shape');
    const count = Number.isInteger(parsed.recommendedCount)
      ? Math.min(3, Math.max(1, parsed.recommendedCount)) : fallback.recommendedCount;
    return { source: 'ai', recommendedCount: count, summary: parsed.summary, actions: parsed.actions.slice(0, 4), volunteers: vols };
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

  const existing = incidents.find(
    i => i.type === type && i.zoneId === zoneId && i.status !== 'resolved' && now - i.lastSeen < MERGE_WINDOW_MS
  );

  if (existing) {
    existing.lastSeen = now;
    existing.reportCount += 1;
    if (!existing.sources.includes(source)) existing.sources.push(source);
    if (confidence != null && (existing.confidence == null || confidence > existing.confidence)) {
      existing.confidence = confidence;
      if (raw.snapshot) existing.snapshot = raw.snapshot;
    }
    if (!existing.snapshot && raw.snapshot) existing.snapshot = raw.snapshot;
    if (raw.note) existing.note = raw.note;
    io.emit('incident:updated', existing);
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
    io.emit('incident:updated', incident);
  });

  return { id: incident.id, merged: false };
}

// Refreshes every unresolved incident, so more people can be added to one that already has someone.
function refreshOpenShortlists() {
  incidents
    .filter(i => i.status !== 'resolved')
    .forEach(i => {
      setCandidates(i);
      io.emit('incident:updated', i);
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
    io.emit('incident:updated', inc);
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
    io.emit('incident:updated', inc);
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

  socket.on('incident:resolve', ({ incidentId } = {}) => {
    const inc = incidents.find(i => i.id === incidentId);
    if (!inc) return;
    inc.status = 'resolved';
    for (const a of inc.assignments) {
      const v = volunteers.find(x => x.id === a.volunteerId);
      if (!v) continue;
      v.status = 'available';
      v.assignment = null;
      if (v.socketId) io.to(v.socketId).emit('assignment:cancelled', { incidentId, resolved: true });
    }
    io.emit('incident:updated', inc);
    broadcastVolunteers();
    refreshOpenShortlists();
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
