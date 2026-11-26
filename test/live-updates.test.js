import assert from 'node:assert/strict';
import express from 'express';
import { after, before, test } from 'node:test';
import { createLiveUpdates } from '../src/live-updates.js';

let server;
let origin;
let live;

async function frame(stream) {
  while (!stream.pending.includes('\n\n')) {
    const next = await stream.reader.read();
    if (next.done) throw new Error('SSE stream ended before a frame arrived');
    stream.pending += next.value;
  }
  const end = stream.pending.indexOf('\n\n');
  const value = stream.pending.slice(0, end);
  stream.pending = stream.pending.slice(end + 2);
  return value;
}

async function eventFrame(stream, eventName) {
  for (;;) {
    const value = await frame(stream);
    if (value.startsWith(`event: ${eventName}\n`)) return value;
  }
}

async function openStream(cookie = 'mci_session=signed-cookie') {
  const response = await fetch(`${origin}/api/live`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  return { reader: response.body.pipeThrough(new TextDecoderStream()).getReader(), pending: '' };
}

before(async () => {
  const app = express();
  app.use(express.json());
  live = createLiveUpdates({ heartbeatMs: 10 });
  app.use('/api', live.observe);
  app.get('/api/live', live.subscribe);
  app.get('/api/session', (_req, res) => res.json({ staff: null }));
  app.post('/api/session', (_req, res) => res.json({ staff: null }));
  app.post('/api/presence', (_req, res) => res.json({ onlineStaffCount: 1 }));
  app.post('/api/patients', (req, res) =>
    res
      .status(201)
      .json({
        patient: { id: 'MCI-001', incidentId: req.get('X-Incident-ID') },
      }),
  );
  app.post('/api/stock', (_req, res) => res.status(201).json({ stock: [] }));
  app.post('/api/register', (_req, res) =>
    res.status(201).json({ staff: { id: 'private' } }),
  );
  app.post('/api/incidents', (_req, res) =>
    res.status(201).json({ incident: { id: 'inc-new' } }),
  );
  app.post('/api/management/staff', (_req, res) =>
    res.status(201).json({ account: { id: 'private' } }),
  );
  app.post('/api/failure', (_req, res) =>
    res.status(500).json({ error: 'failed' }),
  );
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  live?.close();
  await new Promise((resolve) => server?.close(resolve));
});

test('subscribers receive ready, heartbeat, and metadata-only changes', async () => {
  const first = await openStream();
  const second = await openStream();
  assert.match(await frame(first), /^event: ready\ndata: /);
  assert.match(await frame(second), /^event: ready\ndata: /);
  assert.match(await frame(first), /^: heartbeat$/);

  const request = fetch(`${origin}/api/patients`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Incident-ID': 'inc-1' },
    body: JSON.stringify({ medical: 'must never be sent' }),
  });
  assert.equal((await request).status, 201);
  for (const stream of [first, second]) {
    const change = await eventFrame(stream, 'change');
    assert.equal(change.split('\n')[0], 'event: change');
    assert.deepEqual(JSON.parse(change.split('\n')[1].slice('data: '.length)), {
      resource: 'patients',
      incidentId: 'inc-1',
    });
    assert.doesNotMatch(change, /medical|MCI-001/);
  }
  await Promise.all([first.reader.cancel(), second.reader.cancel()]);
});

test('maps stock, incidents, registration, and management writes and suppresses reads, presence, and failures', async () => {
  const stream = await openStream();
  await frame(stream);
  const post = (path, body = {}, headers = {}) =>
    fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  assert.equal((await post('/api/session')).status, 200);
  assert.equal((await post('/api/presence')).status, 200);
  assert.equal((await post('/api/failure')).status, 500);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(
    (await post('/api/stock', {}, { 'X-Incident-ID': 'inc-stock' })).status,
    201,
  );
  assert.deepEqual(
    JSON.parse((await eventFrame(stream, 'change')).split('\n')[1].slice(6)),
    {
      resource: 'stock',
      incidentId: 'inc-stock',
    },
  );
  assert.equal((await post('/api/register')).status, 201);
  assert.deepEqual(
    JSON.parse((await eventFrame(stream, 'change')).split('\n')[1].slice(6)),
    {
      resource: 'staff',
      incidentId: null,
    },
  );
  assert.equal((await post('/api/management/staff')).status, 201);
  assert.deepEqual(
    JSON.parse((await eventFrame(stream, 'change')).split('\n')[1].slice(6)),
    {
      resource: 'staff',
      incidentId: null,
    },
  );
  assert.equal((await post('/api/incidents')).status, 201);
  assert.deepEqual(
    JSON.parse((await eventFrame(stream, 'change')).split('\n')[1].slice(6)),
    {
      resource: 'incidents',
      incidentId: 'inc-new',
    },
  );
  await stream.reader.cancel();
});

test('close clears subscribers and heartbeat without holding the test open', async () => {
  const stream = await openStream();
  await frame(stream);
  live.close();
  await assert.rejects(() => eventFrame(stream, 'change'), /ended before/);
});
