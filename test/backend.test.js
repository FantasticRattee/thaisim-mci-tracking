import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/server.js';

let app, db, server, base, cookie;
before(async () => {
  process.env.SESSION_SECRET = 'test-secret';
  ({ app, db } = createApp({ dbPath: ':memory:' }));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  cookie = '';
});

async function request(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('cookie', cookie);
  const res = await fetch(new URL(path, base), { ...options, headers });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const body = await res.json().catch(() => null);
  return { res, body };
}
const json = (body) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('health and session are public while data routes require signed session', async () => {
  assert.equal((await request('/healthz')).res.status, 200);
  assert.equal((await request('/api/overview')).res.status, 401);
  const signed = await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'Nok',
      org: 'EMS',
      duty: 'Medic',
      opZone: 'triage',
    }),
  });
  assert.equal(signed.res.status, 201);
  assert.equal(signed.body.staff.name, 'Nok');
  assert.match(signed.body.username, /^NokEMS[0-9]{3}$/);
  assert.equal((await request('/api/overview')).body.patients.length, 4);
});

test('creates history, rejects stale updates, and keeps canonical sparse IDs', async () => {
  await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'Nok',
      org: 'EMS',
      duty: 'Medic',
      opZone: 'triage',
    }),
  });
  const created = await request('/api/patients', {
    method: 'POST',
    ...json({
      id: 'MCI-123',
      color: 'red',
      zone: 'triage',
      triagePoint: 'primary',
      deconStatus: 'none',
      demo: 'yes',
      cc: 'pain',
      rr: '20',
      hr: '90',
      bp: '120/80',
      spo2: '98',
      gcs: '15',
      interventions: ['oxygen'],
      transport: 'ambulance',
      note: 'first',
    }),
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.body.patient.id, 'MCI-123');
  assert.equal(created.body.history.length, 1);
  const version = created.body.patient.version;
  assert.equal(
    (
      await request('/api/patients/MCI-123', {
        method: 'PATCH',
        ...json({
          version,
          color: 'yellow',
          zone: 'treatment',
          note: 'second',
        }),
      })
    ).res.status,
    200,
  );
  const conflict = await request('/api/patients/MCI-123', {
    method: 'PATCH',
    ...json({ version, color: 'green' }),
  });
  assert.equal(conflict.res.status, 409);
  assert.equal(conflict.body.error, 'stale version');
  assert.equal((await request('/api/patients/MCI-123')).body.history.length, 2);
  assert.equal(
    (
      await request('/api/patients', {
        method: 'POST',
        ...json({ id: 'MCI-123', color: 'red', zone: 'triage' }),
      })
    ).res.status,
    409,
  );
});

test('sex and age persist independently through registration and later chart updates', async () => {
  await request('/api/session', { method: 'POST', ...json({ username: 'DemoThaiSIM001' }) });
  const legacy = (await request('/api/patients/MCI-001')).body.patient;
  assert.equal(legacy.demo, 'ผู้ร่วมซ้อม A');
  assert.equal(legacy.sex, '');
  assert.equal(legacy.age, null);
  const id = 'MCI-980';
  const path = '/api/patients/' + id;
  const patch = (data) => request(path, { method: 'PATCH', ...json(data) });
  const created = await request('/api/patients', {
    method: 'POST',
    ...json({ id, color: 'green', sex: 'female', age: '0.5' }),
  });
  assert.equal(created.res.status, 201);
  assert.equal(created.body.patient.sex, 'female');
  assert.equal(created.body.patient.age, 0.5);
  const edited = await patch({ version: 1, age: 0 });
  assert.equal(edited.body.patient.sex, 'female');
  assert.equal(edited.body.patient.age, 0);
  const managed = (await request('/api/manage')).body.patients.find((p) => p.id === id);
  assert.equal(managed.age, 0);
  for (const invalid of [{ age: -1 }, { age: 'not an age' }, { age: true }, { sex: 'invalid' }]) {
    assert.equal((await patch({ version: 2, ...invalid })).res.status, 400);
  }
  const cleared = await patch({ version: 2, sex: '', age: null });
  assert.equal(cleared.body.patient.sex, '');
  assert.equal(cleared.body.patient.age, null);
  assert.deepEqual(cleared.body.history.map((h) => [h.sex, h.age]), [
    ['', null],
    ['female', 0],
    ['female', 0.5],
  ]);
});

