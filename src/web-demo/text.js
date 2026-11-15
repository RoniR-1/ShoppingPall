// Conservative vocabulary: relax a chocolate style, never the food itself.
export function normalizeQuery(query) {
 return query.toLowerCase().trim().replace(/\bbeers\b/g,'beer').replace(/\beggs\b/g,'egg').replace(/\bapples\b/g,'apple').replace(/\bchocolate bars?\b/g,'chocolate');
}
// Do not turn a request for a food or drink into an order for its serving vessel.
// Vessels remain available when the buyer explicitly asks for one.
export function compatibleProduct(request, product) {
 const vessels=/\b(?:jugs?|pitchers?|carafes?)\b/gi;
 const wanted=new Set((String(request).toLowerCase().match(vessels)||[]).map(x=>x.replace(/s$/, '')));
 return (String(product.name||'').toLowerCase().match(vessels)||[]).every(x=>wanted.has(x.replace(/s$/, '')));
}
export function concernsSelfHarm(text) {
 return /\b(?:kill|hurt|harm)\s+(?:myself|my\s*self)\b|\b(?:end|take)\s+my\s+(?:own\s+)?life\b|\b(?:commit|attempt)\s+suicide\b/i.test(String(text));
}
export function directLines(text) {
 return text.trim().replace(/^(?:please\s+)?(?:i want|i need|order|buy|get me)\s+/i,'').split(/[,;\n]+|\s+and\s+(?=\d)/i).map(s=>{
 const m=s.trim().match(/^(\d+(?:\.\d+)?)\s*(?:(?:kg|g|l|ml|pcs?|pieces?|bags?|boxes?)\s+(?:of\s+)?|(?:of\s+))?(.+)$/i);
 if(!m)throw Error('Could not parse request without Gemini API key; configure LUNA_API_KEY in .env.');
 return {quantity:Number(m[1]),query:normalizeQuery(m[2])};
 });
}
export function substitutionQuery(query) {
 const q=normalizeQuery(query);
 // Only relax style within chocolate. Preserve dietary/allergen constraints.
 if(/\b(?:vegan|free|allergen|organic|gluten|lactose|nut)\b/.test(q))return null;
 if(/^(?:(?:extra|light|dark|milk|white)\s+)+chocolate$/.test(q))return 'chocolate';
 return null;
}
