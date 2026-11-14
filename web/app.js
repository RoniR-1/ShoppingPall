const $ = id => document.getElementById(id);
let dataSource = 'real';
let toastTimer = null;

const esc = s => String(s ?? '—').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtNum = v => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toFixed(3))) : esc(v);
};
const fmtMoney = v => {
  const n = Number(v);
  return Number.isFinite(n) ? `€${n.toFixed(2)}` : '—';
};

function notify(msg) {
  const el = $('message');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4500);
}

async function api(path, body) {
  const r = await fetch('/portal' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Data-Source': dataSource },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || 'Request failed');
  return data;
}

async function run(fn) {
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    await fn();
  } catch (e) {
    if (!$('execution').hidden) {
      $('steps').innerHTML = `<li>Stopped: ${esc(e.message)}</li>`;
    }
    notify(e.message);
  } finally {
    document.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
}

function statusLabel(status) {
  if (status === 'APPROVED') return 'Approved';
  if (status === 'REJECTED') return 'Rejected';
  return 'Needs approval';
}

function statusBadge(status, score, threshold) {
  const riskText = score !== undefined && threshold !== undefined ? ` · ${fmtNum(score)}/${fmtNum(threshold)}` : '';
  const cls = status === 'APPROVED' ? 'approved' : status === 'REJECTED' ? 'rejected' : 'pending';
  return `<span class="badge ${cls}">${statusLabel(status)}${riskText}</span>`;
}

function renderItemsTable(items) {
  if (!items?.length) return '<p class="order-meta">No matched items yet.</p>';
  return `<table>
    <thead>
      <tr>
        <th>Product</th>
        <th class="num">Qty</th>
        <th class="num">Unit price</th>
        <th class="num">Line total</th>
        <th class="num">CO₂ kg/kg</th>
        <th class="num">Reliability</th>
      </tr>
    </thead>
    <tbody>
      ${items.map(i => {
        const lineTotal = i.lineTotal ?? (Number(i.quantity) * Number(i.price));
        const fav = i.human_approved_count ? ` · ${i.human_approved_count}× approved` : (i.bought_count ? ` · ${i.bought_count}× bought` : '');
        return `<tr>
          <td>
            <strong>${esc(i.name)}</strong> <small>(${esc(i.productId)})</small>
            ${i.requested ? `<br><small>For: ${esc(i.requested)}${i.substitution ? ' · substitute' : ''}${esc(fav)}</small>` : ''}
          </td>
          <td class="num">${fmtNum(i.quantity)} ${esc(i.unit)}</td>
          <td class="num">${fmtMoney(i.price)}</td>
          <td class="num">${fmtMoney(lineTotal)}</td>
          <td class="num">${fmtNum(i.carbon)}</td>
          <td class="num">${i.reliability == null ? '—' : `${fmtNum(Number(i.reliability) * 100)}%`}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function renderOrderCard(o, interactive = true) {
  const total = o.total ?? o.items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.price || 0), 0);
  const title = o.lines?.map(l => l.requested || `${fmtNum(l.quantity)} × ${l.query}`).join(', ') || o.id;
  const issuesHtml = (o.issues || []).map(i => `
    <div class="issue-box">
      <div><strong>${esc(o.lines?.[i.index]?.requested || o.lines?.[i.index]?.query)}</strong>: ${esc(i.reason)} (shortfall: ${fmtNum(i.shortfall)})</div>
      ${interactive && i.options?.length ? `<label>Select alternative
        <select data-line="${i.index}">
          <option value="">Choose a catalog item…</option>
          ${i.options.slice(0, 8).map(p => `<option value="${esc(p.productId)}">${esc(p.name)} (${esc(p.unit)}) · ${fmtMoney(p.price)} · ${fmtNum(p.available)} in stock</option>`).join('')}
        </select>
      </label>` : ''}
    </div>
  `).join('');

  const partialHtml = interactive && o.incomplete && o.items?.length
    ? `<label class="checkbox-label"><input type="checkbox" class="partial"><span>Accept available partial quantities</span></label>`
    : '';

  const actionsHtml = interactive && o.status === 'PENDING_APPROVAL'
    ? `<div class="actions">
        <button class="primary-btn small-btn" data-action="approve" type="button">${o.incomplete ? 'Apply & approve' : 'Approve'}</button>
        <button class="ghost-btn small-btn" data-action="reject" type="button">Reject</button>
      </div>`
    : '';

  return `<article class="order-card" data-id="${esc(o.id)}">
    <div class="order-head">
      <div>
        <h3>${esc(title)}</h3>
        <div class="order-meta">${esc(o.reason || '')}</div>
      </div>
      ${statusBadge(o.status, o.score, o.threshold)}
    </div>
    ${renderItemsTable(o.items)}
    ${o.items?.length ? `<div class="order-total">Total: ${fmtMoney(total)}</div>` : ''}
    ${issuesHtml}
    ${partialHtml}
    ${actionsHtml}
  </article>`;
}

function showExecution(o) {
  $('execution').hidden = false;
  const badgeEl = $('exec-badge');
  badgeEl.className = `badge ${o.status === 'APPROVED' ? 'approved' : o.status === 'REJECTED' ? 'rejected' : 'pending'}`;
  badgeEl.textContent = `${statusLabel(o.status)} · Risk ${fmtNum(o.score)}/${fmtNum(o.threshold)}`;
  $('item-summary').innerHTML = renderOrderCard(o, o.status === 'PENDING_APPROVAL');
  $('steps').innerHTML = (o.steps || []).map(s => `<li>${esc(s)}</li>`).join('');
  $('raw').textContent = JSON.stringify(o, null, 2);
  notify(`${statusLabel(o.status)} — ${o.reason || 'Order processed'}`);
}

