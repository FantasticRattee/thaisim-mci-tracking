import {
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
} from './accounts.js';
import { archivePatient } from './incidents.js';

const incidentFor = (req) =>
  String(req.get('x-incident-id') || req.query.incident || 'legacy')
    .trim()
    .toLowerCase();

function sendError(res, error) {
  return res
    .status(error.status || 400)
    .json({ error: error.message || String(error) });
}

function isManager(canManage, req) {
  if (typeof canManage !== 'function') return Boolean(canManage);
  return Boolean(canManage(req.staff, req));
}

function selectedIncident(db, req) {
  return (
    db.prepare('SELECT * FROM incidents WHERE id=?').get(incidentFor(req)) ||
    null
  );
}

export function registerManagementRoutes(
  app,
  { db, auth, canManage = false, requireManage, staffLabel } = {},
) {
  if (!db) throw new Error('management db is required');
  if (typeof auth !== 'function')
    throw new Error('management auth is required');
  const manage =
    typeof requireManage === 'function'
      ? requireManage
      : (req, res, next) =>
          isManager(canManage, req)
            ? next()
            : res.status(403).json({ error: 'ไม่มีสิทธิ์จัดการ' });
  const actor = (req) =>
    (typeof staffLabel === 'function'
      ? staffLabel(req.staff)
      : req.staff?.name) || 'ผู้จัดการ';

  app.get('/api/manage', auth, (req, res) => {
    const incident = selectedIncident(db, req);
    if (!incident) return res.status(404).json({ error: 'ไม่พบเหตุการณ์' });
    const patients = db
      .prepare(
        'SELECT * FROM patients WHERE incidentId=? AND deletedAt IS NULL ORDER BY length(id),id',
      )
      .all(incident.id)
      .map((patient) => ({
        ...patient,
        interventions: JSON.parse(patient.interventions || '[]'),
      }));
    const allowed = isManager(canManage, req);
    const incidents = db
      .prepare(
        `
      SELECT i.*, count(p.id) AS patientCount FROM incidents AS i
      LEFT JOIN patients AS p ON i.id = p.incidentId AND p.deletedAt IS NULL
      GROUP BY i.id ORDER BY i.createdAt DESC, i.id
    `,
      )
      .all();
    return res.json({
      canManage: allowed,
      patients,
      accounts: allowed ? listAccounts(db) : [],
      incidents,
      incident,
    });
  });

  app.post('/api/manage/staff', auth, manage, (req, res) => {
    try {
      db.exec('BEGIN IMMEDIATE');
      const staff = createAccount(db, req.body || {});
      db.exec('COMMIT');
      return res.status(201).json({ staff });
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      return sendError(res, error);
    }
  });

  app.patch('/api/manage/staff/:id', auth, manage, (req, res) => {
    let inTransaction = false;
    try {
      const version = req.body?.version;
      if (!Number.isInteger(version))
        throw Object.assign(new Error('version is required'), { status: 400 });
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      const staff = updateAccount(db, req.params.id, req.body || {}, version);
      db.exec('COMMIT');
      inTransaction = false;
      return res.json({ staff });
    } catch (error) {
      if (inTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {}
      }
      return sendError(res, error);
    }
  });

  app.delete('/api/manage/staff/:id', auth, manage, (req, res) => {
    let inTransaction = false;
    try {
      const id = req.params.id;
      if (id === req.staff?.id)
        throw Object.assign(new Error('ไม่สามารถลบบัญชีที่กำลังใช้งาน'), {
          status: 409,
        });
      const account = db
        .prepare(
          'SELECT username, version FROM staff_accounts WHERE id=? AND deletedAt IS NULL',
        )
        .get(id);
      if (!account)
        throw Object.assign(new Error('ไม่พบบัญชีเจ้าหน้าที่'), { status: 404 });
      if (account.username === 'DemoThaiSIM001')
        throw Object.assign(new Error('ไม่สามารถลบบัญชี DemoThaiSIM001'), {
          status: 409,
        });
      const version = req.body?.version;
      if (!Number.isInteger(version))
        throw Object.assign(new Error('version is required'), { status: 400 });
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      deleteAccount(db, id, version);
      db.exec('COMMIT');
      inTransaction = false;
      return res.json({ deleted: id });
    } catch (error) {
      if (inTransaction) {
        try {
          db.exec('ROLLBACK');
        } catch {}
      }
      return sendError(res, error);
    }
  });

  app.delete('/api/manage/patients/:id', auth, manage, (req, res) => {
    try {
      const incident = selectedIncident(db, req);
      if (!incident)
        throw Object.assign(new Error('ไม่พบเหตุการณ์'), { status: 404 });
      const version = req.body?.version;
      if (!Number.isInteger(version))
        throw Object.assign(new Error('version is required'), { status: 400 });
      return res.json(
        archivePatient(db, {
          scope: incident.id,
          id: String(req.params.id).trim().toUpperCase(),
          version,
          actor: actor(req),
        }),
      );
    } catch (error) {
      return sendError(res, error);
    }
  });
}
