import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import QRCode from 'qrcode';
import { DatabaseSync } from 'node:sqlite';
import { patientLink } from '../public/patient-link.js';
import {
  initIncidents,
  registerIncidentRoutes,
  savePatient,
  triageReview,
} from '../src/incidents.js';

let db, app, server, base;
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE patients (id TEXT PRIMARY KEY, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, demo TEXT NOT NULL, cc TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL, version INTEGER NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL);
    CREATE TABLE history (seq INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL, note TEXT NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL);
    CREATE TABLE stock (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, qty INTEGER NOT NULL, unit TEXT NOT NULL, minAlert INTEGER NOT NULL, updatedAt TEXT NOT NULL, staff TEXT NOT NULL);
    INSERT INTO patients VALUES ('MCI-001','red','triage','primary','none','','','','','','','15','[]','',1,'Nok','2026-01-01');
    INSERT INTO history (patientId,note,staff,updatedAt,color,zone,triagePoint,deconStatus,rr,hr,bp,spo2,gcs,interventions,transport) VALUES ('MCI-001','old','Nok','2026-01-01','red','triage','primary','none','','','','','15','[]','');
    INSERT INTO stock VALUES ('STK-01','O2','Airway',2,'ชุด',0,'2026-01-01','system');
    PRAGMA user_version=1;`);
  initIncidents(db);
  app = express();
  app.use(express.json());
  const auth = (req, _res, next) => {
    req.staff = { name: 'Nok', org: 'EMS', duty: 'Medic', opZone: 'triage' };
    next();
  };
  registerIncidentRoutes(app, { db, auth, staffLabel: (s) => s.name });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
});

test('migrates v1 rows into legacy without changing identifiers, history sequence or stock quantity', async () => {
  assert.equal(
    db.prepare('SELECT id,incidentId FROM patients').get().id,
    'MCI-001',
  );
  assert.equal(db.prepare('SELECT seq FROM history').get().seq, 1);
  assert.equal(db.prepare('SELECT qty,incidentId FROM stock').get().qty, 2);
  assert.equal(
    db.prepare('SELECT user_version FROM pragma_user_version').get()
      .user_version,
    3,
  );
});

test('automatic intake grows past six digits, survives restart, and skips occupied QR codes', async () => {
  const save = (body) => fetch(base + '/api/patients', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ color: 'green', ...body }),
  });
  const overview = async () => (await fetch(base + '/api/overview')).json();
  assert.equal((await overview()).nextPatientId, 'MCI-002');
  // Place the sequence at a digit boundary without creating a million records.
  db.prepare('UPDATE incidents SET nextPatientId=? WHERE id=?').run('MCI-999999', 'legacy');
  const ahead = await save({ id: 'MCI-1000001' });
  assert.equal(ahead.status, 201);
  assert.equal((await ahead.json()).nextPatientId, 'MCI-999999');
  const failed = await save({ stockUsage: [{ stockId: 'STK-01', quantity: 20 }] });
  assert.equal(failed.status, 409);
  assert.equal((await overview()).nextPatientId, 'MCI-999999');
  const boundary = await save({});
  assert.equal((await boundary.json()).nextPatientId, 'MCI-1000000');
  initIncidents(db);
  assert.equal((await overview()).nextPatientId, 'MCI-1000000');
  assert.equal((await fetch(base + '/api/qr/MCI-1000000.png')).status, 200);
  assert.equal((await (await save({ id: 'MCI-1000000' })).json()).nextPatientId, 'MCI-1000002');
  db.prepare('UPDATE incidents SET nextPatientId=? WHERE id=?').run('MCI-9007199254740992', 'legacy');
  const large = await (await save({})).json();
  assert.equal(large.patient.id, 'MCI-9007199254740992');
  assert.equal(large.nextPatientId, 'MCI-9007199254740993');
});

test('a fresh incident registers 10,000 consecutive patients on demand', async () => {
  const response = await fetch(base + '/api/incidents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '10k intake exercise' }),
  });
  const { incident } = await response.json();
  const headers = { 'x-incident-id': incident.id };
  const intake = async () => (await fetch(base + '/api/overview?view=intake', { headers })).json();
  assert.equal((await intake()).nextPatientId, 'MCI-001');
  const assigned = new Set();
  for (let n = 1; n <= 10_000; n++) {
    const { patient } = savePatient(db, {
      scope: incident.id, data: { color: 'green' }, actor: 'simulation', isEdit: false,
    });
    assert.equal(patient.id, 'MCI-' + String(n).padStart(3, '0'));
    assigned.add(patient.id);
  }
  assert.equal(assigned.size, 10_000);
  const board = await intake();
  assert.equal(board.nextPatientId, 'MCI-10001');
  assert.equal(Object.hasOwn(board, 'patients'), false);
  assert.equal(
    db.prepare('SELECT count(*) AS n FROM patients WHERE incidentId=?').get(incident.id).n,
    10_000,
  );
});

test('V2 printed and clickable QR links stay scoped when patients register out of order', async () => {
  const newIncident = async (name) => {
    const res = await fetch(base + '/api/incidents', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    });
    return (await res.json()).incident.id;
  };
  const first = await newIncident('first');
  const second = await newIncident('second');
  const read = async (scope, code) =>
    (await fetch(base + '/api/patients/' + code, { headers: { 'x-incident-id': scope } })).json();
  const save = async (scope, code, cc) => {
    const res = await fetch(base + '/api/patients', {
      method: 'POST', headers: { 'x-incident-id': scope, 'content-type': 'application/json' },
      body: JSON.stringify({ id: code, color: 'green', cc }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).nextPatientId;
  };
  for (const [scope, code, view] of [
    [first, 'MCI-001', 'cards-v2'], [first, 'MCI-002', 'cards-v2'],
    [second, 'MCI-001', 'cards-v2'], [second, 'MCI-002', 'cards-v2'], [first, 'MCI-001', ''],
  ]) {
    const expected = '/?incident=' + scope + '&id=' + code + (view ? '#cards-v2' : '');
    assert.equal(patientLink(code, scope, view), expected);
    const qr = await fetch(base + '/api/qr/' + code + '.png?incident=' + scope + (view ? '&view=' + view : ''));
    assert.equal(qr.status, 200);
    assert.deepEqual(Buffer.from(await qr.arrayBuffer()), await QRCode.toBuffer(base + expected));
    assert.equal((await read(scope, code)).patient, null);
  }
  assert.equal(await save(first, 'MCI-002', 'first two'), 'MCI-001');
  assert.equal(await save(second, 'MCI-001', 'second one'), 'MCI-002');
  assert.equal(await save(first, 'MCI-001', 'first one'), 'MCI-003');
  const chart = await read(first, 'MCI-001');
  assert.equal(chart.patient.cc, 'first one');
  assert.equal(chart.history.length, 1);
  assert.equal((await read(first, 'MCI-002')).patient.cc, 'first two');
  assert.equal((await read(second, 'MCI-001')).patient.cc, 'second one');
  assert.equal((await read(second, 'MCI-002')).patient, null);
  const archive = await fetch(base + '/api/patients/MCI-001', {
    method: 'DELETE', headers: { 'x-incident-id': first, 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(archive.status, 200);
  const cards = async (scope, query) =>
    (await fetch(base + '/api/overview?view=cards-v2&' + query, { headers: { 'x-incident-id': scope } })).json();
  const mixed = await cards(first, 'start=1&count=12');
  assert.deepEqual(Object.keys(mixed).sort(), ['cardStatuses', 'incident', 'nextPatientId']);
  assert.deepEqual(mixed.cardStatuses, { 'MCI-001': 'archived', 'MCI-002': 'registered' });
  assert.equal(mixed.nextPatientId, 'MCI-003');
  assert.deepEqual((await cards(first, 'start=2&count=1')).cardStatuses, { 'MCI-002': 'registered' });
  assert.deepEqual((await cards(second, 'start=1&count=12')).cardStatuses, { 'MCI-001': 'registered' });
  const png = base + '/api/qr/MCI-001.png?incident=' + first;
  assert.equal((await fetch(png)).status, 410);
  const archivedV2 = await fetch(png + '&view=cards-v2');
  assert.equal(archivedV2.status, 200);
  assert.deepEqual(Buffer.from(await archivedV2.arrayBuffer()), await QRCode.toBuffer(base + patientLink('MCI-001', first, 'cards-v2')));
  const archived = await read(first, 'MCI-001');
  assert.equal(archived.patient.cc, 'first one');
  assert.ok(archived.patient.deletedAt);
});

test('V2 batch statuses validate ranges and keep large decimal IDs exact', async () => {
  const cards = (query) => fetch(base + '/api/overview?view=cards-v2&' + query);
  for (const query of ['start=0', 'start=1e2', 'start=1.5', 'start=-2', 'count=0', 'count=501', 'count=2.5']) {
    assert.equal((await cards(query)).status, 400, query);
  }
  const large = 'MCI-9007199254740993';
  savePatient(db, { scope: 'legacy', id: large, data: { color: 'green' }, actor: 'test', isEdit: false });
  assert.deepEqual((await (await cards('start=9007199254740992&count=2')).json()).cardStatuses, {
    [large]: 'registered',
  });
  assert.equal((await cards('start=10&count=500')).status, 200);
});

test('creates an incident and rejects mutations after it is closed', async () => {
  let response = await fetch(`${base}/api/incidents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Drill 2' }),
  });
  assert.equal(response.status, 201);
  const incident = (await response.json()).incident;
  assert.equal(
    db
      .prepare('SELECT count(*) n FROM stock WHERE incidentId=?')
      .get(incident.id).n,
    6,
  );
  response = await fetch(`${base}/api/incidents/${incident.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'closed' }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-incident-id': incident.id,
    },
    body: JSON.stringify({ color: 'green', zone: 'triage', triagePoint: '' }),
  });
  assert.equal(response.status, 409);
});

test('isolates the same patient and stock IDs across incidents and reports history triage changes', async () => {
  let response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'MCI-002',
      color: 'green',
      zone: 'triage',
      triagePoint: 'primary',
    }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  response = await fetch(`${base}/api/patients/MCI-002`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      version: created.patient.version,
      color: 'yellow',
      triagePoint: 'secondary',
    }),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/incidents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Second' }),
  });
  const second = (await response.json()).incident;
  response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-incident-id': second.id },
    body: JSON.stringify({
      id: 'MCI-002',
      color: 'red',
      zone: 'triage',
      triagePoint: 'primary',
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(
    db.prepare("SELECT count(*) n FROM patients WHERE id='MCI-002'").get().n,
    2,
  );
  response = await fetch(`${base}/api/overview`);
  const overview = await response.json();
  assert.equal(response.status, 200, JSON.stringify(overview));
  const review = overview.triageReview;
  assert.equal(review.matchedCases, 1);
  assert.equal(review.higherDirection, 1);
  assert.deepEqual(review.changes, [
    { id: 'MCI-002', primary: 'green', secondary: 'yellow' },
  ]);
  assert.equal(
    db.prepare('SELECT count(*) n FROM stock WHERE incidentId=?').get(second.id)
      .n,
    6,
  );
});

test('deducts stock exactly once with patient save and rolls back when insufficient', async () => {
  const body = {
    id: 'MCI-002',
    color: 'red',
    zone: 'triage',
    triagePoint: '',
    stockUsage: [{ stockId: 'STK-01', quantity: 1 }],
  };
  let response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'r1' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  assert.equal(
    db.prepare("SELECT qty FROM stock WHERE id='STK-01'").get().qty,
    1,
  );
  response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'r1' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.equal(
    db.prepare("SELECT count(*) n FROM patients WHERE id='MCI-002'").get().n,
    1,
  );
  response = await fetch(`${base}/api/patients`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'MCI-003',
      color: 'red',
      zone: 'triage',
      triagePoint: '',
      stockUsage: [{ stockId: 'STK-01', quantity: 2 }],
    }),
  });
  assert.equal(response.status, 409);
  assert.equal(
    db.prepare("SELECT qty FROM stock WHERE id='STK-01'").get().qty,
    1,
  );
});

test('soft archives patient and legacy QR URL remains accepted', async () => {
  let response = await fetch(`${base}/api/patients/MCI-001`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(response.status, 200);
  assert.ok(
    db.prepare("SELECT deletedAt FROM patients WHERE id='MCI-001'").get()
      .deletedAt,
  );
  response = await fetch(`${base}/api/patients/MCI-001`);
  assert.equal(response.status, 200);
  const archived = await response.json();
  assert.ok(archived.patient.deletedAt);
  assert.equal(archived.history[0].note, 'old');
  const overview = await (await fetch(`${base}/api/overview`)).json();
  assert.equal(overview.patients.length, 0);
  assert.equal(overview.nextPatientId, 'MCI-002');
  for (const [method, path, body] of [
    ['PATCH', '/api/patients/MCI-001', { version: archived.patient.version, color: 'green' }],
    ['POST', '/api/patients', { id: 'MCI-001', color: 'green' }],
  ]) {
    const attempt = await fetch(base + path, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(attempt.status, 409);
  }
});

test('a paired black assessment counts toward coverage and not toward severity direction', () => {
  db.prepare(
    'UPDATE history SET color=? WHERE patientId=? AND triagePoint=?',
  ).run('black', 'MCI-001', 'primary');
  db.prepare(
    `
    INSERT INTO history (
      patientId, note, staff, updatedAt, color, zone, triagePoint, deconStatus,
      rr, hr, bp, spo2, gcs, interventions, transport, incidentId
    ) VALUES ('MCI-001','','ผู้ฝึกสอน','2026-11-26','red','triage','secondary','none','','','','','','[]','','legacy')
  `,
  ).run();
  const review = triageReview(db, 'legacy');
  assert.equal(review.primaryCases, 1);
  assert.equal(review.matchedCases, 1);
  assert.equal(review.coveragePercent, 100);
  assert.equal(review.withoutSecondary, 0);
  assert.equal(review.blackCases, 1);
  assert.equal(review.higherDirection, 0);
  assert.equal(review.lowerDirection, 0);
});

test('intake QR advances only after a committed registration and keeps the first chart bound to its card', async () => {
  const created = await fetch(base + '/api/incidents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'ฝึกรับผู้ป่วย' }),
  });
  const { incident } = await created.json();
  const headers = {
    'x-incident-id': incident.id,
    'content-type': 'application/json',
  };
  const read = async (path) =>
    (await fetch(base + '/api/' + path, { headers })).json();
  const save = (body) =>
    fetch(base + '/api/patients', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  assert.equal((await read('overview')).nextPatientId, 'MCI-001');
  assert.equal((await read('patients/MCI-001')).patient, null);
  assert.equal((await save({ id: 'MCI-001', color: 'invalid' })).status, 400);
  assert.equal((await read('overview')).nextPatientId, 'MCI-001');
  const first = {
    id: 'MCI-001',
    color: 'green',
    cc: 'เคสฝึกซ้อม',
    requestId: 'first-qr',
  };
  const registered = await save(first);
  assert.equal(registered.status, 201);
  assert.equal((await registered.json()).nextPatientId, 'MCI-002');
  assert.equal((await (await save(first)).json()).nextPatientId, 'MCI-002');
  assert.equal(
    (await save({ ...first, requestId: 'other-scanner' })).status,
    409,
  );
  for (let n = 2; n <= 10; n++) {
    const id = 'MCI-' + String(n).padStart(3, '0');
    assert.equal((await read('overview')).nextPatientId, id);
    assert.equal((await save({ id, color: 'yellow' })).status, 201);
  }
  const chart = await read('patients/MCI-001');
  assert.equal(chart.patient.cc, first.cc);
  assert.equal(chart.history.length, 1);
  assert.equal((await read('overview')).nextPatientId, 'MCI-011');
  await fetch(base + '/api/patients/MCI-001', {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal((await read('overview')).nextPatientId, 'MCI-011');
  await fetch(base + '/api/incidents/' + incident.id, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ closed: true }),
  });
  assert.equal((await read('overview')).nextPatientId, null);
  assert.equal(
    (await (await fetch(base + '/api/overview')).json()).nextPatientId,
    'MCI-002',
  );
});
