import {auditActor} from '../audit.js';

// These are evidence captured by the supplier quote and policy gates, not agent reasoning.
export function portalCommercial(order) {
 return {
  currency:'EUR', total_eur:Number(order.total||0), requested_delivery_date:order.quote_requested_date||null,
  quote_expires_at:order.quote_expires_at||null,
  items:(order.items||[]).map(i=>({sku:i.productId,quantity:i.quantity,unit:i.unit,unit_price:i.price,line_total:i.lineTotal,available_amount:i.available,closing_time:i.closing_time??null,delivery_window:i.available_date||order.quote_requested_date||null})),
  supplier_claims:order.supplier_claims||[], supplier_mode:order.supplier_mode||'unknown'
 };
}
export function portalPolicy(order) {
 return { rules_version:'portal-suspicion-scorer-v1',autonomy_rule:'managed agent with deterministic threshold, complete quote, no substitution or allergen conflict; simulation additionally requires autonomous governance and a passing price cap',managed_constraints:order.context?.constraints??null,managed_rule_version:order.context?.why?.rule_version??null,simulation_governance:order.context?.simulation?.governance??null,threshold:order.threshold??null,score:order.score??null,checks:order.checks||[],budget_limit:order.budget_limit??null,budget_overrun:order.budget_overrun??false,baseline:order.buyer_baseline??null,incomplete:Boolean(order.incomplete),autonomous:Boolean(order.audit_autonomous),price_cap_breach:order.policy_breach??null };
}
export function portalAuditInput(order,event_type,type,extra={}) {
 const actor=auditActor(type,order.user_id);
 if(type==='autonomous_agent'&&order.context?.agent?.id)actor.id=order.context.agent.id;
 return {user_id:order.user_id,order_id:order.id,trace_id:order.id,actor,event_type,policy_snapshot:extra.policy_snapshot??null,commercial_commitment:extra.commercial_commitment??null};
}
export function planningEvents(order) {
 const commercial=portalCommercial(order),policy=portalPolicy(order);
 return [
  portalAuditInput(order,'QUOTE_VERIFIED','wholesaler_system',{commercial_commitment:commercial}),
  portalAuditInput(order,order.audit_autonomous?'GUARDRAIL_PASSED':'ESCALATED_FOR_APPROVAL','autonomous_agent',{policy_snapshot:policy,commercial_commitment:commercial})
 ];
}
export function changedProposal(a,b) {
 if(!a)return true;
 return JSON.stringify({items:a.items,claims:a.supplier_claims,policy:portalPolicy(a)})!==JSON.stringify({items:b.items,claims:b.supplier_claims,policy:portalPolicy(b)});
}
export function decisionEvents(order,action,human,policy=null,stockAtCommit=null) {
 const commercial=portalCommercial(order), events=[];
 if(policy)events.push(portalAuditInput(order,'GUARDRAIL_PASSED','autonomous_agent',{policy_snapshot:policy,commercial_commitment:commercial}));
 if(human)events.push(portalAuditInput(order,action==='approve'?'HUMAN_APPROVED':'HUMAN_REJECTED','human_approver',{commercial_commitment:commercial}));
 else if(action==='reject')events.push(portalAuditInput(order,'ORDER_CANCELLED','autonomous_agent',{commercial_commitment:commercial}));
 if(action==='approve')events.push(portalAuditInput(order,'ORDER_COMMITTED','wholesaler_system',{commercial_commitment:{...commercial,commitment_kind:'local_mock_inventory_transaction',supplier_order_submitted:false,stock_at_commit:stockAtCommit}}));
 return events;
}
