const $=id=>document.getElementById(id);let mode='direct',dataSource='demo';
const esc=s=>String(s??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path,body){const r=await fetch('/portal'+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Data-Source':dataSource},body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw Error(data.error);return data;}
async function run(fn){document.querySelectorAll('button').forEach(b=>b.disabled=true);try{await fn();}catch(e){if(!$('execution').hidden)$('steps').innerHTML='<li>Request stopped · '+esc(e.message)+'</li>';$('message').textContent=e.message;$('message').style.display='block';}finally{document.querySelectorAll('button').forEach(b=>b.disabled=false);$('reset').disabled=dataSource==='real';if(dataSource==='real')document.querySelectorAll('[data-action="approve"]').forEach(b=>b.disabled=true);}}
function show(o){$('execution').hidden=false;$('item-summary').innerHTML=itemSummary(o);$('steps').innerHTML=o.steps.map(s=>`<li>${esc(s)}</li>`).join('');$('raw').textContent=JSON.stringify(o,null,2);$('message').textContent=`${o.status.replaceAll('_',' ')} · ${o.reason}`;$('message').style.display='block';}
async function refresh(){await refreshCatalog();const orders=await api('/orders?user_id='+encodeURIComponent($('user').value));const pending=orders.filter(o=>o.status==='PENDING_APPROVAL');$('count').textContent=pending.length;$('orders').innerHTML=pending.length?pending.map(o=>`<article class="order" data-id="${o.id}"><span class="badge">Needs review · ${o.score}/${o.threshold}</span><h3>${esc(o.lines.map(l=>l.quantity+' × '+l.query).join(', '))}</h3><p>${esc(o.reason)}</p><table><thead><tr><th>Product</th><th>Qty / unit</th><th>Unit price</th><th>CO₂ kg/kg</th><th>Reliability</th></tr></thead><tbody>${o.items.map(i=>`<tr><td>${esc(i.name)}${i.requested?'<br><small>For: '+esc(i.requested)+(i.substitution?' · Approved substitute':' · Catalog match')+'</small>':''}</td><td>${i.quantity} ${esc(i.unit)}</td><td>€${Number(i.price).toFixed(2)}</td><td>${esc(i.carbon)}</td><td>${i.reliability==null?'—':Math.round(i.reliability*100)+'%'}</td></tr>`).join('')}</tbody></table>${o.issues.map(i=>`<p>${esc(o.lines[i.index].query)}: ${esc(i.reason)} · missing ${i.shortfall}</p>${i.options.length?`<label>Closest items for ${esc(o.lines[i.index].query)} <select data-line="${i.index}"><option value="">Choose an item…</option>${i.options.slice(0,7).map(p=>`<option value="${p.productId}">${esc(p.name)} · €${p.price} · ${p.available} available</option>`).join('')}</select></label>`:''}`).join('')}${o.incomplete&&o.items.length?'<p><label><input type="checkbox" class="partial"> Accept only the available quantities</label></p>':''}<div class="actions"><button class="primary" data-action="approve" ${dataSource==='real'?'disabled title="Supplier checkout is unavailable"':''}>${o.incomplete?'Use selected items':'Approve order'}</button><button data-action="reject">Reject</button></div></article>`).join(''):'<div class="empty">All clear. Orders needing your judgment will appear here.</div>';}
$('orders').onclick=e=>{const action=e.target.dataset.action;if(!action)return;run(async()=>{const el=e.target.closest('.order');const choices=Object.fromEntries([...el.querySelectorAll('select')].filter(s=>s.value).map(s=>[s.dataset.line,s.value]));show(await api(`/orders/${el.dataset.id}/${action}`,{user_id:$('user').value,choices,acceptPartial:el.querySelector('.partial')?.checked||false}));await refresh();});};
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{mode=b.dataset.mode;resetExecution();document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('active',x===b));$('hint').textContent=mode==='agent'?'Describe your recipe or goal. The configured model translates it into sales units.':'Enter quantities in sales units, separated by semicolons.';});
async function submit(){$('execution').hidden=false;$('raw').textContent='Request in progress';$('steps').innerHTML='<li>Checking your request…</li>';show(await api('/requests',{user_id:$('user').value,text:$('prompt').value,mode,force_flag:$('risk').value==='suspicious',demo_unavailable:$('risk').value==='unavailable'}));await refresh();}
$('submit').onclick=()=>run(()=>submit());
$('toggle').onclick=()=>{$('setup').hidden=!$('setup').hidden;$('setup').style.display=$('setup').hidden?'none':'';};
$('save').onclick=()=>run(async()=>{await api('/config',{threshold:Number($('threshold').value)});$('message').textContent='Threshold updated';$('message').style.display='block';});
$('reset').onclick=()=>run(async()=>{await api('/config',{threshold:Number($('threshold').value),stock:$('stock').value});$('message').textContent='Catalog seeded and stock reset';$('message').style.display='block';await refresh();});
$('refresh').onclick=()=>run(refresh);$('user').onchange=()=>run(refresh);run(async()=>{$('threshold').value=(await api('/config')).threshold;await refresh();});

