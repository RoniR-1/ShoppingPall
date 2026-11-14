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
// Removes order-wide constraints (budget, delivery window, sustainability, origin) so only product lines remain for parsing.
export function stripOrderConstraints(text) {
  return stripOrigin(stripSustainability(stripDelivery(stripBudget(text))));
}
// Country of origin requests. Codes match products.country_of_origin (ISO 3166-1 alpha-2, lower case).
// Adjectives such as "French" or "Greek" only count in an explicit origin context ("French only", "prefer French",
// "from France"), so product names like "French fries" or "Greek yoghurt" are left alone.
const COUNTRIES = [
  ['fi', 'Finland', 'finnish'], ['se', 'Sweden', 'swedish'], ['no', 'Norway', 'norwegian'], ['dk', 'Denmark', 'danish'],
  ['ee', 'Estonia', 'estonian'], ['lv', 'Latvia', 'latvian'], ['lt', 'Lithuania', 'lithuanian'], ['de', 'Germany', 'german'],
  ['fr', 'France', 'french'], ['it', 'Italy', 'italian'], ['es', 'Spain', 'spanish'], ['pt', 'Portugal', 'portuguese'],
  ['nl', 'the Netherlands', 'netherlands', 'holland', 'dutch'], ['be', 'Belgium', 'belgian'], ['pl', 'Poland', 'polish'],
  ['at', 'Austria', 'austrian'], ['ch', 'Switzerland', 'swiss'], ['cz', 'Czechia', 'czech republic', 'czech'],
  ['sk', 'Slovakia', 'slovak', 'slovakian'], ['hu', 'Hungary', 'hungarian'], ['gr', 'Greece', 'greek'], ['ie', 'Ireland', 'irish'],
  ['gb', 'the United Kingdom', 'united kingdom', 'uk', 'great britain', 'britain', 'british', 'england', 'english', 'scotland', 'scottish', 'wales', 'welsh'],
  ['us', 'the United States', 'united states', 'usa', 'american'], ['ca', 'Canada', 'canadian'], ['mx', 'Mexico', 'mexican'],
  ['br', 'Brazil', 'brazilian'], ['ar', 'Argentina', 'argentinian', 'argentine'], ['cl', 'Chile', 'chilean'], ['pe', 'Peru', 'peruvian'],
  ['cn', 'China', 'chinese'], ['jp', 'Japan', 'japanese'], ['th', 'Thailand', 'thai'], ['vn', 'Vietnam', 'vietnamese'],
  ['in', 'India', 'indian'], ['tr', 'Turkey', 'turkish'], ['ma', 'Morocco', 'moroccan'], ['za', 'South Africa', 'south african'],
  ['nz', 'New Zealand', 'new zealand'], ['au', 'Australia', 'australian'], ['il', 'Israel', 'israeli'], ['eg', 'Egypt', 'egyptian'],
  ['ro', 'Romania', 'romanian'], ['bg', 'Bulgaria', 'bulgarian'], ['hr', 'Croatia', 'croatian'], ['si', 'Slovenia', 'slovenian'],
  ['cy', 'Cyprus', 'cypriot'], ['lu', 'Luxembourg'], ['ua', 'Ukraine', 'ukrainian'], ['is', 'Iceland', 'icelandic'],
  ['ph', 'the Philippines', 'philippines', 'filipino'], ['id', 'Indonesia', 'indonesian'], ['my', 'Malaysia', 'malaysian'],
  ['tw', 'Taiwan', 'taiwanese'], ['kr', 'South Korea', 'korea', 'korean'], ['lk', 'Sri Lanka', 'sri lankan'], ['sg', 'Singapore'],
  ['pk', 'Pakistan', 'pakistani'], ['bd', 'Bangladesh'], ['ae', 'the United Arab Emirates', 'united arab emirates', 'uae'],
  ['ke', 'Kenya', 'kenyan'], ['tn', 'Tunisia', 'tunisian'], ['mg', 'Madagascar'], ['ug', 'Uganda'], ['gh', 'Ghana', 'ghanaian'],
  ['cr', 'Costa Rica', 'costa rican'], ['gt', 'Guatemala', 'guatemalan'], ['ec', 'Ecuador', 'ecuadorian'],
  ['co', 'Colombia', 'colombian'], ['py', 'Paraguay'], ['jm', 'Jamaica', 'jamaican'], ['cu', 'Cuba', 'cuban'], ['do', 'the Dominican Republic', 'dominican republic']
];
const COUNTRY_BY_WORD = new Map(COUNTRIES.flatMap(([code, name, ...aliases]) =>
  [name.replace(/^the\s+/i, ''), ...aliases].map(word => [word.toLowerCase(), code])));
