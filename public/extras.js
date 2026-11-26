import { patientLink } from './patient-link.js';
import { CHEMICALS, ERG_SOURCES } from './erg-data.js';

const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
export const filterChemicals = (items, query) => {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  return !q
    ? items
    : items.filter((x) =>
        [x.un, x.nameEn, x.nameThai].some((v) =>
          String(v).toLowerCase().includes(q),
        ),
      );
};

function field(label, type, name, value, attrs = '') {
  return `<label class="field"><span>${label}</span><input type="${type}" name="${name}" value="${esc(value)}" ${attrs}></label>`;
}
function pageHead(title, sub, actions = '') {
  return `<div class="page-head"><div><h1>${title}</h1><p>${sub}</p></div><div class="page-actions">${actions}</div></div>`;
}

function renderStock(root, state, api, notify, incidentClosed) {
  let stock = state.stock || [];
  let saving = false;
  root.innerHTML =
    pageHead(
      'คลังเวชภัณฑ์',
      'ติดตามจำนวนคงเหลือและแจ้งเตือนของใกล้หมด',
      '<button class="btn btn-danger stock-reset" type="button">รีเซ็ตข้อมูลสาธิต</button>',
    ) +
    `<section class="panel stock-controls"><div class="panel-head"><h2>รายการเวชภัณฑ์</h2><span class="badge stock-count"></span></div><div class="filters"><input class="stock-search" type="search" placeholder="ค้นหาชื่อหรือหมวดหมู่" aria-label="ค้นหาเวชภัณฑ์"></div><div class="table-wrap"><table><thead><tr><th>รายการ</th><th>หมวด</th><th>คงเหลือ</th><th>อัปเดต</th><th>การปรับจำนวน</th></tr></thead><tbody class="stock-rows"></tbody></table></div></section>` +
    `<section class="panel stock-add"><div class="panel-head"><h2>เพิ่มรายการใหม่</h2></div><form class="form-grid stock-form">${field('ชื่อรายการ', 'text', 'name', '', 'required maxlength="120"')} ${field('หมวดหมู่', 'text', 'category', 'General', 'required maxlength="80"')} ${field('จำนวน', 'number', 'qty', '0', 'min="0" step="1" required')} ${field('หน่วย', 'text', 'unit', 'ชิ้น', 'required maxlength="30"')} ${field('แจ้งเตือนเมื่อเหลือไม่เกิน', 'number', 'minAlert', '0', 'min="0" step="1" required')}<div class="page-actions"><button class="btn btn-primary" type="submit">เพิ่มเข้าคลัง</button></div></form></section>`;
  const rows = root.querySelector('.stock-rows');
  const drawRows = () => {
    const q = root.querySelector('.stock-search').value.trim().toLowerCase();
    root.querySelector('.stock-count').textContent = `${stock.length} รายการ`;
    rows.innerHTML =
      stock
        .filter((x) => `${x.name} ${x.category}`.toLowerCase().includes(q))
        .map((x) => {
          const low = Number(x.qty) <= Number(x.minAlert);
          const timestamp = x.updatedAt
            ? new Date(x.updatedAt).toLocaleString('th-TH', {
                dateStyle: 'short',
                timeStyle: 'short',
              })
            : '—';
          return `<tr><td><strong>${esc(x.name)}</strong><br><small>${esc(x.id)}</small></td><td>${esc(x.category)}</td><td><span class="badge ${low ? 'badge-low' : 'badge-ok'}">${esc(x.qty)} ${esc(x.unit)}${low ? ' · ใกล้หมด' : ''}</span></td><td>${esc(timestamp)}<br><small>${esc(x.staff || '-')}</small></td><td><div class="stock-stepper"><button class="btn btn-secondary stock-delta" data-id="${esc(x.id)}" data-delta="-5" type="button" aria-label="ลด ${esc(x.name)} 5">−5</button><button class="btn btn-secondary stock-delta" data-id="${esc(x.id)}" data-delta="-1" type="button" aria-label="ลด ${esc(x.name)} 1">−1</button><button class="btn btn-secondary stock-delta" data-id="${esc(x.id)}" data-delta="1" type="button" aria-label="เพิ่ม ${esc(x.name)} 1">+1</button><button class="btn btn-secondary stock-delta" data-id="${esc(x.id)}" data-delta="5" type="button" aria-label="เพิ่ม ${esc(x.name)} 5">+5</button></div></td></tr>`;
        })
        .join('') || '<tr><td colspan="5" class="empty">ไม่พบรายการ</td></tr>';
  };
  drawRows();
  root.querySelector('.stock-search').addEventListener('input', drawRows);
  const refreshStockRows = (next) => {
    stock = next;
    drawRows();
  };
  if (incidentClosed) {
    root.querySelector('.stock-reset').hidden = true;
    root.querySelector('.stock-add').hidden = true;
    root
      .querySelector('.stock-controls table')
      .classList.add('stock-read-only');
    return refreshStockRows;
  }
  async function save(control, pathname, options, message, form) {
    if (saving) return;
    saving = true;
    control.disabled = true;
    try {
      const result = await api(pathname, options);
      state.stock = stock = result.stock;
      form?.reset();
      if (root.contains(rows)) drawRows();
      notify(message);
    } catch (e) {
      notify(e.message || 'บันทึกคลังไม่สำเร็จ', 'error');
    } finally {
      control.disabled = false;
      saving = false;
    }
  }
  rows.addEventListener('click', (event) => {
    const control = event.target.closest('.stock-delta');
    if (!control) return;
    save(
      control,
      `/api/stock/${encodeURIComponent(control.dataset.id)}`,
      { method: 'PATCH', body: { delta: Number(control.dataset.delta) } },
      'อัปเดตจำนวนแล้ว',
    );
  });
  const form = root.querySelector('.stock-form');
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    save(
      form.querySelector('button'),
      '/api/stock',
      {
        method: 'POST',
        body: {
          ...data,
          qty: Number(data.qty),
          minAlert: Number(data.minAlert),
        },
      },
      'เพิ่มรายการแล้ว',
      form,
    );
  });
  root.querySelector('.stock-reset').addEventListener('click', (event) => {
    if (!window.confirm('รีเซ็ตคลังกลับเป็นข้อมูลฝึกซ้อมตั้งต้นหรือไม่?')) return;
    save(
      event.currentTarget,
      '/api/stock/reset',
      { method: 'POST', body: {} },
      'รีเซ็ตคลังแล้ว',
    );
  });
  return refreshStockRows;
}

