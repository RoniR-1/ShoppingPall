import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createAuditEvent, verifyAuditChain, projectAuditEvent, auditCsv, canonicalJson, commercialSnapshot } from '../src/audit.js';
const actor = {type:'autonomous_agent',id:'agent',role:'buyer',organization:'test'};
test('audit chain detects changes, removals and reorder', () => {
  const one = createAuditEvent({actor,event_type:'QUOTE_VERIFIED',commercial_commitment:{items:[{sku:'1',unit_price:2}]} });
  const two = createAuditEvent({actor,event_type:'GUARDRAIL_PASSED',policy_snapshot:{hard_spend_limit:100}},one.integrity_hash);
  const three = createAuditEvent({actor,event_type:'ORDER_COMMITTED'},two.integrity_hash);
  assert.equal(verifyAuditChain([one,two,three]).valid,true);
  assert.equal(verifyAuditChain([{...one,event_type:'HUMAN_APPROVED'},two,three]).valid,false);
  assert.equal(verifyAuditChain([one,three]).valid,false);
  assert.equal(verifyAuditChain([two,one,three]).valid,false);
  assert.equal(verifyAuditChain([one,two]).valid,true); // a trusted external head is required to detect truncation
});
test('canonical encoding and wholesaler projection', () => {
  assert.equal(canonicalJson({z:1,a:{y:2,x:1}}),canonicalJson({a:{x:1,y:2},z:1}));
  const e = createAuditEvent({actor,event_type:'GUARDRAIL_PASSED',policy_snapshot:{budget_note:'private'}});
  const visible = projectAuditEvent(e,'wholesaler');
  assert.equal(JSON.stringify(visible).includes('private'),false);
  assert.equal(visible.policy_redacted,true);
  assert.equal(e.policy_snapshot.budget_note,'private');
  assert.match(auditCsv([e]),/""private""/);
});
test('commitment captures exact unit price, stock and delivery claims', () => {
  const snapshot = commercialSnapshot([{productId:'sku',quantity:2,unit_price:1.25,line_total_cents:250,availableAmount:8,availability:{scheduleLines:[{availableDate:'2026-11-20'}]}}],'EUR',250,'2026-11-20');
  assert.equal(snapshot.total_eur,2.5);
  assert.equal(snapshot.items[0].available_amount,8);
  assert.equal(snapshot.items[0].delivery_window[0].availableDate,'2026-11-20');
});
