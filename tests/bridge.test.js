// Adapted from original synthetic bridge tests; directly imports production ESM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as B from '../plugins/bridge/core.js'
import { createStreamPort } from '../plugins/shared/stream-port.js'
const bytes = obj => new TextEncoder().encode(JSON.stringify(obj) + '\n')
const pause = ms => new Promise(r => setTimeout(r, ms))
function fake(options = {}) {
 let feed, lost, writes = [], closed = 0
 const c = B.create({ timeout: 30, eventTimeout: 80, ports: async () => [], ...options,
  open: async (id, f, l) => { feed = f; lost = l; return {
   write: async b => { const m = JSON.parse(new TextDecoder().decode(b)); writes.push(m); if (options.write) return options.write(m, feed); feed(bytes({t:'rsp',id:m.id,ok:true})); },
   close: async () => { closed++; if (options.close) await options.close() },
  } },
 })
 return { c, writes, event: e => feed(bytes({t:'evt',...e})), lost: () => lost(), get closed() { return closed } }
}
async function connected(f) {
 await f.c.run('open', {deviceId:'fake'})
 f.event({e:'ready'})
 await f.c.run('scan_start')
 f.event({e:'scan',state:'scanning'})
 f.event({e:'dev',items:[{addr:'synthetic',at:0,name:'fake',conn:true,rssi:-50}]})
 const p = f.c.run('connect', {deviceId:f.c.devices()[0].deviceId})
 await pause(0)
 f.event({e:'conn',state:'connected',addr:'synthetic'})
 await p
 f.event({e:'svc',uuid:'0x180f',handle:1,end:20})
 f.event({e:'chr',uuid:'0x2a19',handle:3,props:62})
 f.event({e:'dsc',uuid:'0x2902',handle:4,chr_handle:3})
 f.event({e:'disc_done'})
 return {generation:f.c.state().generation,characteristicId:f.c.gatt().characteristics[0].characteristicId}
}
test('NimBLE UUID original forms and SIG expansion', () => {
 for (const v of ['0x2902',' 0X2902 ','2902','00002902-0000-1000-8000-00805f9b34fb']) assert.equal(B.uuid(v),'2902')
})
test('NDJSON split/coalesced, invalid frame, 1 MiB bound and pending cleanup', async () => {
 const events=[], faults=[], sent=[]
 const c=B.codec(async b=>sent.push(JSON.parse(new TextDecoder().decode(b))),e=>events.push(e),e=>faults.push(e.code),20)
 const p=c.request('ping',{}); await pause(0)
 const data=bytes({t:'rsp',id:sent[0].id,ok:true,d:{x:1}})
 c.feed(data.slice(0,4)); c.feed(data.slice(4)); assert.deepEqual(await p,{x:1}); assert.equal(c.pending,0)
 c.feed(new TextEncoder().encode('bad\n{"t":"evt","e":"ready"}\n{"t":"evt","e":"scan"}\n'))
 assert.equal(events.length,2); assert.deepEqual(faults,['bad_frame'])
 c.feed(new Uint8Array(B.LIMIT+100).fill(65)); c.feed(bytes({t:'evt',e:'discarded'})); c.feed(bytes({t:'evt',e:'ready'}))
 assert.equal(events.length,3); assert.ok(faults.includes('rx_overflow'))
 await assert.rejects(c.request('ping',{}), /response_timeout/); assert.equal(c.pending,0)
 c.close(); await assert.rejects(c.request('ping',{}), /bridge_closed/)
 const failed=B.codec(async()=>{throw Error('write failed')},()=>{},()=>{})
 await assert.rejects(failed.request('ping',{}),/write failed/); assert.equal(failed.pending,0)
})
test('pending bound, close rejects all, late responses ignored', async()=>{
 const c=B.codec(()=>{},()=>{},()=>{},500)
 const ps=Array.from({length:16},()=>c.request('ping',{}).catch(e=>e.code))
 await assert.rejects(c.request('ping',{}),/pending_limit/)
 c.close(); assert.ok((await Promise.all(ps)).every(x=>x==='bridge_closed')); assert.equal(c.pending,0)
 c.feed(bytes({t:'rsp',id:1,ok:true})); assert.equal(c.pending,0)
})
test('scan state/list bounded, stop ignores late advertisements; open never means firmware ready',async()=>{
 const f=fake(); await f.c.run('open',{})
 assert.equal(f.c.state().synchronized,false)
 await f.c.run('scan_start'); f.event({e:'scan',state:'scanning'})
 f.event({e:'dev',items:Array.from({length:512},(_,i)=>({addr:'fake'+i,conn:true}))})
 f.event({e:'dev',items:[{addr:'overflow',conn:true}]}); assert.equal(f.c.devices().length,512)
 await assert.rejects(f.c.run('connect',{deviceId:f.c.devices()[0].deviceId}),/复位/)
 await f.c.run('scan_stop'); f.event({e:'scan',state:'scanning'}); assert.equal(f.c.state().scanning,false)
 f.event({e:'dev',items:[{addr:'late',conn:true}]}); assert.equal(f.c.devices().length,512)
 await f.c.release()
})
test('connect/pair/read/write wait for events; original CCCD works; old GATT invalidated',async()=>{
 const f=fake(), p=await connected(f)
 await f.c.run('subscribe',{...p,on:true}); assert.equal(f.writes.at(-1).p.handle,4)
 let done=false
 const pair=f.c.run('pair',p).then(v=>{done=true;return v}); await pause(0); assert.equal(done,false)
 f.event({e:'passkey',action:'confirm',value:123456}); await f.c.run('passkey',{...p,passkey:1})
 f.event({e:'sec',encrypted:true}); assert.equal((await pair).paired,true)
 const read=f.c.run('read',p); await pause(0); f.event({e:'value',handle:3,src:'read',b64:'AQI='}); assert.equal((await read).base64,'AQI=')
 const write=f.c.run('write',{...p,hex:'01 02',response:true}); await pause(0); f.event({e:'write',handle:3,status:0}); assert.equal((await write).written,true)
 assert.equal((await f.c.run('write',{...p,hex:'01',response:false})).completion,'unacknowledged')
 const disconnect=f.c.run('disconnect',p); await pause(0); f.event({e:'conn',state:'disconnected'}); await disconnect
 f.event({e:'value',handle:3,src:'read',b64:'AAAA'}); assert.equal(f.c.gatt().characteristics.length,0)
 await assert.rejects(f.c.run('read',p),/stale_generation/)
 await f.c.release(); await f.c.run('open',{}); assert.equal(f.c.state().synchronized,false); await f.c.release()
})
test('profiles reject duplicate instances; persist no handles or indices',async()=>{
 const f=fake(),p=await connected(f)
 const profile=f.c.profile(p.characteristicId,p.characteristicId)
 assert.equal(JSON.stringify(profile).includes('handle'),false)
 assert.equal(f.c.resolveProfile(profile).tx,p.characteristicId)
 // A new firmware session with two identical service/characteristic instances is ambiguous.
 await f.c.release(); await f.c.run('open',{}); f.event({e:'ready'}); await f.c.run('scan_start'); f.event({e:'dev',items:[{addr:'synthetic',conn:true}]})
 const cp=f.c.run('connect',{deviceId:f.c.devices()[0].deviceId}); await pause(0); f.event({e:'conn',state:'connected',addr:'synthetic'}); await cp
 for (const offset of [0,20]) { f.event({e:'svc',uuid:'180f',handle:1+offset,end:20+offset}); f.event({e:'chr',uuid:'2a19',handle:3+offset,props:62}); f.event({e:'dsc',uuid:'2902',handle:4+offset,chr_handle:3+offset}) }
 f.event({e:'disc_done'}); assert.throws(()=>f.c.resolveProfile(profile),/唯一/); await f.c.release()
})
test('MCP queue commit/cancel, event timeout and late events invalidate bridge',async()=>{
 const f=fake(),p=await connected(f); let commits=0,cancel=false
 const guard={start:async()=>{commits++;return null},step:()=>cancel?{code:'aborted'}:null}
 const read=f.c.run('read',p,guard); await pause(0)
 const queued=f.c.run('subscribe',p,guard)
 cancel=true
 await assert.rejects(read,/aborted/); await assert.rejects(queued,/generation_changed|aborted/); assert.equal(commits,1)
 assert.equal(f.c.state().phase,'closed'); f.event({e:'conn',state:'connected',addr:'synthetic'}); assert.equal(f.c.state().phase,'closed')
 const g=fake(); const gp=await connected(g); await assert.rejects(g.c.run('read',gp),/event_timeout/); assert.equal(g.c.state().phase,'closed')
})
test('guard cancellation during a response wait releases uncertain operation; idle UI remains live',async()=>{
 let stall=false, cancelled=false
 const f=fake({write:(m,feed)=>{if(!stall || m.op==='disconnect') feed(bytes({t:'rsp',id:m.id,ok:true}))}, timeout:500})
 await f.c.run('open',{}); assert.equal(f.closed,0)
 stall=true
 const p=f.c.run('scan_start',{}, {start:async()=>null,step:()=>cancelled?{code:'service_not_running'}:null})
 await pause(0); cancelled=true
 await assert.rejects(p,/service_not_running|response_timeout/)
 assert.equal(f.c.state().phase,'closed'); assert.ok(f.closed>0)
})