test('stock cannot become negative and reset preserves six seeded items', async () => {
  await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'A',
      org: 'O',
      duty: 'D',
      opZone: 'triage',
    }),
  });
  const overview = await request('/api/overview');
  assert.equal(overview.body.stock.length, 6);
  const item = overview.body.stock[0];
  assert.equal(
    (
      await request(`/api/stock/${item.id}`, {
        method: 'PATCH',
        ...json({ delta: -(item.qty + 1) }),
      })
    ).res.status,
    400,
  );
  assert.equal(
    (await request('/api/stock/reset', { method: 'POST', ...json({}) })).body
      .stock.length,
    6,
  );
});

test('QR endpoint accepts an unused canonical card ID without exposing secrets', async () => {
  await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'QR',
      org: 'EMS',
      duty: 'Medic',
      opZone: 'Primary Triage',
    }),
  });
  const qr = await fetch(base + '/api/qr/MCI-999.png', { headers: { cookie } });
  assert.equal(qr.status, 200);
  assert.equal(qr.headers.get('content-type'), 'image/png');
});

test('automatic numbers remain sequential after a sparse card and simultaneous intake', async () => {
  await request('/api/register', {
    method: 'POST',
    ...json({
      name: 'Nok',
      org: 'EMS',
      duty: 'Medic',
      opZone: 'Primary Triage',
    }),
  });
  const body = json({ color: 'green', zone: 'triage' });
  const responses = await Promise.all([
    request('/api/patients', { method: 'POST', ...body }),
    request('/api/patients', { method: 'POST', ...body }),
  ]);
  assert.deepEqual(responses.map(({ body }) => body.patient.id).sort(), [
    'MCI-005',
    'MCI-006',
  ]);
  assert.equal((await request('/api/patients/MCI-000')).res.status, 400);
  assert.equal((await request('/api/patients/MCI-0001')).res.status, 400);
});

