const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
// Isolate integration wiring from a real Prisma connection; delegates are mocked per test.
const unexpectedDatabaseCall = async () => { throw new Error('Unexpected database call in operator test'); };
global.__soporteExotimerPrisma = {
  conversation: { findUnique: unexpectedDatabaseCall, update: unexpectedDatabaseCall },
  message: { create: unexpectedDatabaseCall, findFirst: unexpectedDatabaseCall, findMany: unexpectedDatabaseCall },
  supportAction: { findMany: unexpectedDatabaseCall },
};
const { withOperatorAuthorization, openAuthorization, requireOperator } = require('./timingOperatorContext');
const { createOperatorSession, confirmationId, runOperator } = require('./timingOperator');
process.env.TIMING_OPERATOR_ENABLED = 'true';
const actor = () => ({ accountId: 42, competitionId: 634, organizationId: 5, userId: 'user-hmac', authorization: 'Bearer operator-token', expiresAt: Date.now()+300000 });

function seal(value, secret='test-key') {
  const iv=crypto.randomBytes(12), key=crypto.createHash('sha256').update(`timing-operator-v1:${secret}`).digest();
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from(`${value.competitionId}:${value.userId}`));
  const body=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join('.');
}

function harness(options={}) {
  const plans=[], calls=[]; let preview='preview-one', timeouts=options.timeouts || 0;
  const db={supportAction:{
    async create({data}) { const plan={id:plans.length+1,...structuredClone(data)};plans.push(plan);return structuredClone(plan); },
    async update({where,data}) { const row=plans.find(p=>p.id===where.id);Object.assign(row,structuredClone(data));return structuredClone(row); },
    async findUnique({where}) { return structuredClone(plans.find(p=>p.id===where.id)); },
    async findFirst({where}) { return structuredClone(plans.find(p=>p.conversationId===where.conversationId && p.input.key===where.input.equals)); },
  }};
  const request=async args=>{
    calls.push(structuredClone(args));
    if(args.path.endsWith('/context'))return {competition_id:634,participants:[{id:18,dorsal:18}],configs:[{id:7}],category_policies:[],has_finish_records:false};
    if(args.path.endsWith('/preview'))return {preview_token:preview,podium_changes:options.podium?[{group:'Individual M',before:[1,2,3],after:[18,1,2]}]:[],requires_confirmation:Boolean(options.risk),changed_results:[]};
    if(args.path.endsWith('/apply')) {if(timeouts-->0)throw new Error('Connection lost');return {synchronized:false,status:'pending',operation_id:args.data.operation_id};}
    if(args.path.includes('/status/'))throw Object.assign(new Error('Not found'),{response:{status:404}});
    if(args.path.endsWith('/18'))return {version:'version-one'};
    throw new Error(`Unexpected ${args.path}`);
  };
  const input={conversationId:1,messageId:2,text:'Cambia al dorsal 18. Hora 09:02:03.'};
  return { plans,calls,db,request,input,session:()=>createOperatorSession(input,{prisma:db,request}), changePreview:()=>preview='changed' };
}
const change={kind:'time',result_id:18,changes:{name_column:'loc_Meta',timeDateCurrent:'2026-11-21T09:02:03'},reason:'Hora exacta indicada por operador'};

test('large contexts retain full configuration and page participants without skipping rows',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness(), rows=Array.from({length:100},(_,i)=>({id:i+1,dorsal:i+1,controls:{raw:'x'.repeat(1000)}}));
  const request=async({params})=>({competition_id:634,configs:[{id:7,event_id:9,reader_bindings:'x'.repeat(120000)}],participants:structuredClone(rows.slice(params.offset)),next_offset:null});
  const s=createOperatorSession(h.input,{prisma:h.db,request});
  const first=await s.inspect();
  assert.ok(JSON.stringify(first).length<=145000);
  assert.equal(first.configs[0].reader_bindings.length,120000);
  assert.ok(first.next_offset>0 && first.next_offset<100);
  const seen=[...first.participants];let cursor=first.next_offset;
  while(cursor!==null){const page=await s.inspect({offset:cursor});seen.push(...page.participants);cursor=page.next_offset;}
  assert.deepEqual(seen.map(r=>r.id),rows.map(r=>r.id));
  const config=await s.inspect({configuration_only:true});
  assert.equal(config.participants.length,0);assert.equal(config.participants_omitted,true);
  assert.equal(config.configs[0].reader_bindings.length,120000);
}));

test('oversized configuration asks for scoped inspection and rejects foreign config ids',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness(),request=async()=>({competition_id:634,configs:[{id:7,event_id:9,data:'x'.repeat(80000)},{id:8,event_id:10,data:'y'.repeat(80000)}],participants:[]});
  const s=createOperatorSession(h.input,{prisma:h.db,request});
  assert.equal((await s.inspect()).available_configs.length,2);
  assert.equal((await s.inspect({configuration_only:true,config_id:7})).configs.length,1);
  await assert.rejects(s.inspect({config_id:999}),/no pertenece/);
}));