test('firmware ready clears scan/list; release attempts stop and disconnect even on failure',async()=>{
 const f=fake(); await f.c.run('open',{}); f.event({e:'ready'}); await f.c.run('scan_start')
 f.event({e:'scan',state:'scanning'}); f.event({e:'dev',items:[{addr:'synthetic',conn:true}]})
 const oldId=f.c.devices()[0].deviceId
 f.event({e:'ready'}); assert.equal(f.c.state().scanning,false); assert.equal(f.c.devices().length,0)
 f.event({e:'dev',items:[{addr:'late',conn:true}]}); assert.equal(f.c.devices().length,0)
 await assert.rejects(f.c.run('connect',{deviceId:oldId}),/stale_device_id/)
 await f.c.release(); assert.deepEqual(f.writes.slice(-2).map(m=>m.op),['scan.stop','disconnect'])
 let failStop=false
 const g=fake({write:(m,feed)=>{if(failStop&&m.op==='scan.stop') throw Error('stop failed');feed(bytes({t:'rsp',id:m.id,ok:true}))}})
 await g.c.run('open',{}); failStop=true; await g.c.release()
 assert.deepEqual(g.writes.slice(-2).map(m=>m.op),['scan.stop','disconnect']); assert.equal(g.closed,1)
})

test('independent Profile stream: RX bytes, chunked TX, exclusive ownership and no backend switch',async()=>{
 const adapter=({createStreamPort}), originalBackend=adapter.backend
 const f=fake({createStreamPort:adapter.createStreamPort,write:(m,feed)=>{
  feed(bytes({t:'rsp',id:m.id,ok:true}))
  if(m.op==='gatt.write'&&m.p.resp) feed(bytes({t:'evt',e:'write',handle:m.p.handle,status:0}))
 }})
 const p=await connected(f), profile=f.c.profile(p.characteristicId,p.characteristicId,true,2)
 const port=f.c.createProfilePort(profile); await port.open({})
 const second=f.c.createProfilePort(profile); await assert.rejects(second.open({}),/profile_port_busy/)
 await assert.rejects(f.c.run('write',{...p,hex:'01'}),/profile_port_busy/)
 await assert.rejects(f.c.run('subscribe',{...p,on:false}),/profile_port_busy/)
 const reader=port.readable.getReader(), reading=reader.read()
 f.event({e:'value',handle:3,src:'notify',b64:'AQID'})
 assert.deepEqual([...(await reading).value],[1,2,3])
 const writer=port.writable.getWriter(); await writer.write(Uint8Array.of(4,5,6,7,8)); writer.releaseLock()
 const chunks=f.writes.filter(m=>m.op==='gatt.write').map(m=>[...Buffer.from(m.p.value,'base64')])
 assert.deepEqual(chunks,[[4,5],[6,7],[8]])
 await reader.cancel();reader.releaseLock(); await port.close()
 assert.equal(f.writes.at(-1).op,'gatt.subscribe'); assert.equal(f.writes.at(-1).p.on,false)
 assert.equal(f.c.state().phase,'connected'); assert.equal(adapter.backend,originalBackend)
 await f.c.release()
})
test('Profile stream loses old generation on disconnect; reopening resolves no stale handles',async()=>{
 const adapter=({createStreamPort}),f=fake({createStreamPort:adapter.createStreamPort})
 const p=await connected(f),profile=f.c.profile(p.characteristicId,p.characteristicId,false,20)
 const port=f.c.createProfilePort(profile);await port.open({})
 const reader=port.readable.getReader(), reading=reader.read()
 f.event({e:'conn',state:'disconnected'})
 await assert.rejects(reading,/stale_generation/);reader.releaseLock();await pause(0)
 await port.close(); assert.equal(port.readable,null);assert.equal(port.writable,null)
 await assert.rejects(port.open({}),/invalid_profile/)
 await f.c.release()
})

