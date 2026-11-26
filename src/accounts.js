import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const presenceTimeout = 90_000;
const sessionDuration = 12 * 60 * 60 * 1000;
const accountFields =
  'id, username, name, org, callSign, personnelCode, duty, opZone, version, updatedAt';

export function initAccounts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS staff_accounts (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      usernameKey TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      org TEXT NOT NULL,
      callSign TEXT NOT NULL,
      personnelCode TEXT NOT NULL,
      duty TEXT NOT NULL,
      opZone TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      updatedAt TEXT NOT NULL,
      deletedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS staff_auto_codes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT
    );
    CREATE TABLE IF NOT EXISTS staff_presence (
      sessionId TEXT PRIMARY KEY,
      staffId TEXT NOT NULL REFERENCES staff_accounts(id),
      incidentId TEXT NOT NULL,
      lastSeenAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS staff_presence_incident
      ON staff_presence(incidentId, lastSeenAt, staffId);
  `);
}

function accountError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function normalizeUsername(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').trim().toLowerCase()
    : '';
}

function staffField(
  value,
  maximum,
  label,
  { optional = false, part = false } = {},
) {
  if (typeof value !== 'string') throw accountError(`กรุณาระบุ${label}`);
  const text = value.normalize('NFC').trim().replace(/ +/g, ' ');
  if (
    (!text && !optional) ||
    text.length > maximum ||
    /[\u0000-\u001F\u007F]/u.test(text) ||
    (part && text.includes('/'))
  ) {
    throw accountError(`ข้อมูล${label}ไม่ถูกต้อง`);
  }
  return text;
}

function validateProfile(source) {
  if (!source || typeof source !== 'object')
    throw accountError('กรุณากรอกข้อมูลเจ้าหน้าที่');
  return {
    name: staffField(source.name, 40, 'ชื่อเล่น', { part: true }),
    org: staffField(source.org, 60, 'สังกัด', { part: true }),
    callSign: staffField(source.callSign ?? '', 30, 'นามเรียกขาน', {
      optional: true,
      part: true,
    }),
    personnelCode: staffField(source.personnelCode ?? '000', 24, 'รหัสบุคลากร', {
      part: true,
    }),
    duty: staffField(source.duty, 50, 'หน้าที่'),
    opZone: staffField(source.opZone, 60, 'โซนปฏิบัติงาน'),
  };
}

export function readAccount(db, id) {
  return (
    db
      .prepare(
        `SELECT ${accountFields} FROM staff_accounts WHERE id = ? AND deletedAt IS NULL`,
      )
      .get(id) || null
  );
}

export function listAccounts(db) {
  return db
    .prepare(
      `SELECT ${accountFields} FROM staff_accounts WHERE deletedAt IS NULL ORDER BY usernameKey`,
    )
    .all();
}

export function createAccount(db, input) {
  const profile = validateProfile(input);
  const base = [`${profile.name}-${profile.org}`, profile.callSign]
    .filter(Boolean)
    .join('/');
  const automatic = profile.personnelCode === '000';
  let username;
  let key;
  const findUsername = db.prepare(
    'SELECT 1 FROM staff_accounts WHERE usernameKey = ?',
  );
  do {
    if (automatic) {
      const next = db
        .prepare('INSERT INTO staff_auto_codes DEFAULT VALUES')
        .run();
      profile.personnelCode = String(next.lastInsertRowid).padStart(3, '0');
    }
    username = `${base}/${profile.personnelCode}`;
    key = normalizeUsername(username);
    if (!findUsername.get(key)) break;
    if (!automatic)
      throw accountError('มี username นี้แล้ว กรุณาใช้ username เดิมเข้าสู่ระบบ', 409);
  } while (true);
  const id = randomUUID();
  db.prepare(
    `
    INSERT INTO staff_accounts (
      id, username, usernameKey, name, org, callSign, personnelCode, duty, opZone, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    id,
    username,
    key,
    profile.name,
    profile.org,
    profile.callSign,
    profile.personnelCode,
    profile.duty,
    profile.opZone,
    new Date().toISOString(),
  );
  return readAccount(db, id);
}

export function updateAccount(db, id, input, version) {
  const current = readAccount(db, id);
  if (!current) throw accountError('ไม่พบบัญชีเจ้าหน้าที่', 404);
  if (version !== current.version)
    throw accountError('ข้อมูลเจ้าหน้าที่เปลี่ยนแล้ว', 409);
  const { name, org, callSign, personnelCode, duty, opZone } = validateProfile({
    ...current,
    ...input,
  });
  const result = db
    .prepare(
      `
    UPDATE staff_accounts
    SET name = ?, org = ?, callSign = ?, personnelCode = ?, duty = ?, opZone = ?, version = version + 1, updatedAt = ?
    WHERE id = ? AND version = ? AND deletedAt IS NULL
  `,
    )
    .run(
      name,
      org,
      callSign,
      personnelCode,
      duty,
      opZone,
      new Date().toISOString(),
      id,
      version,
    );
  if (!result.changes) throw accountError('ข้อมูลเจ้าหน้าที่เปลี่ยนแล้ว', 409);
  return readAccount(db, id);
}

