import {execFileSync} from 'node:child_process';

// Only these validated, public fields may cross into the browser bundle.
export function resolveBuildInfo({cwd, env=process.env, now=()=>new Date(), git}={}) {
 const run=git ?? (args=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim());
 const hashOverride=env.BUILD_GIT_HASH;
 const dirtyOverride=env.BUILD_GIT_DIRTY;
 const hasOverride=Boolean(hashOverride || dirtyOverride);
 let hash='unknown',dirty=null;
 if(hasOverride){
  if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(hashOverride ?? '') || !['true','false'].includes(dirtyOverride))
   throw new Error('BUILD_GIT_HASH and BUILD_GIT_DIRTY must be supplied together: full hexadecimal hash and true/false');
  hash=hashOverride.toLowerCase();dirty=dirtyOverride==='true';
 }else{
  try{
   const candidate=run(['rev-parse','--verify','HEAD']);
   if(!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(candidate))throw new Error('Invalid Git hash');
   const status=run(['status','--porcelain','--untracked-files=normal']);
   hash=candidate.toLowerCase();dirty=status.length>0;
  }catch{ /* Missing Git, repository or readable status: unknown, never clean. */ }
 }
 const builtAt=env.BUILD_TIMESTAMP || now().toISOString();
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(builtAt) || !Number.isFinite(Date.parse(builtAt)))
  throw new Error('BUILD_TIMESTAMP must be an ISO UTC timestamp');
 return {hash,dirty,builtAt};
}
