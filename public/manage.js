/* Management view for the selected exercise incident.  The parent owns auth,
 * incident selection, patient dialog, toast, and the API wrapper. */

const text = (value, fallback = '—') =>
  value === undefined || value === null || value === ''
    ? fallback
    : String(value);
const colors = { red: 'แดง', yellow: 'เหลือง', green: 'เขียว', black: 'ดำ' };
const zones = {
  triage: 'จุดคัดแยก',
  decon: 'จุดชำระล้าง',
  treatment: 'จุดรักษา',
  staging: 'จุดรอส่งต่อ',
  evacuated: 'ส่งต่อแล้ว',
  discharged: 'จำหน่ายแล้ว',
  morgue: 'จุดพักศพ',
};
const decon = {
  pending: 'รอชำระล้าง',
  'in-progress': 'กำลังชำระล้าง',
  cleared: 'ชำระล้างแล้ว',
  none: 'ไม่ต้อง Decon',
};
function isProtectedStaff(current, staff) {
  if (!staff) return false;
  return Boolean(
    (current?.id && staff.id === current.id) ||
    (current?.username && staff.username === current.username) ||
    staff.username === 'DemoThaiSIM001',
  );
}

function date(value) {
  if (!value) return 'ยังไม่มีข้อมูล';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? text(value)
    : parsed.toLocaleString('th-TH', {
        dateStyle: 'short',
        timeStyle: 'short',
      });
}
function el(tag, attrs = {}, content) {
  const node = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'on')
      Object.entries(value).forEach(([event, handler]) =>
        node.addEventListener(event, handler),
      );
    else if (value !== false && value != null)
      node.setAttribute(key, value === true ? '' : value);
  });
  if (content !== undefined) {
    if (content instanceof Node) node.append(content);
    else if (Array.isArray(content)) node.append(...content);
    else node.textContent = content;
  }
  return node;
}
function button(label, className, handler, disabled = false) {
  return el(
    'button',
    {
      class: `btn ${className}`,
      type: 'button',
      disabled,
      on: { click: handler },
    },
    label,
  );
}
function field(label, name, value, state, options = {}) {
  const wrap = el('label', { class: 'manage-field' });
  wrap.append(el('span', { class: 'manage-label', text: label }));
  const input = el(options.tag || 'input', {
    name,
    value: value ?? '',
    required: options.required !== false,
    autocomplete: 'off',
  });
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.tag === 'select') {
    options.options.forEach(([key, labelText]) =>
      input.append(el('option', { value: key, text: labelText })),
    );
    input.value = value ?? '';
  }
  input.addEventListener('input', () => {
    state.dirty = true;
    state.values[name] = input.value;
  });
  input.addEventListener('change', () => {
    state.dirty = true;
    state.values[name] = input.value;
  });
  wrap.append(input);
  return wrap;
}

function patientStatus(patient) {
  return `${colors[patient.color] || text(patient.color)} · ${zones[patient.zone] || text(patient.zone)}${patient.deconStatus && patient.deconStatus !== 'none' ? ` · ${decon[patient.deconStatus] || patient.deconStatus}` : ''}`;
}

function errorText(error) {
  if (
    error?.status === 409 ||
    /stale|เปลี่ยนแล้ว|ปิดแล้ว/i.test(error?.message || '')
  )
    return 'ข้อมูลเปลี่ยนแล้วหรือเหตุการณ์ถูกปิด กรุณารีเฟรชก่อนลองใหม่';
  if (error?.status === 403 || error?.status === 401)
    return 'ไม่มีสิทธิ์จัดการข้อมูล กรุณาขอสิทธิ์จากผู้ควบคุมการฝึกซ้อม';
  if (error?.status === 404)
    return 'ไม่พบรายการนี้ในเหตุการณ์ที่เลือก อาจถูกลบหรือเปลี่ยนเหตุการณ์แล้ว';
  return error?.message || 'ดำเนินการไม่สำเร็จ กรุณาตรวจข้อมูลแล้วลองใหม่';
}