async function refresh() {
  $('buyer-label').textContent = $('user').value;
  const cfg = await api('/config');
  $('threshold').value = cfg.threshold;
  $('source-status').textContent = dataSource === 'real'
    ? `postgres · ${Number(cfg.productCount || 17546).toLocaleString()} items`
    : 'demo · 7 items';

  const orders = await api('/orders?user_id=' + encodeURIComponent($('user').value));
  const pending = orders.filter(o => o.status === 'PENDING_APPROVAL');
  const history = orders.filter(o => o.status !== 'PENDING_APPROVAL');

  $('count').textContent = pending.length;
  $('orders').innerHTML = pending.length
    ? pending.map(o => renderOrderCard(o, true)).join('')
    : '<div class="empty">No orders waiting for human approval.</div>';

  $('history-count').textContent = history.length;
  $('history-orders').innerHTML = history.length
    ? history.slice(0, 15).map(o => renderOrderCard(o, false)).join('')
    : '<div class="empty">No processed orders yet.</div>';
}

async function handleOrderDecision(e) {
  const action = e.target.dataset.action;
  if (!action) return;
  const el = e.target.closest('.order-card');
  if (!el) return;
  await run(async () => {
    const choices = Object.fromEntries(
      [...el.querySelectorAll('select[data-line]')].filter(s => s.value).map(s => [s.dataset.line, s.value])
    );
    const updated = await api(`/orders/${el.dataset.id}/${action}`, {
      user_id: $('user').value,
      choices,
      acceptPartial: el.querySelector('.partial')?.checked || false
    });
    showExecution(updated);
    await refresh();
  });
}

$('orders').onclick = handleOrderDecision;
$('item-summary').onclick = handleOrderDecision;

async function submit() {
  const text = $('prompt').value.trim();
  if (!text) {
    notify('Please enter what you want to order.');
    return;
  }
  $('execution').hidden = false;
  $('exec-badge').className = 'badge pending';
  $('exec-badge').textContent = 'Processing…';
  $('item-summary').innerHTML = '<p class="order-meta">Matching products and checking stock with Gemini…</p>';
  const result = await api('/requests', {
    user_id: $('user').value,
    text,
    force_flag: $('force-flag').checked
  });
  showExecution(result);
  await refresh();
}

$('submit').onclick = () => run(submit);
$('prompt').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run(submit);
  }
});

$('toggle').onclick = () => { $('setup').hidden = !$('setup').hidden; };
$('save').onclick = () => run(async () => {
  await api('/config', { threshold: Number($('threshold').value) });
  notify('Risk threshold updated');
  await refresh();
});
$('reset').onclick = () => run(async () => {
  await api('/config', { threshold: Number($('threshold').value), stock: $('stock').value });
  notify('Inventory reset');
  await refresh();
});
$('refresh').onclick = () => run(refresh);
$('user').onchange = () => run(refresh);

$('source').onchange = () => run(async () => {
  const previous = dataSource;
  dataSource = $('source').value;
  try {
    await api('/config');
  } catch (e) {
    dataSource = previous;
    $('source').value = previous;
    throw e;
  }
  $('catalog-products').hidden = true;
  await refresh();
});

async function searchCatalog() {
  const q = $('catalog-query').value.trim();
  if (!q) {
    $('catalog-products').hidden = true;
    $('catalog-clear-btn').hidden = true;
    return;
  }
  const data = await api(`/catalog-overview?user_id=${encodeURIComponent($('user').value)}&q=${encodeURIComponent(q)}`);
  const products = data.products || [];
  $('catalog-clear-btn').hidden = false;
  $('catalog-products').hidden = false;
  $('catalog-products').innerHTML = products.length
    ? `<table>
        <thead>
          <tr>
            <th>Product</th>
            <th>Unit (lot)</th>
            <th class="num">Stock</th>
            <th class="num">CO₂ kg/kg</th>
            <th class="num">Reliability</th>
          </tr>
        </thead>
        <tbody>
          ${products.slice(0, 8).map(p => `<tr>
            <td><strong>${esc(p.name)}</strong> <small>(${esc(p.id)})</small></td>
            <td>${esc(p.sales_unit)} (${fmtNum(p.allowed_lot_size ?? 1)})</td>
            <td class="num">${fmtNum(p.quantity)} ${esc(p.sales_unit)}</td>
            <td class="num">${fmtNum(p.carbon_kg_co2_per_kg)}</td>
            <td class="num">${p.delivery_reliability == null ? '—' : `${fmtNum(Number(p.delivery_reliability) * 100)}%`}</td>
          </tr>`).join('')}
        </tbody>
      </table>`
    : '<p class="order-meta" style="margin-top:10px">No matching products found.</p>';
}

$('catalog-search-btn').onclick = () => run(searchCatalog);
$('catalog-query').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    run(searchCatalog);
  }
});
$('catalog-clear-btn').onclick = () => {
  $('catalog-query').value = '';
  $('catalog-products').hidden = true;
  $('catalog-clear-btn').hidden = true;
};

run(refresh);
