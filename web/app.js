const $ = id => document.getElementById(id);
let dataSource = 'real';
const plainMode = false;
localStorage.removeItem('plainMode');
const newGuestId = () => `guest-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
let activeBuyer = (localStorage.getItem('activeBuyer') || '').trim();
if (!activeBuyer || activeBuyer === 'demo-buyer') {
  activeBuyer = newGuestId();
  localStorage.setItem('activeBuyer', activeBuyer);
}
$('new-session').onclick = () => {
  localStorage.setItem('activeBuyer', newGuestId());
  location.reload();
};
$('buyer-label').textContent = activeBuyer;
let settingsOpen = false;
let lastExecOrder = null;
let lastOrders = [];
const acceptedQuestionsByOrder = new Map();
let promptScenarios = [];
let guidedScenario = null;
let guidedIndex = -1;
let guidedOrderId = null;
let guidedOrderStatus = null;

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

function showInputError(msg) {
  $('input-error-text').textContent = msg;
  $('input-error').hidden = false;
}

function clearInputError() {
  $('input-error-text').textContent = '';
  $('input-error').hidden = true;
}

function showSettingsFeedback(msg, kind = 'ok') {
  const box = $('settings-feedback');
  box.className = `settings-feedback ${kind}`;
  $('settings-feedback-text').textContent = msg;
  box.hidden = false;
}

function clearSettingsFeedback() {
  $('settings-feedback-text').textContent = '';
  $('settings-feedback').hidden = true;
}

$('input-error-close').onclick = clearInputError;
$('settings-feedback-close').onclick = clearSettingsFeedback;

async function api(path, body) {
  const r = await fetch('/portal' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Data-Source': dataSource },
    body: body ? JSON.stringify(body) : undefined
  });
  const raw = await r.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { error: raw.slice(0, 300) || r.statusText || 'Request failed' };
  }
  if (!r.ok) throw Error(data.error || 'Request failed');
  return data;
}

function resetExecutionView() {
  lastExecOrder = null;
  $('execution').hidden = true;
  clearInputError();
}

async function run(fn) {
  document.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    await fn();
  } catch (e) {
    if (settingsOpen) {
      showSettingsFeedback(e.message, 'err');
    } else {
      if (!$('execution').hidden) {
        if ($('exec-badge').textContent === 'Processing…') {
          $('exec-badge').className = 'badge rejected';
          $('exec-badge').textContent = 'Error';
          $('item-summary').innerHTML = `<p class="order-meta">${esc(e.message)}</p>`;
        }
        $('steps').innerHTML = `<li>Stopped: ${esc(e.message)}</li>`;
      }
      showInputError(e.message);
    }
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

function renderItemsTable(items, interactive = false) {
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
        ${interactive ? '<th class="num">Item</th>' : ''}
      </tr>
    </thead>
    <tbody>
      ${items.map((i, idx) => {
        const lineTotal = i.lineTotal ?? (Number(i.quantity) * Number(i.price));
        const fav = i.human_approved_count ? ` · ${i.human_approved_count}× approved` : (i.bought_count ? ` · ${i.bought_count}× bought` : '');
        const lineIdx = i.lineIndex ?? idx;
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
          ${interactive ? `<td class="num"><button type="button" class="ghost-btn small-btn" data-action="remove-line" data-line="${lineIdx}" title="Remove this item from the order">Remove</button></td>` : ''}
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function getAcceptedQuestions(orderId) {
  if (!acceptedQuestionsByOrder.has(orderId)) {
    acceptedQuestionsByOrder.set(orderId, new Set());
  }
  return acceptedQuestionsByOrder.get(orderId);
}

function renderQuestionsHtml(o, interactive = true) {
  if (!interactive || o.status !== 'PENDING_APPROVAL' || !o.questions?.length) return '';
  const accepted = getAcceptedQuestions(o.id);
  const totalQ = o.questions.length;
  const currentIdx = o.questions.findIndex(q => !accepted.has(q.id));

  if (currentIdx === -1) {
    return `<div class="question-box accepted">
      <div class="question-row">
        <div class="question-text">
          <strong>✓ All ${totalQ} check${totalQ === 1 ? '' : 's'} reviewed.</strong> ${o.incomplete ? 'Resolve the availability issue below to approve.' : 'Ready to approve.'}
        </div>
        <div class="question-btns">
          <button type="button" class="ghost-btn small-btn" data-q-reset="${esc(o.id)}">Review again</button>
        </div>
      </div>
    </div>`;
  }

  const q = o.questions[currentIdx];
  const alts = q.alternatives || [];
  const lineIdx = q.lineIndex ?? 0;
  const canEditQty = q.allowQuantityEdit !== false && q.productId != null;
  const canSubstitute = q.allowSubstitution !== false && alts.length > 0;
  const stepTag = totalQ > 1 ? `<span class="question-step">Question ${currentIdx + 1} of ${totalQ}</span> ` : '';
  const noBtnLabel = !q.allowSubstitution
    ? 'No, adjust amount'
    : 'No, change this';

  return `<div class="question-box" data-qid="${esc(q.id)}">
    <div class="question-row">
      <div class="question-text">
        ${stepTag}<strong>+${fmtNum(q.points)} pts:</strong> ${esc(q.message)}
      </div>
      <div class="question-btns">
        <button type="button" class="primary-btn small-btn" data-q-decide="yes">Yes, looks good</button>
        <button type="button" class="ghost-btn small-btn" data-q-decide="no">${noBtnLabel}</button>
      </div>
    </div>
    <div class="question-sub-panel" hidden>
      ${canEditQty ? `
        <div class="qty-edit-row">
          <label>
            <span>Set quantity for <strong>${esc(q.productName || 'this item')}</strong> (${esc(q.unit || 'unit')}, step ${fmtNum(q.lot || 1)}):</span>
            <input type="number" class="qty-edit-input" data-qty-line="${lineIdx}" min="${q.lot || 1}" step="${q.lot || 1}" value="${q.suggestedQty ?? q.currentQty ?? 1}">
          </label>
          <button type="button" class="primary-btn small-btn" data-action="update-qty" data-line="${lineIdx}">Update quantity</button>
        </div>
      ` : ''}
      ${canSubstitute ? `
        <label>Or pick a substitute for <strong>${esc(q.productName || 'this item')}</strong>:
          <select data-line="${lineIdx}">
            <option value="">Choose a substitute item…</option>
            ${alts.map(p => `<option value="${esc(p.productId)}">${esc(p.name)} (${esc(p.unit)}) · ${fmtMoney(p.price)} · CO₂ ${fmtNum(p.carbon)} · ${fmtNum(p.available)} in stock</option>`).join('')}
          </select>
        </label>
      ` : ''}
      <div class="sub-actions">
        ${canSubstitute ? `
          <button type="button" class="primary-btn small-btn" data-action="approve">Quote substitute for review</button>
          <button type="button" class="ghost-btn small-btn" data-action="substitute">Swap &amp; re-evaluate</button>
        ` : ''}
        ${q.productId != null ? `
          <button type="button" class="ghost-btn small-btn" data-action="remove-line" data-line="${lineIdx}">Don't include ${esc(q.productName || 'this item')}</button>
        ` : ''}
        <button type="button" class="ghost-btn small-btn" data-action="reject">Cancel entire order</button>
      </div>
    </div>
  </div>`;
}

function renderPlainCard(o, interactive = true) {
  const total = o.total ?? o.items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.price || 0), 0);
  const itemsText = o.items?.length
    ? o.items.map((i, idx) => `#${esc(i.productId)} × ${fmtNum(i.quantity)} ${esc(i.unit)} (${fmtMoney(i.lineTotal ?? Number(i.quantity) * Number(i.price))})${interactive && o.status === 'PENDING_APPROVAL' ? ` <button type="button" data-action="remove-line" data-line="${i.lineIndex ?? idx}">drop</button>` : ''}`).join(', ')
    : 'none';
  let questionsHtml = '';
  if (interactive && o.status === 'PENDING_APPROVAL' && o.questions?.length) {
    const accepted = getAcceptedQuestions(o.id);
    const currentIdx = o.questions.findIndex(q => !accepted.has(q.id));
    if (currentIdx !== -1) {
      const q = o.questions[currentIdx];
      const lineIdx = q.lineIndex ?? 0;
      const canEditQty = q.allowQuantityEdit !== false && q.productId != null;
      const canSubstitute = q.allowSubstitution !== false && q.alternatives?.length > 0;
      questionsHtml = `
        <div class="question-box" data-qid="${esc(q.id)}">
          <div>[${currentIdx + 1}/${o.questions.length}] +${fmtNum(q.points)}: ${esc(q.message)} <button type="button" data-q-decide="yes">yes</button> <button type="button" data-q-decide="no">no</button></div>
          <div class="question-sub-panel" hidden>
            ${canEditQty ? `<input type="number" data-qty-line="${lineIdx}" min="${q.lot || 1}" step="${q.lot || 1}" value="${q.suggestedQty ?? q.currentQty ?? 1}"> <button type="button" data-action="update-qty" data-line="${lineIdx}">qty</button> ` : ''}
            ${canSubstitute ? `<select data-line="${lineIdx}">
              <option value="">sub…</option>
              ${q.alternatives.map(p => `<option value="${esc(p.productId)}">#${esc(p.productId)} (${esc(p.unit)}) ${fmtMoney(p.price)} [${fmtNum(p.available)}]</option>`).join('')}
            </select> <button type="button" data-action="approve">quote for review</button> <button type="button" data-action="substitute">swap</button> ` : ''}
            ${q.productId != null ? `<button type="button" data-action="remove-line" data-line="${lineIdx}">drop item</button> ` : ''}
            <button type="button" data-action="reject">cancel</button>
          </div>
        </div>`;
    }
  }
  const issuesHtml = (o.issues || []).map(i => `
    <div>
      <span>${esc(i.reason)} (-${fmtNum(i.shortfall)})</span>
      ${interactive && i.options?.length ? `<select data-line="${i.index}">
        <option value="">alt…</option>
        ${i.options.slice(0, 8).map(p => `<option value="${esc(p.productId)}">#${esc(p.productId)} (${esc(p.unit)}) ${fmtMoney(p.price)} [${fmtNum(p.available)}]</option>`).join('')}
      </select>` : ''}
    </div>
  `).join('');
  const partialHtml = interactive && o.incomplete && o.items?.length
    ? `<label><input type="checkbox" class="partial"> partial</label>`
    : '';
  const actionsHtml = interactive && o.status === 'PENDING_APPROVAL'
    ? ` <button data-action="approve" type="button">${o.incomplete ? 'apply' : 'ok'}</button> <button data-action="reject" type="button">cancel</button>`
    : '';
  const state = o.status === 'APPROVED' ? 'ok' : o.status === 'REJECTED' ? 'no' : 'hold';
  return `<div class="order-card" data-id="${esc(o.id)}">
    <div><code>${state} ${fmtNum(o.score)}/${fmtNum(o.threshold)}</code> | ${itemsText} | ${fmtMoney(total)}${actionsHtml}</div>
    ${questionsHtml}
    ${issuesHtml}
    ${partialHtml}
  </div>`;
}

