// Conservative vocabulary: relax a chocolate style, never the food itself.
export function normalizeQuery(query) {
 return query.toLowerCase().trim().replace(/\bbeers\b/g,'beer').replace(/\beggs\b/g,'egg').replace(/\bchocolate bars?\b/g,'chocolate');
}
export function directLines(text) {
 return text.trim().replace(/^(?:please\s+)?(?:i want|i need|order|buy|get me)\s+/i,'').split(/[,;\n]+|\s+and\s+(?=\d)/i).map(s=>{
 const m=s.trim().match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
 if(!m)throw Error('Enter quantities and items, for example “I want 5 beers and 2 chocolate bars”. Use Agent mode for recipes.');
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
