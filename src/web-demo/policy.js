import { round3 } from '../contracts.js';

export class SuspicionScorer {
  score(order = {}) {
    const lines = order.lines || [];
    const items = order.items || [];
    const total = Number(order.total ?? items.reduce((sum, i) => sum + Number(i.quantity || 0) * Number(i.price || 0), 0));
    const reasons = [];
    let points = 0;

    if (order.force_flag) {
      points += 85;
      reasons.push('Manual review flag (+85)');
    }

    const totalQty = lines.reduce((n, l) => n + Number(l.quantity || 0), 0);
    if (lines.length > 20 || totalQty > 100) {
      points += 80;
      reasons.push('Large request volume (+80)');
    }

    let unfamiliarCount = 0;
    let quantitySpikePts = 0;
    let quantityDropPts = 0;
    let allergenPts = 0;
    let substitutionPts = 0;
    let reliabilityPts = 0;
    let carbonPts = 0;

    for (const item of items) {
      const priorApprovals = Number(item.human_approved_count || 0) + Number(item.bought_count || 0);
      if (priorApprovals === 0) unfamiliarCount += 1;

      const priorMax = Number(item.prior_max_qty || 0);
      if (priorMax > 0 && Number(item.quantity) > 1.5 * priorMax) {
        const spike = 30 + 40 * (Number(item.quantity) / priorMax - 1.5);
        quantitySpikePts = Math.max(quantitySpikePts, spike);
      }

      const priorMin = Number(item.prior_min_qty || item.prior_avg_qty || item.prior_max_qty || 0);
      if (priorMin > 0 && Number(item.quantity) < 0.5 * priorMin) {
        const drop = 25 + 20 * (priorMin / Math.max(Number(item.quantity), 0.001) - 2);
        quantityDropPts = Math.max(quantityDropPts, drop);
      }

      if (item.allergen_safe === false) allergenPts = Math.max(allergenPts, 80);
      if (item.substitution === true) substitutionPts = Math.max(substitutionPts, 30);

      if (item.reliability != null && Number(item.reliability) < 0.85) {
        reliabilityPts = Math.max(reliabilityPts, Math.max(10, (0.85 - Number(item.reliability)) * 100));
      }

      if (item.carbon != null && Number(item.carbon) >= 10) {
        carbonPts = Math.max(carbonPts, Math.min(40, Number(item.carbon) * 1.5));
      }
    }

    if (unfamiliarCount > 0) {
      const pts = 30 + (unfamiliarCount - 1) * 10;
      points += pts;
      reasons.push(`Unfamiliar item not in approved history (+${pts})`);
    }
    if (quantitySpikePts > 0) {
      const pts = round3(quantitySpikePts);
      points += pts;
      reasons.push(`Quantity spike vs prior orders (+${pts})`);
    }
    if (quantityDropPts > 0) {
      const pts = round3(quantityDropPts);
      points += pts;
      reasons.push(`Unusually small quantity vs prior orders (+${pts})`);
    }
    if (allergenPts > 0) {
      points += allergenPts;
      reasons.push(`Excluded allergen conflict (+${allergenPts})`);
    }
    if (substitutionPts > 0) {
      points += substitutionPts;
      reasons.push(`Product substitution (+${substitutionPts})`);
    }
    if (reliabilityPts > 0) {
      const pts = round3(reliabilityPts);
      points += pts;
      reasons.push(`Low supplier reliability (+${pts})`);
    }
    if (carbonPts > 0) {
      const pts = round3(carbonPts);
      points += pts;
      reasons.push(`High carbon footprint (+${pts})`);
    }

    const spendCap = Number(order.buyerHistory?.spendCap) || 200;
    if (total > spendCap) {
      const pts = round3(35 + 100 * ((total - spendCap) / spendCap));
      points += pts;
      reasons.push(`Order total €${total.toFixed(2)} exceeds €${spendCap.toFixed(2)} baseline (+${pts})`);
    }

    const minOrderTotal = Number(order.buyerHistory?.minOrderTotal || 0);
    if (minOrderTotal > 0 && total > 0 && total < 0.4 * minOrderTotal) {
      const pts = round3(20 + 15 * (minOrderTotal / Math.max(total, 0.01) - 2.5));
      points += pts;
      reasons.push(`Order total €${total.toFixed(2)} unusually small vs €${minOrderTotal.toFixed(2)} prior baseline (+${pts})`);
    }

    if (points === 0) {
      points = 5;
      reasons.push(items.length ? 'Matches regular pattern' : 'Routine procurement quantities');
    }

    return {
      score: round3(points),
      reason: reasons.join(' · ')
    };
  }
}

export function route(order, scorer = new SuspicionScorer(), threshold = 25) {
  const result = scorer.score(order);
  const score = round3(Number(result.score));
  const limit = round3(Number(threshold));
  if (!Number.isFinite(score) || score < 0 || !Number.isFinite(limit) || limit < 0) {
    throw Error('Invalid scoring configuration');
  }
  return {
    ...result,
    score,
    threshold: limit,
    status: score > limit || order.incomplete ? 'PENDING_APPROVAL' : 'APPROVED'
  };
}