function renderErg(root) {
  root.innerHTML =
    pageHead(
      'คู่มือสารเคมี',
      'ค้นเลข UN หรือชื่อสารเคมี และเปิดคู่มือ ERG4Thai ของกรมควบคุมมลพิษ',
    ) +
    `<section class="panel">
      <div class="page-actions" aria-label="ช่องทางเปิด ERG4Thai">
        <a class="btn btn-primary" href="${ERG_SOURCES.web}" target="_blank" rel="noopener">เปิดเว็บ ERG4Thai</a>
        <a class="btn btn-secondary" href="${ERG_SOURCES.ios}" target="_blank" rel="noopener">แอป iPhone / iPad</a>
        <a class="btn btn-secondary" href="${ERG_SOURCES.android}" target="_blank" rel="noopener">แอป Android</a>
      </div>
    </section>
    <section class="panel"><div class="filters"><input class="erg-search" type="search" placeholder="ค้นหา UN / ชื่อไทย / ชื่ออังกฤษ" aria-label="ค้นหาสารเคมี"></div><div class="erg-results"></div><div class="resource-links"><a href="${ERG_SOURCES.thai}" target="_blank" rel="noopener">คู่มือกรมควบคุมมลพิษ</a> · <a href="${ERG_SOURCES.phmsa}" target="_blank" rel="noopener">U.S. PHMSA ERG</a> · <a href="${ERG_SOURCES.erg2024}" target="_blank" rel="noopener">ERG2024 PDF</a></div></section>`;
  const search = root.querySelector('.erg-search'),
    results = root.querySelector('.erg-results');
  const draw = () => {
    const list = filterChemicals(CHEMICALS, search.value);
    results.innerHTML = list.length
      ? list
          .map(
            (x) =>
              `<article class="erg-result"><div><strong>UN ${esc(x.un)}</strong> · ${esc(x.nameThai)}<br><span>${esc(x.nameEn)}</span></div><span class="badge badge-guide">Guide ${esc(x.guide)}</span><a href="${esc(x.source)}" target="_blank" rel="noopener" aria-label="เปิดแหล่งข้อมูล ERG สำหรับ ${esc(x.nameEn)}">แหล่งข้อมูล</a></article>`,
          )
          .join('')
      : '<p class="empty">ไม่พบสารเคมีที่ตรงกัน</p>';
  };
  search.addEventListener('input', draw);
  draw();
}