test('a cleared exercise remains empty when its SQLite database reopens', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mci-test-'));
  try {
    const dbPath = join(dir, 'exercise.sqlite');
    const first = createApp({ dbPath }).db;
    first.exec('DELETE FROM history; DELETE FROM patients;');
    first.close();
    const next = createApp({ dbPath }).db;
    try {
      assert.equal(
        next.prepare('SELECT count(*) AS count FROM patients').get().count,
        0,
      );
    } finally {
      next.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incident deletion is manager-only, targets its URL, and isolates the remaining exercise', async () => {
  const login = () => request('/api/session', { method: 'POST', ...json({ username: 'DemoThaiSIM001' }) });
  await login();
  const create = async (name) => {
    const response = await request('/api/incidents', { method: 'POST', ...json({ name }) });
    assert.equal(response.res.status, 201);
    return response.body.incident.id;
  };
  const removed = await create('เก่าที่จะลบ');
  const retained = await create('รอบถัดไป');
  for (const incident of [removed, retained]) {
    await login();
    await request('/api/presence', { method: 'POST', headers: { 'x-incident-id': incident } });
    const payload = json({
      color: 'green', requestId: 'register-' + incident,
      stockUsage: [{ stockId: 'STK-01', quantity: 2 }],
    });
    const saved = await request('/api/patients', {
      ...payload, method: 'POST', headers: { ...payload.headers, 'x-incident-id': incident },
    });
    assert.equal(saved.res.status, 201);
    assert.equal(saved.body.patient.id, 'MCI-001');
  }
  const remove = () => request('/api/manage/incidents/' + removed, {
    method: 'DELETE', headers: { 'x-incident-id': retained },
  });
  cookie = '';
  assert.equal((await remove()).res.status, 401);
  const operator = await request('/api/register', {
    method: 'POST', ...json({ name: 'ฝน', org: 'ภาคสนาม', duty: 'Medic', opZone: 'triage' }),
  });
  assert.equal(operator.res.status, 201);
  assert.equal((await remove()).res.status, 403);
  assert.equal((await request('/api/manage')).body.canDeleteIncidents, false);
  await login();
  assert.equal((await request('/api/manage')).body.canDeleteIncidents, true);
  await request('/api/manage/patients/MCI-001', {
    method: 'DELETE', body: JSON.stringify({ version: 1 }),
    headers: { 'content-type': 'application/json', 'x-incident-id': removed },
  });
  assert.ok(db.prepare("SELECT deletedAt FROM patients WHERE incidentId=? AND id='MCI-001'").get(removed).deletedAt);
  const tables = ['patients', 'history', 'stock', 'stock_movements', 'incident_mutations', 'staff_presence'];
  const counts = (scope) => tables.map((table) =>
    db.prepare('SELECT count(*) AS n FROM ' + table + ' WHERE incidentId=?').get(scope).n);
  const before = counts(removed);
  const beforeOther = counts(retained);
  assert.ok(before.every((n) => n > 0));
  db.exec("CREATE TEMP TRIGGER stop_deletion BEFORE DELETE ON incidents BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  try {
    assert.ok((await remove()).res.status >= 400);
    assert.deepEqual(counts(removed), before);
  } finally {
    db.exec('DROP TRIGGER stop_deletion');
  }
  const deleted = await remove();
  assert.equal(deleted.res.status, 200);
  assert.equal(deleted.body.incidentId, removed);
  assert.deepEqual(counts(removed), tables.map(() => 0));
  assert.deepEqual(counts(retained), beforeOther);
  assert.equal((await remove()).res.status, 404);
  const listed = (await request('/api/incidents')).body.incidents.map((incident) => incident.id);
  assert.ok(!listed.includes(removed));
  assert.ok(listed.includes(retained));
  for (const path of ['/api/overview', '/api/manage', '/api/patients/MCI-001', '/api/qr/MCI-001.png']) {
    assert.equal((await request(path, { headers: { 'x-incident-id': removed } })).res.status, 404);
  }
  const other = (await request('/api/manage', { headers: { 'x-incident-id': retained } })).body;
  assert.equal(other.patients[0].id, 'MCI-001');
  assert.ok(other.accounts.some((account) => account.username === operator.body.username));
});

test('deleting the sole, closed legacy incident stays permanent across restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mci-delete-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'exercise.sqlite');
  const instance = createApp({ dbPath });
  const http = instance.app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => http.once('listening', resolve));
    const url = 'http://127.0.0.1:' + http.address().port;
    await request(url + '/api/session', { method: 'POST', ...json({ username: 'DemoThaiSIM001' }) });
    const closed = await request(url + '/api/incidents/legacy', {
      method: 'PATCH', ...json({ closed: true }),
    });
    assert.equal(closed.res.status, 200);
    assert.equal((await request(url + '/api/manage/incidents/legacy', { method: 'DELETE' })).res.status, 200);
    assert.deepEqual((await request(url + '/api/incidents')).body.incidents, []);
  } finally {
    await new Promise((resolve) => http.close(resolve));
    instance.db.close();
  }
  const reopened = createApp({ dbPath });
  const second = reopened.app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => second.once('listening', resolve));
    const url = 'http://127.0.0.1:' + second.address().port;
    assert.deepEqual((await request(url + '/api/incidents')).body.incidents, []);
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM patients').get().n, 0);
    assert.equal((await request(url + '/api/qr/MCI-001.png?incident=legacy')).res.status, 404);
    const created = await request(url + '/api/incidents', { method: 'POST', ...json({ name: 'รอบใหม่' }) });
    assert.equal(created.res.status, 201);
    assert.equal(created.body.incident.nextPatientId, 'MCI-001');
  } finally {
    await new Promise((resolve) => second.close(resolve));
    reopened.db.close();
  }
});