function renderOrderCard(o, interactive = true) {
  if (plainMode) return renderPlainCard(o, interactive);
  const total = o.total ?? o.items.reduce((sum, i) => sum + Number(i.quantity) * Number(i.price || 0), 0);
  const title = o.lines?.map(l => l.requested || `${fmtNum(l.quantity)} × ${l.query}`).join(', ') || o.id;
  const questionsHtml = renderQuestionsHtml(o, interactive);
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
    ? (o.incomplete
      ? `<div class="actions">
          <button class="primary-btn small-btn" data-action="approve" type="button">Apply selection &amp; approve</button>
          <button class="link-btn" data-action="reject" type="button">Discard order</button>
        </div>`
      : `<div class="order-override-actions">
          <span class="override-label">Or decide without review:</span>
          <button class="link-btn" data-action="approve" type="button">Approve as-is</button>
          <button class="link-btn danger" data-action="reject" type="button">Discard order</button>
        </div>`)
    : '';

  const isInspected = lastExecOrder?.id === o.id;
  return `<article class="order-card${isInspected ? ' is-inspected' : ''}" data-id="${esc(o.id)}">
    <div class="order-head">
      <div>
        <h3>${esc(title)}</h3>
        <div class="order-meta">${esc(o.reason || '')}</div>
      </div>
      <div class="order-head-right">
        <button type="button" class="link-btn inspect-btn" data-inspect-order="${esc(o.id)}">${isInspected ? '● Trace shown' : 'Inspect trace'}</button>
        ${statusBadge(o.status, o.score, o.threshold)}
      </div>
    </div>
    ${renderItemsTable(o.items, interactive && o.status === 'PENDING_APPROVAL')}
    ${o.items?.length ? `<div class="order-total">Total: ${fmtMoney(total)}</div>` : ''}
    ${questionsHtml}
    ${issuesHtml}
    ${partialHtml}
    ${actionsHtml}
  </article>`;
}

