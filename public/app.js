import { renderExtras } from './extras.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const labels = {
  overview: 'ภาพรวมสถานการณ์',
  patients: 'รายชื่อผู้ป่วย',
  zones: 'พื้นที่ปฏิบัติงาน & Decon',
  stock: 'คลังเวชภัณฑ์',
  erg: 'คู่มือ ERG4Thai',
  cards: 'พริ้นต์การ์ด QR',
};
const mobileLabels = {
  overview: 'ภาพรวม',
  patients: 'ผู้ป่วย',
  zones: 'พื้นที่',
  stock: 'เวชภัณฑ์',
  erg: 'สารเคมี',
  cards: 'การ์ด QR',
};
const zoneLabels = {
  triage: 'จุดคัดแยก',
  decon: 'จุดชำระล้าง',
  treatment: 'จุดรักษา',
  staging: 'จุดรอส่งต่อ',
  evacuated: 'ส่งต่อแล้ว',
  discharged: 'จำหน่ายแล้ว',
  morgue: 'จุดพักศพ',
};
const colorLabels = { red: 'แดง', yellow: 'เหลือง', green: 'เขียว', black: 'ดำ' };
const points = { primary: 'Primary', secondary: 'Secondary' };
const deconLabels = {
  pending: 'รอชำระล้าง',
  'in-progress': 'กำลังชำระล้าง',
  cleared: 'ชำระล้างแล้ว',
};
const interventions = [
  'O2 / Airway',
  'ETT',
  'Needle Decomp / ICD',
  'Stop Bleeding',
  'IV Fluid',
  'Decontamination',
  'Splint / C-Collar',
  'CPR',
];
const state = {
  session: null,
  overview: { patients: [], stock: [], staffCount: 0 },
  activePage: 'overview',
  selectedPatient: null,
  history: [],
  filterQuery: '',
  filterColor: '',
  filterZone: '',
  filterTriage: '',
  chartRequest: 0,
};

export async function api(path, options = {}) {
  const init = {
    credentials: 'same-origin',
    ...options,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
  };
  if (options.body && typeof options.body !== 'string') {
    init.body = JSON.stringify(options.body);
    init.headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, init);
  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    /* empty response */
  }
  if (!response.ok) {
    const error = new Error(
      payload?.error || `Request failed (${response.status})`,
    );
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function refresh() {
  try {
    state.overview = await api('/api/overview');
  } catch (error) {
    notify(error.message, 'error');
    return;
  }
  renderCorePage();
  if (state.activePage === 'stock')
    renderExtras('stock', {
      root: $(`#page-${state.activePage}`),
      state: state.overview,
      api,
      refresh,
      notify,
    });
}

function text(value, fallback = '—') {
  return value === undefined || value === null || value === ''
    ? fallback
    : String(value);
}
function fmtDate(value) {
  if (!value) return 'ยังไม่มีข้อมูล';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? text(value)
    : date.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}
function el(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function button(label, className, handler) {
  const b = el('button', `btn ${className}`, label);
  b.type = 'button';
  b.addEventListener('click', handler);
  return b;
}
function badge(color) {
  return el(
    'span',
    `badge badge-${color || 'black'}`,
    colorLabels[color] || text(color),
  );
}
function patientIdFromUrl() {
  return new URLSearchParams(location.search).get('id') || '';
}
function notify(message, type = 'success') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.hidden = false;
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    toast.hidden = true;
  }, 3600);
}
function showError(target, message) {
  target.textContent = message;
  target.hidden = !message;
}

function renderNav() {
  const make = (mobile = false) =>
    Object.entries(labels).map(([page, label]) => {
      const b = el(
        'button',
        `nav-item ${state.activePage === page ? 'active' : ''}`,
        mobile ? mobileLabels[page] : label,
      );
      b.type = 'button';
      if (state.activePage === page) b.setAttribute('aria-current', 'page');
      b.addEventListener('click', () => navigate(page));
      if (mobile) b.setAttribute('aria-label', label);
      return b;
    });
  $('#sideNav').replaceChildren(...make());
  $('#mobileNav').replaceChildren(...make(true));
}
function navigate(page) {
  state.activePage = page;
  window.scrollTo(0, 0);
  renderNav();
  $$('.page-section').forEach((s) => {
    s.hidden = s.dataset.page !== page;
  });
  renderCorePage();
  if (['stock', 'erg', 'cards'].includes(page))
    renderExtras(page, {
      root: $(`#page-${page}`),
      state: state.overview,
      api,
      refresh,
      notify,
    });
}