test('advertising filters normalize, AND, merge incremental packets and isolate devices/scans', async()=>{
 const f=fake();await f.c.run('open',{});await f.c.run('scan_start')
 const u='12345678-1234-5678-9abc-123456789abc',v='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
 f.event({e:'dev',items:[{addr:'fixture-a',name:'Sensor Alpha',conn:true,uuids:[u.toUpperCase(),'bad'],rssi:-40},{addr:'fixture-b',name:'Sensor Alpha',conn:1,uuids:[v],rssi:-50}]})
 const a=f.c.devices({name:'sEnSoR',serviceUuid:u.replaceAll('-','').toUpperCase()});assert.equal(a.length,1);assert.deepEqual(a[0].uuids,[u])
 assert.equal(f.c.devices({name:'missing',serviceUuid:u}).length,0)
 assert.equal(f.c.devices({name:'',serviceUuid:'  '}).length,2);assert.equal(f.c.devices()[1].connectable,true)
 assert.notEqual(f.c.devices()[0].deviceId,f.c.devices()[1].deviceId)
 f.event({e:'dev',items:[{addr:'fixture-a',rssi:-70},{addr:'fixture-a',name:'',uuids:[]},{addr:'fixture-a',uuids:[v,u]}]})
 const updated=f.c.devices({serviceUuid:u})[0];assert.equal(updated.name,'Sensor Alpha');assert.equal(updated.rssi,-70);assert.equal(updated.connectable,true);assert.equal(updated.deviceId,a[0].deviceId);assert.deepEqual(updated.uuids,[u,v])
 updated.uuids.length=0;assert.equal(f.c.devices({serviceUuid:u}).length,1)
 for(const serviceUuid of ['180f','1234-5678123456789abc123456789abc','x'.repeat(32),42]) assert.throws(()=>f.c.devices({serviceUuid}),/UUID/)
 assert.throws(()=>f.c.devices({name:42}),/广播名/)
 f.event({e:'dev',items:[{addr:'fixture-c',uuids:Array.from({length:100},(_,i)=>i.toString(16).padStart(32,'0'))}]});assert.equal(f.c.devices().at(-1).uuids.length,64)
 await f.c.run('scan_stop');await f.c.run('scan_start');f.event({e:'dev',items:[{addr:'fixture-a',rssi:-30}]});assert.equal(f.c.devices({serviceUuid:u}).length,0);assert.notEqual(f.c.devices()[0].deviceId,a[0].deviceId)
 await f.c.release()
})