export function qrImagePath(code, incidentId = 'legacy', view) {
  const suffix = view ? `&view=${encodeURIComponent(view)}` : '';
  return `/api/qr/${encodeURIComponent(code)}.png?incident=${encodeURIComponent(incidentId)}${suffix}`;
}
export function updateNextPatientCard(
  root,
  { nextPatientId, incidentId, incidentName, incidentClosed } = {},
) {
  const card = root?.querySelector?.('[data-next-patient-card]');
  if (!card) return;
  const id = nextPatientId || '';
  const closed = Boolean(incidentClosed);
  const available = Boolean(id) && !closed;
  const link = card.querySelector('.next-patient-link');
  const image = card.querySelector('.next-patient-qr');
  const idLabel = card.querySelector('.next-patient-id');
  const incidentLabel = card.querySelector('.next-patient-incident');
  const empty = card.querySelector('.next-patient-empty');
  const content = card.querySelector('.next-patient-content');
  incidentLabel.textContent = incidentName || 'ยังไม่ได้เลือกเหตุการณ์';
  empty.textContent = closed
    ? 'เหตุการณ์นี้ปิดรับผู้ป่วยแล้ว'
    : 'กำลังโหลดรหัสผู้ป่วย…';
  empty.hidden = available;
  content.hidden = !available;
  if (!available) return;
  const href = patientLink(id, incidentId || 'legacy');
  link.href = href;
  link.setAttribute('aria-label', `เปิดแฟ้ม ${id}`);
  link.title = `เปิดแฟ้ม ${id}`;
  const imagePath = qrImagePath(id, incidentId || 'legacy');
  if (image.getAttribute('src') !== imagePath) {
    // Swap image nodes so the previous patient's QR cannot remain visible under the new number.
    const nextImage = document.createElement('img');
    nextImage.className = image.className;
    nextImage.width = nextImage.height = 150;
    nextImage.alt = `QR สำหรับรหัส ${id}`;
    nextImage.src = imagePath;
    image.replaceWith(nextImage);
  }
  idLabel.textContent = id;
}
export function updateBatchCardStatuses(root, cardStatuses = {}) {
  root?.querySelectorAll?.('[data-card-code]').forEach((card) => {
    const statusNode = card.querySelector('.qr-card-status');
    if (!statusNode) return;
    const status = cardStatuses?.[card.dataset.cardCode];
    if (status === 'registered') {
      statusNode.textContent = 'บันทึกข้อมูลแล้ว';
      statusNode.setAttribute('aria-label', 'การ์ดนี้มีข้อมูลผู้ป่วยแล้ว');
      statusNode.hidden = false;
    } else if (status === 'archived') {
      statusNode.textContent = 'เก็บออกจากรายชื่อแล้ว';
      statusNode.setAttribute('aria-label', 'การ์ดนี้เป็นแฟ้มที่เก็บออกจากรายชื่อแล้ว');
      statusNode.hidden = false;
    } else {
      statusNode.textContent = '';
      statusNode.removeAttribute('aria-label');
      statusNode.hidden = true;
    }
  });
}
async function printCurrentCard(root, button, notify) {
  const image = root.querySelector('.next-patient-qr');
  const content = root.querySelector('.next-patient-content');
  if (button.disabled || root.hidden || content.hidden) return;
  button.disabled = true;
  let sheet;
  try {
    await image.decode();
    if (root.hidden || !root.contains(button)) return;
    if (content.hidden || !content.contains(image)) {
      notify('QR เปลี่ยนแล้ว กรุณากดพิมพ์ใบที่แสดงอีกครั้ง', 'error');
      return;
    }
    // Freeze the decoded pixels with their labels while the live intake board keeps updating.
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    canvas.getContext('2d').drawImage(image, 0, 0);
    const code = document.createElement('strong');
    code.textContent = root.querySelector('.next-patient-id').textContent;
    const caption = document.createElement('figcaption');
    caption.textContent = root.querySelector('.next-patient-incident').textContent;
    sheet = document.createElement('figure');
    sheet.className = 'printed-patient-qr';
    sheet.append(canvas, code, caption);
    document.querySelector('.printed-patient-qr')?.remove();
    document.body.append(sheet);
    window.addEventListener('afterprint', () => sheet.remove(), { once: true });
    window.print();
  } catch {
    sheet?.remove();
    if (root.contains(button) && !root.hidden)
      notify('พิมพ์ QR ไม่สำเร็จ กรุณารีเฟรชหน้าแล้วลองอีกครั้ง', 'error');
  } finally {
    button.disabled = false;
  }
}

