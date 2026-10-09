// Runs the lost-person flow without any browsers. A volunteer with a mum reports her child missing, the lookout goes
// to other volunteers, another volunteer reports finding a child, the AI offers the match, the finder sends a photo,
// the mum (through her volunteer) recognises him, both are sent to the meeting point and reunited, and the photos are
// deleted. Then an adult who is found chooses not to be reunited, and only "they're safe" is passed on.
// Start the server first. Works with or without an API key (without one, the only open report is offered as a match).
const { io } = require('socket.io-client');
const URL = process.env.URL || 'http://localhost:3000';
const wait = ms => new Promise(r => setTimeout(r, ms));

async function until(what, test, ms = 90000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = test();
    if (v) return v;
    await wait(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function phone(name, zoneId) {
  const socket = io(URL);
  const p = { socket, name, tasks: [], messages: [], assignments: [], cancelled: [] };
  socket.on('task', t => { p.task = t; if (t) p.tasks.push(t); });
  socket.on('question', q => { p.question = q; });
  socket.on('zone:message', m => p.messages.push(m));
  socket.on('assignment', a => p.assignments.push(a));
  socket.on('assignment:cancelled', c => p.cancelled.push(c));
  p.join = async () => { p.me = (await socket.emitWithAck('volunteer:join', { name, qualifications: [], zoneId })).volunteer; return p; };
  p.report = (type, note) => socket.emitWithAck('incident:report', { type, note, source: 'volunteer', zoneId, reporterId: p.me.id });
  return p;
}

(async () => {
  const coordinator = io(URL, { query: { view: 'coordinator' } });
  const incidents = new Map();
  const banners = [];
  coordinator.on('state', s => s.incidents.forEach(i => incidents.set(i.id, i)));
  coordinator.on('incident:new', i => incidents.set(i.id, i));
  coordinator.on('incident:updated', i => incidents.set(i.id, { ...incidents.get(i.id), ...i }));
  coordinator.on('match:event', m => { banners.push(m.text); console.log('  banner:', m.text); });
  let rosterLeak = false; // a volunteer's task can hold a photo of a person: it must never reach the shared roster
  coordinator.on('volunteers:updated', list => { if (list.some(v => 'task' in v)) rosterLeak = true; });
  const results = [];
  const check = (label, ok) => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`); };

  const sam = await phone('Sam', 'gate-a').join();       // with the mum
  const tom = await phone('Tom', 'food-court').join();   // finds the child
  const kai = await phone('Kai', 'food-court').join();   // gets the lookout
  console.log('volunteers joined:', [sam, tom, kai].map(p => `${p.name} at ${p.me.zoneId}`).join(', '));
  check('volunteers posted where they chose', sam.me.zoneId === 'gate-a' && tom.me.zoneId === 'food-court');

  // ---- A child goes missing ----
  console.log('\n-- missing child --');
  const r1 = await sam.report('lost_person', 'A mum here, Sarah, has lost her son Leo. He is 5, curly brown hair, red hoodie with a dinosaur on it and blue shorts. She last saw him at the Food Court about 10 minutes ago.');
  const missing = () => incidents.get(r1.id);
  await until('a profile and a plan for the missing child', () => missing()?.person && missing()?.recommendation && !missing().analysing);
  check('"someone lost" read as someone looking for him', missing().type === 'missing_person');
  console.log('person:', missing().person.summary, `| ${missing().typeLabel}, priority ${missing().priority}`);
  console.log('insight:', missing().recommendation.insight);
  const plan = missing().recommendation.options[0].plan;
  console.log('plan:', plan.map(a => `${a.kind}${a.zoneIds ? ` [${a.zoneIds}]` : ''}`).join(', ') || '(none)');
  const lookout = plan.find(a => a.kind === 'alert_zones');
  check('plan alerts volunteers', !!lookout);
  if (lookout) {
    // Make sure the demo's lookout reaches the Food Court whatever zones the AI chose.
    const run = await coordinator.emitWithAck('plan:run', { incidentId: r1.id, actions: [{ id: lookout.id, text: lookout.text }] });
    console.log('ran lookout:', JSON.stringify(run.results));
    await wait(300);
    if (lookout.zoneIds.includes('food-court')) check('Kai got the lookout', kai.messages.some(m => m.lookout));
    check('Sam (the reporter) did not get the lookout', !sam.messages.some(m => m.lookout));
  }

  // ---- The coordinator asks for more, and the answer lands on the same incident ----
  console.log('\n-- question and answer --');
  if (missing().recommendation.askReporter) console.log('AI suggests asking:', missing().recommendation.askReporter);
  const incidentCount = incidents.size;
  const asked = await coordinator.emitWithAck('incident:ask', { incidentId: r1.id, text: 'Is he carrying anything, and does he have any medical needs?' });
  check('question sent to the reporter', asked.ok && asked.to === 'Sam' && asked.delivered);
  await until('Sam gets the question', () => sam.question?.incidentId === r1.id);
  const reportsBefore = missing().reports.length;
  const answer = await sam.socket.emitWithAck('incident:report', {
    source: 'volunteer', reporterId: sam.me.id, updateFor: r1.id, update: 'answer', questionId: sam.question.questionId,
    note: 'Sarah says he has a small blue backpack with a toy shark on it. No medical needs.',
  });
  check('answer filed on the same incident', answer.id === r1.id && answer.merged);
  await until('the answer on the card', () => missing().reports.length === reportsBefore + 1);
  const last = missing().reports.at(-1);
  check('marked as the answer to the question', last.update === 'answer' && /medical/.test(last.answerTo));
  check('question closed on the phone', sam.question === null);
  check('no new incident opened', incidents.size === incidentCount);
  check('the coordinator can see it was answered', missing().questions.at(-1).answeredAt > 0);
  if (missing().person.source === 'ai') { // without the AI the profile is just the first report's words
    const reread = await until('the AI re-reads him with the answer', () => /backpack|shark/i.test(missing().person.looks + missing().person.summary), 60000).catch(() => false);
    check('profile now includes the backpack', !!reread);
    console.log('person now:', missing().person.looks);
  }
  const extra = await sam.socket.emitWithAck('incident:report', { source: 'volunteer', reporterId: sam.me.id, updateFor: r1.id, update: 'update', note: 'Sarah has his photo on her phone if needed.' });
  check('the reporter can add detail without being asked', extra.id === r1.id && incidents.size === incidentCount);

  // ---- A child is found ----
  console.log('\n-- found child --');
  const r2 = await tom.report('lost_person', 'Found a little boy on his own by the water station, crying. About 5, curly brown hair, grey striped T-shirt and blue shorts. He says his name is Leo and he cannot find his mum.');
  const found = () => incidents.get(r2.id);
  await until('a match on the found child', () => found()?.match);
  check('"someone lost" read as the child being with Tom', found().type === 'found_person');
  const m = found().match;
  console.log(`match: ${m.confidence ?? '?'}% | agree: ${m.agree.join('; ')} | differ: ${m.differ.join('; ')} | check: ${m.check}`);
  console.log('summary:', m.summary);
  check('matched the found child to the missing report', m.missingId === r1.id && m.foundId === r2.id);
  check('missing card shows the same match', missing().match?.id === m.id);

  // ---- Check with a photo of the child, shown to the mum ----
  const c1 = await coordinator.emitWithAck('match:action', { matchId: m.id, action: 'check', method: 'photo_of_found' });
  check('check started', c1.ok && c1.delivered);
  await until('Tom asked for a photo', () => tom.task?.kind === 'photo');
  await until('Sam told a photo is coming', () => sam.task?.kind === 'info');
  const jpeg = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  const wrongPhone = await fetch(`${URL}/api/match-photo`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Match-Id': m.id, 'X-Volunteer-Id': kai.me.id }, body: jpeg });
  check('only the finder can send the photo', wrongPhone.status === 409);
  const up = await fetch(`${URL}/api/match-photo`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'X-Match-Id': m.id, 'X-Volunteer-Id': tom.me.id }, body: jpeg });
  check('photo uploaded', up.ok);
  await until('Sam asked to show the photo', () => sam.task?.kind === 'answer' && sam.task.photoUrl);
  const photoUrl = sam.task.photoUrl;
  const ans = await sam.socket.emitWithAck('match:answer', { matchId: m.id, value: 'yes' });
  check('mum recognised him', ans.ok);
  await until('confirmed', () => found().match?.status === 'confirmed');
  if (lookout?.zoneIds.includes('food-court')) await until('Kai told to stand down', () => kai.messages.some(x => x.standDown), 3000).then(() => check('lookout stood down', true), () => check('lookout stood down', false));

  // ---- Reunite at the meeting point ----
  const meet = await coordinator.emitWithAck('match:action', { matchId: m.id, action: 'meet' });
  check('sent to meet', meet.ok);
  await until('both sent to the Info Tent', () => tom.assignments.at(-1)?.reunion && sam.assignments.at(-1)?.reunion);
  console.log('Tom:', tom.assignments.at(-1).summary);
  console.log('Sam:', sam.assignments.at(-1).summary);
  check('directions to the Info Tent', tom.assignments.at(-1).zoneName === 'Info Tent' && sam.assignments.at(-1).zoneName === 'Info Tent');
  await tom.socket.emitWithAck('incident:report', { source: 'volunteer', reporterId: tom.me.id, updateFor: r2.id, update: 'sorted', type: 'found_person', note: '' });
  await until('Tom says reunited', () => found().match?.reunitedBy === 'Tom');
  const fin = await coordinator.emitWithAck('match:action', { matchId: m.id, action: 'finish' });
  check('closed both', fin.ok);
  await until('both resolved', () => missing().status === 'resolved' && found().status === 'resolved');
  // Each phone hears on its own socket, so its news can land just after the coordinator's.
  const stoodDown = await until('both phones stood down', () => tom.cancelled.some(c => c.resolved) && sam.cancelled.some(c => c.resolved), 3000).catch(() => false);
  check('both volunteers stood down', stoodDown);
  check('photo deleted on close', (await fetch(URL + photoUrl)).status === 404);

  // ---- An adult who is found chooses not to meet ----
  console.log('\n-- adult who does not want to be found --');
  const r3 = await sam.report('lost_person', 'Alex has lost their friend Sam, 24, near the Main Stage about half an hour ago. Tall, black cap, green festival T-shirt. His phone is dead.');
  await until('profile for the missing adult', () => incidents.get(r3.id)?.person);
  const r4 = await tom.report('lost_person', 'A guy here says he has lost his mates. Mid twenties, black cap, green T-shirt. Says his name is Sam and his phone is flat. He seems fine.');
  const adult = () => incidents.get(r4.id);
  await until('a match on the found adult', () => adult()?.match);
  check('the adult reports read as missing and found', incidents.get(r3.id).type === 'missing_person' && adult().type === 'found_person');
  console.log(`match: ${adult().match.confidence ?? '?'}%, AI suggests ${adult().match.check} (${adult().match.checkWhy})`);
  console.log(`missing adult priority ${incidents.get(r3.id).priority}, found adult priority ${adult().priority}`);
  const c2 = await coordinator.emitWithAck('match:action', { matchId: adult().match.id, action: 'check', method: 'ask_person' });
  check('asking the adult', c2.ok);
  await until('Tom asked to ask him', () => tom.task?.kind === 'answer' && tom.task.answers?.some(a => a.value === 'declines'));
  await tom.socket.emitWithAck('match:answer', { matchId: adult().match.id, value: 'declines' });
  await until('declined', () => adult().match?.status === 'declined');
  check('Alex only hears he is safe', sam.task?.kind === 'info' && /safe/.test(sam.task.text) && !/Food Court|Gate A|Main Stage/.test(sam.task.text));
  await coordinator.emitWithAck('match:action', { matchId: adult().match.id, action: 'finish' });
  await until('both adult reports closed', () => adult().status === 'resolved' && incidents.get(r3.id).status === 'resolved');
  check('closed without a reunion', adult().match.status === 'closed');

  check('the shared roster never carried a task or photo', !rosterLeak);

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(err => { console.error(err.message); process.exit(1); });