function renderCorePage() {
  if (!state.session) return;
  const fn = {
    overview: renderOverview,
    patients: renderPatients,
    zones: renderZones,
  }[state.activePage];
  if (fn) fn($(`#page-${state.activePage}`));
}
function pageHead(title, subtitle, action) {
  const head = el('div', 'page-head');
  const copy = el('div');
  copy.append(el('h1', null, title), el('p', 'muted', subtitle));
  head.append(copy);
  if (action) head.append(action);
  return head;
}
function renderOverview(root) {
  const patients = state.overview.patients || [];
  const counts = Object.fromEntries(
    Object.keys(colorLabels).map((k) => [
      k,
      patients.filter((p) => p.color === k).length,
    ]),
  );
  const active = patients.filter(
    (p) => !['evacuated', 'discharged', 'morgue'].includes(p.zone),
  ).length;
  const kpis = [
    ['ผู้ป่วยทั้งหมด', patients.length],
    ['อยู่ระหว่างดูแล', active],
    ['จุดชำระล้าง', patients.filter((p) => p.zone === 'decon').length],
    ['ส่งต่อแล้ว', patients.filter((p) => p.zone === 'evacuated').length],
    ['จำหน่ายแล้ว', patients.filter((p) => p.zone === 'discharged').length],
    ['จุดพักศพ', patients.filter((p) => p.zone === 'morgue').length],
  ];
  const grid = el('div', 'kpi-grid');
  kpis.forEach(([label, value]) => {
    const card = el('article', 'kpi');
    card.append(
      el('span', 'kpi-label', label),
      el('strong', 'kpi-value', String(value)),
    );
    grid.append(card);
  });
  const colorPanel = el('section', 'panel');
  colorPanel.append(el('h2', 'panel-head', 'แยกตามสีคัดแยก'));
  const bars = el('div', 'bar-list');
  Object.entries(colorLabels).forEach(([key, label]) => {
    const row = el('div', 'bar-row');
    const meta = el('div', 'bar-meta');
    meta.append(
      el('span', null, label),
      el('strong', null, String(counts[key])),
    );
    const track = el('div', 'bar-track');
    const fill = el('div', `bar-fill fill-${key}`);
    fill.style.width = `${patients.length ? (counts[key] / patients.length) * 100 : 0}%`;
    track.append(fill);
    row.append(meta, track);
    bars.append(row);
  });
  colorPanel.append(bars);
  const zonePanel = el('section', 'panel');
  zonePanel.append(el('h2', 'panel-head', 'แยกตามพื้นที่'));
  const zoneList = el('div', 'summary-list');
  Object.entries(zoneLabels).forEach(([zone, label]) => {
    const count = patients.filter((p) => p.zone === zone).length;
    const row = el('button', 'summary-row');
    row.append(
      el('span', null, label),
      el('strong', 'summary-count', String(count)),
    );
    row.setAttribute('aria-label', `${label} ${count} เคส`);
    row.type = 'button';
    row.addEventListener('click', () => {
      state.filterQuery = '';
      state.filterColor = '';
      state.filterTriage = '';
      state.filterZone = zone;
      navigate('patients');
    });
    zoneList.append(row);
  });
  zonePanel.append(zoneList);
  const lowStock = state.overview.stock.filter(
    (item) => item.qty <= item.minAlert,
  ).length;
  const stats = el('div', 'operation-stats');
  stats.append(
    el('span', 'badge', `เจ้าหน้าที่ลงชื่อ ${state.overview.staffCount} คน`),
    button(`เวชภัณฑ์ใกล้หมด ${lowStock} รายการ`, 'btn-secondary btn-sm', () =>
      navigate('stock'),
    ),
  );
  zonePanel.append(stats);
  const recent = el('section', 'panel');
  const rh = el('div', 'panel-head');
  rh.append(el('h2', null, 'รายการอัปเดตล่าสุด'));
  rh.append(
    button('ดูผู้ป่วยทั้งหมด', 'btn-secondary btn-sm', () => navigate('patients')),
  );
  recent.append(
    rh,
    patientTable(
      patients
        .slice()
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .slice(0, 8),
    ),
  );
  const overviewGrid = el('div', 'overview-grid');
  overviewGrid.append(colorPanel, zonePanel);
  const heading = pageHead(
    'ภาพรวมสถานการณ์',
    `${state.session.name} · ${state.session.org} · ${state.session.opZone}`,
    button('+ บันทึกเคสใหม่', 'btn-primary', () => openPatient()),
  );
  heading.classList.add('overview-heading');
  root.replaceChildren(heading, grid, overviewGrid, recent);
}
function patientTable(patients) {
  const wrap = el('div', 'table-wrap patient-table');
  const table = el('table');
  const head = el('thead');
  const tr = el('tr');
  [
    'รหัส',
    'สี',
    'พื้นที่ / จุดคัดแยก',
    'Decon',
    'อาการหลัก',
    'Vital signs',
    'อัปเดต',
    '',
  ].forEach((h) => tr.append(el('th', null, h)));
  head.append(tr);
  const body = el('tbody');
  if (!patients.length) {
    const row = el('tr');
    const cell = el('td', 'empty', 'ยังไม่มีผู้ป่วย');
    cell.colSpan = 8;
    row.append(cell);
    body.append(row);
  }
  patients.forEach((p) => {
    const row = el('tr');
    row.append(
      el('td', 'patient-code', text(p.id)),
      tdBadge(p.color),
      el(
        'td',
        null,
        `${zoneLabels[p.zone] || text(p.zone)}${points[p.triagePoint] ? ` · ${points[p.triagePoint]}` : ''}`,
      ),
      el('td', null, deconLabels[p.deconStatus] || '—'),
      el('td', null, text(p.cc)),
      el('td', null, vitalText(p)),
      el('td', null, fmtDate(p.updatedAt)),
    );
    const actions = el('td');
    actions.append(
      button('เปิด', 'btn-secondary btn-sm', () => openPatient(p.id)),
    );
    row.append(actions);
    body.append(row);
  });
  table.append(head, body);
  wrap.append(table);
  return wrap;
}
function tdBadge(color) {
  const td = el('td');
  td.append(badge(color));
  return td;
}
function vitalText(p) {
  return (
    [
      p.rr && `RR ${p.rr}`,
      p.hr && `HR ${p.hr}`,
      p.bp && `BP ${p.bp}`,
      p.spo2 && `SpO₂ ${p.spo2}`,
      p.gcs && `GCS ${p.gcs}`,
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  );
}

function renderPatients(root) {
  const q = state.filterQuery || '';
  const color = state.filterColor || '';
  const zone = state.filterZone || '';
  const triage = state.filterTriage || '';
  const search = el('input');
  search.id = 'patientSearch';
  search.type = 'search';
  search.placeholder = 'ค้นหารหัส อาการ หรือโรงพยาบาลปลายทาง';
  search.setAttribute('aria-label', 'ค้นหาผู้ป่วย');
  search.value = q;
  search.addEventListener('input', () => {
    state.filterQuery = search.value;
    updateResults();
  });
  const colorSelect = el('select');
  colorSelect.setAttribute('aria-label', 'กรองตามสีคัดแยก');
  [['', 'ทุกสี Triage'], ...Object.entries(colorLabels)].forEach(
    ([value, label]) => colorSelect.append(new Option(label, value)),
  );
  colorSelect.value = color;
  colorSelect.addEventListener('change', () => {
    state.filterColor = colorSelect.value;
    updateResults();
  });
  const zoneSelect = el('select');
  zoneSelect.setAttribute('aria-label', 'กรองตามพื้นที่');
  [['', 'ทุก Zone'], ...Object.entries(zoneLabels)].forEach(([value, label]) =>
    zoneSelect.append(new Option(label, value)),
  );
  zoneSelect.value = zone;
  zoneSelect.addEventListener('change', () => {
    state.filterZone = zoneSelect.value;
    updateResults();
  });
  const triageSelect = el('select');
  triageSelect.setAttribute('aria-label', 'กรองตามจุดคัดแยก');
  [
    ['', 'ทุกจุดคัดแยก'],
    ['primary', 'Primary Triage'],
    ['secondary', 'Secondary Triage'],
  ].forEach(([value, label]) => triageSelect.append(new Option(label, value)));
  triageSelect.value = triage;
  triageSelect.addEventListener('change', () => {
    state.filterTriage = triageSelect.value;
    updateResults();
  });
  const resultCount = el('span', 'result-count');
  const results = el('div');
  function updateResults() {
    const term = state.filterQuery.trim().toLowerCase();
    const list = state.overview.patients.filter(
      (p) =>
        (!term ||
          [p.id, p.cc, p.demo, p.transport, zoneLabels[p.zone]]
            .join(' ')
            .toLowerCase()
            .includes(term)) &&
        (!state.filterColor || p.color === state.filterColor) &&
        (!state.filterZone || p.zone === state.filterZone) &&
        (!state.filterTriage || p.triagePoint === state.filterTriage),
    );
    resultCount.textContent = `${list.length} รายการ`;
    results.replaceChildren(patientTable(list));
  }
  const filter = el('div', 'filters');
  filter.append(search, colorSelect, zoneSelect, triageSelect, resultCount);
  const actions = el('div', 'page-actions');
  actions.append(
    button('+ เพิ่มผู้ป่วยใหม่', 'btn-primary', () => openPatient()),
    button('ล้างผู้ป่วยและประวัติ', 'btn-danger mobile-only', clearPatients),
  );
  root.replaceChildren(
    pageHead('รายชื่อผู้ป่วย', 'เปิดแฟ้มเพื่อดูประวัติย้อนหลังและบันทึกการเปลี่ยนแปลง', actions),
    el('section', 'panel'),
  );
  root.lastElementChild.append(filter, results);
  updateResults();
}

function renderZones(root) {
  const patients = state.overview.patients || [];
  const grid = el('div', 'zone-grid');
  const stations = [
    ['triage', 'คัดแยกเบื้องต้น (Primary)', 'primary'],
    ['triage', 'คัดแยกซ้ำ (Secondary)', 'secondary'],
    ['triage', 'คัดแยก (ทุกจุด)', ''],
    ...Object.entries(zoneLabels).filter(([zone]) => zone !== 'triage'),
  ];
  stations.forEach(([zone, label, point = '']) => {
    const list = patients.filter(
      (p) => p.zone === zone && (!point || p.triagePoint === point),
    );
    const card = el('button', 'zone-card');
    card.type = 'button';
    card.append(
      el('strong', 'zone-title', label),
      el('span', 'zone-total', `${list.length} เคส`),
    );
    card.append(
      el(
        'small',
        null,
        list.length ? list.map((p) => p.id).join(' · ') : 'ยังไม่มีผู้ป่วย',
      ),
    );
    if (zone === 'decon' && list.length) {
      const status = el('div', 'zone-status');
      for (const [value, caption] of Object.entries(deconLabels)) {
        const count = list.filter((p) => p.deconStatus === value).length;
        if (count) status.append(el('span', 'badge', `${caption} ${count}`));
      }
      card.append(status);
    }
    card.addEventListener('click', () => {
      state.filterQuery = '';
      state.filterColor = '';
      state.filterTriage = point;
      state.filterZone = zone;
      navigate('patients');
    });
    grid.append(card);
  });
  root.replaceChildren(
    pageHead(
      'พื้นที่ปฏิบัติงาน & Decon',
      'คลิกพื้นที่เพื่อดูรายชื่อผู้ป่วยในโซนนั้น',
      button('+ บันทึก / ย้ายโซน', 'btn-primary', () => openPatient()),
    ),
    grid,
  );
}

function clearForm() {
  $('#patientForm').reset();
  $('#patientColor').value = '';
  $$('.triage-option').forEach((b) => b.classList.remove('selected'));
  $$('#interventionPicker input').forEach((i) => {
    i.checked = false;
  });
  showError($('#patientError'), '');
}
function openPatient(id = '') {
  clearForm();
  const chartRequest = ++state.chartRequest;
  state.selectedPatient = null;
  state.history = [];
  $('#dialogTitle').textContent = id ? `แฟ้ม ${id}` : 'บันทึกผู้ป่วย';
  $('#historyPanel').hidden = true;
  $('#patientIdHelp').hidden = Boolean(id);
  $('#patientId').readOnly = Boolean(id);
  $('#patientId').value = id;
  $('#savePatientBtn').disabled = Boolean(id);
  $('#dialogMeta').textContent = id
    ? 'กำลังโหลดข้อมูล…'
    : 'กรอกสี Triage และข้อมูลที่ทราบ';
  $('#patientDialog').showModal();
  if (id) loadPatient(id, chartRequest);
}
async function loadPatient(id, chartRequest) {
  const stillOpen = () =>
    $('#patientDialog').open && state.chartRequest === chartRequest;
  try {
    const data = await api(`/api/patients/${encodeURIComponent(id)}`);
    if (!stillOpen()) return;
    if (!data.patient) {
      $('#dialogTitle').textContent = `ขึ้นทะเบียน ${id}`;
      $('#dialogMeta').textContent = 'กรอกข้อมูลเพื่อสร้างแฟ้มใหม่สำหรับการ์ดนี้';
      $('#savePatientBtn').disabled = false;
      return;
    }
    state.selectedPatient = data.patient;
    fillPatient(data.patient);
    state.history = data.history || [];
    $('#historyPanel').hidden = false;
    renderHistory();
    $('#dialogMeta').textContent =
      `แก้ไขล่าสุด ${fmtDate(data.patient.updatedAt)}`;
    $('#savePatientBtn').disabled = false;
  } catch (e) {
    if (!stillOpen()) return;
    $('#dialogMeta').textContent = 'เปิดแฟ้มไม่สำเร็จ';
    showError($('#patientError'), e.message);
  }
}
function fillPatient(p) {
  Object.entries({
    patientId: p.id,
    patientDemo: p.demo,
    patientZone: p.zone,
    patientTriagePoint: p.triagePoint,
    patientDecon: p.deconStatus,
    patientTransport: p.transport,
    patientCc: p.cc,
    patientRr: p.rr,
    patientHr: p.hr,
    patientBp: p.bp,
    patientSpo2: p.spo2,
    patientGcs: p.gcs,
  }).forEach(([id, value]) => {
    const node = $(`#${id}`);
    if (node) node.value = value || '';
  });
  $('#patientColor').value = p.color || '';
  $$('.triage-option').forEach((b) =>
    b.classList.toggle('selected', b.dataset.color === p.color),
  );
  $$('#interventionPicker input').forEach((i) => {
    i.checked = (p.interventions || []).includes(i.value);
  });
}
function renderHistory() {
  const root = $('#historyList');
  root.replaceChildren();
  if (!state.history.length) {
    root.append(el('p', 'muted', 'ยังไม่มีประวัติ'));
    return;
  }
  state.history.forEach((h) => {
    const item = el('article', 'history-item');
    item.append(
      el('strong', null, `${fmtDate(h.updatedAt)} · ${h.staff || 'ไม่ระบุชื่อ'}`),
      el('p', null, h.note || 'มีการอัปเดตข้อมูลผู้ป่วย'),
      el(
        'small',
        null,
        `${colorLabels[h.color] || text(h.color)} · ${zoneLabels[h.zone] || text(h.zone)} · ${vitalText(h)}`,
      ),
    );
    root.append(item);
  });
}
function formBody() {
  const form = $('#patientForm');
  const fd = new FormData(form);
  const body = Object.fromEntries(fd.entries());
  body.id = body.id.trim().toUpperCase();
  body.color = $('#patientColor').value;
  body.interventions = $$('#interventionPicker input:checked').map(
    (i) => i.value,
  );
  return body;
}
async function savePatient(event) {
  event.preventDefault();
  const saveButton = $('#savePatientBtn');
  if (saveButton.disabled) return;
  const body = formBody();
  if (!body.color) {
    showError($('#patientError'), 'กรุณาเลือกสี Triage ให้ชัดเจน');
    return;
  }
  if (!body.id && state.selectedPatient) body.id = state.selectedPatient.id;
  const isEdit = Boolean(state.selectedPatient);
  if (isEdit) body.version = state.selectedPatient.version;
  saveButton.disabled = true;
  try {
    const result = await api(
      isEdit
        ? `/api/patients/${encodeURIComponent(state.selectedPatient.id)}`
        : '/api/patients',
      { method: isEdit ? 'PATCH' : 'POST', body },
    );
    state.selectedPatient = result.patient;
    state.history = result.history || [];
    notify('บันทึกข้อมูลผู้ป่วยแล้ว');
    $('#patientDialog').close();
    await refresh();
  } catch (e) {
    showError(
      $('#patientError'),
      e.status === 409 ? 'ข้อมูลถูกแก้ไขโดยเจ้าหน้าที่อื่น กรุณาปิดแล้วโหลดใหม่' : e.message,
    );
  } finally {
    saveButton.disabled = false;
  }
}

async function loadSession() {
  try {
    const result = await api('/api/session');
    if (result?.staff) {
      state.session = result.staff;
      enterApp();
    }
  } catch (_) {
    /* unauthenticated */
  }
}
async function login(event) {
  event.preventDefault();
  const form = $('#loginForm');
  const body = Object.fromEntries(new FormData(form).entries());
  const error = $('#loginError');
  if (!Object.values(body).every(Boolean)) {
    showError(error, 'กรุณากรอกข้อมูลให้ครบทุกช่อง');
    return;
  }
  try {
    const result = await api('/api/session', { method: 'POST', body });
    state.session = result.staff || body;
    enterApp();
    notify('เข้าสู่ระบบสำเร็จ');
  } catch (e) {
    showError(error, e.message);
  }
}
function enterApp() {
  $('#authView').hidden = true;
  $('#mainView').hidden = false;
  $('#sessionLabel').textContent =
    `${state.session.name} · ${state.session.duty}`;
  $('#sideProfile').textContent =
    `${state.session.name} · ${state.session.org}\n${state.session.opZone}`;
  renderNav();
  navigate('overview');
  refresh();
  const id = patientIdFromUrl();
  if (id) setTimeout(() => openPatient(id), 0);
}
async function logout() {
  try {
    await api('/api/session', { method: 'DELETE' });
  } catch (_) {
    /* still clear local view */
  }
  state.session = null;
  $('#mainView').hidden = true;
  $('#authView').hidden = false;
  $('#loginForm').reset();
}
async function clearPatients() {
  if (!window.confirm('ยืนยันล้างผู้ป่วยและประวัติทั้งหมด? การกระทำนี้ย้อนกลับไม่ได้')) return;
  try {
    await api('/api/patients', { method: 'DELETE' });
    notify('ล้างข้อมูลผู้ป่วยแล้ว');
    await refresh();
  } catch (e) {
    notify(e.message, 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('#loginForm').addEventListener('submit', login);
  $('#patientForm').addEventListener('submit', savePatient);
  $('#closeDialogBtn').addEventListener('click', () =>
    $('#patientDialog').close(),
  );
  $('#logoutBtn').addEventListener('click', logout);
  $('#refreshBtn').addEventListener('click', refresh);
  $('#clearBtn').addEventListener('click', clearPatients);
  $$('.triage-option').forEach((b) =>
    b.addEventListener('click', () => {
      $('#patientColor').value = b.dataset.color;
      $$('.triage-option').forEach((x) =>
        x.classList.toggle('selected', x === b),
      );
    }),
  );
  $('#interventionPicker').replaceChildren(
    ...interventions.map((value) => {
      const label = el('label', 'chip');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = value;
      label.append(input, document.createTextNode(value));
      return label;
    }),
  );
  loadSession();
});

export { state, renderPatients, openPatient, clearPatients };
