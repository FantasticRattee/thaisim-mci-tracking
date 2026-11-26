import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COLORS = new Set(['red', 'yellow', 'green', 'black']);
const ZONES = new Set([
  'triage',
  'decon',
  'treatment',
  'staging',
  'evacuated',
  'discharged',
  'morgue',
]);
const POINTS = new Set(['primary', 'secondary', '']);
const DECON = new Set(['none', 'pending', 'in-progress', 'cleared']);
const STOCK = [
  ['STK-01', 'Oxygen Tank + Mask', 'Airway', 20, 'ถัง', 5],
  ['STK-02', 'IV Set + 0.9% NSS', 'Circulation', 50, 'ชุด', 10],
  ['STK-03', 'Tourniquet / Gauze', 'Bleeding', 30, 'ชุด', 8],
  ['STK-04', 'Decon Wash Kit', 'Decontamination', 25, 'ชุด', 6],
  ['STK-05', 'C-Collar / Spine Board', 'Immobilization', 12, 'ชุด', 3],
  ['STK-06', 'Cold Pack / Dressing', 'General', 40, 'ชิ้น', 10],
];
const SEED = [
  [
    'MCI-001',
    'red',
    'triage',
    'primary',
    'none',
    'ผู้ร่วมซ้อม A',
    'หายใจลำบากหลังออกจากอาคาร',
    '24',
    '110',
    '90/60',
    '94',
    '13',
    ['O2 / Airway'],
    '',
  ],
  [
    'MCI-002',
    'yellow',
    'decon',
    'secondary',
    'pending',
    'ผู้ร่วมซ้อม B',
    'แผลบริเวณแขน รอชำระล้าง',
    '20',
    '98',
    '120/80',
    '98',
    '15',
    ['Stop Bleeding'],
    '',
  ],
  [
    'MCI-003',
    'green',
    'staging',
    '',
    'none',
    'ผู้ร่วมซ้อม C',
    'ถลอกเล็กน้อยที่ขา',
    '18',
    '82',
    '125/80',
    '99',
    '15',
    [],
    'รถฝึกซ้อม 01',
  ],
  [
    'MCI-004',
    'black',
    'morgue',
    '',
    'none',
    'ผู้ร่วมซ้อม D',
    'กรณีสมมติสำหรับฝึกบันทึกสีดำ',
    '',
    '',
    '',
    '',
    '3',
    [],
    'none',
  ],
];
const fields = [
  'color',
  'zone',
  'triagePoint',
  'deconStatus',
  'demo',
  'cc',
  'rr',
  'hr',
  'bp',
  'spo2',
  'gcs',
  'interventions',
  'transport',
];
const now = () => new Date().toISOString();
const makeId = (number) => `MCI-${String(number).padStart(3, '0')}`;
const idOk = (id) => {
  if (!/^MCI-\d{3,6}$/.test(id)) return false;
  const number = Number(id.slice(4));
  return number > 0 && id === makeId(number);
};
const normalizeId = (id) =>
  String(id || '')
    .trim()
    .toUpperCase();
function dbPath(opts) {
  return (
    opts?.dbPath ||
    process.env.DB_PATH ||
    (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'mci.sqlite')
      : path.join(process.cwd(), 'mci.sqlite'))
  );
}

function nextPatientId(db) {
  const rows = db
    .prepare('SELECT id FROM patients ORDER BY length(id), id')
    .iterate();
  let number = 1;
  for (const { id } of rows) {
    if (Number(id.slice(4)) > number) break;
    number += 1;
  }
  return makeId(number);
}

