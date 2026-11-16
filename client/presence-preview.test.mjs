import test from 'node:test';import assert from 'node:assert/strict';import {keepSession} from './src/presence.js';import {createPreviewPipeline} from './src/preview-pipeline.js';
class Clock{tasks=new Map();id=0;setTimeout=(fn,ms)=>{const id=++this.id;this.tasks.set(id,{fn,ms});return id;};clearTimeout=id=>this.tasks.delete(id);run(){const [id,t]=this.tasks.entries().next().value||[];if(t){this.tasks.delete(id);t.fn();return t.ms;}}}
const flush=async()=>{for(let i=0;i<10;i++)await Promise.resolve();};
test('idle heartbeat renews without editing and stops after conflict',async()=>{const timers=new Clock();let count=0,lost=null;const x=keepSession({ping:async()=>({ok:count++===0,status:count===1?200:409}),onLost:s=>lost=s,onNotice:()=>{},timers,interval:1000,events:null});assert.equal(timers.run(),1000);await flush();assert.equal(count,1);timers.run();await flush();assert.equal(lost,409);assert.equal(timers.tasks.size,0);x.stop();});
test('transient heartbeat failure backs off without pretending the session expired',async()=>{const timers=new Clock(),notices=[];let count=0;const x=keepSession({ping:async()=>{if(++count===1)throw Error('offline');return{ok:true,status:200};},onLost:()=>assert.fail('not expired'),onNotice:s=>notices.push(s),timers,interval:240000,events:null});timers.run();await flush();assert.equal(timers.run(),60000);await flush();assert.equal(notices.at(-1),'');x.stop();assert.equal(timers.tasks.size,0);});
test('preview worker discards stale results and never changes source',()=>{const sent=[],rendered=[];const worker={postMessage:x=>sent.push(x),terminate(){this.stopped=true;}};const p=createPreviewPipeline({render:html=>rendered.push(html),fallback:()=>assert.fail(),workerFactory:()=>worker});p.update('old');p.update('new');worker.onmessage({data:{id:sent[0].id,html:'stale'}});worker.onmessage({data:{id:sent[1].id,html:'fresh'}});assert.deepEqual(rendered,['fresh']);p.destroy();assert.equal(worker.stopped,true);worker.onmessage({data:{id:sent[1].id,html:'late'}});assert.deepEqual(rendered,['fresh']);});
test('worker-unavailable browsers retain a safe functional preview',()=>{const rendered=[];const p=createPreviewPipeline({render:h=>rendered.push(h),fallback:s=>'html:'+s,workerFactory:()=>{throw Error('disabled');}});p.update('source');assert.deepEqual(rendered,['html:source']);p.destroy();});

test('worker failing after launch immediately renders the current source via fallback',()=>{const rendered=[],worker={postMessage(){},terminate(){}};const p=createPreviewPipeline({render:h=>rendered.push(h),fallback:s=>'html:'+s,workerFactory:()=>worker});p.update('current');worker.onerror();assert.deepEqual(rendered,['html:current']);p.destroy();});

import {recoverSession} from './src/presence.js';
test('recovery protects drafts first, coalesces callers and tolerates transient failures',async()=>{
 const timers=new Clock(),order=[];let calls=0,restored;
 const x=recoverSession({timers,flush:()=>order.push('draft'),reopen:async()=>{order.push('request');return ++calls===1?{status:503,ok:false}:{status:200,ok:true,json:async()=>({ok:true,canWrite:false,collab:{status:{blocked:'external-lock'}}})};},reconnect:d=>restored=d,onTerminal:()=>assert.fail('transient is not expired'),onTransient:()=>{}});
 const a=x.recover(),b=x.recover();assert.equal(a,b);await flush();assert.deepEqual(order,['draft','request']);assert.equal(timers.run(),1000);await a;
 assert.equal(calls,2);assert.equal(restored.canWrite,false);assert.equal(restored.collab.status.blocked,'external-lock');assert.deepEqual(order,['draft','request','draft','request']);x.stop();
});
test('recovery stops on terminal auth and disposal ignores in-flight responses',async()=>{
 for(const status of [401,403,404,410]){let calls=0,terminal=0;const x=recoverSession({flush(){},reopen:async()=>{calls++;return {status};},reconnect:()=>assert.fail(),onTerminal:()=>terminal++,onTransient:()=>assert.fail()});await x.recover();await x.recover();assert.equal(calls,1);assert.equal(terminal,1);}
 let resolve;const x=recoverSession({flush(){},reopen:()=>new Promise(r=>resolve=r),reconnect:()=>assert.fail('disposed'),onTerminal:()=>assert.fail(),onTransient:()=>assert.fail()});const p=x.recover();x.stop();resolve({ok:true,status:200,json:async()=>({ok:true})});await p;
});
test('recovery retries are bounded and disposal cancels backoff',async()=>{
 const timers=new Clock();let calls=0;const x=recoverSession({timers,attempts:2,flush(){},reopen:async()=>{calls++;throw Error('offline');},reconnect:()=>assert.fail(),onTerminal:()=>assert.fail(),onTransient(){}});const p=x.recover();await flush();timers.run();await p;assert.equal(calls,2);assert.equal(timers.tasks.size,0);
 x.reset();const q=x.recover();await flush();x.stop();await q;assert.equal(timers.tasks.size,0);
});

test('successful HTTP reopen without protocol sync cannot reset reconnect budget',async()=>{
 let calls=0;const x=recoverSession({attempts:2,flush(){},reopen:async()=>{calls++;return {ok:true,status:200,json:async()=>({ok:true})};},reconnect(){},onTerminal:()=>assert.fail(),onTransient:()=>assert.fail()});await x.recover();await x.recover();await x.recover();assert.equal(calls,2);x.reset();await x.recover();assert.equal(calls,3);x.stop();
});

import {EventEmitter} from 'node:events';import {watchSessionRecovery} from './src/presence.js';
test('provider recovery includes graceful server closes but ignores reentrant local disconnects',()=>{
 const provider=new EventEmitter();provider.shouldConnect=true;let calls=0,terminals=0;
 provider.disconnect=()=>{provider.shouldConnect=false;provider.emit('connection-close',null);};
 const stop=watchSessionRecovery({provider,recover(){calls++;provider.disconnect();},terminal(){terminals++;provider.disconnect();}});
 provider.emit('connection-close',{code:1000});assert.equal(calls,1);
 provider.shouldConnect=true;provider.emit('connection-error',{});assert.equal(calls,2);
 provider.shouldConnect=true;provider.emit('connection-close',{code:4401});assert.equal(terminals,1);assert.equal(calls,2);
 stop();provider.shouldConnect=true;provider.emit('connection-close',{code:1006});assert.equal(calls,2);
});
