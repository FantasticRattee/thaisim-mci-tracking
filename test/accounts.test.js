import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/server.js';

const profile = {
  name: 'นก',
  org: 'EMS01',
  callSign: 'A1',
  personnelCode: '007',
  duty: 'Paramedic',
  opZone: 'Primary Triage',
};
let server;
let origin;
let time = Date.parse('2026-11-26T08:00:00Z');

before(async () => {
  process.env.SESSION_SECRET = 'tests-only';
  process.env.DEMO_PASSCODE = 'old-test-pass';
  const { app } = createApp({ dbPath: ':memory:', clock: () => time });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function request(path, { method = 'POST', body, cookie, incident } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (incident) headers['X-Incident-ID'] = incident;
  const response = await fetch(origin + path, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => null),
    cookie: response.headers.get('set-cookie')?.split(';')[0],
  };
}

test('staff can register once and sign in with only their assigned username', async () => {
  const registered = await request('/api/register', { body: profile });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.username, 'นก-EMS01/A1/007');
  const signedIn = await request('/api/session', {
    body: { username: 'นก-ems01/a1/007' },
  });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.staff.id, registered.body.staff.id);
  assert.equal(
    (await request('/api/session', { body: { username: 'missing' } })).status,
    401,
  );
  assert.equal(
    (await request('/api/register', { body: { ...profile, org: 'ems01' } }))
      .status,
    409,
  );
});

test('000 assigns a new sequential code to each registration', async () => {
  const missingCode = {
    ...profile,
    name: 'โดม',
    personnelCode: '000',
    callSign: '',
  };
  const first = await request('/api/register', { body: missingCode });
  const second = await request('/api/register', { body: missingCode });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.body.username, 'โดม-EMS01/001');
  assert.equal(second.body.username, 'โดม-EMS01/002');
});

test('presence counts staff once over multiple sessions and expires', async () => {
  const registered = await request('/api/register', {
    body: { ...profile, name: 'พลอย' },
  });
  assert.equal(registered.status, 201);
  const anotherTab = await request('/api/session', {
    body: { username: registered.body.username },
  });
  const heartbeat = (cookie) => request('/api/presence', { cookie, body: {} });
  assert.equal((await heartbeat(registered.cookie)).body.onlineStaffCount, 1);
  assert.equal((await heartbeat(anotherTab.cookie)).body.onlineStaffCount, 1);
  time += 91000;
  assert.equal(
    (
      await request('/api/overview', {
        method: 'GET',
        cookie: registered.cookie,
      })
    ).body.onlineStaffCount,
    0,
  );
  await heartbeat(registered.cookie);
  await request('/api/session', {
    method: 'DELETE',
    cookie: registered.cookie,
  });
  assert.equal(
    (
      await request('/api/overview', {
        method: 'GET',
        cookie: anotherTab.cookie,
      })
    ).body.onlineStaffCount,
    0,
  );
});