function cardsViewToggle(active) {
  return `<div class="cards-view-toggle" role="group" aria-label="รูปแบบการ์ด QR"><button type="button" class="btn btn-secondary ${active === 'cards-v2' ? 'active' : ''}" data-cards-view="cards-v2" aria-pressed="${active === 'cards-v2'}">หลายใบ (V2)</button><button type="button" class="btn btn-secondary ${active === 'cards' ? 'active' : ''}" data-cards-view="cards" aria-pressed="${active === 'cards'}">ทีละใบ</button></div>`;
}
function bindCardsViewToggle(root, onChange) {
  root.querySelectorAll('[data-cards-view]').forEach((button) => {
    button.addEventListener('click', () => onChange?.(button.dataset.cardsView));
  });
}
function renderCards(root, cardState, notify) {
  root.innerHTML =
    pageHead('QR ผู้ป่วย', 'แตะหรือสแกน QR เพื่อเปิดแฟ้มของผู้ป่วยในเหตุการณ์นี้') +
    cardsViewToggle('cards') +
    `<section class="panel next-patient-card" data-next-patient-card aria-labelledby="next-patient-title">
      <div class="panel-head"><div><h2 id="next-patient-title">QR ผู้ป่วยคนถัดไป</h2><p class="next-patient-incident"></p></div></div>
      <div class="next-patient-content"><a class="next-patient-link"><img class="next-patient-qr" alt="" width="150" height="150"><strong class="next-patient-id" aria-live="polite"></strong></a><div class="next-patient-purpose"><p>เมื่อบันทึกข้อมูลสำเร็จ QR ของผู้ป่วยคนถัดไปจะขึ้นตรงนี้อัตโนมัติ</p><p>สแกน QR ใบเดิมอีกครั้งเพื่อดูประวัติผู้ป่วยคนนั้น</p><button type="button" class="btn btn-secondary print-current-qr">พิมพ์ QR ใบนี้</button></div></div>
      <p class="next-patient-empty" hidden></p>
    </section>`;
  updateNextPatientCard(root, cardState);
  const print = root.querySelector('.print-current-qr');
  print.addEventListener('click', () => printCurrentCard(root, print, notify));
  bindCardsViewToggle(root, cardState.onCardsViewChange);
}