test('operator envelope binds user and competition, rejects tampering and expiration',()=>{
  const value=actor(), envelope=seal(value), scope={competitionId:634,userId:value.userId,secret:'test-key'};
  assert.deepEqual(openAuthorization(envelope,scope),value);
  for(const invalid of [envelope+'.extra',envelope.slice(0,-4)+'aaaa',seal({...value,expiresAt:Date.now()-1}),seal({...value,expiresAt:undefined})])assert.throws(()=>openAuthorization(invalid,scope));
  assert.throws(()=>openAuthorization(envelope,{...scope,competitionId:612}));
  assert.throws(()=>openAuthorization(envelope,{...scope,userId:'other'}));
  assert.throws(()=>requireOperator());
});

test('clear requested changes preview then apply and repeated model call does not duplicate',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness(),s=h.session();await s.inspect({dorsal:18});
  const result=await s.propose(change);assert.equal(result.receipt.synchronized,false);
  await s.propose(change);assert.equal(h.calls.filter(c=>c.path.endsWith('/apply')).length,1);
  assert.equal(h.plans[0].status,'EXECUTED');assert.match(s.reports[0],/pendiente/);
}));

test('podium risk ignores model confirmed flag and requires exact human confirmation',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness({podium:true}),s=h.session();await s.inspect({dorsal:18});
  const p=await s.propose({...change,confirmed:true});
  assert.equal(p.requires_confirmation,true);assert.equal(h.calls.filter(c=>c.path.endsWith('/apply')).length,0);
  assert.match(p.reply,/1, 2, 3 → 18, 1, 2/);
  assert.equal(confirmationId('procede'),null);assert.equal(confirmationId('no confirmo propuesta 1'),null);
  assert.equal(confirmationId('Confirmo propuesta 1'),1);
  await s.confirm(1);assert.equal(h.calls.at(-1).data.confirmed,true);
}));

test('inferred clock is estimated even when the model marks it false',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness(),s=h.session();await s.inspect({dorsal:18});
  await s.propose({...change,estimated:false,changes:{name_column:'loc_Meta',timeDateCurrent:'2026-11-21T10:10:10'}});
  assert.equal(h.plans[0].input.payload.estimated,true);assert.equal(h.plans[0].status,'PROPOSED');
}));

test('confirmation cannot approve changed data or a different actor',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness({risk:true}),s=h.session();await s.inspect({dorsal:18});await s.propose(change);
  await withOperatorAuthorization({...actor(),accountId:88},async()=>{await assert.rejects(h.session().confirm(1),/no pertenece/);});
  h.changePreview();await assert.rejects(s.confirm(1),/cambiaron/);assert.equal(h.plans[0].status,'SKIPPED');
  assert.equal(h.calls.filter(c=>c.path.endsWith('/apply')).length,0);
}));

test('unread foreign result is rejected before preview',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness();await assert.rejects(h.session().propose(change),/Consulta primero/);assert.equal(h.calls.length,0);
}));

test('timeout recovery retains operation id and original confirmation',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness({timeouts:1}),s=h.session();await s.inspect({dorsal:18});
  await assert.rejects(s.propose(change),/No pude confirmar/);
  await s.confirm(1);
  const applied=h.calls.filter(c=>c.path.endsWith('/apply'));
  assert.equal(applied.length,2);assert.equal(applied[0].data.operation_id,applied[1].data.operation_id);
  assert.equal(applied[1].data.confirmed,false);
}));

test('chat reports actual receipt, not invented model success prose',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness();let turn=0;
  const client={chat:{completions:{create:async()=>({choices:[{message:turn++===0?{tool_calls:[{id:'1',type:'function',function:{name:'inspect',arguments:'{"dorsal":18}'}}]}:turn===2?{tool_calls:[{id:'2',type:'function',function:{name:'change',arguments:JSON.stringify(change)}}]}:{content:'Publicado y todo terminado'}}]})}}};
  const result=await runOperator(h.input,{prisma:h.db,request:h.request,client});
  assert.match(result.reply,/pendiente/);assert.doesNotMatch(result.reply,/todo terminado/);
}));

test('operator HTTP credentials cannot fall back to service account or caller supplied headers',async t=>{
  const axios=require('axios'),config=require('../config');
  const previous=config.raceline.baseUrl;config.raceline.baseUrl='https://backend.test';t.after(()=>config.raceline.baseUrl=previous);
  const calls=[];
  t.mock.method(axios,'request',async args=>{calls.push(args);throw Object.assign(new Error('Unauthorized'),{response:{status:401}});});
  t.mock.method(axios,'post',async()=>{throw new Error('Must not login');});
  await withOperatorAuthorization({...actor(),organizationId:null},async()=>{
    await assert.rejects(require('./racelineClient').apiRequest({path:'/safe',headers:{authorization:'Bearer forged','X-Timing-Organization-Id':'99'}}),/Unauthorized/);
    await assert.rejects(require('./racelineClient').apiMultipartRequest({path:'/safe'}),/Unauthorized/);
  });
  assert.equal(calls.length,2);assert.equal(calls[0].headers.Authorization,'Bearer operator-token');assert.equal(calls[0].headers['X-Timing-Organization-Id'],undefined);
  assert.equal(axios.post.mock.callCount(),0);
});

