import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveBuildInfo} from './build-info.mjs';
import {readFileSync} from 'node:fs';
const hash='a'.repeat(40),stamp='2026-11-16T05:00:00.000Z';
const options={env:{},now:()=>new Date(stamp)};
const fakeGit=status=>args=>args[0]==='rev-parse'?hash:status;
test('clean Git worktree embeds full hash and false',()=>{
 assert.deepEqual(resolveBuildInfo({...options,git:fakeGit('')}),{hash,dirty:false,builtAt:stamp});
});
test('tracked, staged and untracked changes are Dirty',()=>{
 for(const status of [' M source.js','M  source.js','?? new.js'])
  assert.equal(resolveBuildInfo({...options,git:fakeGit(status)}).dirty,true);
});
test('missing Git and failed status remain unknown, not clean',()=>{
 for(const git of [()=>{throw Error('no git');},args=>{if(args[0]==='rev-parse')return hash;throw Error('status failure');}])
  assert.deepEqual(resolveBuildInfo({...options,git}),{hash:'unknown',dirty:null,builtAt:stamp});
});
test('validated explicit metadata overrides Git for isolated builds',()=>{
 for(const dirty of ['true','false']){
  const result=resolveBuildInfo({...options,env:{BUILD_GIT_HASH:hash.toUpperCase(),BUILD_GIT_DIRTY:dirty,BUILD_TIMESTAMP:stamp,PRIVATE_PATH:'/private/example'},git:()=>{throw Error('must not query Git');}});
  assert.deepEqual(result,{hash,dirty:dirty==='true',builtAt:stamp});
  assert.equal(JSON.stringify(result).includes('/private'),false);
 }
});
test('partial or unsafe overrides fail closed',()=>{
 for(const env of [{BUILD_GIT_HASH:hash},{BUILD_GIT_DIRTY:'true'},{BUILD_GIT_HASH:'/private/example',BUILD_GIT_DIRTY:'false'},{BUILD_GIT_HASH:hash,BUILD_GIT_DIRTY:'clean'},{BUILD_TIMESTAMP:'not a date'}])
  assert.throws(()=>resolveBuildInfo({...options,env,git:fakeGit('')}));
});
test('Vite defines build identity and About consumes that constant',()=>{
 const config=readFileSync(new URL('../vite.config.mjs',import.meta.url),'utf8');
 const source=readFileSync(new URL('./src/workbench/App.jsx',import.meta.url),'utf8');
 assert.ok(config.includes('__BUILD_INFO__:JSON.stringify(resolveBuildInfo({cwd:root}))'));
 assert.ok(source.includes('const info=__BUILD_INFO__'));
 assert.ok(source.includes('(Dirty)'));
 assert.ok(source.includes('关于'));
});
