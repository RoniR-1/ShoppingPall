const esc = s => String(s ?? '—').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMoney = v => {
  const n = Number(v);
  return Number.isFinite(n) ? `€${n.toFixed(2)}` : '—';
};

export function setAuditPerspective(perspective, reasoningButton) {
  reasoningButton.hidden = perspective === 'wholesaler';
}

function auditObject(value) {
  return `<pre class="audit-json">${esc(JSON.stringify(value, null, 2))}</pre>`;
}

export function renderAudit(data, perspective) {
  const events = data.events || [];
  if (!events.length) return '<p class="empty">No audit events recorded for this order.</p>';
  const buyer = perspective === 'buyer';
  const verified = data.verification?.valid;
  const quote = events.findLast(e => e.event_type === 'QUOTE_VERIFIED');
  const lastQuoteIndex = events.findLastIndex(e => e.event_type === 'QUOTE_VERIFIED');
  const authorizationEvents = events.slice(Math.max(0, lastQuoteIndex));
  const approval = authorizationEvents.findLast(e => e.event_type === 'HUMAN_APPROVED') || authorizationEvents.findLast(e => e.event_type === 'GUARDRAIL_PASSED');
  const policy = events.findLast(e => e.policy_snapshot)?.policy_snapshot;
  const budgetPolicy = events.findLast(e => e.policy_snapshot?.budget_limit != null || e.policy_snapshot?.budget_overrun === true)?.policy_snapshot;
  const hardSpendPolicy = events.findLast(e => typeof e.policy_snapshot?.hard_spend_passed === 'boolean')?.policy_snapshot;
  const budget = budgetPolicy?.budget_overrun === true || hardSpendPolicy?.hard_spend_passed === false ? 'Budget flagged' :
    (budgetPolicy?.budget_limit != null && budgetPolicy?.budget_overrun === false) || hardSpendPolicy?.hard_spend_passed === true ? 'Budget check passed' : 'Budget result not recorded';
  const policyStatus = policy ? (policy.incomplete || policy.price_cap_breach || policy.hard_spend_passed === false || policy.weekly_spend_passed === false || policy.categories_passed === false || policy.allergens_passed === false || (policy.score != null && policy.threshold != null && Number(policy.score) > Number(policy.threshold)) ? 'Review required' : 'Recorded; see checks') : 'Not recorded';
  const commit = events.findLast(e => e.event_type === 'ORDER_COMMITTED');
  const commitValue = commit?.commercial_commitment?.total_eur;
  const authorization = approval?.event_type === 'HUMAN_APPROVED' ? 'Human approval recorded' : approval ? 'Autonomous guardrail pass recorded' : 'No authorization event recorded';
  const cards = buyer
    ? `<div><strong>Budget compliance</strong><span>${esc(budget)}</span></div>
       <div><strong>Policy adherence</strong><span>${esc(policyStatus)}</span></div>
       <div><strong>Authorization</strong><span>${esc(authorization)}</span></div>
       <div><strong>${approval?.event_type === 'HUMAN_APPROVED' ? 'Human-approved spend' : 'Autonomous spend'}</strong><span>${commitValue == null ? 'Not recorded' : fmtMoney(commitValue)}</span></div>`
    : `<div><strong>Quote snapshot</strong><span>${quote ? 'Recorded' : 'Not recorded'}</span></div>
       <div><strong>Buyer authorization</strong><span>${esc(authorization)}</span></div>
       <div><strong>Commitment</strong><span>${commit ? 'Event recorded; see snapshot' : 'No commitment event'}</span></div>`;
  return `<div class="audit-summary">${cards}</div>
    <p class="audit-verification">Chain: <strong>${verified === true ? 'verified' : verified === false ? 'verification failed' : 'not verified'}</strong> · ${esc(data.storage || 'unknown')} storage</p>
    <p class="order-meta">${esc(data.limitation || '')} Non-repudiation is not established: a hash chain is not a digital signature.</p>
    ${!buyer && quote ? `<p class="audit-hash"><strong>Quote event hash:</strong> ${esc(quote.integrity_hash)}</p>` : ''}
    <ol class="audit-events">${events.map(e => `<li>
      <div class="audit-event-head"><strong>${esc(String(e.event_type || '').replaceAll('_', ' '))}</strong><time>${esc(e.timestamp)}</time></div>
      <p>${esc(e.actor?.type)} · ${esc(e.actor?.id)} · ${esc(e.actor?.role)} · ${esc(e.actor?.organization)}</p>
      ${e.commercial_commitment ? `<details><summary>Commercial snapshot</summary>${auditObject(e.commercial_commitment)}</details>` : ''}
      ${buyer && e.policy_snapshot ? `<details><summary>Policy snapshot</summary>${auditObject(e.policy_snapshot)}</details>` : ''}
      <details><summary>Integrity hashes</summary><p class="audit-hash">Event: ${esc(e.integrity_hash)}<br>Previous: ${esc(e.previous_hash || 'genesis')}</p></details>
    </li>`).join('')}</ol>`;
}