export function deleteAccount(db, id, version) {
  const current = readAccount(db, id);
  if (!current) throw accountError('ไม่พบบัญชีเจ้าหน้าที่', 404);
  const at = new Date().toISOString();
  const result = db
    .prepare(
      `
    UPDATE staff_accounts SET deletedAt = ?, updatedAt = ?, version = version + 1
    WHERE id = ? AND version = ? AND deletedAt IS NULL
  `,
    )
    .run(at, at, id, version);
  if (!result.changes) throw accountError('ข้อมูลเจ้าหน้าที่เปลี่ยนแล้ว', 409);
  db.prepare('DELETE FROM staff_presence WHERE staffId = ?').run(id);
}

export function registerAccountRoutes(
  app,
  { db, secret, cookieOptions, clock = Date.now },
) {
  const sign = (value) =>
    createHmac('sha256', secret).update(value).digest('base64url');
  function session(req) {
    const raw = req.headers.cookie?.match(/(?:^|;)\s*mci_session=([^;]+)/)?.[1];
    if (!raw) return null;
    const [value, signature, surplus] = raw.split('.');
    if (!value || !signature || surplus) return null;
    const expected = Buffer.from(sign(value));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return null;
    let payload;
    try {
      payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!payload?.sid || !payload.staffId || clock() >= payload.expiresAt)
      return null;
    const staff = readAccount(db, payload.staffId);
    return staff ? { ...payload, staff } : null;
  }
  function auth(req, res, next) {
    const current = session(req);
    if (!current) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
    req.staff = current.staff;
    req.staffSessionId = current.sid;
    next();
  }
  function setSession(res, staff) {
    const value = Buffer.from(
      JSON.stringify({
        sid: randomUUID(),
        staffId: staff.id,
        expiresAt: clock() + sessionDuration,
      }),
    ).toString('base64url');
    res.setHeader(
      'Set-Cookie',
      `mci_session=${value}.${sign(value)}; ${cookieOptions}`,
    );
  }
  function getOnlineCount(incidentId) {
    const closed = db
      .prepare('SELECT closedAt FROM incidents WHERE id = ?')
      .get(incidentId);
    if (!closed || closed.closedAt) return 0;
    return db
      .prepare(
        `
      SELECT COUNT(DISTINCT staffId) AS amount FROM staff_presence AS presence
      JOIN staff_accounts AS account ON account.id = presence.staffId
      WHERE presence.incidentId = ? AND lastSeenAt > ? AND account.deletedAt IS NULL
    `,
      )
      .get(incidentId, clock() - presenceTimeout).amount;
  }

  app.get('/api/session', (req, res) =>
    res.json({ staff: session(req)?.staff || null }),
  );
  app.post('/api/session', (req, res) => {
    const key = normalizeUsername(req.body?.username);
    const account =
      key &&
      key.length <= 170 &&
      db
        .prepare(
          `
      SELECT ${accountFields} FROM staff_accounts WHERE usernameKey = ? AND deletedAt IS NULL
    `,
        )
        .get(key);
    if (!account)
      return res
        .status(401)
        .json({ error: 'ไม่พบ username นี้ กรุณาตรวจสอบหรือลงทะเบียน' });
    setSession(res, account);
    res.json({ staff: account });
  });
  app.post('/api/register', (req, res) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const staff = createAccount(db, req.body);
      db.exec('COMMIT');
      setSession(res, staff);
      res.status(201).json({ staff, username: staff.username });
    } catch (error) {
      db.exec('ROLLBACK');
      if (!error.status) throw error;
      res.status(error.status).json({ error: error.message });
    }
  });
  app.delete('/api/session', (req, res) => {
    const current = session(req);
    if (current)
      db.prepare('DELETE FROM staff_presence WHERE sessionId = ?').run(
        current.sid,
      );
    res.setHeader('Set-Cookie', `mci_session=; Max-Age=0; ${cookieOptions}`);
    res.json({ staff: null });
  });
  app.post('/api/presence', auth, (req, res) => {
    const incidentId = req.get('X-Incident-ID') || 'legacy';
    const incident = db
      .prepare('SELECT closedAt FROM incidents WHERE id = ?')
      .get(incidentId);
    if (!incident) return res.status(404).json({ error: 'ไม่พบเหตุการณ์' });
    db.prepare('DELETE FROM staff_presence WHERE lastSeenAt <= ?').run(
      clock() - presenceTimeout,
    );
    if (incident.closedAt) {
      db.prepare('DELETE FROM staff_presence WHERE sessionId = ?').run(
        req.staffSessionId,
      );
      return res.json({ onlineStaffCount: 0 });
    }
    db.prepare(
      `
      INSERT INTO staff_presence (sessionId, staffId, incidentId, lastSeenAt) VALUES (?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET incidentId = excluded.incidentId, lastSeenAt = excluded.lastSeenAt
    `,
    ).run(req.staffSessionId, req.staff.id, incidentId, clock());
    res.json({ onlineStaffCount: getOnlineCount(incidentId) });
  });
  return { auth, getOnlineCount };
}