test('imports only ready rows and refuses races with finish records',async()=>withOperatorAuthorization(actor(),async()=>{
  const {operate}=require('./timingOperatorImports');const h=harness(),draft='f1234567-1234-1234-1234-123456789012';
  let batch={id:draft,competition_id:634,version:1,metadata:{start_list:{analysis:{candidates:[{id:'ok',issues:[]},{id:'bad',issues:[{severity:'error'}]}]}}},rows:[{row_key:'ok',status:'pending'},{row_key:'bad',status:'pending'}]};
  const calls=[];const session={...h.session(),request:async a=>{calls.push(a);if(a.path.endsWith('/preview')){batch={...batch,version:2,preview_token:'token',rows:batch.rows.map(r=>r.row_key==='ok'?{...r,status:'ready',validation:{valid:true}}:r)};}if(a.path.endsWith('/commit')){assert.deepEqual(a.data.row_keys,['ok']);batch={...batch,version:3,rows:batch.rows.map(r=>r.row_key==='ok'?{...r,status:'imported'}:r)};}return batch;}};
  const result=await operate(session,{draft_id:draft,operation:'import'},h.input);assert.equal(result.counts.imported,1);assert.equal(result.counts.pending,1);
  await assert.rejects(operate({...session,inspect:async()=>({has_finish_records:true})},{draft_id:draft,operation:'import'},h.input),/ya tiene llegadas/);
}));

test('inbound lifecycle preserves legacy conversation reads and rejects rollout mismatch before saving',async t=>{
  const db=require('../lib/prisma'),processor=require('./supportProcessor'),config=require('../config');
  const oldFlag=process.env.TIMING_OPERATOR_ENABLED,oldSecret=config.security.exotimerApiKey;
  t.after(()=>{process.env.TIMING_OPERATOR_ENABLED=oldFlag;config.security.exotimerApiKey=oldSecret;});
  const conversation={id:91,channel:'EXOTIMER',phone:'exotimer:634:user-hmac',userType:'SYSTEM_USER'};
  t.mock.method(db.conversation,'findUnique',async()=>conversation);
  t.mock.method(db.conversation,'update',async()=>conversation);
  t.mock.method(db.message,'create',async({data})=>({id:9,...data}));
  t.mock.method(require('./replyJobs'),'enqueue',async()=>({}));
  process.env.TIMING_OPERATOR_ENABLED='false';
  assert.equal((await processor.findOrCreateExotimerConversation({competitionId:634,userId:'user-hmac',touchLastMessageAt:false})).id,91);
  const payload={competitionId:634,userId:'user-hmac',text:'Revisa el dorsal 18',operatorAuthorization:seal(actor())};
  await assert.rejects(processor.processInboundExotimerMessage(payload),/no está habilitada/);
  assert.equal(db.message.create.mock.callCount(),0);
  process.env.TIMING_OPERATOR_ENABLED='true';config.security.exotimerApiKey='test-key';
  await processor.processInboundExotimerMessage(payload);
  assert.equal(db.message.create.mock.callCount(),1);
  assert.equal(db.message.create.mock.calls[0].arguments[0].data.rawPayload.operatorAuthorization,payload.operatorAuthorization);
  assert.equal(require('./replyJobs').enqueue.mock.callCount(),1);
});

test('queued operator request never uses legacy execution after flag is disabled',async t=>{
  const db=require('../lib/prisma'),processor=require('./supportProcessor');
  const oldFlag=process.env.TIMING_OPERATOR_ENABLED;
  t.after(()=>process.env.TIMING_OPERATOR_ENABLED=oldFlag);process.env.TIMING_OPERATOR_ENABLED='false';
  const message={id:9,competitionId:634,direction:'INBOUND',content:'Cambia hora',timestamp:new Date(),createdAt:new Date(),rawPayload:{operatorAuthorization:'expired',userId:'user-hmac'}};
  t.mock.method(db.conversation,'findUnique',async()=>({id:92,channel:'EXOTIMER',phone:'exotimer:634:user-hmac'}));
  t.mock.method(db.message,'findFirst',async({where})=>where.direction==='OUTBOUND'?null:message);
  t.mock.method(db.message,'findMany',async()=>[message]);
  t.mock.method(db.supportAction,'findMany',async()=>[]);
  const result=await processor.processConversationReply(92,{sendReply:false});
  assert.equal(result.operator,true);assert.match(result.reply,/sesión vigente/);
});

test('step limit reports incomplete work instead of claiming completion',async()=>withOperatorAuthorization(actor(),async()=>{
  const h=harness();const client={chat:{completions:{create:async()=>({choices:[{message:{tool_calls:[{id:'query',type:'function',function:{name:'inspect',arguments:'{}'}}]}}]})}}};
  const result=await runOperator(h.input,{prisma:h.db,request:h.request,client});
  assert.match(result.reply,/límite de pasos/);assert.equal(h.calls.length,12);
}));
