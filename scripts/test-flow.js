// Runs the full flow without any browsers: volunteer joins, camera reports a fire,
// coordinator dispatches, volunteer receives directions. Then a medical incident
// arrives and the same volunteer is reassigned to it. Start the server first.
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const coordinator = io(URL), volunteer = io(URL), camera = io(URL);
  const incidents = new Map();
  const volunteerEvents = []; // ordered log of what the volunteer phone received
  let assignment = null;
  coordinator.on('incident:new', i => { incidents.set(i.id, i); console.log('coordinator got incident:', i.id, i.typeLabel, 'at', i.zoneName); });
  coordinator.on('incident:updated', i => {
    if (i.recommendation && !incidents.get(i.id)?.recommendation) console.log('recommendation (' + i.recommendation.source + '):', i.recommendation.summary);
    incidents.set(i.id, i);
  });
  volunteer.on('assignment', a => {
    assignment = a; volunteerEvents.push({ event: 'assignment', ...a });
    console.log('volunteer got assignment:', a.typeLabel, '->', a.zoneName); console.log('directions:', a.directionsUrl);
  });
  volunteer.on('assignment:cancelled', c => { volunteerEvents.push({ event: 'assignment:cancelled', ...c }); console.log('volunteer got assignment:cancelled', c); });
  await wait(500);

  // ---- Scenario 1: fire, dispatch, accept ----
  const joined = await volunteer.emitWithAck('volunteer:join', { name: 'Judge', qualifications: ['first_aid'] });
  console.log('volunteer joined:', joined.volunteer.id, 'at', joined.volunteer.zoneId);

  const r1 = await camera.emitWithAck('incident:report', { type: 'fire', source: 'camera', confidence: 0.82 });
  const r2 = await camera.emitWithAck('incident:report', { type: 'fire', source: 'camera', confidence: 0.91 });
  console.log('reports:', r1, r2);
  await wait(9000);

  const fire = () => incidents.get(r1.id);
  console.log('shortlist:', fire().shortlist.map(v => `${v.name} (tier ${v.tier}, ${v.distance} m)`).join(', '));
  const top = fire().shortlist[0];
  const res = await coordinator.emitWithAck('dispatch', { incidentId: r1.id, volunteerId: top.id });
  console.log('dispatch:', res);
  await wait(500);
  volunteer.emit('assignment:respond', { incidentId: r1.id, status: 'accepted' });
  await wait(300);
  console.log('incident status:', fire().status, fire().assignmentStatus);
  const ok1 = assignment && fire().assignmentStatus === 'accepted' && top.name === 'Judge';
  console.log(ok1 ? 'scenario 1 ok' : 'scenario 1 FAILED');

  // ---- Scenario 2: medical arrives, Judge is reassigned from the fire ----
  console.log('\n-- scenario 2: reassignment --');
  const r3 = await camera.emitWithAck('incident:report', { type: 'medical', source: 'camera', zoneId: 'food-court', confidence: 0.9 });
  await wait(1000);
  const medical = () => incidents.get(r3.id);
  console.log('medical shortlist:', medical().shortlist.map(v => v.name).join(', '));
  const hasPriya = medical().shortlist.some(v => v.name === 'Priya');

  const logStart = volunteerEvents.length;
  const res2 = await coordinator.emitWithAck('dispatch', { incidentId: r3.id, volunteerId: joined.volunteer.id });
  console.log('reassign dispatch:', res2);
  await wait(500);
  const [first, second] = volunteerEvents.slice(logStart);
  const gotCancelThenNew = first?.event === 'assignment:cancelled' && first.reassigned === true && first.incidentId === r1.id
    && second?.event === 'assignment' && second.incidentId === r3.id;
  console.log('fire incident status:', fire().status);
  const ok2 = hasPriya && gotCancelThenNew && fire().status === 'open';
  console.log(ok2 ? 'scenario 2 ok' : `scenario 2 FAILED (Priya in shortlist: ${hasPriya}, cancel then new assignment: ${gotCancelThenNew}, fire reopened: ${fire().status === 'open'})`);

  const ok = ok1 && ok2;
  console.log(ok ? '\nPASS: full flow works' : '\nFAIL');
  process.exit(ok ? 0 : 1);
})();
