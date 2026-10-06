// Runs the full flow without any browsers: volunteer joins, camera reports a fire,
// coordinator dispatches, volunteer receives directions. Start the server first.
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const coordinator = io(URL), volunteer = io(URL), camera = io(URL);
  let incident = null, assignment = null;
  coordinator.on('incident:new', i => { incident = i; console.log('coordinator got incident:', i.id, i.typeLabel, 'at', i.zoneName); });
  coordinator.on('incident:updated', i => { if (i.recommendation && !incident?.recommendation) console.log('recommendation (' + i.recommendation.source + '):', i.recommendation.summary); incident = i; });
  volunteer.on('assignment', a => { assignment = a; console.log('volunteer got assignment:', a.typeLabel, '->', a.zoneName); console.log('directions:', a.directionsUrl); });
  await wait(500);

  const joined = await volunteer.emitWithAck('volunteer:join', { name: 'Judge', qualifications: ['first_aid'] });
  console.log('volunteer joined:', joined.volunteer.id, 'at', joined.volunteer.zoneId);

  const r1 = await camera.emitWithAck('incident:report', { type: 'fire', source: 'camera', confidence: 0.82 });
  const r2 = await camera.emitWithAck('incident:report', { type: 'fire', source: 'camera', confidence: 0.91 });
  console.log('reports:', r1, r2);
  await wait(9000);

  console.log('shortlist:', incident.shortlist.map(v => `${v.name} (tier ${v.tier}, ${v.distance} m)`).join(', '));
  const top = incident.shortlist[0];
  const res = await coordinator.emitWithAck('dispatch', { incidentId: incident.id, volunteerId: top.id });
  console.log('dispatch:', res);
  await wait(500);
  volunteer.emit('assignment:respond', { incidentId: incident.id, status: 'accepted' });
  await wait(300);
  console.log('incident status:', incident.status, incident.assignmentStatus);
  const ok = assignment && incident.assignmentStatus === 'accepted' && top.name === 'Judge';
  console.log(ok ? '\nPASS: full flow works' : '\nFAIL');
  process.exit(ok ? 0 : 1);
})();
