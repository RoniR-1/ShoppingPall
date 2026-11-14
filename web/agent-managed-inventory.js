const $ = id => document.getElementById(id);
const newGuestId = () => `guest-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
let user = (localStorage.getItem('activeBuyer') || '').trim();
if (!user || user === 'demo-buyer') { user = newGuestId(); localStorage.setItem('activeBuyer', user); }
$('buyer-label').textContent = user;
$('new-session').onclick = async () => {
  if (state?.simulation?.running) {
    try { await request('', { action: 'simulation', running: false }); } catch (error) { setError(error.message); return; }
  }
  localStorage.setItem('activeBuyer', newGuestId()); location.reload();
};
const endpoint = '/portal/agent-managed-inventory';
let state = null;
let inventoryDirty = false;
let busy = false;
let refreshInFlight = false;
let revision = 0;
let chatDraftReady = false;
const connectionError = 'Connection interrupted. Retrying automatically; the server continues the simulation when available.';
function node(tag, text, className) { const element = document.createElement(tag); if (text != null) element.textContent = text; if (className) element.className = className; return element; }
function setError(message = '') { $('error').textContent = message; $('error').hidden = !message; }
async function request(path = '', body) {
  let response;
  try {
    response = await fetch(endpoint + path + (!path && !body ? `?user_id=${encodeURIComponent(user)}` : ''), { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Data-Source': 'demo' }, body: body ? JSON.stringify({ user_id: user, ...body }) : undefined, signal: AbortSignal.timeout(15000) });
  } catch { throw Error(connectionError); }
  let data;
  try { data = await response.json(); } catch { throw Error(connectionError); }
  if (!response.ok) throw Error(data.error || 'Request failed. Please try again.');
  return data;
}
async function refresh() {
  if (refreshInFlight || busy) return;
  refreshInFlight = true;
  const startedAt = revision;
  try { const result = await request(); if (startedAt === revision && !busy) { state = result; setError(); render(); } } catch (error) { if (startedAt === revision && !busy) setError(error.message); } finally { refreshInFlight = false; }
}
async function perform(fn) {
  if (busy) return;
  busy = true;
  revision++;
  document.querySelectorAll('#simulation-toggle, #demand-spike, [data-speed], #governance').forEach(el => { el.disabled = true; });
  try { const result = await fn(); if (result && result.inventory) state = result; else state = await request(); setError(); render(); } catch (error) { setError(error.message); } finally { busy = false; document.querySelectorAll('#simulation-toggle, #demand-spike, [data-speed], #governance').forEach(el => { el.disabled = false; }); }
}
const simulation = changes => perform(() => request('', { action: 'simulation', ...changes }));
$('simulation-toggle').onclick = () => simulation({ running: !state?.simulation?.running });
document.querySelectorAll('[data-speed]').forEach(button => { button.onclick = () => simulation({ speed: button.dataset.speed }); });
$('governance').onchange = event => simulation({ governance: event.target.value });
$('demand-spike').onclick = () => perform(() => request('', { action: 'demand_spike' }));
function render() {
  if (!state) return;
  const sim = state.simulation || {};
  const running = Boolean(sim.running);
  $('agent-status').classList.toggle('active', running);
  $('agent-status').querySelector('span').textContent = running ? 'ACTIVE' : 'PAUSED';
  $('status-caption').textContent = running ? 'Monitoring demand in real time' : 'Simulation is paused';
  $('simulation-toggle').textContent = running ? 'Pause simulation' : 'Start simulation';
  $('simulation-toggle').setAttribute('aria-pressed', String(running));
  document.querySelectorAll('[data-speed]').forEach(button => { const selected = button.dataset.speed === (sim.speed || '1x'); button.classList.toggle('selected', selected); button.setAttribute('aria-pressed', String(selected)); });
  $('governance').value = sim.governance || 'autonomous';
  const metrics = state.metrics || {};
  $('stockouts').textContent = Number(metrics.stockouts_prevented || 0).toLocaleString();
  $('orders-count').textContent = Number(metrics.autonomous_orders || 0).toLocaleString();
  $('spend').textContent = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(Number(metrics.spend_governed || 0));
  renderStock(); renderApprovals(); renderTelemetry(); renderForms(); renderActivity();
}
function renderStock() {
  const rules = state.preview || [];
  $('sku-count').textContent = `${rules.length} MONITORED`;
  if (!rules.length) { $('stock-list').replaceChildren(node('p', 'Start the simulation to monitor inventory.', 'dashboard-empty')); return; }
  const rows = rules.map(rule => {
    const item = (state.inventory || []).find(product => product.id === rule.product_id);
    const onHand = Number(item?.on_hand ?? rule.on_hand ?? 0), target = Number(rule.target) || 1, minimum = Number(rule.minimum) || 0;
    const episode = (state.activity || []).find(activity => activity.id === rule.episode);
    const replenishing = episode && ['SIMULATED_PLACED', 'IN_TRANSIT', 'APPROVED'].includes(episode.status);
    const status = replenishing ? 'Replenishing' : onHand < minimum ? 'Low Stock' : 'Optimal';
    let row = Array.from($('stock-list').children).find(element => element.dataset.productId === String(rule.product_id));
    const oldWidth = row?.querySelector('.gauge-fill')?.style.width;
    row = node('div', null, 'stock-row'); row.dataset.productId = rule.product_id;
    const header = node('div', null, 'stock-row-header');
    const product = node('div'); product.append(node('h3', rule.query), node('p', `${onHand} / ${target} ${item?.unit || rule.sales_unit || 'units'} on hand`));
    header.append(product, node('span', status, `stock-pill ${replenishing ? 'replenishing' : onHand < minimum ? 'low' : 'optimal'}`));
    const gauge = node('div', null, 'stock-gauge'); gauge.setAttribute('role', 'progressbar'); gauge.setAttribute('aria-label', `${rule.query} stock`); gauge.setAttribute('aria-valuemin', '0'); gauge.setAttribute('aria-valuemax', String(target)); gauge.setAttribute('aria-valuenow', String(Math.min(onHand, target)));
    const fill = node('div', null, `gauge-fill ${replenishing ? 'replenishing' : onHand < minimum ? 'low' : ''}`); const width = `${Math.max(0, Math.min(100, onHand / target * 100))}%`; fill.style.width = oldWidth || width; if (oldWidth && oldWidth !== width) requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = width; }));
    const marker = node('i', null, 'gauge-marker'); marker.style.left = `${Math.max(0, Math.min(100, minimum / target * 100))}%`; marker.title = `Minimum ${minimum}`; gauge.append(fill, marker);
    const labels = node('div', null, 'gauge-labels'); labels.append(node('span', '0'), node('span', `MIN ${minimum}`), node('span', `TARGET ${target}`)); row.append(header, gauge, labels); return row;
  });
  $('stock-list').replaceChildren(...rows);
}
function renderApprovals() {
  const pending = (state.orders || []).filter(order => order.context?.agent?.type === 'managed' && order.status === 'PENDING_APPROVAL');
  $('approval-count').textContent = `${pending.length} PENDING`;
  if (!pending.length) { $('approvals').replaceChildren(node('p', 'No orders awaiting approval. Your agent will surface decisions here.', 'dashboard-empty')); return; }
  $('approvals').replaceChildren(...pending.map(order => {
    const card = node('article', null, 'approval-card');
    const heading = node('div', null, 'approval-heading'); heading.append(node('strong', order.items?.map(item => `${item.quantity} ${item.name}`).join(', ') || 'Purchase order'), node('span', 'REVIEW REQUIRED', 'approval-tag'));
    card.append(heading, node('p', order.reason || 'This order requires your approval.'));
    const cap = order.context?.constraints;
    const total = Number(order.total);
    const value = Number.isFinite(total) ? new Intl.NumberFormat('en-IE', { style: 'currency', currency: order.items?.[0]?.currency || 'EUR' }).format(total) : 'Unavailable';
    const policy = cap?.max_price != null ? `${cap.currency || 'EUR'} ${cap.max_price} per ${cap.price_quantity || 1} ${cap.price_unit || cap.sales_unit || 'unit'}` : 'No cap configured';
    card.append(node('p', `Order value: ${value} · Price cap: ${policy}`, 'approval-policy'));
    if (order.incomplete) card.append(node('p', 'Resolve missing items in the procurement portal.'));
    else { const actions = node('div', null, 'form-actions'); for (const action of ['approve', 'reject']) { const button = node('button', action === 'approve' ? 'Approve' : 'Reject', `dashboard-button ${action === 'approve' ? 'primary' : 'outline'}`); button.type = 'button'; button.onclick = () => perform(async () => { let response; try { response = await fetch(`/portal/orders/${encodeURIComponent(order.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Data-Source': 'demo' }, body: JSON.stringify({ user_id: user }), signal: AbortSignal.timeout(15000) }); } catch { throw Error(connectionError); } const result = await response.json(); if (!response.ok) throw Error(result.error || 'Decision failed'); await request('', { action: 'check' }); }); actions.append(button); } card.append(actions); }
    return card;
  }));
}
function renderTelemetry() {
  const entries = (state.telemetry || []).slice(-80).reverse();
  if (!entries.length) { $('telemetry').replaceChildren(node('p', 'Awaiting agent activity...', 'telemetry-empty')); return; }
  $('telemetry').replaceChildren(...entries.map(entry => { const row = node('div', null, 'telemetry-row'); const date = new Date(entry.at); row.append(node('time', Number.isNaN(date.getTime()) ? '--:--:--' : date.toLocaleTimeString('en-GB', { hour12: false }), 'telemetry-time'), node('span', `[${entry.category || 'AGENT'}]`, `telemetry-category category-${String(entry.category || '').toLowerCase()}`), node('span', entry.message || '')); return row; }));
}
function replaceOptions(select, values, getValue, getLabel) {
  if (document.activeElement === select) return;
  const selected = select.value;
  select.replaceChildren(...values.map(value => { const option = node('option', getLabel(value)); option.value = getValue(value); return option; }));
  if (values.some(value => getValue(value) === selected)) select.value = selected;
}
function syncQuantity() {
  const item = (state?.inventory || []).find(product => product.name === $('rule').elements.query.value);
  const fields = $('rule').elements; fields.on_hand.value = item?.on_hand ?? 0;
  const previous = fields.price_unit.value;
  const units = item ? [...new Set([item.unit, item.baseUnit, 'KGM', 'GRM', 'LTR', 'MLT', ...(item.units || []).filter(unit => unit.sizeInBaseUnits > 0).map(unit => unit.unitId)].filter(Boolean))] : [];
  replaceOptions(fields.price_unit, units, unit => unit, unit => ({ KGM: 'kg — kilogram', GRM: 'g — gram', LTR: 'L — litre', MLT: 'mL — millilitre', ST: 'ST — sales unit' })[unit] || unit);
  fields.price_unit.value = units.includes(previous) ? previous : item?.unit || '';
  $('rule-units').textContent = item ? `Stock unit: ${item.unit}. Base unit: ${item.baseUnit || item.unit}. Order step: ${item.allowedLotSize || 1} ${item.unit}.` : '';
}
function showInventory() { const item = (state?.inventory || []).find(product => product.id === $('inventory-product').value); $('inventory-current').textContent = item ? `Current quantity: ${item.on_hand} ${item.unit}` : 'No products available'; if (!inventoryDirty) $('inventory-amount').value = item?.on_hand ?? ''; $('inventory-edit').disabled = !item; }
function renderForms() {
  const products = state.inventory || [];
  replaceOptions($('rule').elements.query, products, item => item.name, item => item.name);
  if (!$('rule').contains(document.activeElement)) syncQuantity();
  replaceOptions($('inventory-product'), products, item => item.id, item => item.name); showInventory();
}
$('rule').elements.query.onchange = syncQuantity;
$('rule').onsubmit = event => { event.preventDefault(); const rule = Object.fromEntries(new FormData(event.currentTarget)); for (const key of ['minimum', 'target', 'on_hand', 'price_quantity']) rule[key] = Number(rule[key]); rule.max_price = rule.max_price === '' ? null : Number(rule.max_price); perform(async () => { const result = await request('', { action: 'rule', rule }); $('rule-draft').textContent = 'Rule saved.'; return result; }); };
$('inventory-product').onchange = () => { inventoryDirty = false; $('inventory-status').textContent = ''; showInventory(); };
$('inventory-amount').oninput = () => { inventoryDirty = true; };
$('inventory').onsubmit = event => { event.preventDefault(); const item = (state?.inventory || []).find(product => product.id === $('inventory-product').value); if (!item) return; perform(async () => { const result = await request('', { action: 'snapshot', id: item.id, on_hand: Number($('inventory-amount').value) }); inventoryDirty = false; $('inventory-status').textContent = `${item.name} quantity saved.`; return result; }); };
$('inventory-edit').onclick = () => { const item = (state?.inventory || []).find(product => product.id === $('inventory-product').value); if (!item) return; const rule = (state.preview || []).find(entry => entry.product_id === item.id); $('rule-details').open = true; $('rule').elements.query.value = item.name; syncQuantity(); for (const [key, value] of Object.entries({ minimum: rule?.minimum ?? 10, target: rule?.target ?? 20, max_price: rule?.max_price ?? '', price_quantity: rule?.price_quantity ?? 1, currency: rule?.currency || 'EUR', price_unit: rule?.price_unit || item.unit })) $('rule').elements[key].value = value; $('rule').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('rule').elements.minimum.focus({ preventScroll: true }); };
function renderActivity() {
  const records = (state.activity || []).filter(entry => ['RECONCILING', 'DENIED', 'REJECTED'].includes(entry.status));
  if (!records.length) { $('activity').replaceChildren(node('p', 'No decisions require reconciliation.', 'dashboard-empty')); return; }
  $('activity').replaceChildren(...records.map(entry => { const details = node('details', null, 'audit-record'); details.append(node('summary', `${entry.status} · ${entry.message || entry.context?.why?.trigger || ''}`), node('pre', JSON.stringify(entry, null, 2))); if (entry.status === 'RECONCILING') { details.append(node('p', 'Inspect supplier and portal orders before resolving this dispatch.')); for (const [label, resolution] of [['Confirm no order was placed', 'no_order'], ['Attach matching order', 'attach_order']]) { const button = node('button', label, 'dashboard-button outline'); button.type = 'button'; button.onclick = () => { if (confirm('Have you inspected and verified the order outcome?')) perform(() => request('', { action: 'resolve', id: entry.id, resolution })); }; details.append(button); } } else if (!entry.resolved_at) { const button = node('button', 'Reset episode', 'dashboard-button outline'); button.type = 'button'; button.onclick = () => { if (confirm('Allow a future check to create a new proposal?')) perform(() => request('', { action: 'reset_episode', id: entry.id })); }; details.append(button); } return details; }));
}
$('open-agent-chat').onclick = () => { $('agent-chat').showModal(); $('chat').elements.text.focus(); };
$('close-agent-chat').onclick = () => $('agent-chat').close();
$('agent-chat').addEventListener('close', () => { if (chatDraftReady) { chatDraftReady = false; $('rule-details').open = true; $('rule').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('rule').elements.minimum.focus({ preventScroll: true }); } });
$('chat').onsubmit = async event => { event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true; $('reply').textContent = 'Preparing your rule…'; try { const result = await request('/chat', { text: new FormData(form).get('text') }); $('reply').textContent = result.message; if (result.proposal) { $('rule').elements.query.value = result.proposal.query; syncQuantity(); for (const [key, value] of Object.entries(result.proposal)) { const field = $('rule').elements.namedItem(key); if (field) field.value = value ?? ''; } $('rule-draft').textContent = 'Draft filled from your instruction. Edit and save to apply.'; chatDraftReady = true; } } catch (error) { $('reply').textContent = error.message; } finally { button.disabled = false; } };
refresh();
setInterval(refresh, 2000);
