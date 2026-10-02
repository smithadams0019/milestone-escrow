import '/home/rogerkorantenng/dev/Hackathons/paypal/projects/cancelled-op/backend/test/envload.js';
import * as pp from '/home/rogerkorantenng/dev/Hackathons/paypal/projects/cancelled-op/backend/src/paypal.js';
const rid=()=>Math.random().toString(16).slice(2,8);
const tok=await pp.getToken();
async function raw(batch, reqId, note, email='sb-patient@personal.example.com'){
  const r=await fetch(process.env.PAYPAL_API+'/v1/payments/payouts',{method:'POST',headers:{Authorization:'Bearer '+tok,'Content-Type':'application/json',...(reqId?{'PayPal-Request-Id':reqId}:{})},body:JSON.stringify({sender_batch_header:{sender_batch_id:batch},items:[{recipient_type:'EMAIL',amount:{value:'1.00',currency:'GBP'},receiver:email,note,sender_item_id:batch}]})});
  return [r.status, await r.json()];
}
// 1. Request-Id replay: same Request-Id, SAME body
const a='rq-'+rid(); const x=await raw(a,a,'n'); const y=await raw(a,a,'n');
console.log('A same id+body:', x[0], x[1].batch_header?.payout_batch_id, '| replay:', y[0], y[1].batch_header?.payout_batch_id||JSON.stringify(y[1]).slice(0,200));
// 2. same Request-Id, DIFFERENT sender_batch_id
const b='rq-'+rid(); const z=await raw(b+'x',a,'n');
console.log('B same Request-Id, new sender_batch_id:', z[0], z[1].batch_header?.payout_batch_id||JSON.stringify(z[1]).slice(0,200));
// 3. new Request-Id, same sender_batch_id
const w=await raw(a,'other-'+rid(),'n'); console.log('C same sender_batch_id, new Request-Id:', w[0], JSON.stringify(w[1]).slice(0,160));
// 4. magic values
for (const m of ['ERRPYO001','ERRPYO003','ERRPYO004','ERRPYO005','ERRPYO006','ERRPYO007','ERRPYO008','ERRPYO009','ERRPYO010']) {
  const id='mg-'+rid(); const r=await raw(id,id,m);
  let s=''; if(r[0]<300){ await new Promise(q=>setTimeout(q,9000)); const g=await pp.getBatch(r[1].batch_header.payout_batch_id); s=`batch=${g.batchStatus} item=${g.itemStatus} err=${g.errors&&g.errors.name}`; } else s=r[1].name;
  console.log(m, r[0], s);
}