function normalizeV2Start(value) {
  const raw = String(value ?? '').trim();
  if (raw.length > 5596 || !/^\d+$/.test(raw)) return null;
  const start = BigInt(raw);
  return start > 0n ? start.toString() : null;
}
function normalizeV2Count(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 500 ? n : null;
}
function v2Code(start, offset) {
  return `MCI-${(BigInt(start) + BigInt(offset)).toString().padStart(3, '0')}`;
}
function renderCardsV2(
  root,
  { incidentId, incidentName, incidentClosed, cardRange, onCardRangeChange, onCardsViewChange } = {},
  notify,
) {
  const activeIncident = Boolean(incidentId) && !incidentClosed;
  const initial = cardRange || { start: '1', count: 12 };
  root.innerHTML =
    pageHead('การ์ด QR ผู้ป่วย', 'กดที่บัตรเพื่อเปิดข้อมูลผู้ป่วย หรือพิมพ์บัตรไว้สแกนที่จุดปฏิบัติงาน') +
    cardsViewToggle('cards-v2') +
    `<section class="panel cards-v2-controls"><form class="qr-controls qr-controls-v2">
      <label class="field"><span>จำนวนบัตร</span><input class="cards-v2-count" name="count" type="number" min="1" max="500" value="${esc(initial.count)}" required></label>
      <label class="field"><span>รหัสเริ่มต้น</span><input class="cards-v2-start" name="start" type="text" inputmode="numeric" pattern="[0-9]+" maxlength="5596" value="${esc(initial.start)}" required></label>
      <div class="page-actions"><button class="btn btn-secondary cards-v2-preview" type="submit">สร้างตัวอย่าง</button><button class="btn btn-primary cards-v2-print" type="button">พิมพ์ช่วงนี้</button></div>
    </form><small class="cards-v2-help">${activeIncident ? 'พิมพ์ได้ครั้งละ 1–500 ใบ' : 'ยังไม่มีเหตุการณ์ที่เปิดรับผู้ป่วย จึงยังสร้าง QR ไม่ได้'}</small><p class="form-error cards-v2-error" role="alert" hidden></p></section>
    <section id="print-area-v2" class="qr-grid qr-grid-v2" aria-label="ตัวอย่างการ์ด QR หลายใบ"></section>`;
  const form = root.querySelector('.qr-controls-v2');
  const area = root.querySelector('#print-area-v2');
  const error = root.querySelector('.cards-v2-error');
  const print = root.querySelector('.cards-v2-print');
  let renderedKey = '';
  if (!activeIncident) {
    form.querySelectorAll('input,button').forEach((control) => { control.disabled = true; });
    error.textContent = incidentClosed ? 'เหตุการณ์ปิดแล้ว' : 'กรุณาเลือกเหตุการณ์ที่เปิดอยู่ก่อน';
    error.hidden = false;
  }
  const draw = () => {
    const data = Object.fromEntries(new FormData(form));
    const start = normalizeV2Start(data.start);
    const count = normalizeV2Count(data.count);
    if (!activeIncident || start === null || count === null) {
      error.textContent = !activeIncident ? 'ยังสร้าง QR ไม่ได้ในสถานะนี้' : 'กรุณาระบุรหัสเริ่มต้นเป็นตัวเลข และจำนวน 1–500 ใบ';
      error.hidden = false;
      return false;
    }
    const nextKey = `${start}:${count}`;
    if (nextKey === renderedKey) {
      error.hidden = true;
      return true;
    }
    error.hidden = true;
    area.innerHTML = Array.from({ length: count }, (_, index) => {
      const code = v2Code(start, index);
      return `<article class="qr-card qr-card-v2" data-card-code="${esc(code)}">
        <div class="qr-caption"><strong>${esc(code)}</strong><span>${esc(incidentName || 'ThaiSim')}</span></div>
        <a class="qr-link" href="${esc(patientLink(code, incidentId, 'cards-v2'))}" aria-label="เปิดแฟ้ม ${esc(code)}" title="เปิดแฟ้ม ${esc(code)}">
          <img src="${qrImagePath(code, incidentId, 'cards-v2')}" alt="QR สำหรับรหัส ${esc(code)}" loading="${index < 12 ? 'eager' : 'lazy'}" width="132" height="132">
        </a>
        <div class="qr-bands">
          <span class="badge badge-red">แดง</span><span class="badge badge-yellow">เหลือง</span>
          <span class="badge badge-green">เขียว</span><span class="badge badge-black">ดำ</span>
        </div>
        <span class="qr-card-status" role="status" hidden></span>
      </article>`;
    }).join('');
    renderedKey = nextKey;
    onCardRangeChange?.({ start, count });
    return true;
  };
  form.addEventListener('submit', (event) => { event.preventDefault(); if (form.reportValidity()) draw(); });
  print.addEventListener('click', async () => {
    if (!form.reportValidity() || !draw()) return;
    const printKey = renderedKey;
    print.disabled = true;
    try {
      const images = [...area.querySelectorAll('img')];
      images.forEach((img) => { img.loading = 'eager'; });
      await Promise.all(images.map((img) => img.decode()));
      const latestStart = normalizeV2Start(form.elements.start.value);
      const latestCount = normalizeV2Count(form.elements.count.value);
      const latestKey = latestStart === null || latestCount === null
        ? ''
        : `${latestStart}:${latestCount}`;
      if (print.isConnected && !root.hidden && printKey === renderedKey && latestKey === renderedKey)
        window.print();
      else if (print.isConnected && latestKey !== renderedKey)
        notify('ช่วงรหัสเปลี่ยนแล้ว กรุณากดสร้างตัวอย่างอีกครั้ง', 'error');
    } catch { notify('โหลด QR ไม่ครบ กรุณารีเฟรชหน้าแล้วลองใหม่', 'error'); }
    finally { print.disabled = false; }
  });
  bindCardsViewToggle(root, onCardsViewChange);
  draw();
}

export function renderExtras(
  page,
  { root, state, api, notify, incidentId, incidentName, incidentClosed, cardRange, onCardRangeChange, onCardsViewChange },
) {
  if (!root) throw new Error('Extras root is required');
  if (page === 'stock')
    return renderStock(root, state, api, notify, incidentClosed);
  else if (page === 'erg') renderErg(root);
  else if (page === 'cards')
    renderCards(root, {
      incidentId,
      incidentName,
      nextPatientId: state?.nextPatientId,
      incidentClosed,
      onCardsViewChange,
    }, notify);
  else if (page === 'cards-v2')
    renderCardsV2(root, {
      incidentId,
      incidentName,
      incidentClosed,
      cardRange,
      onCardRangeChange,
      onCardsViewChange,
    }, notify);
  else root.innerHTML = '<p class="empty">ไม่พบหน้าที่เลือก</p>';
  return root;
}