function resetExecution(){$('execution').hidden=true;$('steps').innerHTML='';$('raw').textContent='No request yet.';$('message').style.display='none';}
$('prompt').oninput=resetExecution;$('risk').onchange=resetExecution;

function itemSummary(o){
 const rows=[...o.items.map(i=>({requested:i.requested||i.name,name:i.name,status:i.substitution?'Approved substitute':'Available',quantity:i.quantity})),...o.issues.map(i=>({requested:o.lines[i.index].query,name:i.reason==='Substitution needs approval'?'Choose a substitute below':'No confirmed match / stock',status:'Not available in full',quantity:i.shortfall}))];
 const render=items=>items.map(i=>`<div class="item-row"><div><strong>${esc(i.requested)}</strong><span>${esc(i.name)}</span></div><div><span class="badge">${esc(i.status)}</span><small>${esc(i.quantity)} sales units</small></div></div>`).join('');
 return '<h3>Items & availability</h3>'+render(rows.slice(0,7))+(rows.length>7?`<details><summary>Show ${rows.length-7} more items</summary>${render(rows.slice(7))}</details>`:'');
}

async function refreshCatalog(){
 const data=await api('/catalog-overview?user_id='+encodeURIComponent($('user').value));
 const stock=p=>p.quantity==null?'Unknown':`${esc(p.quantity)} ${esc(p.sales_unit)}`;
 $('catalog-products').innerHTML=`<p class="small">${data.mocked?'Current demo stock':'Live Valio availability · real database'}</p><table><thead><tr><th>Product</th><th>Quantity available</th><th>Mapped substitutes → quantity available</th></tr></thead><tbody>${data.products.map(p=>`<tr><td><strong>${esc(p.name)}</strong><br><small>${esc(p.id)}</small></td><td>${stock(p)}</td><td>${p.substitutions.length?p.substitutions.map(s=>`<div class="catalog-substitute">↳ ${esc(s.name)} <strong>${stock(s)}</strong></div>`).join(''):'No mapped substitute'}</td></tr>`).join('')}</tbody></table>`;
}
$('catalog-refresh').onclick=()=>run(refreshCatalog);

$('source').onchange=()=>run(async()=>{
 const previous=dataSource;dataSource=$('source').value;
 try{await api('/config');}catch(e){dataSource=previous;$('source').value=previous;throw e;}
 resetExecution();$('source-status').textContent=dataSource==='demo'?'Demo database':'Real database · preview only';
 $('stock').disabled=dataSource==='real';$('risk').querySelector('[value="unavailable"]').disabled=dataSource==='real';
 if(dataSource==='real'&&$('risk').value==='unavailable')$('risk').value='normal';
 $('orders').innerHTML='';$('catalog-products').textContent='Loading selected database…';await refresh();
});
