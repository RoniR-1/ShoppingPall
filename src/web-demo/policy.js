import { round3 } from '../contracts.js';

export class SuspicionScorer {
  score(order = {}) {
    const lines = order.lines || [];
    const items = order.items || [];
    const total = Number(order.total ?? items.reduce((sum, i) => sum + Number(i.quantity || 0) * Number(i.price || 0), 0));
    const reasons = [];
    const questions = [];
    let points = 0;

    const addQuestion = (rule, pts, item, message) => {
      questions.push({
        id: `${rule}:${item?.lineIndex ?? item?.productId ?? 'order'}`,
        rule,
        points: round3(pts),
        lineIndex: item?.lineIndex ?? 0,
        productId: item?.productId ?? null,
        productName: item?.name ?? null,
        message,
        alternatives: item?.alternatives || []
      });
    };

    if (order.force_flag) {
      points += 85;
      reasons.push('Manual review flag (+85)');
      addQuestion(
        'manualFlag',
        85,
        items[0],
        `Manual review flag (--force-flag) was requested${items[0]?.name ? ` for ${items[0].name}` : ''}. Is this order reasonable to approve?`
      );
    }

    const totalQty = lines.reduce((n, l) => n + Number(l.quantity || 0), 0);
    if (lines.length > 20 || totalQty > 100) {
      points += 80;
      reasons.push('Large request volume (+80)');
      addQuestion(
        'largeVolume',
        80,
        items[0],
        `Large request volume (${lines.length} line(s), ${round3(totalQty)} total units). Is this volume tradeoff reasonable?`
      );
    }

    let unfamiliarCount = 0;
    let quantitySpikePts = 0;
    let quantityDropPts = 0;
    let allergenPts = 0;
    let substitutionPts = 0;
    let reliabilityPts = 0;
    let carbonPts = 0;

    for (const item of items) {
      const itemLabel = item.name || item.productId || 'item';
      const itemCost = Number(item.lineTotal ?? Number(item.quantity || 0) * Number(item.price || 0)).toFixed(2);
      const priorApprovals = Number(item.human_approved_count || 0) + Number(item.bought_count || 0);
      if (priorApprovals === 0) {
        unfamiliarCount += 1;
        const itemPts = unfamiliarCount === 1 ? 30 : 10;
        addQuestion(
          'unfamiliarItem',
          itemPts,
          item,
          `${itemLabel} (${round3(item.quantity)} ${item.unit || 'unit'}, €${itemCost}) has not been ordered/approved before. Is this item reasonable?`
        );
      }

      const priorMax = Number(item.prior_max_qty || 0);
      if (priorMax > 0 && Number(item.quantity) > 1.5 * priorMax) {
        const spike = round3(30 + 40 * (Number(item.quantity) / priorMax - 1.5));
        quantitySpikePts = Math.max(quantitySpikePts, spike);
        addQuestion(
          'quantitySpike',
          spike,
          item,
          `Quantity spike: ordering ${round3(item.quantity)} ${item.unit || 'units'} of ${itemLabel} vs your previous max of ${round3(priorMax)} ${item.unit || 'units'}. Is this quantity reasonable?`
        );
      }

      const priorMin = Number(item.prior_min_qty || item.prior_avg_qty || item.prior_max_qty || 0);
      if (priorMin > 0 && Number(item.quantity) < 0.5 * priorMin) {
        const drop = round3(25 + 20 * (priorMin / Math.max(Number(item.quantity), 0.001) - 2));
        quantityDropPts = Math.max(quantityDropPts, drop);
        addQuestion(
          'quantityDrop',
          drop,
          item,
          `Unusually small quantity: ordering only ${round3(item.quantity)} ${item.unit || 'units'} of ${itemLabel} vs your previous min of ${round3(priorMin)} ${item.unit || 'units'}. Is this smaller amount reasonable?`
        );
      }

      if (item.allergen_safe === false) {
        allergenPts = Math.max(allergenPts, 80);
        addQuestion(
          'allergenConflict',
          80,
          item,
          `${itemLabel} conflicts with your excluded allergen policy. Is this allergen tradeoff acceptable?`
        );
      }

      if (item.substitution === true) {
        substitutionPts = Math.max(substitutionPts, 30);
        addQuestion(
          'substitution',
          30,
          item,
          `Substituted item: using ${itemLabel} (€${Number(item.price || 0).toFixed(2)}/${item.unit || 'unit'}) for "${item.requested || 'requested item'}". Is this substitution reasonable?`
        );
      }

      if (item.reliability != null && Number(item.reliability) < 0.85) {
        const relPts = round3(Math.max(10, (0.85 - Number(item.reliability)) * 100));
        reliabilityPts = Math.max(reliabilityPts, relPts);
        addQuestion(
          'lowReliability',
          relPts,
          item,
          `${itemLabel} has low supplier delivery reliability (${round3(Number(item.reliability) * 100)}%). Is this reliability tradeoff reasonable?`
        );
      }

      if (item.carbon != null && Number(item.carbon) >= 10) {
        const carbPts = round3(Math.min(40, Number(item.carbon) * 1.5));
        carbonPts = Math.max(carbonPts, carbPts);
        addQuestion(
          'highCarbon',
          carbPts,
          item,
          `${itemLabel} has a high carbon footprint (${round3(item.carbon)} kg CO₂/kg). Is this carbon tradeoff reasonable?`
        );
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

    const topCostItem = [...items].sort(
      (a, b) => Number(b.lineTotal ?? Number(b.quantity || 0) * Number(b.price || 0)) - Number(a.lineTotal ?? Number(a.quantity || 0) * Number(a.price || 0))
    )[0];

    const spendCap = Number(order.buyerHistory?.spendCap) || 200;
    if (total > spendCap) {
      const pts = round3(35 + 100 * ((total - spendCap) / spendCap));
      points += pts;
      reasons.push(`Order total €${total.toFixed(2)} exceeds €${spendCap.toFixed(2)} baseline (+${pts})`);
      addQuestion(
        'highSpend',
        pts,
        topCostItem,
        `High price / spend: order total €${total.toFixed(2)} exceeds your €${spendCap.toFixed(2)} baseline${topCostItem ? ` (driven by ${topCostItem.name || topCostItem.productId} at €${Number(topCostItem.lineTotal ?? topCostItem.quantity * topCostItem.price).toFixed(2)})` : ''}. Is this price tradeoff reasonable?`
      );
    }

    const minOrderTotal = Number(order.buyerHistory?.minOrderTotal || 0);
    if (minOrderTotal > 0 && total > 0 && total < 0.4 * minOrderTotal) {
      const pts = round3(20 + 15 * (minOrderTotal / Math.max(total, 0.01) - 2.5));
      points += pts;
      reasons.push(`Order total €${total.toFixed(2)} unusually small vs €${minOrderTotal.toFixed(2)} prior baseline (+${pts})`);
      addQuestion(
        'lowSpend',
        pts,
        topCostItem || items[0],
        `Order total €${total.toFixed(2)} is unusually small compared to your €${minOrderTotal.toFixed(2)} prior baseline. Is this small order reasonable?`
      );
    }

    if (points === 0) {
      points = 5;
      reasons.push(items.length ? 'Matches regular pattern' : 'Routine procurement quantities');
    }

    return {
      score: round3(points),
      reason: reasons.join(' · '),
      questions
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