function selectionReasonText(mode) {
  if (mode === 'human-substitution') return 'selected as your requested substitute';
  if (mode === 'human-pinned') return 'kept from your current selection during order edit';
  if (mode === 'gemini-selection') return 'selected by Gemini for best unit/packaging fit and catalog rank';
  if (mode === 'fallback-suggestions') return 'selected from closest catalog suggestions (no exact keyword match)';
  if (mode === 'no-match') return 'no catalog match found';
  if (mode === 'origin-blocked') return 'none from the required country of origin; sent for human review';
  return 'ranked #1 on keyword relevance, allergen safety, buyer history, stock, and supplier reliability';
}

function renderTraceNarrative(o) {
  const total = o.total ?? (o.items || []).reduce((sum, i) => sum + Number(i.quantity) * Number(i.price || 0), 0);
  const title = o.raw_prompt || o.lines?.map(l => l.requested || `${fmtNum(l.quantity)} × ${l.query}`).join(', ') || o.id;
  const modelTag = o.parser_model || 'gemini-2.5-flash';
  const lineCount = (o.lines || []).length;

  const lineTraces = o.line_traces?.length
    ? o.line_traces
    : (o.lines || []).map((l, idx) => {
        const matchedItems = (o.items || []).filter(i => (i.lineIndex ?? 0) === idx);
        const first = matchedItems[0];
        const topCandidates = first
          ? [first, ...(first.alternatives || []).slice(0, 2)]
          : [];
        return {
          lineIndex: idx,
          requested: l.requested || `${fmtNum(l.quantity)} × ${l.query}`,
          query: l.query,
          alternatives: l.alternatives || [],
          matchedQuery: l.query,
          totalCandidates: topCandidates.length,
          selectionMode: first?.substitution ? 'human-substitution' : 'top-ranked',
          selectedProductId: first?.productId || null,
          selectedName: first?.name || null,
          selectedQty: first?.quantity ?? l.quantity,
          selectedUnit: first?.unit || null,
          topCandidates
        };
      });

  const linesProse = lineTraces.map(lt => {
    const altsText = lt.alternatives?.length ? ` (tried: <code>${esc(lt.alternatives.slice(0, 3).join(', '))}</code>)` : '';
    if (!lt.topCandidates?.length) {
      return `<li><strong>"${esc(lt.requested)}"</strong> → <code>${esc(lt.query)}</code>${altsText}: <strong>0 available matches</strong>.</li>`;
    }
    const candList = lt.topCandidates.slice(0, 3).map((c, idx) => {
      const isWinner = lt.selectionMode !== 'origin-blocked' && (c.productId === lt.selectedProductId || idx === 0);
      const origin = c.country_of_origin ? `, ${esc(String(c.country_of_origin).toUpperCase())}` : '';
      const rel = c.reliability != null ? `, ${fmtNum(Number(c.reliability) * 100)}% rel` : '';
      const co2 = c.carbon != null ? `, ${fmtNum(c.carbon)} CO₂` : '';
      const hist = Number(c.bought_count || 0) > 0 ? `, ${c.bought_count}× prior` : ', new';
      const safety = c.allergen_safe === false ? ', ⚠ allergen' : '';
      return `<span class="trace-cand${isWinner ? ' is-winner' : ''}">${idx + 1}) <strong>${esc(c.name)}</strong> <small>(${fmtMoney(c.price)}/${esc(c.unit)}, ${fmtNum(c.available)} avail${origin}${rel}${co2}${hist}${safety})</small>${isWinner ? ` ✓ <em>${fmtNum(lt.selectedQty)} ${esc(lt.selectedUnit || c.unit)}</em>` : ''}</span>`;
    }).join(' · ');
    const totalMatches = lt.totalCandidates || lt.topCandidates.length;
    return `<li><strong>"${esc(lt.requested)}"</strong> → <code>${esc(lt.matchedQuery || lt.query)}</code>${altsText} (${totalMatches} match${totalMatches === 1 ? '' : 'es'}): ${candList}. ${lt.selectionMode === 'origin-blocked' ? `Nothing picked (${selectionReasonText(lt.selectionMode)})` : `Picked <strong>${esc(lt.selectedName || lt.topCandidates[0]?.name)}</strong> (${selectionReasonText(lt.selectionMode)})`}.</li>`;
  }).join('');

  const checks = o.checks?.length
    ? o.checks
    : [
        ...(o.questions || []).map(q => ({ status: 'flag', points: q.points, text: q.message })),
        ...(o.score <= (o.threshold ?? 25) ? [{ status: 'pass', points: 0, text: 'Order matches routine buyer pattern and spend baseline.' }] : [])
      ];

  const checksHtml = checks.map(c => {
    const icon = c.status === 'flag' ? '⚠' : '✓';
    const cls = c.status === 'flag' ? 'trace-check flag' : 'trace-check pass';
    return `<li class="${cls}"><span>${icon}</span> <span>${esc(c.text)}</span></li>`;
  }).join('');

  const spendCap = o.buyer_baseline?.spendCap ?? 200;
  let decisionProse = '';
  if (o.status === 'PENDING_APPROVAL') {
    decisionProse = `Because the combined risk score is <strong>${fmtNum(o.score)} pts</strong> (above <strong>${esc(o.user_id || activeBuyer)}</strong>'s threshold of <strong>${fmtNum(o.threshold)} pts</strong>), I held the order in <strong>02 · Approval queue</strong> for your confirmation${o.questions?.length ? ` (${o.questions.length} question${o.questions.length === 1 ? '' : 's'} to review)` : ''}.`;
  } else if (o.status === 'APPROVED') {
    decisionProse = o.human_approved
      ? `Following human review, <strong>${esc(o.user_id || activeBuyer)}</strong> approved this order (<strong>${fmtMoney(total)}</strong>, risk score <strong>${fmtNum(o.score)}/${fmtNum(o.threshold)}</strong>) and stock was deducted.`
      : `Because the risk score (<strong>${fmtNum(o.score)} pts</strong>) is within <strong>${esc(o.user_id || activeBuyer)}</strong>'s <strong>${fmtNum(o.threshold)} pt</strong> threshold and no blocking issues were found, I <strong>auto-approved</strong> the order immediately.`;
  } else {
    decisionProse = `This order (<strong>${fmtMoney(total)}</strong>, risk score <strong>${fmtNum(o.score)}/${fmtNum(o.threshold)}</strong>) was <strong>cancelled / rejected</strong> and no stock was deducted.`;
  }

  const editActions = (o.audit_trail || []).filter(
    a => a.actor && a.actor !== 'gatekeeper' && a.text && !/^(approved|rejected|cancelled)\b/i.test(a.text.trim())
  );
  const formatActionTime = iso => {
    if (!iso) return 'now';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? esc(iso.slice(11, 16)) : esc(d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  };
  const auditHtml = editActions.length
    ? `<div class="trace-audit"><strong>Edits applied:</strong> ${editActions.map(a => `<span class="trace-audit-item"><code>${formatActionTime(a.at)}</code> ${esc(a.text)}</span>`).join(' → ')}</div>`
    : '';

  return `<div class="llm-trace-report">
    <p>Parsed <strong>"${esc(title)}"</strong> for <strong>${esc(o.user_id || activeBuyer)}</strong> via <code>${esc(modelTag)}</code> into ${lineCount} line${lineCount === 1 ? '' : 's'} (${fmtMoney(total)}):</p>
    <ul class="trace-prose-list">${linesProse}</ul>
    <p>Policy checks (threshold <strong>${fmtNum(o.threshold)} pts</strong>, cap <strong>${fmtMoney(spendCap)}</strong>):</p>
    <ul class="trace-checks-list">${checksHtml}</ul>
    <p class="trace-conclusion">${decisionProse}</p>
    ${auditHtml}
  </div>`;
}

function showExecution(o) {
  lastExecOrder = o;
  if (plainMode && o.status === 'PENDING_APPROVAL') {
    $('execution').hidden = true;
    return;
  }
  $('execution').hidden = false;
  const badgeEl = $('exec-badge');
  badgeEl.className = `badge ${o.status === 'APPROVED' ? 'approved' : o.status === 'REJECTED' ? 'rejected' : 'pending'}`;
  badgeEl.textContent = `${statusLabel(o.status)} · Risk ${fmtNum(o.score)}/${fmtNum(o.threshold)}`;
  $('item-summary').innerHTML = plainMode ? renderOrderCard(o, false) : renderTraceNarrative(o);
  $('steps').innerHTML = (o.steps || []).map(s => `<li>${esc(s)}</li>`).join('');
  $('raw').textContent = JSON.stringify(o, null, 2);
}

function renderOrders(orders) {
  lastOrders = orders;
  const visibleOrders = orders.filter(o => !o.superseded_by);
  const pending = visibleOrders.filter(o => o.status === 'PENDING_APPROVAL');
  const history = visibleOrders.filter(o => o.status !== 'PENDING_APPROVAL');

  if (lastExecOrder) {
    const updatedActive = orders.find(o => o.id === lastExecOrder.id);
    if (updatedActive) showExecution(updatedActive);
  } else if (visibleOrders.length && !plainMode) {
    showExecution(visibleOrders[0]);
  }

  $('count').textContent = pending.length;
  $('orders').innerHTML = pending.length
    ? pending.map(o => renderOrderCard(o, true)).join('')
    : (plainMode ? '' : '<div class="empty">No orders waiting for human approval.</div>');

  $('history-count').textContent = history.length;
  $('history-orders').innerHTML = history.length
    ? history.slice(0, 15).map(o => renderOrderCard(o, false)).join('')
    : '<div class="empty">No processed orders yet.</div>';
}

function setSettingsView(open) {
  settingsOpen = plainMode ? false : Boolean(open);
  $('setup').hidden = !settingsOpen;
  $('workspace').hidden = settingsOpen;
  $('toggle').classList.toggle('is-active', settingsOpen);
  $('toggle').textContent = settingsOpen ? 'Close settings' : 'Settings';
  if (!settingsOpen) clearSettingsFeedback();
}

function renderBuyers(buyers) {
  const list = buyers.some(b => b.user_id === activeBuyer)
    ? buyers
    : [...buyers, { user_id: activeBuyer, threshold: Number($('threshold').value) || 25 }];

  $('user').innerHTML = list
    .map(b => `<option value="${esc(b.user_id)}">${esc(b.user_id)} (threshold ${fmtNum(b.threshold)})</option>`)
    .join('');
  $('user').value = activeBuyer;

  $('buyers-table').innerHTML = list.map(b => {
    const isActive = b.user_id === activeBuyer;
    return `
      <tr class="${isActive ? 'active-row' : ''}">
        <td>${esc(b.user_id)}${isActive ? '<span class="active-pill">active</span>' : ''}</td>
        <td class="num">${fmtNum(b.threshold)}</td>
        <td class="num">
          ${isActive
            ? '<span class="order-meta">Selected</span>'
            : `<button type="button" class="ghost-btn small-btn" data-select-buyer="${esc(b.user_id)}">Select</button>`}
        </td>
      </tr>`;
  }).join('');
}

function applyPlainMode() {
  $('theme-css').disabled = false;
  document.title = 'shopping pal';
  setSettingsView(false);
}

async function refresh() {
  localStorage.setItem('activeBuyer', activeBuyer);
  $('buyer-label').textContent = activeBuyer;
  const cfg = await api('/config?user_id=' + encodeURIComponent(activeBuyer));
  $('threshold').value = cfg.threshold;
  $('source-status').textContent = dataSource === 'real'
    ? `postgres · ${Number(cfg.productCount || 17546).toLocaleString()} items`
    : 'demo · 7 items';

  const [buyerData, orders] = await Promise.all([
    api('/buyers'),
    api('/orders?user_id=' + encodeURIComponent(activeBuyer))
  ]);
  renderBuyers(buyerData.buyers || []);
  renderOrders(orders);
}

async function handleOrderDecision(e) {
  const inspectBtn = e.target.closest('button[data-inspect-order]');
  if (inspectBtn) {
    const targetOrder = lastOrders.find(o => o.id === inspectBtn.dataset.inspectOrder);
    if (targetOrder) {
      showExecution(targetOrder);
      renderOrders(lastOrders);
    }
    return;
  }

  const resetBtn = e.target.closest('button[data-q-reset]');
  if (resetBtn) {
    acceptedQuestionsByOrder.delete(resetBtn.dataset.qReset);
    renderOrders(lastOrders);
    return;
  }

  const qBtn = e.target.closest('button[data-q-decide]');
  if (qBtn) {
    const qBox = qBtn.closest('.question-box');
    const card = qBtn.closest('.order-card');
    const decide = qBtn.dataset.qDecide;
    if (decide === 'yes' && card && qBox?.dataset.qid) {
      const orderId = card.dataset.id;
      const accepted = getAcceptedQuestions(orderId);
      accepted.add(qBox.dataset.qid);
      const orderObj = lastOrders.find(x => x.id === orderId);
      const allAnsweredYes = orderObj && (orderObj.questions || []).every(q => accepted.has(q.id));
      if (allAnsweredYes && !orderObj.incomplete) {
        await run(async () => {
          clearInputError();
          const approved = await api(`/orders/${orderId}/approve`, {
            user_id: activeBuyer,
            choices: {},
            acceptPartial: false
          });
          acceptedQuestionsByOrder.delete(orderId);
          showExecution(approved);
          if (guidedScenario && guidedOrderId === orderId) guidedOrderId = approved.id;
          updateGuidedProgress(approved);
          await refresh();
        });
        return;
      }
      renderOrders(lastOrders);
      return;
    }
    const subPanel = qBox?.querySelector('.question-sub-panel');
    qBox.querySelectorAll('button[data-q-decide]').forEach(b => b.classList.toggle('active', b === qBtn));
    qBox.classList.toggle('declined', decide === 'no');
    if (subPanel) {
      subPanel.hidden = decide !== 'no';
    }
    return;
  }

  const actionBtn = e.target.closest('button[data-action]');
  if (!actionBtn) return;
  const action = actionBtn.dataset.action;
  const el = actionBtn.closest('.order-card');
  if (!el) return;

  if (action === 'remove-line') {
    const lineIndex = Number(actionBtn.dataset.line ?? 0);
    await run(async () => {
      clearInputError();
      const updated = await api(`/orders/${el.dataset.id}/substitute`, {
        user_id: activeBuyer,
        removeLines: [lineIndex]
      });
      showExecution(updated);
      if (guidedScenario && guidedOrderId === el.dataset.id) guidedOrderId = updated.id;
      updateGuidedProgress(updated);
      await refresh();
    });
    return;
  }

  if (action === 'update-qty') {
    const lineIndex = Number(actionBtn.dataset.line ?? 0);
    const insideSubPanel = actionBtn.closest('.question-sub-panel') || el;
    const qtyInput = insideSubPanel.querySelector(`input[data-qty-line="${lineIndex}"]`);
    const newQty = Number(qtyInput?.value);
    if (!Number.isFinite(newQty) || newQty <= 0) {
      showInputError('Enter a valid quantity greater than 0.');
      return;
    }
    await run(async () => {
      clearInputError();
      const updated = await api(`/orders/${el.dataset.id}/substitute`, {
        user_id: activeBuyer,
        quantities: { [lineIndex]: newQty }
      });
      showExecution(updated);
      if (guidedScenario && guidedOrderId === el.dataset.id) guidedOrderId = updated.id;
      updateGuidedProgress(updated);
      await refresh();
    });
    return;
  }

  const insideSubPanel = actionBtn.closest('.question-sub-panel');
  const selectEls = insideSubPanel
    ? [...insideSubPanel.querySelectorAll('select[data-line]')]
    : [
        ...el.querySelectorAll('.issue-box select[data-line]'),
        ...el.querySelectorAll('.question-sub-panel:not([hidden]) select[data-line]')
      ];
  const choices = Object.fromEntries(
    selectEls.filter(s => s.value).map(s => [s.dataset.line, s.value])
  );
  if (action === 'substitute' && !Object.keys(choices).length) {
    showInputError('Select a substitute from the dropdown first, or click Cancel order.');
    return;
  }
  if (insideSubPanel && action === 'approve' && !Object.keys(choices).length) {
    showInputError('Select a substitute from the dropdown first, or click Cancel order.');
    return;
  }

  await run(async () => {
    clearInputError();
    const updated = await api(`/orders/${el.dataset.id}/${action}`, {
      user_id: activeBuyer,
      choices,
      acceptPartial: el.querySelector('.partial')?.checked || false
    });
    showExecution(updated);
    if (guidedScenario && guidedOrderId === el.dataset.id) guidedOrderId = updated.id;
    updateGuidedProgress(updated);
    await refresh();
  });
}

$('orders').onclick = handleOrderDecision;
$('history-orders').onclick = handleOrderDecision;

async function submit() {
  clearInputError();
  const text = $('prompt').value.trim();
  if (!text) {
    const msg = plainMode ? 'empty' : 'Try specifying products and quantities, or describe what you want to order.';
    showInputError(msg);
    return;
  }
  $('execution').hidden = false;
  $('exec-badge').className = 'badge pending';
  $('exec-badge').textContent = 'Processing…';
  $('item-summary').innerHTML = plainMode ? '<p>…</p>' : '<p class="order-meta">Matching products and checking stock with Gemini…</p>';
  try {
    const result = await api('/requests', {
      user_id: activeBuyer,
      text,
      force_flag: !plainMode && $('force-flag').checked,
      demo_unavailable: Boolean(guidedScenario?.steps[guidedIndex]?.demoUnavailable)
    });
    showExecution(result);
    if (guidedScenario) {
      guidedOrderId = result.id;
      updateGuidedProgress(result);
    }
    await refresh();
  } catch (e) {
    if (lastExecOrder) showExecution(lastExecOrder);
    else $('execution').hidden = true;
    showInputError(e.message);
  }
}

$('submit').onclick = () => run(submit);
$('prompt').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run(submit);
  }
});

