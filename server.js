// Festival Dispatch relay server.
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

function buildShortlist(incident) {
  const requires = config.incidentTypes[incident.type].requires; // in priority order
  const target = zone(incident.zoneId);
  return volunteers
    .filter(v => v.status === 'available')
    .map(v => {
      const tier = requires.findIndex(q => v.qualifications.includes(q));
      return {
        id: v.id,
        name: v.name,
        qualifications: v.qualifications,
        zoneId: v.zoneId,
        zoneName: zone(v.zoneId)?.name,
        online: v.online,
        distance: distanceMetres(zone(v.zoneId), target),
        tier: tier === -1 ? 99 : tier,
        qualified: tier !== -1,
      };
    })
    .sort((a, b) => a.tier - b.tier || (a.distance ?? 1e9) - (b.distance ?? 1e9))
    .slice(0, 3);
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
    summary: `Possible ${label} reported at ${incident.zoneName}.`,
    actions,
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
    },
    shortlist: incident.shortlist.map(v => ({
      id: v.id,
      name: v.name,
      qualifications: v.qualifications.map(q => config.qualifications[q]),
      currentZone: v.zoneName,
      distanceMetres: v.distance,
    })),
  };

  const system =
    'You assist a volunteer coordinator at a music festival. Given an incident and a shortlist of available ' +
    'volunteers (already filtered by code), respond with ONLY a JSON object, no markdown, in this shape: ' +
    '{"summary": "max 2 short sentences", "actions": ["3 short imperative actions"], ' +
    '"volunteers": [{"id": "volunteer id from the shortlist", "reason": "max 12 words"}]}. ' +
    'Rank volunteers best first. Only use ids from the shortlist. Be calm and practical.';

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
    return { source: 'ai', summary: parsed.summary, actions: parsed.actions.slice(0, 4), volunteers: vols };
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
    status: 'open', // open -> dispatched -> resolved
    assignedVolunteerId: null,
    assignmentStatus: null, // sent -> accepted -> arrived
    shortlist: [],
    recommendation: null,
  };
  incident.shortlist = buildShortlist(incident);
  incidents.unshift(incident);
  console.log(`[incident] ${incident.id} ${type} at ${incident.zoneName} via ${source}`);
  io.emit('incident:new', incident);

  getRecommendation(incident).then(rec => {
    incident.recommendation = rec;
    io.emit('incident:updated', incident);
  });

  return { id: incident.id, merged: false };
}

function refreshOpenShortlists() {
  incidents
    .filter(i => i.status === 'open')
    .forEach(i => {
      i.shortlist = buildShortlist(i);
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

  socket.on('dispatch', ({ incidentId, volunteerId } = {}, ack) => {
    const inc = incidents.find(i => i.id === incidentId);
    const v = volunteers.find(x => x.id === volunteerId);
    if (!inc || !v) return typeof ack === 'function' && ack({ error: 'Incident or volunteer not found' });

    // If this incident was already assigned to someone else, free them.
    const previous = volunteers.find(x => x.id === inc.assignedVolunteerId);
    if (previous && previous !== v) {
      previous.status = 'available';
      previous.assignment = null;
      if (previous.socketId) io.to(previous.socketId).emit('assignment:cancelled', { incidentId });
    }

    inc.status = 'dispatched';
    inc.assignedVolunteerId = v.id;
    inc.assignmentStatus = 'sent';
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
  });

  socket.on('assignment:respond', ({ incidentId, status } = {}) => {
    const inc = incidents.find(i => i.id === incidentId);
    const v = volunteers.find(x => x.id === socket.data.volunteerId);
    if (!inc || !v || !['accepted', 'arrived'].includes(status)) return;
    inc.assignmentStatus = status;
    if (v.assignment) v.assignment.status = status;
    io.emit('incident:updated', inc);
    broadcastVolunteers();
  });

  socket.on('incident:resolve', ({ incidentId } = {}) => {
    const inc = incidents.find(i => i.id === incidentId);
    if (!inc) return;
    inc.status = 'resolved';
    const v = volunteers.find(x => x.id === inc.assignedVolunteerId);
    if (v) {
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
  console.log(`Festival Dispatch running on http://localhost:${PORT}`);
  console.log(`  Camera:      http://localhost:${PORT}/camera.html`);
  console.log(`  Coordinator: http://localhost:${PORT}/coordinator.html`);
  console.log(`  Volunteer:   http://localhost:${PORT}/volunteer.html`);
  console.log(`  AI recommendations: ${anthropic ? `on (${MODEL})` : 'off (no ANTHROPIC_API_KEY, using template)'}`);
});
