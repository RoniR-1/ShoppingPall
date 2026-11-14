import 'dotenv/config';
const endpoint=process.env.LUNA_BASE_URL.trim().replace(/\/+$/,'')+'/chat/completions';
const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.LUNA_API_KEY}`},body:JSON.stringify({model:process.env.LUNA_MODEL,messages:[{role:'user',content:'Return JSON only: {"lines":[{"query":"milk","quantity":1}]}'}],response_format:{type:'json_object'}}),signal:AbortSignal.timeout(60000)});
const body=await response.text();console.log(JSON.stringify({endpoint,status:response.status,body:body.replaceAll(process.env.LUNA_API_KEY||'__missing__','[redacted]').slice(0,4000)}));