$('toggle').onclick = () => setSettingsView(!settingsOpen);
$('back-workspace').onclick = () => setSettingsView(false);

$('save').onclick = () => run(async () => {
  const thresholdVal = Number($('threshold').value);
  if (!Number.isFinite(thresholdVal) || thresholdVal < 0) throw Error('Enter a valid non-negative threshold.');
  const saved = await api('/config', { user_id: activeBuyer, threshold: thresholdVal });
  await refresh();
  showSettingsFeedback(`Saved threshold ${fmtNum(saved.threshold)} for "${saved.user_id}".`, 'ok');
});

$('create-buyer-btn').onclick = () => run(async () => {
  const userId = $('new-buyer-id').value.trim();
  const thresholdVal = Number($('new-buyer-threshold').value);
  if (!userId) throw Error('Enter a new buyer ID.');
  if (!Number.isFinite(thresholdVal) || thresholdVal < 0) throw Error('Enter a valid non-negative threshold.');
  const created = await api('/buyers', { user_id: userId, threshold: thresholdVal });
  activeBuyer = created.user_id;
  resetExecutionView();
  $('new-buyer-id').value = '';
  await refresh();
  showSettingsFeedback(`Created and selected buyer "${created.user_id}" (threshold ${fmtNum(created.threshold)}).`, 'ok');
});

