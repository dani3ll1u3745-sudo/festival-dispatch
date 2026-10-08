// Runs the full flow without any browsers: volunteer joins, camera reports a fire,
// coordinator dispatches, volunteer receives directions. Then a medical incident
// arrives and the same volunteer is reassigned to it. Then two volunteers are sent
// to one incident and stood down one at a time, and a volunteer describes an "other"
// incident, camera sightings come and go, and a voice report's transcript arrives after
// the report, a plan is run, and a volunteer adds a photo to their report. Start the server first.
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
  const judgeOnFire = fire().assignments.find(a => a.volunteerId === joined.volunteer.id);
  console.log('incident status:', fire().status, judgeOnFire?.status);
  const ok1 = assignment && judgeOnFire?.status === 'accepted' && top.name === 'Judge';
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

  // ---- Scenario 3: two volunteers on one incident, stood down one at a time ----
  console.log('\n-- scenario 3: multiple volunteers --');
  const r4 = await camera.emitWithAck('incident:report', { type: 'overcrowding', source: 'camera', confidence: 0.8 });
  await wait(500);
  const crowd = () => incidents.get(r4.id);
  const assignedIds = () => crowd().assignments.map(a => a.volunteerId);
  console.log('dispatch Tom:', await coordinator.emitWithAck('dispatch', { incidentId: r4.id, volunteerId: 'seed-tom' }));
  console.log('dispatch Priya:', await coordinator.emitWithAck('dispatch', { incidentId: r4.id, volunteerId: 'seed-priya' }));
  await wait(300);
  console.log('assigned:', crowd().assignments.map(a => a.name).join(', '), '| status:', crowd().status);
  const bothOn = assignedIds().includes('seed-tom') && assignedIds().includes('seed-priya') && crowd().status === 'dispatched';

  coordinator.emit('incident:unassign', { incidentId: r4.id, volunteerId: 'seed-tom' });
  await wait(300);
  console.log('after removing Tom:', crowd().assignments.map(a => a.name).join(', '), '| status:', crowd().status);
  const priyaStays = !assignedIds().includes('seed-tom') && assignedIds().includes('seed-priya') && crowd().status === 'dispatched';

  coordinator.emit('incident:unassign', { incidentId: r4.id, volunteerId: 'seed-priya' });
  await wait(300);
  console.log('after removing Priya:', crowd().assignments.length, 'assigned | status:', crowd().status);
  const reopened = crowd().assignments.length === 0 && crowd().status === 'open';
  const ok3 = bothOn && priyaStays && reopened;
  console.log(ok3 ? 'scenario 3 ok' : `scenario 3 FAILED (both on: ${bothOn}, Priya stays: ${priyaStays}, reopened: ${reopened})`);

  // ---- Scenario 4: volunteer describes an "other" incident ----
  // With AI on it may be reclassified, so only check that a sensible incident with candidates exists.
  console.log('\n-- scenario 4: described "other" incident --');
  const r5 = await volunteer.emitWithAck('incident:report', {
    type: 'other', source: 'volunteer', zoneId: 'food-court', reporterId: joined.volunteer.id,
    note: 'A child is lost near the food trucks',
  });
  console.log('report:', r5);
  await wait(10000); // classification and recommendation, if the AI is on
  const other = incidents.get(r5.id);
  console.log('incident:', other?.type, `"${other?.typeLabel}"`, 'priority', other?.priority,
    '| reclassifiedFrom:', other?.reclassifiedFrom, '| reason:', other?.classificationReason);
  console.log('shortlist:', other?.shortlist.map(v => v.name).join(', '));
  const ok4 = !!other && !r5.merged && ['other', 'fire', 'medical', 'overcrowding'].includes(other.type) &&
    other.shortlist.length > 0 && other.reports?.[0]?.typedNote === 'A child is lost near the food trucks';
  console.log(ok4 ? 'scenario 4 ok' : 'scenario 4 FAILED');

  // ---- Scenario 5: camera fire goes out of view and comes back; closing never silences the camera ----
  console.log('\n-- scenario 5: camera status, false alarm and resolve --');
  const auto = { type: 'fire', source: 'camera', zoneId: 'gate-a', confidence: 0.7 };
  const cam1 = await camera.emitWithAck('incident:report', auto);
  await wait(300);
  const gateFire = () => incidents.get(cam1.id);
  const visibleAtStart = gateFire().camera?.visible === true;
  camera.emit('camera:status', { type: 'fire', zoneId: 'gate-a', visible: false });
  await wait(300);
  const clearedOnCard = gateFire().camera?.visible === false;
  // Back in view more than a minute later would still merge; this checks the merge itself.
  const cam2 = await camera.emitWithAck('incident:report', auto);
  await wait(300);
  const backInView = cam2.id === cam1.id && cam2.merged && gateFire().camera?.visible === true;
  console.log('camera visible / cleared / back in view:', visibleAtStart, clearedOnCard, backInView);

  // Closing an incident never silences the camera: the next sighting raises a new alert.
  coordinator.emit('incident:dismiss', { incidentId: cam1.id });
  await wait(300);
  const dismissed = gateFire().status === 'resolved' && gateFire().outcome === 'false_alarm';
  const cam3 = await camera.emitWithAck('incident:report', auto);
  const alertsAfterFalseAlarm = !!cam3.id && !cam3.merged && cam3.id !== cam1.id;
  coordinator.emit('incident:resolve', { incidentId: cam3.id });
  await wait(300);
  const cam4 = await camera.emitWithAck('incident:report', auto);
  const alertsAfterResolve = !!cam4.id && !cam4.merged && cam4.id !== cam3.id;
  console.log('after false alarm:', cam3, '| after resolve:', cam4);
  const ok5 = visibleAtStart && clearedOnCard && backInView && dismissed && alertsAfterFalseAlarm && alertsAfterResolve;
  console.log(ok5 ? 'scenario 5 ok' : `scenario 5 FAILED (dismissed: ${dismissed}, after false alarm: ${alertsAfterFalseAlarm}, after resolve: ${alertsAfterResolve})`);

  // ---- Scenario 6: a voice report is sent at once and its transcript follows ----
  console.log('\n-- scenario 6: background transcript --');
  const reportId = `test-${Date.now()}`;
  const r6 = await volunteer.emitWithAck('incident:report', {
    type: 'other', source: 'volunteer', zoneId: 'food-court', reporterId: joined.volunteer.id,
    note: '', reportId, transcriptPending: true,
  });
  await wait(300);
  const voiceReport = () => incidents.get(r6.id)?.reports?.find(r => r.reportId === reportId);
  const statusBefore = voiceReport()?.transcriptStatus;
  volunteer.emit('incident:transcript', { reportId, text: 'A child is lost near the food trucks' });
  await wait(500);
  console.log('report:', r6, '| transcript status before/after:', statusBefore, voiceReport()?.transcriptStatus,
    '| transcript:', voiceReport()?.transcript);
  const ok6 = statusBefore === 'pending' && voiceReport()?.transcriptStatus === 'done' &&
    voiceReport()?.transcript === 'A child is lost near the food trucks';
  console.log(ok6 ? 'scenario 6 ok' : 'scenario 6 FAILED');

  // ---- Scenario 7: run a plan. A step is re-checked when it runs; a stale one fails and can be retried edited ----
  console.log('\n-- scenario 7: run a plan --');
  const fresh = await volunteer.emitWithAck('volunteer:join', { name: 'Planner', qualifications: ['first_aid'] });
  const spare = await volunteer.emitWithAck('volunteer:join', { name: 'Spare', qualifications: ['first_aid'] });
  await wait(300);
  const p1 = await camera.emitWithAck('incident:report', { type: 'medical', source: 'camera', zoneId: 'first-aid-tent', manual: true, confidence: 1 });
  const med = () => incidents.get(p1.id);
  const steps = () => (med()?.recommendation?.options || []).flatMap(o => o.plan);
  // The plan arrives with the recommendation: within seconds from the AI, at once from the template.
  for (let t = 0; t < 20000 && !steps().some(a => a.kind === 'dispatch'); t += 250) await wait(250);
  const step = steps().find(a => a.kind === 'dispatch');
  console.log('plan:', steps().map(a => `${a.kind} ${a.volunteerName || ''}`).join(', '));
  // Make the planned volunteer busy elsewhere, so the step is stale when it runs.
  const elsewhere = await camera.emitWithAck('incident:report', { type: 'overcrowding', source: 'camera', zoneId: 'gate-a', manual: true, confidence: 1 });
  await coordinator.emitWithAck('dispatch', { incidentId: elsewhere.id, volunteerId: step.volunteerId });
  const stale = await coordinator.emitWithAck('plan:run', { incidentId: p1.id, actions: [{ id: step.id }] });
  console.log('stale run:', stale.results);
  const failedStale = !!stale.results[0]?.error && steps().find(a => a.id === step.id).status === 'failed';
  // Retry with a different volunteer and an edited briefing.
  const swapTo = [fresh.volunteer.id, spare.volunteer.id].find(id => id !== step.volunteerId);
  const retry = await coordinator.emitWithAck('plan:run', { incidentId: p1.id, actions: [{ id: step.id, volunteerId: swapTo, briefing: 'Bring the AED' }] });
  await wait(300);
  console.log('retry:', retry.results);
  const doneStep = steps().find(a => a.id === step.id);
  const retried = doneStep.status === 'done' && doneStep.volunteerId === swapTo && doneStep.briefing === 'Bring the AED'
    && med().assignments.some(a => a.volunteerId === swapTo);
  const again = await coordinator.emitWithAck('plan:run', { incidentId: p1.id, actions: [{ id: step.id }] });
  const notTwice = again.results.length === 0;
  const ok7 = !!step && failedStale && retried && notTwice;
  console.log(ok7 ? 'scenario 7 ok' : `scenario 7 FAILED (plan step: ${!!step}, stale failed: ${failedStale}, retried: ${retried}, not run twice: ${notTwice})`);

  // ---- Scenario 8: a volunteer adds a photo to their report ----
  // Only checks the upload and the coordinator's view, never what the AI makes of it.
  console.log('\n-- scenario 8: photo added to a report --');
  // Its own phone: only the volunteer who sent a report can add to it.
  const photographer = io(URL);
  const { volunteer: snapper } = await photographer.emitWithAck('volunteer:join', { name: 'Snapper', qualifications: [] });
  const photoReportId = `photo-${Date.now()}`;
  const statuses = [];
  photographer.on('report:status', s => statuses.push(s));
  const mediaEvents = [];
  coordinator.on('media:new', m => mediaEvents.push(m));
  const r8 = await photographer.emitWithAck('incident:report', {
    type: 'other', source: 'volunteer', zoneId: 'gate-a', reporterId: snapper.id,
    note: 'Smoke behind the security tent', reportId: photoReportId,
  });
  const TINY_JPEG = Buffer.from('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgUFBcUFxsbGxsbGyAeICEhISAgICAhISEkJCQqKiokJCQhISQkKCgqKi4vLisrKisvLzIyMjw8OTlGRkhWVmf/xABMAAEBAAAAAAAAAAAAAAAAAAAABQEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAAIAAgDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOANqi/9k=', 'base64');
  const upload = await fetch(`${URL}/api/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg', 'X-Report-Id': photoReportId, 'X-Volunteer-Id': snapper.id, 'X-Media-Kind': 'photo' },
    body: TINY_JPEG,
  });
  const { mediaId } = await upload.json();
  const registered = await photographer.emitWithAck('report:media', { reportId: photoReportId, mediaId, kind: 'photo', frames: [] });
  await wait(500);
  const photoReport = incidents.get(r8.id)?.reports?.find(r => r.reportId === photoReportId);
  const served = await fetch(`${URL}/api/media/${mediaId}`, { headers: { Range: 'bytes=0-9' } });
  await served.arrayBuffer(); // read it, so the connection can close
  const latestStatus = statuses.filter(s => s.reportId === photoReportId).pop();
  console.log('upload:', upload.status, mediaId, '| registered:', registered, '| media:new:', mediaEvents,
    '| served:', served.status, served.headers.get('content-type'), '| volunteer sees', latestStatus?.media.length, 'item(s)');
  const ok8 = upload.ok && registered?.ok && mediaEvents.some(m => m.incidentId === r8.id && m.kind === 'photo')
    && photoReport?.media.length === 1 && served.status === 206 && latestStatus?.media.length === 1;
  console.log(ok8 ? 'scenario 8 ok' : 'scenario 8 FAILED');

  const ok = ok1 && ok2 && ok3 && ok4 && ok5 && ok6 && ok7 && ok8;
  console.log(ok ? '\nPASS: full flow works' : '\nFAIL');
  // Exit by closing everything rather than process.exit(): on Windows, exiting while fetch's connections
  // are closing can crash Node after the result is printed. The timer is a backstop if something stays open.
  process.exitCode = ok ? 0 : 1;
  [coordinator, volunteer, camera, photographer].forEach(s => s.close());
  setTimeout(() => process.exit(), 8000).unref();
})();
