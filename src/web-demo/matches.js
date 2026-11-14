const words=s=>String(s).toLowerCase().match(/[a-z0-9]+/g)?.map(w=>w.length>3&&w.endsWith('s')?w.slice(0,-1):w)||[];
function distance(a,b){let row=Array.from({length:b.length+1},(_,i)=>i);for(let i=0;i<a.length;i++){const next=[i+1];for(let j=0;j<b.length;j++)next.push(Math.min(next[j]+1,row[j+1]+1,row[j]+(a[i]===b[j]?0:1)));row=next;}return row[b.length];}
export function searchTokens(query){return words(query).filter(w=>w.length>=3);}
export function closestProducts(query,products){
 const terms=searchTokens(query);if(!terms.length)return [];
 return products.map(p=>{
 const tokens=words(p.name);const scores=terms.map(t=>Math.max(0,...tokens.map(w=>t===w?1:t.length>=5&&distance(t,w)<=2?0.7:0)));
 // Every named ingredient/constraint must match; relax only optional style words.
 const required=terms.map((t,i)=>({t,score:scores[i]})).filter(x=>!['extra','light','dark','white','milk'].includes(x.t)||terms.length===1);
 if(!required.length||required.some(x=>x.score===0))return null;
 return {p,score:scores.reduce((a,b)=>a+b,0)/terms.length};
 }).filter(Boolean).sort((a,b)=>b.score-a.score||a.p.name.localeCompare(b.p.name)).slice(0,7).map(x=>x.p);
}