const COUNTRY_NAMES = new Map(COUNTRIES.map(([code, name]) => [code, name]));
const COUNTRY_WORD = String.raw`(?:the\s+)?(?:${[...COUNTRY_BY_WORD.keys()].sort((a, b) => b.length - a.length).map(w => w.replace(/\s+/g, String.raw`\s+`)).join('|')})`;
const COUNTRY_LIST = String.raw`(${COUNTRY_WORD}(?:\s*(?:,|\/|\bor\b|\band\b)\s*${COUNTRY_WORD})*)`;
const ORIGIN_VERB = String.raw`(?:from|made\s+in|grown\s+in|produced\s+in|sourced\s+from|of)\s+`;
const ORIGIN_NOUN = String.raw`(?:\s+(?:origin|products?|produce|goods|ones|items))?`;
const ORIGIN_PATTERNS = [
  // Strict: "English only", "only from Finland", "Finnish products only", "must be from Spain".
  [new RegExp(String.raw`\b(?:only|exclusively|strictly)\s+(?:${ORIGIN_VERB})?${COUNTRY_LIST}${ORIGIN_NOUN}\b`, 'i'), true],
  [new RegExp(String.raw`(?<!\bin\s)\b${COUNTRY_LIST}${ORIGIN_NOUN}\s+only\b`, 'i'), true],
  [new RegExp(String.raw`\b(?:must|has\s+to|have\s+to|needs?\s+to)\s+be\s+(?:${ORIGIN_VERB})?${COUNTRY_LIST}${ORIGIN_NOUN}\b`, 'i'), true],
  // Preference: "prefer Finnish", "from Finland if possible", "Finnish origin", "made in Italy".
  [new RegExp(String.raw`\b(?:prefer(?:ably|red|ring)?|ideally)\s+(?:${ORIGIN_VERB})?${COUNTRY_LIST}${ORIGIN_NOUN}(?:\s+if\s+possible)?\b`, 'i'), false],
  [new RegExp(String.raw`\b(?:from|made\s+in|grown\s+in|produced\s+in|sourced\s+from)\s+${COUNTRY_LIST}${ORIGIN_NOUN}(?:\s+if\s+possible)?\b`, 'i'), false],
  [new RegExp(String.raw`\b${COUNTRY_LIST}\s+(?:origin|if\s+possible|preferred)\b`, 'i'), false]
];
function countriesIn(list) {
  return [...new Set(list.toLowerCase().split(/\s*(?:,|\/|\bor\b|\band\b)\s*/)
    .map(word => COUNTRY_BY_WORD.get(word.replace(/^the\s+/, '').replace(/\s+/g, ' ').trim())).filter(Boolean))];
}
function findOrigins(text) {
  const source = String(text ?? '');
  const found = [];
  for (const [pattern, strict] of ORIGIN_PATTERNS) {
    const global = new RegExp(pattern.source, 'gi');
    for (const match of source.matchAll(global)) {
      const countries = countriesIn(match[1]);
      if (countries.length) found.push({ countries, strict, index: match.index, length: match[0].length });
    }
  }
  // Keep non-overlapping matches, earliest and longest first.
  found.sort((a, b) => a.index - b.index || b.length - a.length);
  return found.filter((m, i) => found.slice(0, i).every(prev => prev.index + prev.length <= m.index || m.index + m.length <= prev.index));
}
// { countries: ['fi'], strict: true } for "Finnish only"; strict is false for a preference such as "prefer Finnish".
export function parseOriginPreference(text) {
  const found = findOrigins(text);
  if (!found.length) return null;
  return { countries: [...new Set(found.flatMap(m => m.countries))], strict: found.some(m => m.strict) };
}
export function countryName(code) {
  // zy/zz/xs are not countries: the catalog uses them when origin varies or is unknown.
  if (['zy', 'zz', 'xs'].includes(String(code ?? '').toLowerCase())) return 'unknown origin';
  return COUNTRY_NAMES.get(String(code ?? '').toLowerCase()) ?? String(code ?? 'unknown').toUpperCase();
}
export function stripOrigin(text) {
  let source = String(text ?? '');
  // Strip from the end so earlier match positions stay valid.
  for (const match of findOrigins(source).reverse()) source = stripClause(source, match);
  return source;
}