export function mountManagement(root, options = {}) {
  if (!root) throw new Error('mountManagement ต้องได้รับ root element');
  const state = {
    data: { patients: [], accounts: [], incident: options.incident },
    tab: 'patients',
    query: '',
    form: null,
    destroyed: false,
    refs: {},
    request: 0,
  };
  const api = options.api;
  if (typeof api !== 'function')
    throw new Error('mountManagement ต้องได้รับ api function');
  const notify = options.notify || (() => {});

  function canManage() {
    return Boolean(state.data.canManage ?? options.canManage);
  }
  function setNotice(message, type = 'error') {
    const node = state.refs.notice;
    if (!node) return;
    node.className = `manage-notice ${type}`;
    node.textContent = message || '';
    node.hidden = !message;
  }
  function filtered(items) {
    const q = state.query.trim().toLocaleLowerCase();
    return !q
      ? items
      : items.filter((item) =>
          JSON.stringify(item).toLocaleLowerCase().includes(q),
        );
  }
  function renderShell() {
    root.replaceChildren();
    const section = el('section', {
      class: 'manage-panel',
      'aria-labelledby': 'managementTitle',
    });
    const header = el('div', { class: 'manage-head' });
    const title = el('div');
    title.append(
      el('h1', { id: 'managementTitle', text: 'จัดการข้อมูลการฝึกซ้อม' }),
      el(
        'p',
        { class: 'muted manage-subtitle' },
        `เหตุการณ์: ${state.data.incident?.name || options.incident?.name || 'เหตุการณ์ที่เลือก'}`,
      ),
    );
    header.append(title);
    const tabs = el('div', {
      class: 'manage-tabs',
      role: 'tablist',
      'aria-label': 'ประเภทข้อมูล',
    });
    [
      ['patients', 'ผู้ป่วย'],
      ['staff', 'เจ้าหน้าที่'],
      ['incidents', 'เหตุการณ์'],
    ].forEach(([key, label]) => {
      const tab = button(
        label,
        `manage-tab ${state.tab === key ? 'active' : ''}`,
        () => {
          state.tab = key;
          state.query = '';
          state.form = null;
          render();
        },
      );
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', state.tab === key ? 'true' : 'false');
      tabs.append(tab);
    });
    const controls = el('div', { class: 'manage-controls' });
    const searchLabel = el('label', { class: 'manage-search' });
    searchLabel.append(el('span', { text: 'ค้นหา' }));
    const search = el('input', {
      type: 'search',
      placeholder:
        state.tab === 'patients'
          ? 'รหัส อาการ หรือพื้นที่'
          : state.tab === 'staff'
            ? 'ชื่อผู้ใช้ ชื่อ หรือหน่วยงาน'
            : 'ชื่อเหตุการณ์',
      value: state.query,
      'aria-label': 'ค้นหารายการ',
    });
    search.addEventListener('input', () => {
      state.query = search.value;
      renderList();
    });
    searchLabel.append(search);
    controls.append(searchLabel);
    const count = el('span', { class: 'manage-count', 'aria-live': 'polite' });
    controls.append(count);
    if (state.tab === 'patients' && canManage() && !incidentClosed())
      controls.append(
        button('+ ผู้ป่วยใหม่', 'btn-primary', () => options.openPatient?.()),
      );
    if (state.tab === 'staff' && canManage())
      controls.append(button('+ เจ้าหน้าที่ใหม่', 'btn-primary', () => openStaff()));
    if (!canManage())
      section.append(
        el(
          'p',
          { class: 'manage-lock', role: 'status' },
          'โหมดดูอย่างเดียว · จัดการรายชื่อด้วยบัญชีเดโม DemoThaiSIM001',
        ),
      );
    section.append(header, tabs, controls);
    const notice = el('p', {
      class: 'manage-notice',
      role: 'alert',
      hidden: true,
    });
    state.refs = { section, tabs, controls, count, notice };
    section.append(notice);
    const list = el('div', { class: 'manage-list' });
    state.refs.list = list;
    section.append(list);
    const form = el('div', { class: 'manage-form-slot' });
    state.refs.form = form;
    section.append(form);
    root.append(section);
  }
  function renderList() {
    if (!state.refs.list) return;
    const source =
      state.tab === 'patients'
        ? state.data.patients || []
        : state.tab === 'staff'
          ? state.data.accounts || state.data.staff || []
          : state.data.incidents || [];
    const rows = filtered(source);
    state.refs.count.textContent = `${rows.length} / ${source.length} รายการ`;
    state.refs.list.replaceChildren();
    if (!rows.length) {
      state.refs.list.append(
        el('p', {
          class: 'manage-empty',
          text: source.length ? 'ไม่พบรายการที่ตรงกับคำค้น' : 'ยังไม่มีข้อมูลในเหตุการณ์นี้',
        }),
      );
      return;
    }
    if (state.tab === 'patients') renderPatients(rows);
    else if (state.tab === 'staff') renderStaff(rows);
    else renderIncidents(rows);
    const headings = [...state.refs.list.querySelectorAll('thead th')].map(
      (cell) => cell.textContent,
    );
    for (const row of state.refs.list.querySelectorAll('tbody tr')) {
      [...row.cells].forEach((cell, i) => {
        cell.dataset.label = headings[i];
      });
    }
  }
  function renderPatients(rows) {
    const table = el('table', { class: 'manage-table' });
    table.append(
      el(
        'thead',
        {},
        (() => {
          const tr = el('tr');
          [
            'รหัส',
            'รายละเอียดผู้ป่วย',
            'สถานะ',
            'อาการหลัก',
            'อัปเดต',
            'การทำงาน',
          ].forEach((x) => tr.append(el('th', { scope: 'col', text: x })));
          return tr;
        })(),
      ),
    );
    const body = el('tbody');
    rows.forEach((patient) => {
      const tr = el('tr');
      const open = button(patient.id, 'btn-text manage-id', () =>
        options.openPatient?.(patient.id),
      );
      open.setAttribute('aria-label', `เปิดแฟ้มผู้ป่วย ${patient.id}`);
      tr.append(
        el('td', { class: 'manage-code' }, open),
        el('td', {}, text(patient.demo)),
        el('td', {}, patientStatus(patient)),
        el('td', {}, text(patient.cc)),
        el('td', {}, date(patient.updatedAt)),
      );
      const actions = el('td', { class: 'manage-actions' });
      actions.append(
        button('เปิดแฟ้ม', 'btn-secondary btn-sm', () =>
          options.openPatient?.(patient.id),
        ),
      );
      if (canManage() && !incidentClosed())
        actions.append(
          button('ลบ', 'btn-danger btn-sm', () => deletePatient(patient)),
        );
      tr.append(actions);
      body.append(tr);
    });
    table.append(body);
    state.refs.list.append(
      el('div', { class: 'table-wrap manage-table-wrap' }, table),
    );
  }
  function renderStaff(rows) {
    const table = el('table', { class: 'manage-table' });
    const tr = el('tr');
    ['ชื่อผู้ใช้', 'ชื่อ', 'หน่วยงาน', 'หน้าที่', 'โซน', 'การทำงาน'].forEach((x) =>
      tr.append(el('th', { scope: 'col', text: x })),
    );
    table.append(el('thead', {}, tr));
    const body = el('tbody');
    rows.forEach((staff) => {
      const tr = el('tr');
      tr.append(
        el('td', { class: 'manage-code' }, text(staff.username)),
        el('td', {}, text(staff.name)),
        el('td', {}, text(staff.org)),
        el('td', {}, text(staff.duty)),
        el('td', {}, text(staff.opZone)),
      );
      const actions = el('td', { class: 'manage-actions' });
      if (canManage()) {
        actions.append(
          button('แก้ไข', 'btn-secondary btn-sm', () => openStaff(staff)),
        );
        if (!isProtectedStaff(options.staff, staff))
          actions.append(
            button('ลบ', 'btn-danger btn-sm', () => deleteStaff(staff)),
          );
      } else actions.append(el('span', { class: 'muted', text: 'ดูอย่างเดียว' }));
      tr.append(actions);
      body.append(tr);
    });
    table.append(body);
    state.refs.list.append(
      el('div', { class: 'table-wrap manage-table-wrap' }, table),
    );
  }
  function renderIncidents(rows) {
    const table = el('table', { class: 'manage-table manage-incidents-table' });
    const head = el('tr');
    ['เหตุการณ์', 'สถานะ', 'เปิดเมื่อ', 'ผู้ป่วย', 'การทำงาน'].forEach((label) =>
      head.append(el('th', { scope: 'col', text: label })),
    );
    table.append(el('thead', {}, head));
    const body = el('tbody');
    rows.forEach((incident) => {
      const closed = Boolean(incident.closedAt || incident.status === 'closed');
      const row = el('tr');
      row.append(
        el('td', { class: 'manage-code' }, text(incident.name)),
        el(
          'td',
          {},
          el('span', {
            class: `badge ${closed ? 'badge-black' : 'badge-green'}`,
            text: closed ? 'ปิดแล้ว' : 'เปิดอยู่',
          }),
        ),
        el('td', {}, date(incident.openedAt || incident.createdAt)),
        el('td', {}, text(incident.patientCount, '0')),
      );
      const actions = el('td', { class: 'manage-actions' });
      actions.append(
        button('เปิดเหตุการณ์', 'btn-secondary btn-sm', () =>
          options.selectIncident?.(incident),
        ),
      );
      row.append(actions);
      body.append(row);
    });
    table.append(body);
    state.refs.list.append(
      el('div', { class: 'table-wrap manage-table-wrap' }, table),
    );
  }
  function renderForm() {
    const slot = state.refs.form;
    if (!slot) return;
    slot.replaceChildren();
    if (!state.form) return;
    const formState = state.form;
    const isStaff = formState.kind === 'staff';
    const form = el('form', {
      class: 'manage-inline-form',
      'aria-label': isStaff
        ? formState.id
          ? 'แก้ไขเจ้าหน้าที่'
          : 'เพิ่มเจ้าหน้าที่'
        : 'จัดการผู้ป่วย',
    });
    const heading = el('div', { class: 'manage-form-heading' });
    heading.append(
      el('h3', {
        text: isStaff
          ? formState.id
            ? 'แก้ไขเจ้าหน้าที่'
            : 'เพิ่มเจ้าหน้าที่'
          : 'ผู้ป่วยใหม่',
      }),
    );
    heading.append(
      button('ยกเลิก', 'btn-text btn-sm', () => {
        state.form = null;
        render();
      }),
    );
    form.append(heading);
    if (!isStaff) return;
    const grid = el('div', { class: 'manage-form-grid' });
    grid.append(
      field('ชื่อเล่น *', 'name', formState.values.name, formState),
      field('หน่วยงาน *', 'org', formState.values.org, formState),
      field('นามเรียกขาน', 'callSign', formState.values.callSign, formState, {
        required: false,
      }),
      field(
        'รหัสบุคลากร',
        'personnelCode',
        formState.values.personnelCode || '000',
        formState,
        { required: false },
      ),
      field('หน้าที่ *', 'duty', formState.values.duty, formState),
      field('โซนปฏิบัติงาน *', 'opZone', formState.values.opZone, formState),
    );
    form.append(grid);
    const actions = el('div', { class: 'manage-form-actions' });
    const save = button(
      formState.id ? 'บันทึกการแก้ไข' : 'สร้างเจ้าหน้าที่',
      'btn-primary',
      () => {},
    );
    save.type = 'submit';
    actions.append(save);
    form.append(actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitStaff(form, save);
    });
    slot.append(form);
  }
  function openStaff(staff = null) {
    state.form = {
      kind: 'staff',
      id: staff?.id || '',
      version: staff?.version,
      values: {
        name: staff?.name || '',
        org: staff?.org || '',
        callSign: staff?.callSign || '',
        personnelCode: staff?.personnelCode || '000',
        duty: staff?.duty || '',
        opZone: staff?.opZone || '',
      },
      dirty: false,
    };
    renderForm();
    state.refs.form.querySelector('input')?.focus();
  }
  async function submitStaff(form, saveButton) {
    const current = state.form;
    if (!current || current.submitting) return;
    const payload = Object.fromEntries(new FormData(form));
    if (!payload.name || !payload.org || !payload.duty || !payload.opZone) {
      setNotice('กรุณากรอกชื่อ หน่วยงาน หน้าที่ และโซนปฏิบัติงานให้ครบ', 'error');
      return;
    }
    current.submitting = true;
    saveButton.disabled = true;
    try {
      const path = current.id
        ? `/api/manage/staff/${encodeURIComponent(current.id)}`
        : '/api/manage/staff';
      const result = await api(path, {
        method: current.id ? 'PATCH' : 'POST',
        body: current.id ? { ...payload, version: current.version } : payload,
      });
      notify(current.id ? 'บันทึกเจ้าหน้าที่แล้ว' : 'เพิ่มเจ้าหน้าที่แล้ว');
      state.form = null;
      await controllerRefresh();
      options.refresh?.(result);
    } catch (error) {
      current.submitting = false;
      saveButton.disabled = false;
      setNotice(errorText(error));
    }
  }
  async function deletePatient(patient) {
    if (incidentClosed()) return setNotice('เหตุการณ์ปิดแล้ว ไม่สามารถลบผู้ป่วยได้');
    if (
      !window.confirm(
        `ยืนยันลบผู้ป่วยจากเหตุการณ์ “${state.data.incident?.name || options.incident?.name || 'เหตุการณ์นี้'}”\nรหัส: ${patient.id}\nการลบนี้กู้คืนจากหน้าจอนี้ไม่ได้`,
      )
    )
      return;
    try {
      await api(`/api/manage/patients/${encodeURIComponent(patient.id)}`, {
        method: 'DELETE',
        body: { version: patient.version },
      });
      notify(`ลบผู้ป่วย ${patient.id} แล้ว`);
      await controllerRefresh();
      options.refresh?.();
    } catch (error) {
      setNotice(errorText(error));
    }
  }
  async function deleteStaff(staff) {
    if (
      !window.confirm(
        `ยืนยันลบเจ้าหน้าที่ “${staff.name || staff.username}”\nชื่อผู้ใช้: ${staff.username}\nการลบนี้กู้คืนจากหน้าจอนี้ไม่ได้`,
      )
    )
      return;
    try {
      await api(`/api/manage/staff/${encodeURIComponent(staff.id)}`, {
        method: 'DELETE',
        body: { version: staff.version },
      });
      notify(`ลบเจ้าหน้าที่ ${staff.username} แล้ว`);
      await controllerRefresh();
      options.refresh?.();
    } catch (error) {
      setNotice(errorText(error));
    }
  }
  function render() {
    if (state.destroyed) return;
    renderShell();
    renderList();
    renderForm();
  }
  async function controllerRefresh() {
    const request = ++state.request;
    try {
      const data = await api('/api/manage');
      if (request !== state.request || state.destroyed) return data;
      const permissionChanged = canManage() !== Boolean(data.canManage);
      const closedChanged =
        incidentClosed() !== Boolean(data.incident?.closedAt);
      state.data = { ...state.data, ...data };
      if (!state.refs.section || permissionChanged || closedChanged) render();
      else {
        renderList();
        if (!state.form) state.refs.form.replaceChildren();
      }
      return data;
    } catch (error) {
      setNotice(errorText(error));
      return null;
    }
  }
  function destroy() {
    state.destroyed = true;
    root.replaceChildren();
  }
  function incidentClosed() {
    const incident = state.data.incident || options.incident;
    return Boolean(incident?.closedAt || incident?.status === 'closed');
  }
  render();
  controllerRefresh();
  return { refresh: controllerRefresh, destroy };
}
