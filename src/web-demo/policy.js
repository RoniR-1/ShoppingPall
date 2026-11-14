import { round3 } from '../contracts.js';

const REQUEST_FILLER_WORDS = new Set([
  'i', 'we', 'you', 'want', 'would', 'like', 'need', 'order', 'buy', 'get', 'please', 'some', 'any',
  'of', 'for', 'to', 'in', 'on', 'a', 'an', 'the', 'and', 'or', 'with', 'without', 'approx', 'about',
  'fresh', 'ripe', 'good', 'nice', 'regular', 'normal', 'standard', 'classic',
  'kg', 'kgs', 'g', 'gr', 'gram', 'grams', 'l', 'lt', 'ltr', 'liter', 'liters', 'litre', 'litres',
  'ml', 'cl', 'dl', 'pc', 'pcs', 'piece', 'pieces', 'st', 'ki', 'rs', 'unit', 'units',
  'bag', 'bags', 'box', 'boxes', 'pack', 'packs', 'package', 'packages', 'crate', 'crates',
  'bottle', 'bottles', 'carton', 'cartons', 'can', 'cans', 'jar', 'jars', 'tray', 'trays', 'tin', 'tins'
]);

function stemToken(word) {
  let w = String(word || '').toLowerCase().replace(/[^a-z0-9äöå]/g, '');
  if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('es') && w.length > 4 && !/(cheese|sauce)/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith('s') && w.length > 3 && !w.endsWith('ss')) w = w.slice(0, -1);
  return w;
}

