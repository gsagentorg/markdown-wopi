export function keepSession({ping,onLost,onNotice,timers=globalThis,interval=240000,events=globalThis.window}) {
  let timer=null,stopped=false,running=false;
  const schedule=ms=>{timers.clearTimeout(timer);if(!stopped)timer=timers.setTimeout(run,ms);};
  async function run(){
    if(stopped||running)return;running=true;
    try{const response=await ping();if(stopped)return;
      if([401,403,404,409].includes(response.status)){stopped=true;onLost(response.status);return;}
      if(!response.ok)throw Error('HTTP '+response.status);
      onNotice('');schedule(interval);
    }catch{if(!stopped){onNotice('续锁暂时失败，未保存内容仍在本地；恢复网络后会重试');schedule(Math.min(interval,60000));}}
    finally{running=false;}
  }
  const online=()=>{if(!stopped)schedule(0);},offline=()=>onNotice('网络已断开，本机草稿继续保护；云端尚未保存');
  events?.addEventListener('online',online);events?.addEventListener('offline',offline);schedule(interval);
  return {check:run,stop(){stopped=true;timers.clearTimeout(timer);events?.removeEventListener('online',online);events?.removeEventListener('offline',offline);}};
}

// One recovery flight per mounted document; callers keep the existing Y.Doc.
export function recoverSession({flush,reopen,reconnect,onTerminal,onTransient,onExhausted=()=>{},timers=globalThis,attempts=5}) {
 let flight=null,stopped=false,timer=null,wake=null,remaining=attempts,exhausted=false;
 const sleep=ms=>new Promise(resolve=>{wake=resolve;timer=timers.setTimeout(resolve,ms);});
 async function run(){
  for(let n=0;remaining>0&&!stopped;n++){
   remaining--;
   flush(); // Protect the current editor snapshot before any asynchronous work.
   try{
    const response=await reopen();if(stopped)return;
    if([401,403,404,410].includes(response.status)){stopped=true;onTerminal(response.status);return;}
    if(!response.ok)throw Error('HTTP '+response.status);
    const data=await response.json();if(stopped)return;
    if(!data.ok)throw Error('document unavailable');
    reconnect(data);return;
   }catch(e){if(stopped)return;onTransient(e);if(remaining>0)await sleep(Math.min(1000*2**n,8000));}
  }
  if(!stopped&&!exhausted){exhausted=true;onExhausted();}
 }
 return {reset(){if(!stopped){remaining=attempts;exhausted=false;}},recover(){if(stopped)return Promise.resolve();if(!flight)flight=run().finally(()=>{flight=null;});return flight;},stop(){stopped=true;timers.clearTimeout(timer);wake?.();}};
}

// y-websocket emits a synchronous null close inside disconnect(); never recurse into it.
export function watchSessionRecovery({provider,recover,terminal,isClosed=()=>false}) {
 const active=()=>!isClosed()&&provider.shouldConnect;
 const error=()=>{if(active())recover();};
 const close=event=>{if(!active())return;if([4401,4403].includes(event?.code))terminal(event);else recover();};
 provider.on('connection-error',error);provider.on('connection-close',close);
 return ()=>{provider.off('connection-error',error);provider.off('connection-close',close);};
}
