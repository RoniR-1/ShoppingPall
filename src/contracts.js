import { z } from 'zod';
export const id = z.string().trim().min(1).max(100);
export const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
  const d = new Date(v); return !isNaN(d) && d.toISOString().slice(0, 10) === v;
}, 'Expected a real calendar date');
export const productsRequest = z.object({ customer: id, requestedDate: date,
  products: z.array(id).min(1).max(1000).refine(v => new Set(v).size === v.length, 'Duplicate products') }).strict();
export const selectedRequest = z.object({ requestedDate: date, products: productsRequest.shape.products,
  selection_ids: z.array(z.string().uuid()).min(1).max(100) }).strict();
export const orderRequest = z.object({ quote_id: z.string().uuid(), force_flag: z.boolean().default(false),
  force_flag_reason: z.string().trim().min(1).max(300).optional(),
  items: z.array(z.object({ productId: id, quantity: z.number().finite().positive().max(1000000), substitutedFrom: id.optional() }).strict()).min(1).max(1000)
    .refine(v => new Set(v.map(i => i.productId)).size === v.length, 'Duplicate order products') }).strict();
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function assert(condition, status, message) { if (!condition) throw new HttpError(status, message); }
export function round3(value) {
  if (value === null || value === undefined || value === '') return value;
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(3)) : value;
}
// Parses an order-wide budget such as "budget of €10", "budget 1.000,50 EUR", "€25 budget" or "max 40 euros".
// Per-unit limits ("max €3 per kg") are not total budgets and are ignored.
const MONEY = String.raw`(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?(?![.,]?\d)|\d+(?:[.,]\d{1,2})?(?![.,]?\d))`;
const CURRENCY = String.raw`(?:€|eur(?:os?)?\b)`;
const NOT_PER_UNIT = String.raw`(?!\s*(?:\/|per\b|each\b|a\s+(?:kg|kilo|piece|unit|litre|liter)\b))`;
const AMOUNT = String.raw`(?:${CURRENCY}\s*${MONEY}|${MONEY}\s*${CURRENCY})`;
const BUDGET_PATTERNS = [
  // A bare number after "budget" only counts when it ends the clause, so "budget: 10 eggs" is not a budget.
  new RegExp(String.raw`\bbudget\b(?:\s+(?:of|is|under|up\s+to|max(?:imum)?))?\s*[:=]?\s*(?:${AMOUNT}|${MONEY}(?=\s*(?:$|[,;!?)]|\.(?!\d))))${NOT_PER_UNIT}`, 'i'),
  new RegExp(String.raw`\b(?:max(?:imum)?|no\s+more\s+than|under|within|up\s+to|at\s+most)\s*${AMOUNT}${NOT_PER_UNIT}`, 'i'),
  new RegExp(String.raw`${AMOUNT}\s*(?:total\s+)?(?:budget|max(?:imum)?)\b`, 'i')
];
function parseMoney(raw) {
  const decimal = raw.match(/[.,](\d{1,2})$/);
  const whole = (decimal ? raw.slice(0, -decimal[0].length) : raw).replace(/[.,]/g, '');
  return Number(decimal ? `${whole}.${decimal[1]}` : whole);
}
function findBudget(text) {
  const source = String(text ?? '');
  let best = null;
  for (const pattern of BUDGET_PATTERNS) {
    const match = source.match(pattern);
    const raw = match?.slice(1).find(Boolean);
    const value = raw ? parseMoney(raw) : NaN;
    if (Number.isFinite(value) && value >= 0 && (!best || match.index < best.index)) {
      best = { value, index: match.index, length: match[0].length };
    }
  }
  return best;
}
export function parseBudget(text) {
  return findBudget(text)?.value ?? null;
}
function stripClause(source, found) {
  if (!found) return source;
  const before = source.slice(0, found.index).replace(/(?:[\s,;:(-]|\b(?:with|and|for|on|at|in|a|an|my|our|the|total|overall|order|of|please|it|them|i|we|need|want)\b)*$/i, '');
  const after = source.slice(found.index + found.length).replace(/^(?:[\s,;:.)!-]|\bplease\b)*/i, '');
  return [before, after].filter(Boolean).join(before && after ? ', ' : '').trim();
}
// Removes the budget clause so line parsers do not treat "total budget €10" as a product to search for.
export function stripBudget(text) {
  const source = String(text ?? '');
  return stripClause(source, findBudget(source));
}
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const DELIVERY_PREFIX = String.raw`(?:(?:to\s+be\s+|get\s+(?:it\s+|them\s+)?)?(?:delivered|delivery|deliver(?:\s+(?:it|them))?|arriv(?:e|ing|al)|shipped|shipping)\s+)?`;
const DELIVERY_PATTERNS = [
  [new RegExp(String.raw`\b${DELIVERY_PREFIX}(?:in|within)\s+(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten)\s+(days?|weeks?)\b`, 'i'),
    m => (/^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()]) * (/^week/i.test(m[2]) ? 7 : 1)],
  [new RegExp(String.raw`\b${DELIVERY_PREFIX}(?:by\s+)?tomorrow\b`, 'i'), () => 1]
];
function findDelivery(text) {
  const source = String(text ?? '');
  let best = null;
  for (const [pattern, toDays] of DELIVERY_PATTERNS) {
    const match = source.match(pattern);
    const days = match ? toDays(match) : NaN;
    if (Number.isSafeInteger(days) && days >= 0 && days <= 365 && (!best || match.index < best.index)) {
      best = { days, index: match.index, length: match[0].length };
    }
  }
  return best;
}
// Delivery window stated in the request ("delivered in 3 days", "within a week", "by tomorrow") as a YYYY-MM-DD deadline.
export function parseDeliveryDeadline(text, now = Date.now()) {
  const found = findDelivery(text);
  return found ? new Date(now + found.days * 86400000).toISOString().slice(0, 10) : null;
}
export function stripDelivery(text) {
  const source = String(text ?? '');
  return stripClause(source, findDelivery(source));
}
// Sustainability wording ("sustainable", "eco-friendly", "lowest CO2", "low carbon footprint"...). A bare "green" is
// deliberately ignored because it usually names a product ("green apples", "green beans").
const SUSTAINABLE = String.raw`(?:sustainab\w*|eco[-\s]?friendly|environment(?:ally)?[-\s]friendly|climate[-\s](?:friendly|smart)|planet[-\s]friendly|`
  + String.raw`low[-\s](?:carbon|co2|co₂|emissions?)(?:\s+footprint)?|carbon[-\s](?:neutral|friendly)|`
  + String.raw`(?:lowest|lower|less|least|minimi[sz]e|reduce|small(?:er|est)?)\s+(?:the\s+)?(?:carbon|co2|co₂|emissions?)(?:\s+footprint|\s+emissions)?|`
  + String.raw`greenest|green(?:er)?\s+(?:options?|choices?|products?|sourcing))`;