test('advertisements accept prefixed 128bit and SIG UUIDs while filters remain strict',async()=>{
 const f=fake();await f.c.run('open');await f.c.run('scan_start')
 const u='12345678-1234-5678-9abc-123456789abc',hex=u.replaceAll('-','')
 for(const [i,value] of [hex,'0x'+hex,'0X'+hex.toUpperCase(),'180f','0X180F','12345678','bad','0x'+hex+'f',42].entries()) f.event({e:'dev',items:[{addr:'fixture-'+i,uuids:[value]}]})
 assert.equal(f.c.devices({serviceUuid:u}).length,3)
 assert.equal(f.c.devices({serviceUuid:'0000180f-0000-1000-8000-00805f9b34fb'}).length,2)
 assert.equal(f.c.devices({serviceUuid:'12345678-0000-1000-8000-00805f9b34fb'}).length,1)
 assert.ok(f.c.devices().slice(-3).every(d=>d.uuids.length===0))
 for(const serviceUuid of ['0x'+hex,'0X'+hex,'180f','arbitrary'])assert.throws(()=>f.c.devices({serviceUuid}),/UUID/)
 await f.c.release()
})
test('BLE update busy tracks scan, discovery, GATT, complete Profile write and failed release',async()=>{
 let held=null,failClose=false
 const f=fake({createStreamPort:({createStreamPort}).createStreamPort,close:()=>{if(failClose)throw Error('close failed')},write:(m,feed)=>{
  if(m.op==='gatt.write'){held=()=>{feed(bytes({t:'rsp',id:m.id,ok:true}));feed(bytes({t:'evt',e:'write',handle:m.p.handle,status:0}))};return}
  feed(bytes({t:'rsp',id:m.id,ok:true}))
 }})
 const p=await connected(f);await pause(0);assert.equal(f.c.isBusyForUpdate(),false)
 const port=f.c.createProfilePort(f.c.profile(p.characteristicId,p.characteristicId,true,1));await port.open({});await pause(0)
 assert.equal(f.c.isBusyForUpdate(),false,'notification subscription alone is idle')
 const w=port.writable.getWriter(),writing=w.write(Uint8Array.of(1,2,3));await pause(0)
 for(let i=0;i<3;i++){assert.equal(f.c.isBusyForUpdate(),true);const next=held;held=null;next();await Promise.resolve();assert.equal(f.c.isBusyForUpdate(),true,'no gap between chunks');await pause(0)}
 await writing;w.releaseLock();await pause(0);assert.equal(f.c.isBusyForUpdate(),false)
 const read=f.c.run('read',p);assert.equal(f.c.isBusyForUpdate(),true);await pause(0);f.event({e:'value',handle:3,src:'read',b64:'AQ=='});await read;await pause(0);assert.equal(f.c.isBusyForUpdate(),false)
 failClose=true;await assert.rejects(f.c.release());assert.equal(f.c.isBusyForUpdate(),true);failClose=false;await f.c.release();assert.equal(f.c.isBusyForUpdate(),false)
 const g=fake();await g.c.run('open');await pause(0);assert.equal(g.c.isBusyForUpdate(),false)
 await g.c.run('scan_start');await pause(0);assert.equal(g.c.isBusyForUpdate(),true)
 await g.c.run('scan_stop');await pause(0);assert.equal(g.c.isBusyForUpdate(),false);await g.c.release()
})
test('update busy covers connect/discovery, physical write after response and release in flight',async()=>{
 let finishWrite,finishClose
 const f=fake({write:(m,feed)=>{feed(bytes({t:'rsp',id:m.id,ok:true}));if(m.op==='ping')return new Promise(r=>{finishWrite=r})},close:()=>new Promise(r=>{finishClose=r})})
 await f.c.run('open');await pause(0);assert.equal(f.c.state().pending,0);assert.equal(f.c.state().busy,false);assert.equal(f.c.isBusyForUpdate(),true,'physical write still active after response')
 finishWrite();await pause(0);assert.equal(f.c.isBusyForUpdate(),false)
 f.event({e:'ready'});await f.c.run('scan_start');f.event({e:'dev',items:[{addr:'synthetic',conn:true}]})
 const connecting=f.c.run('connect',{deviceId:f.c.devices()[0].deviceId});assert.equal(f.c.isBusyForUpdate(),true);await pause(0)
 f.event({e:'conn',state:'connected',addr:'synthetic'});await connecting;await pause(0);assert.equal(f.c.isBusyForUpdate(),true,'automatic discovery remains active')
 f.event({e:'disc_done'});assert.equal(f.c.isBusyForUpdate(),false)
 const releasing=f.c.release();await pause(0);assert.equal(f.c.state().phase,'closed');assert.equal(f.c.isBusyForUpdate(),true)
 finishClose();await releasing;assert.equal(f.c.isBusyForUpdate(),false)
})

