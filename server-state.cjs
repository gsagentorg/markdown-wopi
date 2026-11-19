'use strict';
const crypto=require('node:crypto');
function fileMetadata(session,info) {
  const u=new URL(session.wopisrc); // no query or access token is sent to the browser or stored in the key
  const user=String(info.UserId||info.UserID||'');
  const docKey=user?crypto.createHash('sha256').update(JSON.stringify([u.origin,u.pathname,user])).digest('hex'):null;
  // Fail-closed: only an explicit host "yes" grants write access. A host that omits
  // UserCanWrite (or sends a non-boolean) must never be read as permission to write.
  const canWrite=info.UserCanWrite===true && info.ReadOnly!==true;
  return {userId:user,userName:String(info.UserFriendlyName||'Cloudreve user').slice(0,100),name:info.BaseFileName||'document.md',canWrite,draftKey:docKey,version:String(info.Version||''),capabilities:{relativeWrite:info.UserCanNotWriteRelative===false,relativeRead:false,directoryList:false,rename:false}};
}
function shouldRenew(s,now,leaseMs) { return !!s.lockId && !s.lockFailed && !s.closing && now<s.ttl && now<s.created+12*3600000 && now-(s.lastSeen||s.created)<leaseMs && now>=(s.nextRefresh||0); }
function refreshError(status) {const code=status===401||status===403?403:status===409?409:502;return Object.assign(new Error('refresh lock HTTP '+status),{status:code});}
// Private recovery records retain only the original credential lifetime.
function sessionStore(root) {
 const fs=require('node:fs'),path=require('node:path');
 const dir=path.join(root,'sessions');
 fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const directory=fs.lstatSync(dir);
 if(!directory.isDirectory()||directory.isSymbolicLink()||(process.getuid&&directory.uid!==process.getuid()))throw Error('unsafe private session directory');
 fs.chmodSync(dir,0o700);
 const file=sid=>{if(!/^[A-Za-z0-9_-]{32}$/.test(sid))throw Error('invalid session id');return path.join(dir,sid+'.json');};
 function save(sid,s){
  const target=file(sid),tmp=target+'.'+crypto.randomBytes(8).toString('hex')+'.tmp';
  const value={v:1,wopisrc:s.wopisrc,token:s.token,ttl:s.ttl,created:s.created,roomEpoch:s.roomEpoch||null};
  try{fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.renameSync(tmp,target);}finally{try{fs.unlinkSync(tmp);}catch{}}
 }
 function load(sid){try{
  const target=file(sid),st=fs.lstatSync(target);
  if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||(process.getuid&&st.uid!==process.getuid())||st.size>65536)return null;
  const fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let s;
  try{const opened=fs.fstatSync(fd);if(opened.ino!==st.ino||opened.dev!==st.dev)return null;s=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
  const now=Date.now();
  if(s.v!==1||typeof s.token!=='string'||!s.token||typeof s.wopisrc!=='string'||!Number.isFinite(s.ttl)||!Number.isFinite(s.created)||s.created>now||now>=Math.min(s.ttl,s.created+12*3600000))return null;
  if(!['http:','https:'].includes(new URL(s.wopisrc).protocol))return null;
  return {wopisrc:s.wopisrc,token:s.token,ttl:s.ttl,created:s.created,lockId:null,lockFailed:false,roomEpoch:s.roomEpoch||null,rehydrated:true};
 }catch{return null;}}
 function prune(){for(const name of fs.readdirSync(dir)){if(/^[A-Za-z0-9_-]{32}\.json$/.test(name)&&!load(name.slice(0,-5))){try{fs.unlinkSync(path.join(dir,name));}catch{}}}}
 prune();
 return {save,load,prune,remove(sid){try{fs.unlinkSync(file(sid));}catch{}}};
}
module.exports={fileMetadata,shouldRenew,refreshError,sessionStore};