function initDb(db) {
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS patients (id TEXT PRIMARY KEY, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, demo TEXT NOT NULL, cc TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL, version INTEGER NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY AUTOINCREMENT, patientId TEXT NOT NULL, note TEXT NOT NULL, staff TEXT NOT NULL, updatedAt TEXT NOT NULL, color TEXT NOT NULL, zone TEXT NOT NULL, triagePoint TEXT NOT NULL, deconStatus TEXT NOT NULL, rr TEXT NOT NULL, hr TEXT NOT NULL, bp TEXT NOT NULL, spo2 TEXT NOT NULL, gcs TEXT NOT NULL, interventions TEXT NOT NULL, transport TEXT NOT NULL); CREATE TABLE IF NOT EXISTS stock (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, qty INTEGER NOT NULL, unit TEXT NOT NULL, minAlert INTEGER NOT NULL, updatedAt TEXT NOT NULL, staff TEXT NOT NULL); CREATE TABLE IF NOT EXISTS staff (key TEXT PRIMARY KEY, name TEXT NOT NULL, org TEXT NOT NULL, duty TEXT NOT NULL, opZone TEXT NOT NULL);`,
  );
  db.exec('BEGIN IMMEDIATE');
  try {
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (version === 0) {
      if (!db.prepare('SELECT 1 FROM patients LIMIT 1').get()) {
        for (const [id, ...values] of SEED) {
          const record = Object.fromEntries(
            fields.map((field, index) => [field, values[index]]),
          );
          insertPatient(db, record, id, 'ทีมจัดการฝึกซ้อม');
          addHistory(
            db,
            id,
            { ...record, note: 'เคสจำลองตั้งต้น' },
            'ทีมจัดการฝึกซ้อม',
          );
        }
      }
      if (!db.prepare('SELECT 1 FROM stock LIMIT 1').get())
        resetStock(db, 'ระบบ');
      db.exec('PRAGMA user_version=1');
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
function insertPatient(db, data, id, staff) {
  const t = now();
  db.prepare(
    'INSERT INTO patients VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    data.color || '',
    data.zone || 'triage',
    data.triagePoint || '',
    data.deconStatus || 'none',
    data.demo || '',
    data.cc || '',
    data.rr || '',
    data.hr || '',
    data.bp || '',
    data.spo2 || '',
    data.gcs || '',
    JSON.stringify(data.interventions || []),
    data.transport || '',
    1,
    staff,
    t,
  );
}
function resetStock(db, staff) {
  const t = now();
  db.exec('DELETE FROM stock');
  const q = db.prepare('INSERT INTO stock VALUES (?,?,?,?,?,?,?,?)');
  for (const [id, name, category, qty, unit, minAlert] of STOCK)
    q.run(id, name, category, qty, unit, minAlert, t, staff);
}
function readPatient(db, id) {
  return publicPatient(db.prepare('SELECT * FROM patients WHERE id=?').get(id));
}
function publicPatient(p) {
  return p ? { ...p, interventions: JSON.parse(p.interventions) } : null;
}
function readHistory(db, id) {
  return db
    .prepare(
      'SELECT note,staff,updatedAt,color,zone,triagePoint,deconStatus,rr,hr,bp,spo2,gcs,interventions,transport FROM history WHERE patientId=? ORDER BY seq DESC',
    )
    .all(id)
    .map((h) => ({ ...h, interventions: JSON.parse(h.interventions) }));
}
function addHistory(db, id, data, staff) {
  db.prepare(
    'INSERT INTO history (patientId,note,staff,updatedAt,color,zone,triagePoint,deconStatus,rr,hr,bp,spo2,gcs,interventions,transport) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id,
    data.note || '',
    staff,
    now(),
    data.color || '',
    data.zone || '',
    data.triagePoint || '',
    data.deconStatus || '',
    data.rr || '',
    data.hr || '',
    data.bp || '',
    data.spo2 || '',
    data.gcs || '',
    JSON.stringify(data.interventions || []),
    data.transport || '',
  );
}

export function createApp(opts = {}) {
  const secret = process.env.SESSION_SECRET;
  const passcode = process.env.DEMO_PASSCODE;
  if (!secret || !passcode)
    throw new Error('SESSION_SECRET and DEMO_PASSCODE are required');

  const db = opts.db || new DatabaseSync(dbPath(opts));
  initDb(db);
  const app = express();
  const configuredOrigin =
    process.env.PUBLIC_ORIGIN ||
    (process.env.RAILWAY_PUBLIC_DOMAIN &&
      `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  const publicOrigin = configuredOrigin
    ? new URL(configuredOrigin).origin
    : null;
  const cookieOptions = `HttpOnly; SameSite=Lax; Path=/${publicOrigin?.startsWith('https:') ? '; Secure' : ''}`;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const origin = req.get('origin');
    const sameOrigin = publicOrigin || `${req.protocol}://${req.get('host')}`;
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      origin &&
      origin !== sameOrigin
    ) {
      return res.status(403).json({ error: 'คำขอมาจากเว็บไซต์อื่น' });
    }
    next();
  });
  app.use(express.json({ limit: '100kb' }));
  const sign = (value) =>
    crypto.createHmac('sha256', secret).update(value).digest('base64url');
  const session = (req) => {
    const raw = req.headers.cookie?.match(/(?:^|;)\s*mci_session=([^;]+)/)?.[1];
    if (!raw) return null;
    const [v, s] = raw.split('.');
    if (!v || !s) return null;
    const expected = Buffer.from(sign(v));
    const actual = Buffer.from(s);
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    )
      return null;
    try {
      const { staff, expiresAt } = JSON.parse(
        Buffer.from(v, 'base64url').toString(),
      );
      return Date.now() < expiresAt ? staff : null;
    } catch {
      return null;
    }
  };
  const staffLabel = (staff) =>
    [staff.name, staff.duty, staff.org, staff.opZone]
      .filter(Boolean)
      .join(' · ');
  const setSession = (res, staff) => {
    const expiresAt = Date.now() + 12 * 60 * 60 * 1000;
    const v = Buffer.from(JSON.stringify({ staff, expiresAt })).toString(
      'base64url',
    );
    res.setHeader(
      'Set-Cookie',
      `mci_session=${v}.${sign(v)}; ${cookieOptions}`,
    );
  };
  const auth = (req, res, next) => {
    req.staff = session(req);
    if (!req.staff) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    next();
  };
  const error = (res, e, status = 400) => res.status(status).json({ error: e });
  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/api/session', (req, res) => res.json({ staff: session(req) }));
  const loginFailures = new Map();
  app.post('/api/session', (req, res) => {
    const { passcode, name, org, duty, opZone } = req.body || {},
      ip = req.ip || 'unknown',
      attempt = loginFailures.get(ip) || { count: 0, at: 0 };
    if (Date.now() - attempt.at > 60000) {
      attempt.count = 0;
      attempt.at = Date.now();
    }
    if (passcode !== process.env.DEMO_PASSCODE) {
      if (attempt.count >= 5) return error(res, 'ลองใหม่ภายหลัง', 429);
      loginFailures.set(ip, {
        count: attempt.count + 1,
        at: attempt.at || Date.now(),
      });
      return error(res, 'รหัสสาธิตไม่ถูกต้อง', 401);
    }
    loginFailures.delete(ip);
    if (
      ![name, org, duty, opZone].every(
        (value) =>
          typeof value === 'string' && value.trim() && value.length <= 80,
      )
    )
      return error(res, 'กรุณากรอกข้อมูลเจ้าหน้าที่ให้ครบ');
    const staff = {
      name: String(name).trim(),
      org: String(org).trim(),
      duty: String(duty).trim(),
      opZone: String(opZone).trim(),
    };
    db.prepare('INSERT OR REPLACE INTO staff VALUES (?,?,?,?,?)').run(
      `${staff.name.toLowerCase()}|${staff.org.toLowerCase()}`,
      staff.name,
      staff.org,
      staff.duty,
      staff.opZone,
    );
    setSession(res, staff);
    res.json({ staff });
  });
  app.delete('/api/session', (req, res) => {
    res.setHeader('Set-Cookie', `mci_session=; Max-Age=0; ${cookieOptions}`);
    res.json({ staff: null });
  });
  app.get('/api/overview', auth, (req, res) =>
    res.json({
      patients: db
        .prepare('SELECT * FROM patients ORDER BY length(id), id')
        .all()
        .map(publicPatient),
      stock: db.prepare('SELECT * FROM stock ORDER BY id').all(),
      staffCount: db.prepare('SELECT count(*) n FROM staff').get().n,
    }),
  );
  app.get('/api/patients/:id', auth, (req, res) => {
    const id = normalizeId(req.params.id);
    if (!idOk(id)) return error(res, 'invalid patient id');
    res.json({
      patient: readPatient(db, id),
      history: readHistory(db, id),
    });
  });
  app.post('/api/patients', auth, (req, res) => {
    const data = req.body || {};
    let id = normalizeId(data.id);
    if (id && !idOk(id)) return error(res, 'invalid patient id');
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!id) id = nextPatientId(db);
      if (!idOk(id) || readPatient(db, id)) {
        db.exec('ROLLBACK');
        return error(res, 'duplicate patient id', 409);
      }
      for (const f of fields)
        if (f === 'color' && !COLORS.has(data[f])) {
          db.exec('ROLLBACK');
          return error(res, 'invalid color');
        }
      if (
        !COLORS.has(data.color) ||
        !ZONES.has(data.zone) ||
        !POINTS.has(data.triagePoint || '') ||
        !DECON.has(data.deconStatus || 'none')
      ) {
        db.exec('ROLLBACK');
        return error(res, 'invalid patient fields');
      }
      const actor = staffLabel(req.staff);
      insertPatient(db, data, id, actor);
      addHistory(db, id, data, actor);
      db.exec('COMMIT');
      res.status(201).json({
        patient: readPatient(db, id),
        history: readHistory(db, id),
      });
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      error(res, e.message);
    }
  });
  app.patch('/api/patients/:id', auth, (req, res) => {
    const id = normalizeId(req.params.id),
      data = req.body || {};
    if (!idOk(id)) return error(res, 'invalid patient id');
    const old = readPatient(db, id);
    if (!old) return error(res, 'patient not found', 404);
    if (!Number.isInteger(data.version))
      return error(res, 'version is required');
    if (data.version !== old.version) return error(res, 'stale version', 409);
    const merged = { ...old, ...data };
    if (
      !COLORS.has(merged.color) ||
      !ZONES.has(merged.zone) ||
      !POINTS.has(merged.triagePoint || '') ||
      !DECON.has(merged.deconStatus || 'none')
    )
      return error(res, 'invalid patient fields');
    db.exec('BEGIN IMMEDIATE');
    try {
      const t = now(),
        actor = staffLabel(req.staff);
      db.prepare(
        'UPDATE patients SET color=?,zone=?,triagePoint=?,deconStatus=?,demo=?,cc=?,rr=?,hr=?,bp=?,spo2=?,gcs=?,interventions=?,transport=?,version=?,staff=?,updatedAt=? WHERE id=? AND version=?',
      ).run(
        merged.color,
        merged.zone,
        merged.triagePoint || '',
        merged.deconStatus || 'none',
        merged.demo || '',
        merged.cc || '',
        merged.rr || '',
        merged.hr || '',
        merged.bp || '',
        merged.spo2 || '',
        merged.gcs || '',
        JSON.stringify(merged.interventions || []),
        merged.transport || '',
        old.version + 1,
        actor,
        t,
        id,
        old.version,
      );
      addHistory(db, id, merged, actor);
      db.exec('COMMIT');
      res.json({
        patient: readPatient(db, id),
        history: readHistory(db, id),
      });
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      error(res, e.message);
    }
  });
  app.delete('/api/patients', auth, (req, res) => {
    db.exec('BEGIN IMMEDIATE');
    db.exec('DELETE FROM patients; DELETE FROM history');
    db.exec('COMMIT');
    res.json({ patients: [], history: [] });
  });
  app.get('/api/stock', auth, (req, res) =>
    res.json({ stock: db.prepare('SELECT * FROM stock ORDER BY id').all() }),
  );
  app.post('/api/stock', auth, (req, res) => {
    const { name, category, qty, unit, minAlert } = req.body || {};
    if (
      !name ||
      !category ||
      !unit ||
      !Number.isInteger(qty) ||
      qty < 0 ||
      !Number.isInteger(minAlert) ||
      minAlert < 0
    )
      return error(res, 'invalid stock');
    const id = `STK-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      t = now();
    db.prepare('INSERT INTO stock VALUES (?,?,?,?,?,?,?,?)').run(
      id,
      name,
      category,
      qty,
      unit,
      minAlert,
      t,
      req.staff.name,
    );
    res
      .status(201)
      .json({ stock: db.prepare('SELECT * FROM stock ORDER BY id').all() });
  });
  app.patch('/api/stock/:id', auth, (req, res) => {
    const item = db
        .prepare('SELECT * FROM stock WHERE id=?')
        .get(req.params.id),
      delta = req.body?.delta;
    if (!item || !Number.isInteger(delta)) return error(res, 'invalid stock');
    if (item.qty + delta < 0) return error(res, 'stock cannot be negative');
    db.prepare('UPDATE stock SET qty=?,updatedAt=?,staff=? WHERE id=?').run(
      item.qty + delta,
      now(),
      req.staff.name,
      item.id,
    );
    res.json({ stock: db.prepare('SELECT * FROM stock ORDER BY id').all() });
  });
  app.post('/api/stock/reset', auth, (req, res) => {
    resetStock(db, req.staff.name);
    res.json({ stock: db.prepare('SELECT * FROM stock ORDER BY id').all() });
  });
  app.get('/api/qr/:id.png', auth, async (req, res) => {
    const id = normalizeId(req.params.id);
    if (!idOk(id)) return error(res, 'invalid patient id', 404);
    const origin =
      process.env.PUBLIC_ORIGIN ||
      (process.env.RAILWAY_PUBLIC_DOMAIN &&
        `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`) ||
      `${req.protocol}://${req.get('host')}`;
    res.type('png').send(await QRCode.toBuffer(`${origin}/?id=${id}`));
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/'))
      return res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    next();
  });
  return { app, db };
}
export function startServer() {
  const { app } = createApp();
  return app.listen(Number(process.env.PORT || 3000), '0.0.0.0');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
