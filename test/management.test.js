import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { initAccounts, listAccounts } from '../src/accounts.js';
import { initIncidents, savePatient } from '../src/incidents.js';
import { registerManagementRoutes } from '../src/management.js';

let server;
let origin;
let db;
const manager = {
  id: 'manager',
  name: 'Manager',
  org: 'Ops',
  duty: 'Lead',
  opZone: 'HQ',
};
const operator = {
  id: 'operator',
  name: 'Operator',
  org: 'Ops',
  duty: 'Medic',
  opZone: 'HQ',
};

before(async () => {
  db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE patients (id TEXT NOT NULL, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, demo TEXT NOT NULL, cc TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL, version INTEGER NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL, incidentId TEXT NOT NULL DEFAULT 'legacy', deletedAt TEXT, PRIMARY KEY (id,incidentId));
    CREATE TABLE history (seq INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL, note TEXT NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL, incidentId TEXT NOT NULL DEFAULT 'legacy');
    CREATE TABLE stock (id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, qty INTEGER NOT NULL, unit TEXT NOT NULL, minAlert INTEGER NOT NULL, updatedAt TEXT NOT NULL, staff TEXT NOT NULL, incidentId TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY (id,incidentId));`);
  initAccounts(db);
  initIncidents(db);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.staff = req.get('x-staff') === 'operator' ? operator : manager;
    next();
  });
  const canManage = (staff) => staff?.id === manager.id;
  const requireManage = (req, res, next) =>
    canManage(req.staff)
      ? next()
      : res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการ' });
  registerManagementRoutes(app, {
    db,
    auth: (_req, _res, next) => next(),
    canManage,
    requireManage,
    staffLabel: (staff) => staff?.name || 'ผู้ใช้',
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

async function request(
  path,
  { method = 'GET', body, staff = 'manager', incident = 'legacy' } = {},
) {
  const response = await fetch(origin + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-staff': staff,
      'x-incident-id': incident,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('management GET hides roster without manage rights and returns scoped roster for managers', async () => {
  const hidden = await request('/api/manage', { staff: 'operator' });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.canManage, false);
  assert.deepEqual(hidden.body.patients, []);
  assert.deepEqual(hidden.body.accounts, []);
  assert.equal(hidden.body.incident.id, 'legacy');

  const visible = await request('/api/manage');
  assert.equal(visible.status, 200);
  assert.equal(visible.body.canManage, true);
  assert.equal(visible.body.accounts.length, 1);
  assert.deepEqual(visible.body.patients, []);
});

test('management staff CRUD uses account versions and protects current and demo accounts', async () => {
  const created = await request('/api/manage/staff', {
    method: 'POST',
    body: { name: 'Nok', org: 'EMS', duty: 'Medic', opZone: 'Triage' },
  });
  assert.equal(created.status, 201);
  const account = created.body.staff;
  const updated = await request(`/api/manage/staff/${account.id}`, {
    method: 'PATCH',
    body: { version: account.version, duty: 'Lead Medic' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.staff.version, account.version + 1);
  assert.equal(
    (
      await request(`/api/manage/staff/${account.id}`, {
        method: 'PATCH',
        body: { version: account.version, duty: 'x' },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/api/manage/staff/${account.id}`, {
        method: 'DELETE',
        body: { version: updated.body.staff.version },
      })
    ).status,
    200,
  );
  const demo = listAccounts(db).find((x) => x.username === 'DemoThaiSIM001');
  assert.equal(
    (
      await request(`/api/manage/staff/${demo.id}`, {
        method: 'DELETE',
        body: { version: demo.version },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/api/manage/staff/${manager.id}`, {
        method: 'DELETE',
        body: { version: 1 },
      })
    ).status,
    409,
  );
});

test('management patient archive is incident-scoped and requires current version', async () => {
  const created = savePatient(db, {
    scope: 'legacy',
    id: 'MCI-901',
    version: undefined,
    isEdit: false,
    actor: 'seed',
    data: { color: 'green', zone: 'triage' },
  });
  const patient = created.patient;
  assert.equal(
    (
      await request('/api/manage/patients/MCI-901', {
        method: 'DELETE',
        body: { version: patient.version - 1 },
      })
    ).status,
    409,
  );
  const archived = await request('/api/manage/patients/MCI-901', {
    method: 'DELETE',
    body: { version: patient.version },
  });
  assert.equal(archived.status, 200);
  assert.ok(archived.body.patient.deletedAt);
  assert.equal((await request('/api/manage')).body.patients.length, 0);
});