const SUSTAINABILITY = new RegExp(String.raw`(?:\b(?:please\s+)?(?:(?:make|keep)\s+it|prefer(?:ably)?|prioriti[sz]e|focus\s+on|choose|pick|go\s+for|with(?:\s+(?:a|the))?|and|as)\s+)*`
  + String.raw`(?:\b(?:more|most|very|the)\s+)?\b${SUSTAINABLE}(?:\s+(?:please|options?|choices?|products?|sourcing|footprint|ones?))*\b`, 'gi');
export function parseSustainability(text) {
  return new RegExp(SUSTAINABILITY.source, 'i').test(String(text ?? ''));
}
// Removes sustainability wording whether it is its own clause ("10 eggs, sustainable please") or inline ("10 eco-friendly eggs").
export function stripSustainability(text) {
  const source = String(text ?? '');
  if (!parseSustainability(source)) return source;
  return source.replace(SUSTAINABILITY, ' ')
    .split(/([,;\n])/).reduce((parts, piece, i) => {
      if (i % 2) { parts.sep = piece; return parts; }
      const clean = piece.replace(/\s+/g, ' ').replace(/^\s*(?:and|please)\b\s*|\s*\b(?:and|please)\s*$/gi, '').trim();
      if (clean) parts.out += (parts.out ? `${parts.sep === '\n' ? '\n' : parts.sep + ' '}` : '') + clean;
      return parts;
    }, { out: '', sep: ',' }).out.replace(/[\s.!]+$/, '');
}
// Removes order-wide constraints (budget, delivery window, sustainability) so only product lines remain for parsing.
export function stripOrderConstraints(text) {
  return stripSustainability(stripDelivery(stripBudget(text)));
}