$('buyers-table').onclick = e => {
  const btn = e.target.closest('button[data-select-buyer]');
  if (!btn) return;
  activeBuyer = btn.dataset.selectBuyer;
  resetExecutionView();
  run(async () => {
    await refresh();
    showSettingsFeedback(`Switched active buyer to "${activeBuyer}" (threshold ${fmtNum($('threshold').value)}).`, 'ok');
  });
};

$('user').onchange = () => run(async () => {
  activeBuyer = $('user').value;
  resetExecutionView();
  await refresh();
  showSettingsFeedback(`Switched active buyer to "${activeBuyer}" (threshold ${fmtNum($('threshold').value)}).`, 'ok');
});

$('refresh').onclick = () => run(refresh);

$('source').onchange = () => run(async () => {
  const previous = dataSource;
  dataSource = $('source').value;
  try {
    await api('/config?user_id=' + encodeURIComponent(activeBuyer));
  } catch (e) {
    dataSource = previous;
    $('source').value = previous;
    throw e;
  }
  resetExecutionView();
  await refresh();
  showSettingsFeedback(`Switched catalog source to "${dataSource}".`, 'ok');
});

async function loadDemoScenarios() {
  try {
    const response = await fetch('/demo-prompts.json');
    if (!response.ok) throw Error('Could not load demo prompts');
    promptScenarios = await response.json();
    $('demo-scenario').innerHTML = promptScenarios.map(s => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('');
    $('demo-scenario').onchange = () => {
      const selected = promptScenarios.find(s => s.id === $('demo-scenario').value);
      if (selected) $('scenario-help').textContent = `${selected.description} (${selected.steps.length} step${selected.steps.length === 1 ? '' : 's'}).`;
    };
    $('demo-scenario').dispatchEvent(new Event('change'));
  } catch (error) {
    $('demo-scenario').innerHTML = '<option value="">Sample prompts unavailable</option>';
    $('scenario-help').textContent = error.message;
  }
}

function loadScenarioStep(index) {
  guidedIndex = index;
  guidedOrderId = null;
  guidedOrderStatus = null;
  const step = guidedScenario.steps[index];
  $('prompt').value = step.prompt;
  $('force-flag').checked = false;
  $('scenario-next').disabled = true;
  $('scenario-help').textContent = `Step ${index + 1} of ${guidedScenario.steps.length} (${step.label}): Submit this prompt, then approve it if queued before continuing.`;
  $('prompt').focus();
}

function updateGuidedProgress(order) {
  if (!guidedScenario || !order || (guidedOrderId && order.id !== guidedOrderId)) return;
  guidedOrderId = order.id;
  guidedOrderStatus = order.status;
  if (order.status === 'APPROVED') {
    if (guidedIndex === guidedScenario.steps.length - 1) {
      $('scenario-help').textContent = guidedScenario.completion || `Scenario complete — all ${guidedScenario.steps.length} prompts were processed.`;
      $('scenario-next').disabled = true;
    } else {
      $('scenario-help').textContent = `Step ${guidedIndex + 1} approved. Click "Next prompt" to continue.`;
      $('scenario-next').disabled = false;
    }
  } else if (order.status === 'REJECTED') {
    $('scenario-help').textContent = `Step ${guidedIndex + 1} was discarded/rejected. Click "Start" to restart the scenario.`;
    $('scenario-next').disabled = true;
  } else {
    $('scenario-help').textContent = `Step ${guidedIndex + 1} is waiting in the approval queue — review and approve it before continuing.`;
    $('scenario-next').disabled = true;
  }
}

$('scenario-start').onclick = () => run(async () => {
  const scenario = promptScenarios.find(s => s.id === $('demo-scenario').value);
  if (!scenario) throw Error('Choose a demo scenario first.');
  dataSource = 'demo';
  $('source').value = 'demo';
  const freshBuyer = `scenario-${scenario.id}-${Date.now().toString(36).slice(-4)}`;
  activeBuyer = freshBuyer;
  const cfg = await api('/config?user_id=' + encodeURIComponent(activeBuyer));
  $('threshold').value = cfg.threshold;
  guidedScenario = scenario;
  await api('/config', {
    user_id: activeBuyer,
    threshold: Number($('threshold').value) || 25,
    stock: scenario.stock || 'normal'
  });
  resetExecutionView();
  await refresh();
  loadScenarioStep(0);
});

$('scenario-next').onclick = () => run(async () => {
  if (!guidedScenario || guidedOrderStatus !== 'APPROVED') throw Error('Submit and approve the current prompt before continuing.');
  if (guidedIndex >= guidedScenario.steps.length - 1) {
    $('scenario-next').disabled = true;
    $('scenario-help').textContent = guidedScenario.completion || 'Scenario complete.';
    return;
  }
  await api('/config', {
    user_id: activeBuyer,
    threshold: Number($('threshold').value) || 25,
    stock: guidedScenario.stock || 'normal'
  });
  loadScenarioStep(guidedIndex + 1);
});

applyPlainMode();
loadDemoScenarios();
run(refresh);