function tokenizeProductText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)?/g, ' ')
    .replace(/[×*+/\\()[\],.:;!?'"-]/g, ' ')
    .split(/\s+/)
    .map(stemToken)
    .filter(w => w.length >= 2);
}

export function missingRequestTerms(item = {}, line = null) {
  const rawReq = item.requested || line?.requested || line?.query || '';
  if (!rawReq || !item.name) return null;
  const reqTokens = [...new Set(tokenizeProductText(rawReq).filter(w => !REQUEST_FILLER_WORDS.has(w)))];
  if (!reqTokens.length) return [];
  const nameTokens = new Set(tokenizeProductText(item.name));
  if (nameTokens.has('drink') && !nameTokens.has('milk')) nameTokens.add('milk');
  if (nameTokens.has('beverage') && !nameTokens.has('drink')) nameTokens.add('drink');
  return reqTokens.filter(t => ![...nameTokens].some(n => n === t || (t.length >= 4 && n.startsWith(t)) || (n.length >= 4 && t.startsWith(n))));
}

export function isBrandOrVariantMismatch(item = {}, line = null) {
  const rawReq = item.requested || line?.requested || line?.query || '';
  if (!rawReq || !item.name) return false;
  const reqTokens = [...new Set(tokenizeProductText(rawReq).filter(w => !REQUEST_FILLER_WORDS.has(w)))];
  if (reqTokens.length < 2) return false;
  const missing = missingRequestTerms(item, line);
  return Array.isArray(missing) && missing.length > 0 && missing.length < reqTokens.length;
}

export class SuspicionScorer {
  score(order = {}) {
    const lines = order.lines || [];
    const items = order.items || [];
    const total = Number(order.total ?? items.reduce((sum, i) => sum + Number(i.quantity || 0) * Number(i.price || 0), 0));
    const reasons = [];
    const questions = [];
    const checks = [];
    let points = 0;

    const addCheck = (status, rule, pts, text) => {
      checks.push({ status, rule, points: round3(pts || 0), text });
    };

    const addQuestion = (rule, pts, item, message, extra = {}) => {
      const targetKey = item?.productId
        ? `${item.lineIndex ?? 0}:${item.productId}`
        : `${item?.lineIndex ?? 'order'}`;
      const lot = round3(Number(item?.lot) || 1);
      const currentQty = item?.quantity != null ? round3(Number(item.quantity)) : null;
      const quantityOnlyRules = ['quantitySpike', 'quantityDrop', 'largeVolume', 'lowSpend'];
      questions.push({
        id: `${rule}:${targetKey}`,
        rule,
        points: round3(pts),
        lineIndex: item?.lineIndex ?? 0,
        productId: item?.productId ?? null,
        productName: item?.name ?? null,
        unit: item?.unit || 'unit',
        lot,
        currentQty,
        suggestedQty: extra.suggestedQty != null ? round3(extra.suggestedQty) : currentQty,
        allowQuantityEdit: Boolean(item) && extra.allowQuantityEdit !== false,
        allowSubstitution: !quantityOnlyRules.includes(rule) && extra.allowSubstitution !== false,
        message,
        alternatives: item?.alternatives || []
      });
    };

    if (order.force_flag) {
      points += 85;
      reasons.push('Manual review flag (+85)');
      addCheck('flag', 'manualFlag', 85, 'Manual review flag (--force-flag) enabled (+85 pts).');
      addQuestion(
        'manualFlag',
        85,
        items[0],
        `You checked manual review (--force-flag) for this order${items[0]?.name ? ` (${items[0].name})` : ''}. Ready to send it through, or would you like to tweak anything first?`
      );
    }

    if (order.budget_overrun) {
      const amount = Number(order.total || 0);
      const budget = Number(order.budget_limit || 0);
      points += 85;
      reasons.push(`Order total €${amount.toFixed(2)} exceeds stated budget €${budget.toFixed(2)} (+85)`);
      addCheck('flag', 'budgetOverrun', 85, `Order total €${amount.toFixed(2)} exceeds the requested budget of €${budget.toFixed(2)} (+85 pts).`);
      addQuestion('budgetOverrun', 85, items[0],
        `The requested total budget is €${budget.toFixed(2)}, but this order costs €${amount.toFixed(2)}. Review or reduce the order before approving it.`,
        { allowSubstitution: true });
    }

    const totalQty = lines.reduce((n, l) => n + Number(l.quantity || 0), 0);
    if (lines.length > 20 || totalQty > 100) {
      points += 80;
      reasons.push('Large request volume (+80)');
      addCheck('flag', 'largeVolume', 80, `Order volume (${lines.length} line${lines.length === 1 ? '' : 's'}, ${round3(totalQty)} total units) exceeds the 100-unit routine limit (+80 pts).`);
      const halfQty = items[0]?.quantity ? Math.max(Number(items[0].lot) || 1, Math.floor(Number(items[0].quantity) / 2)) : 1;
      addQuestion(
        'largeVolume',
        80,
        items[0],
        `That's quite a large order (${lines.length} line${lines.length === 1 ? '' : 's'}, ${round3(totalQty)} units total). Did you mean to order this much volume, or would you like to scale it back?`,
        { suggestedQty: halfQty, allowSubstitution: false }
      );
    } else if (lines.length > 0) {
      addCheck('pass', 'largeVolume', 0, `Volume within normal limits (${lines.length} line${lines.length === 1 ? '' : 's'}, ${round3(totalQty)} total units <= 100).`);
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
      const unit = item.unit || 'unit';
      const lot = Number(item.lot) > 0 ? Number(item.lot) : 1;
      const snap = q => round3(Math.max(lot, Math.round(Number(q) / lot) * lot));
      const itemCost = Number(item.lineTotal ?? Number(item.quantity || 0) * Number(item.price || 0)).toFixed(2);
      const priorApprovals = Number(item.human_approved_count || 0) + Number(item.bought_count || 0);
      if (priorApprovals === 0) {
        unfamiliarCount += 1;
        const itemPts = unfamiliarCount === 1 ? 30 : 10;
        addCheck('flag', 'unfamiliarItem', itemPts, `${itemLabel} has no prior approved orders for this buyer (+${itemPts} pts).`);
        const msg = unfamiliarCount === 1
          ? `Looks like this is your first time ordering ${itemLabel} (${round3(item.quantity)} ${unit} for €${itemCost}). Does this look like the right product and amount?`
          : `${itemLabel} (${round3(item.quantity)} ${unit}, €${itemCost}) is also new to your order history. Still want to include it?`;
        addQuestion('unfamiliarItem', itemPts, item, msg);
      } else {
        addCheck('pass', 'unfamiliarItem', 0, `${itemLabel} is in approved buyer history (${Number(item.bought_count || 0)} prior order${Number(item.bought_count || 0) === 1 ? '' : 's'}, ${Number(item.human_approved_count || 0)} human-approved).`);
      }

      const priorMax = Number(item.prior_max_qty || 0);
      const priorMin = Number(item.prior_min_qty || item.prior_avg_qty || item.prior_max_qty || 0);
      let qtyFlagged = false;
      if (priorMax > 0 && Number(item.quantity) > 1.5 * priorMax) {
        qtyFlagged = true;
        const spike = round3(30 + 40 * (Number(item.quantity) / priorMax - 1.5));
        quantitySpikePts = Math.max(quantitySpikePts, spike);
        const ratio = Number(item.quantity) / priorMax;
        addCheck('flag', 'quantitySpike', spike, `${itemLabel} quantity (${round3(item.quantity)} ${unit}) is ${round3(ratio)}× your historical max of ${round3(priorMax)} ${unit} (+${spike} pts).`);
        const msg = ratio >= 3
          ? `Whoa — ${round3(item.quantity)} ${unit} of ${itemLabel} is over ${Math.round(ratio)}× what you usually order at most (${round3(priorMax)} ${unit}). Did you really need this many, or want to dial the amount back?`
          : `You usually order at most ${round3(priorMax)} ${unit} of ${itemLabel}, so ${round3(item.quantity)} ${unit} is a noticeable jump. Keep all ${round3(item.quantity)} ${unit}, or lower the quantity?`;
        addQuestion('quantitySpike', spike, item, msg, {
          suggestedQty: snap(priorMax),
          allowSubstitution: false
        });
      }

      if (priorMin > 0 && Number(item.quantity) < 0.5 * priorMin) {
        qtyFlagged = true;
        const drop = round3(25 + 20 * (priorMin / Math.max(Number(item.quantity), 0.001) - 2));
        quantityDropPts = Math.max(quantityDropPts, drop);
        addCheck('flag', 'quantityDrop', drop, `${itemLabel} quantity (${round3(item.quantity)} ${unit}) is well below your usual minimum of ${round3(priorMin)} ${unit} (+${drop} pts).`);
        addQuestion(
          'quantityDrop',
          drop,
          item,
          `You normally get at least ${round3(priorMin)} ${unit} of ${itemLabel}, and this order only has ${round3(item.quantity)} ${unit}. Is that smaller amount enough for now, or would you like to bump it up?`,
          { suggestedQty: snap(priorMin), allowSubstitution: false }
        );
      }
      if (!qtyFlagged && priorMax > 0) {
        addCheck('pass', 'quantityRange', 0, `${itemLabel} quantity (${round3(item.quantity)} ${unit}) fits historical baseline (${round3(priorMin)}–${round3(priorMax)} ${unit}).`);
      }

      if (item.allergen_safe === false) {
        allergenPts = Math.max(allergenPts, 80);
        addCheck('flag', 'allergenConflict', 80, `${itemLabel} contains an excluded buyer allergen (+80 pts).`);
        addQuestion(
          'allergenConflict',
          80,
          item,
          `Heads up: ${itemLabel} conflicts with your allergen settings. Do you still want to keep it in this order, or swap/drop it?`
        );
      } else {
        addCheck('pass', 'allergenConflict', 0, `${itemLabel} passed buyer allergen check.`);
      }

      const itemUnfamiliarQ = priorApprovals === 0
        ? questions.find(q => q.rule === 'unfamiliarItem' && q.lineIndex === (item.lineIndex ?? 0) && q.productId === (item.productId ?? null))
        : null;
      const lineObj = lines[item.lineIndex ?? 0];
      const brandMismatch = !item.userSelected && isBrandOrVariantMismatch(item, lineObj);
      let subFlagged = false;
      if (item.substitution === true || brandMismatch) {
        const missing = missingRequestTerms(item, lineObj);
        // A general request (e.g. "50 × pear" matched to "PEAR SUOMI KG") has no missing brand/variant qualifiers.
        const isGenericMatch = item.substitution === true && Array.isArray(missing) && missing.length === 0;
        if (!isGenericMatch && !item.userSelected) {
          subFlagged = true;
          substitutionPts = Math.max(substitutionPts, 30);
          addCheck('flag', 'substitution', 30, `Substituted ${itemLabel} for "${item.requested || 'requested item'}"${Array.isArray(missing) && missing.length ? ` (missing qualifier: ${missing.join(' ')})` : ''} (+30 pts).`);
          const subMsg = Array.isArray(missing) && missing.length > 0
            ? `You asked for "${item.requested || 'a specific item'}" (specifically ${missing.join(' ')}), and we matched ${itemLabel} (€${Number(item.price || 0).toFixed(2)}/${unit}) instead.`
            : `We swapped in ${itemLabel} (€${Number(item.price || 0).toFixed(2)}/${unit}) for "${item.requested || 'your requested item'}".`;
          if (itemUnfamiliarQ) {
            itemUnfamiliarQ.points = round3(Number(itemUnfamiliarQ.points || 0) + 30);
            itemUnfamiliarQ.message = `${subMsg} It's also your first time ordering it (${round3(item.quantity)} ${unit} for €${itemCost}) — does this replacement and amount look good?`;
          } else {
            addQuestion('substitution', 30, item, `${subMsg} Does that replacement work for you?`);
          }
        }
      }
      if (!subFlagged) {
        addCheck('pass', 'substitution', 0, `${itemLabel} directly satisfies "${item.requested || lineObj?.query || itemLabel}" without brand/type conflict.`);
      }

      if (item.reliability != null && Number(item.reliability) < 0.85) {
        const relPts = round3(Math.max(10, (0.85 - Number(item.reliability)) * 100));
        reliabilityPts = Math.max(reliabilityPts, relPts);
        addCheck('flag', 'lowReliability', relPts, `${itemLabel} delivery reliability is ${round3(Number(item.reliability) * 100)}% (< 85% threshold, +${relPts} pts).`);
        addQuestion(
          'lowReliability',
          relPts,
          item,
          `Supplier delivery reliability for ${itemLabel} is a bit shaky (${round3(Number(item.reliability) * 100)}%). Are you okay waiting on it, or would you rather swap or drop it?`
        );
      } else if (item.reliability != null) {
        addCheck('pass', 'lowReliability', 0, `${itemLabel} delivery reliability is ${round3(Number(item.reliability) * 100)}% (>= 85%).`);
      }

      if (item.carbon != null && Number(item.carbon) >= 10) {
        const carbPts = round3(Math.min(40, Number(item.carbon) * 1.5));
        carbonPts = Math.max(carbonPts, carbPts);
        addCheck('flag', 'highCarbon', carbPts, `${itemLabel} carbon footprint is ${round3(item.carbon)} kg CO₂/kg (>= 10 threshold, +${carbPts} pts).`);
        addQuestion(
          'highCarbon',
          carbPts,
          item,
          `${itemLabel} has a fairly high carbon footprint (${round3(item.carbon)} kg CO₂/kg). Are you okay keeping it, or would you prefer another option?`
        );
      } else if (item.carbon != null) {
        addCheck('pass', 'highCarbon', 0, `${itemLabel} carbon footprint is ${round3(item.carbon)} kg CO₂/kg (< 10).`);
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
    const minOrderTotal = Number(order.buyerHistory?.minOrderTotal || 0);
    let spendFlagged = false;
    if (total > spendCap) {
      spendFlagged = true;
      const pts = round3(35 + 100 * ((total - spendCap) / spendCap));
      points += pts;
      reasons.push(`Order total €${total.toFixed(2)} exceeds €${spendCap.toFixed(2)} baseline (+${pts})`);
      addCheck('flag', 'highSpend', pts, `Order total €${total.toFixed(2)} exceeds buyer spend cap of €${spendCap.toFixed(2)} (+${pts} pts).`);
      let suggestedSpendQty = topCostItem?.quantity;
      if (topCostItem && Number(topCostItem.price) > 0) {
        const lot = Number(topCostItem.lot) > 0 ? Number(topCostItem.lot) : 1;
        const otherCost = Math.max(0, total - Number(topCostItem.lineTotal ?? topCostItem.quantity * topCostItem.price));
        const budgetForTop = Math.max(lot * Number(topCostItem.price), spendCap - otherCost);
        const rawTarget = Math.floor(budgetForTop / Number(topCostItem.price) / lot) * lot;
        suggestedSpendQty = round3(Math.max(lot, Math.min(Number(topCostItem.quantity), rawTarget || lot)));
      }
      addQuestion(
        'highSpend',
        pts,
        topCostItem,
        `This order comes out to €${total.toFixed(2)}, which is above your €${spendCap.toFixed(2)} spending baseline${topCostItem ? ` (mainly ${round3(topCostItem.quantity)} ${topCostItem.unit || 'units'} of ${topCostItem.name || topCostItem.productId} at €${Number(topCostItem.lineTotal ?? topCostItem.quantity * topCostItem.price).toFixed(2)})` : ''}. Are you comfortable with that total, or want to trim the amount / swap items?`,
        { suggestedQty: suggestedSpendQty }
      );
    }

    if (minOrderTotal > 0 && total > 0 && total < 0.4 * minOrderTotal) {
      spendFlagged = true;
      const pts = round3(20 + 15 * (minOrderTotal / Math.max(total, 0.01) - 2.5));
      points += pts;
      reasons.push(`Order total €${total.toFixed(2)} unusually small vs €${minOrderTotal.toFixed(2)} prior baseline (+${pts})`);
      addCheck('flag', 'lowSpend', pts, `Order total €${total.toFixed(2)} is well below usual minimum order total of €${minOrderTotal.toFixed(2)} (+${pts} pts).`);
      const targetItem = topCostItem || items[0];
      let suggestedLowQty = targetItem?.quantity;
      if (targetItem && Number(targetItem.price) > 0) {
        const lot = Number(targetItem.lot) > 0 ? Number(targetItem.lot) : 1;
        const needed = Math.ceil((minOrderTotal / Number(targetItem.price)) / lot) * lot;
        suggestedLowQty = round3(Math.max(Number(targetItem.quantity) + lot, needed));
      }
      addQuestion(
        'lowSpend',
        pts,
        targetItem,
        `Just checking — at €${total.toFixed(2)}, this order is much smaller than your usual €${minOrderTotal.toFixed(2)}+ orders. Still want to send it through as-is, or add a bit more?`,
        { suggestedQty: suggestedLowQty, allowSubstitution: false }
      );
    }
    if (!spendFlagged && items.length > 0) {
      addCheck('pass', 'spendBaseline', 0, `Order total €${total.toFixed(2)} is within €${spendCap.toFixed(2)} spend cap${minOrderTotal > 0 ? ` (usual min €${minOrderTotal.toFixed(2)})` : ''}.`);
    }

    if (points === 0) {
      points = 5;
      reasons.push(items.length ? 'Matches regular pattern' : 'Routine procurement quantities');
    }

    return {
      score: round3(points),
      reason: reasons.join(' · '),
      questions,
      checks
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
    status: score > limit || order.incomplete || order.budget_overrun ? 'PENDING_APPROVAL' : 'APPROVED'
  };
}