test('advanced bridge actions cannot bypass a pinned Profile stream; stream writes still work',async()=>{
 let pinned=false
 const f=fake({isPinned:()=>pinned,createStreamPort:({createStreamPort}).createStreamPort})
 const p=await connected(f),port=f.c.createProfilePort(f.c.profile(p.characteristicId,p.characteristicId,false,20));await port.open({});pinned=true
 const before=f.writes.length
 for(const action of ['disconnect','close','read'])await assert.rejects(f.c.run(action,p),/先停止事务/)
 assert.equal(f.writes.length,before)
 const w=port.writable.getWriter();await w.write(Uint8Array.of(1));w.releaseLock();assert.equal(f.writes.at(-1).op,'gatt.write')
 pinned=false;await port.close();await f.c.release()
})
test('profile writable recovers after an acknowledged command rejection without dropping ownership', async () => {
 let failWrite = true
 const f = fake({ createStreamPort, write: (m, feed) => {
  const reject = m.op === 'gatt.write' && failWrite
  feed(bytes({ t: 'rsp', id: m.id, ok: !reject, err: 'synthetic write rejection' }))
  if (m.op === 'gatt.write') failWrite = false
 } })
 const p = await connected(f), port = f.c.createProfilePort(f.c.profile(p.characteristicId, p.characteristicId, false, 20))
 await port.open({}); const stream = port.writable, first = stream.getWriter()
 await assert.rejects(first.write(Uint8Array.of(1)), error => error.code === 'bridge_error'); first.releaseLock()
 assert.notEqual(port.writable, stream); assert.equal(port.state, 'open')
 await assert.rejects(f.c.run('write', { ...p, hex: '01' }), /profile_port_busy/)
 const next = port.writable.getWriter(); await next.write(Uint8Array.of(2)); next.releaseLock()
 await port.close(); await f.c.release()
})
