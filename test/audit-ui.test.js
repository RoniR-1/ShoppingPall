import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAudit, setAuditPerspective } from '../web/audit-render.js';

const actor = { type: 'human_approver', id: '<img src=x onerror=alert(1)>', role: 'approver', organization: 'Buyer' };
const events = [
  { event_type: 'QUOTE_VERIFIED', integrity_hash: 'quote-hash', actor },
  { event_type: 'HUMAN_APPROVED', actor },
  { event_type: 'GUARDRAIL_PASSED', actor, policy_snapshot: { budget_limit: 100, budget_overrun: false, secret: 'buyer-only-budget' } },
  { event_type: 'ORDER_COMMITTED', actor, commercial_commitment: { total_eur: 42 } }
];

test('buyer audit attributes committed spend to human approval even after a later guardrail pass', () => {
  const html = renderAudit({ events, verification: { valid: true } }, 'buyer');
  assert.match(html, /Human-approved spend/);
  assert.match(html, /€42\.00/);
  assert.match(html, /Budget check passed/);
  assert.doesNotMatch(html, /Autonomous spend/);
});

test('wholesaler audit hides policy and reasoning and escapes untrusted fields', () => {
  const html = renderAudit({ events, verification: { valid: true } }, 'wholesaler');
  assert.doesNotMatch(html, /buyer-only-budget|Policy snapshot/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  assert.match(html, /quote-hash/);
  const button = { hidden: false };
  setAuditPerspective('wholesaler', button);
  assert.equal(button.hidden, true);
  setAuditPerspective('buyer', button);
  assert.equal(button.hidden, false);
});


test('planning budget remains visible after final checkout checks and approval', () => {
  const actualFlow = [
    { event_type: 'QUOTE_VERIFIED', actor },
    { event_type: 'ESCALATED_FOR_APPROVAL', actor, policy_snapshot: { budget_limit: 100, budget_overrun: true } },
    { event_type: 'GUARDRAIL_PASSED', actor, policy_snapshot: { hard_spend_passed: true, weekly_spend_passed: true } },
    { event_type: 'HUMAN_APPROVED', actor },
    { event_type: 'ORDER_COMMITTED', actor, commercial_commitment: { total_eur: 110 } }
  ];
  const html = renderAudit({ events: actualFlow }, 'buyer');
  assert.match(html, /Budget flagged/);
  assert.match(html, /Human-approved spend/);
});
