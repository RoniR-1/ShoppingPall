const newGuestId=()=>`guest-${Array.from(crypto.getRandomValues(new Uint8Array(16)),byte=>byte.toString(16).padStart(2,'0')).join('')}`;
let user=(localStorage.getItem('activeBuyer')||'').trim();
if(!user||user==='demo-buyer'){user=newGuestId();localStorage.setItem('activeBuyer',user);}
document.getElementById('buyer-label').textContent=user;
document.getElementById('new-session').onclick=()=>{localStorage.setItem('activeBuyer',newGuestId());location.reload();};
const sessionStartedAt=Date.now();
const connectionError='Cannot reach the portal. Start npm run web; this page will reconnect automatically.';
const $=id=>document.getElementById(id);
let inventory=[];
let inventoryRules=[];
let inventoryDirty=false;
function showInventory(){const item=inventory.find(p=>p.id===$('inventory-product').value);$('inventory-current').textContent=item?`Current quantity: ${item.on_hand} ${item.unit}`:'No products available';if(!inventoryDirty)$('inventory-amount').value=item?.on_hand??'';$('inventory-edit').disabled=!item;}
$('inventory-product').onchange=()=>{inventoryDirty=false;$('inventory-status').textContent='';showInventory();};
$('inventory-amount').oninput=()=>{inventoryDirty=true;};
$('inventory').onsubmit=e=>{e.preventDefault();const item=inventory.find(p=>p.id===$('inventory-product').value);if(!item)return;const input=$('inventory-amount');run(async()=>{if(input.value.trim()===''||!input.checkValidity())throw Error('Enter a non-negative quantity');await api('',{action:'snapshot',id:item.id,on_hand:Number(input.value)});inventoryDirty=false;$('inventory-status').textContent=`${item.name} quantity saved.`;});};
$('inventory-edit').onclick=()=>{const item=inventory.find(p=>p.id===$('inventory-product').value);if(!item)return;const rule=inventoryRules.find(r=>r.product_id===item.id);$('rule').elements.query.value=item.name;syncQuantity();$('rule').elements.minimum.value=rule?.minimum??10;$('rule').elements.target.value=rule?.target??20;$('rule').elements.max_price.value=rule?.max_price??'';$('rule').elements.price_quantity.value=rule?.price_quantity??1;$('rule').elements.currency.value=rule?.currency||'EUR';$('rule').elements.price_unit.value=rule?.price_unit||item.unit;$('rule').scrollIntoView({behavior:'smooth',block:'center'});$('rule').elements.minimum.focus({preventScroll:true});};
function syncQuantity(){const item=inventory.find(p=>p.name===$('rule').elements.query.value);const form=$('rule').elements;form.on_hand.value=item?.on_hand??0;const previous=form.price_unit.value;const units=item?[...new Set([item.unit,item.baseUnit,'KGM','GRM','LTR','MLT',...(item.units||[]).filter(u=>u.sizeInBaseUnits>0).map(u=>u.unitId)].filter(Boolean))]:[];form.price_unit.replaceChildren(...units.map(unit=>{const option=node('option',({KGM:'kg — kilogram',GRM:'g — gram',LTR:'L — litre',MLT:'mL — millilitre',ST:'ST — sales unit'})[unit]||unit);option.value=unit;return option;}));form.price_unit.value=units.includes(previous)?previous:item?.unit||'';$('rule-units').textContent=item?`Stock unit: ${item.unit}. Base unit: ${item.baseUnit||item.unit}. Order quantity step: ${item.allowedLotSize||1} ${item.unit}. Demo net contents per sales unit: ${item.net_contents?.kg?item.net_contents.kg+' kg':item.net_contents?.litres?item.net_contents.litres+' L':'unknown'}. Weight and volume are not interchangeable.`:'';}
$('rule').elements.query.onchange=syncQuantity;
async function api(path='',body){let r;try{r=await fetch('/portal/managed-agent'+path+(path?'':'?user_id='+user),{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Data-Source':'demo'},body:body?JSON.stringify({user_id:user,...body}):undefined,signal:AbortSignal.timeout(15000)});}catch{throw Error(connectionError);}const raw=await r.text();let data;try{data=JSON.parse(raw);}catch{throw Error('Agent endpoint unavailable. Restart the portal server and reload this page.');}if(!r.ok)throw Error(data.error||'Request failed');return data;}
async function run(fn){try{$('error').textContent='';await fn();await refresh();}catch(e){$('error').textContent=e.message;}}
function node(tag,text){const el=document.createElement(tag);el.textContent=text;return el;}
async function refresh(){const s=await api();if($('error').textContent===connectionError||$('error').textContent==='Middle layer unavailable')$('error').textContent='';
inventory=s.inventory||[];
const select=$('rule').elements.query;const selected=select.value;
select.replaceChildren(...inventory.map(p=>{const option=node('option',p.name);option.value=p.name;return option;}));if(inventory.some(p=>p.name===selected))select.value=selected;syncQuantity();
inventoryRules=s.preview;
const productSelect=$('inventory-product');const productId=productSelect.value;
productSelect.replaceChildren(...inventory.map(p=>{const option=node('option',p.name);option.value=p.id;return option;}));
if(inventory.some(p=>p.id===productId))productSelect.value=productId;
showInventory();
const table=document.createElement('table');
table.setAttribute('aria-label','Replenishment rule summaries');
const head=document.createElement('thead');const headings=document.createElement('tr');
for(const title of ['Product','Position','Minimum','Target','Proposed','Price cap','Status']){const th=node('th',title);th.scope='col';headings.append(th);}head.append(headings);
const body=document.createElement('tbody');
for(const r of s.preview){const row=document.createElement('tr');const cap=r.max_price!=null?`${r.currency||'EUR'} ${r.max_price} per ${r.price_quantity} ${r.price_unit||r.sales_unit||'sales units'}`:'—';for(const value of [r.query,r.position,r.minimum,r.target,r.quantity,cap,r.episode?'Awaiting approval or reconciliation; duplicate ordering paused.':'—'])row.append(node('td',value));body.append(row);}
table.append(head,body);$('preview').replaceChildren(table);
$('activity').replaceChildren(...s.activity.filter(a=>Date.parse(a.at)>=sessionStartedAt).reverse().map(a=>{const d=document.createElement('details');const o=s.orders.find(o=>o.id===a.order_id);d.append(node('summary',`${a.at} · ${o?.status==='APPROVED'?'SIMULATED_PLACED':o?.status||a.status} · ${a.message||a.context?.why.trigger||''}`),node('pre',JSON.stringify(a,null,2)));return d;}));
$('approvals').replaceChildren(...s.orders.filter(o=>o.context?.agent?.type==='managed'&&o.status==='PENDING_APPROVAL').map(o=>{const d=node('div',`${o.reason} · ${o.items.map(i=>i.quantity+' '+i.name).join(', ')}`);d.className='order-card';if(o.incomplete)d.append(node('p','Resolve missing items in the procurement portal.'));else for(const action of ['approve','reject']){const b=node('button',action);b.className=action==='approve'?'primary-btn':'ghost-btn';b.style.margin='10px 8px 0 0';b.onclick=()=>run(async()=>{const r=await fetch(`/portal/orders/${o.id}/${action}`,{method:'POST',headers:{'Content-Type':'application/json','X-Data-Source':'demo'},body:JSON.stringify({user_id:user})});const data=await r.json();if(!r.ok)throw Error(data.error);});d.append(b);}return d;}));if(!$('approvals').childElementCount){const empty=node('p','No orders awaiting approval.');empty.className='empty';$('approvals').append(empty);}if(!$('activity').childElementCount){const empty=node('p','No activity yet this session.');empty.className='empty';$('activity').append(empty);}}
document.querySelectorAll('[data-action]').forEach(b=>b.onclick=()=>run(()=>api('',{action:b.dataset.action})));
$('rule').onsubmit=e=>{e.preventDefault();const r=Object.fromEntries(new FormData(e.target));for(const k of ['minimum','target','on_hand','price_quantity'])r[k]=Number(r[k]);r.max_price=r.max_price===''?null:Number(r.max_price);run(async()=>{await api('',{action:'rule',rule:r});$('rule-draft').textContent='Rule saved.';});};
let chatDraftReady=false;
$('open-agent-chat').onclick=()=>{$('agent-chat').showModal();$('chat').elements.text.focus();};
$('close-agent-chat').onclick=()=>$('agent-chat').close();
$('agent-chat').addEventListener('close',()=>{if(chatDraftReady){chatDraftReady=false;$('rule').scrollIntoView({behavior:'smooth',block:'center'});$('rule').elements.minimum.focus({preventScroll:true});}});
$('chat').onsubmit=async e=>{e.preventDefault();const form=e.currentTarget;const text=new FormData(form).get('text');const button=form.querySelector('button');button.disabled=true;button.textContent='Sending…';const response=node('p','Preparing your rule…');$('reply').replaceChildren(response);try{const result=await api('/chat',{text});response.textContent=result.message;if(result.proposal){$('rule').elements.query.value=result.proposal.query;syncQuantity();for(const [k,v]of Object.entries(result.proposal)){const input=$('rule').elements.namedItem(k);if(input)input.value=v??'';}$('rule-draft').textContent='Draft filled from your instruction. Edit any field, then save to apply.';chatDraftReady=true;}}catch(e){response.textContent=e.message;}finally{button.disabled=false;button.textContent='Send instruction';}};
run(async()=>{});setInterval(()=>{if(document.activeElement?.matches('input,select')||$('chat').querySelector('button').disabled)return;refresh().catch(e=>{$('error').textContent=e.message;});},10000);
