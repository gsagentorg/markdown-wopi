import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as Y from 'yjs';

// Execute the production registration/callback without mounting Monaco or a provider.
const source=readFileSync(new URL('./src/workbench/session.js',import.meta.url),'utf8');
const syncStart=source.indexOf("provider.on('sync'");
const statusStart=source.indexOf("provider.on('status'",syncStart);
assert.ok(syncStart>=0&&statusStart>syncStart,'sync registration is bounded by the next status registration');
const code=source.slice(syncStart,statusStart);
const text='# First heading\n\nOpening text.\n\n## Later heading\n\nLast paragraph.';
const start={lineNumber:1,column:1};
function positionAtOffset(value,index){
 const lines=value.slice(0,index).split('\n');
 return {lineNumber:lines.length,column:lines.at(-1).length+1};
}
const eof=positionAtOffset(text,text.length);
function selection(anchor,cursor){
 const backward=anchor.lineNumber>cursor.lineNumber||(anchor.lineNumber===cursor.lineNumber&&anchor.column>cursor.column);
 const first=backward?cursor:anchor,last=backward?anchor:cursor;
 return {selectionStartLineNumber:anchor.lineNumber,selectionStartColumn:anchor.column,positionLineNumber:cursor.lineNumber,positionColumn:cursor.column,startLineNumber:first.lineNumber,startColumn:first.column,endLineNumber:last.lineNumber,endColumn:last.column};
}
const initialView={cursor:start,selection:selection(start,start),scrollTop:0};

function harness(handlerCode=code){
 let cursor={...eof},selected=selection(eof,eof),scrollTop=575;
 const events=[],state={initialSynced:false},callbacks=new Map(),lastStatus={persistedHash:'test-only'};
 const view=()=>({cursor:{...cursor},selection:{...selected},scrollTop});
 const observe=type=>events.push({type,initialSynced:state.initialSynced,view:view()});
 const provider={on(event,callback){assert.equal(event,'sync');assert.ok(!callbacks.has(event),'one sync callback');callbacks.set(event,callback);}};
 const editor={
  getPosition:()=>({...cursor}),getSelection:()=>({...selected}),getScrollTop:()=>scrollTop,
  setPosition(next){cursor={...next};selected=selection(next,next);events.push({type:'setPosition',position:{...next}});},
  setScrollTop(next){scrollTop=next;events.push({type:'setScrollTop',scrollTop:next});},
 };
 const store={set(patch){Object.assign(state,patch);events.push({type:'store',patch:{...patch}});}};
 const sessionRecovery={reset(){events.push({type:'reset'});}};
 const control=new Function('provider','editor','store','sessionRecovery','readOnly','analyze','position','renderStatus','lastStatus',
  `let closed=false,initialSynced=false;\n${handlerCode}\nreturn {close(){closed=true;},get initialSynced(){return initialSynced;}};`
 )(provider,editor,store,sessionRecovery,()=>observe('readOnly'),()=>observe('analyze'),()=>observe('position'),status=>events.push({type:'renderStatus',status}),lastStatus);
 assert.equal(callbacks.size,1,'actual registration installed a callback');
 return {
  events,lastStatus,
  emit(synced){provider.synced=synced;callbacks.get('sync')(synced);},
  close:()=>control.close(),
  setUserView(next){cursor={...next.cursor};selected={...next.selection};scrollTop=next.scrollTop;},
  calls:type=>events.filter(event=>event.type===type),
  get view(){return view();},get state(){return {...state};},
  get initialSynced(){return control.initialSynced;},
  get editorWrites(){return events.filter(event=>event.type==='setPosition'||event.type==='setScrollTop');},
 };
}

function firstSync(handlerCode=code){
 const h=harness(handlerCode),before=h.view;
 h.emit(false);
 assert.deepEqual(h.view,before,'false must not normalize the initial view');
 assert.equal(h.initialSynced,false);
 assert.deepEqual(h.state,{initialSynced:false});
 assert.deepEqual(h.events.map(event=>event.type),['store','readOnly'],'false neither analyzes nor resets recovery');
 const offset=h.events.length;
 h.emit(true);
 assert.deepEqual(h.view,initialView,'first successful sync starts at the first heading, not EOF');
 assert.equal(h.initialSynced,true);
 assert.deepEqual(h.state,{initialSynced:true});
 assert.deepEqual(h.calls('setPosition').map(event=>event.position),[start]);
 assert.deepEqual(h.calls('setScrollTop').map(event=>event.scrollTop),[0]);
 assert.equal(h.calls('reset').length,1);
 assert.deepEqual(h.events.slice(offset).map(event=>event.type),['setPosition','setScrollTop','reset','store','readOnly','analyze','position','renderStatus']);
 for(const type of ['analyze','position']){
  assert.equal(h.calls(type).length,1);
  assert.deepEqual(h.calls(type)[0].view,initialView,type+' observes the normalized cursor/selection/viewport');
  assert.equal(h.calls(type)[0].initialSynced,true);
 }
 assert.equal(h.calls('renderStatus').length,1);
 assert.equal(h.calls('renderStatus')[0].status,h.lastStatus);
}

function reconnect(handlerCode=code){
 const h=harness(handlerCode);
 h.emit(true);
 assert.equal(h.calls('reset').length,1);
 const userViews=[
  {cursor:{lineNumber:3,column:5},selection:selection({lineNumber:7,column:11},{lineNumber:3,column:5}),scrollTop:344},
  {cursor:{lineNumber:5,column:3},selection:selection({lineNumber:5,column:10},{lineNumber:5,column:3}),scrollTop:140},
 ];
 for(const [index,userView]of userViews.entries()){
  h.setUserView(userView);
  const offset=h.events.length,resets=h.calls('reset').length;
  h.emit(false);
  assert.deepEqual(h.view,userView,'disconnect preserves the user view');
  assert.equal(h.initialSynced,true);
  assert.deepEqual(h.state,{initialSynced:true});
  assert.equal(h.calls('reset').length,resets,'false does not reset recovery');
  assert.deepEqual(h.events.slice(offset).map(event=>event.type),['store','readOnly']);
  h.emit(true);
  assert.deepEqual(h.view,userView,'reconnect preserves cursor, reverse selection and scroll');
  assert.equal(h.editorWrites.length,2,'only the first sync writes editor position/scroll');
  assert.equal(h.calls('reset').length,index+2,'every successful reconnect still resets recovery');
  assert.deepEqual(h.events.slice(offset).map(event=>event.type),['store','readOnly','reset','store','readOnly','analyze','position','renderStatus']);
  for(const type of ['analyze','position'])assert.deepEqual(h.calls(type).at(-1).view,userView,type+' observes the retained user view');
  assert.equal(h.calls('renderStatus').at(-1).status,h.lastStatus);
 }
}

test('an empty Y.Text relative index 0 resolves to EOF after encoded remote updates merge',()=>{
 const local=new Y.Doc(),remote=new Y.Doc();
 try{
  const localText=local.getText('markdown'),remoteText=remote.getText('markdown');
  assert.equal(localText.length,0);
  const relative=Y.decodeRelativePosition(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(localText,0)));
  assert.equal(Y.createAbsolutePositionFromRelativePosition(relative,local).index,0);
  const split=text.indexOf('## Later heading');
  remoteText.insert(0,text.slice(0,split));
  const first=Y.encodeStateAsUpdate(remote),vector=Y.encodeStateVector(remote);
  remoteText.insert(remoteText.length,text.slice(split));
  const second=Y.encodeStateAsUpdate(remote,vector);
  Y.applyUpdate(local,Y.mergeUpdates([second,first]),'test-remote-sync');
  assert.equal(localText.toString(),text);
  const resolved=Y.createAbsolutePositionFromRelativePosition(relative,local);
  assert.ok(resolved,'relative position survives the real Yjs update');
  assert.equal(resolved.type,localText);
  assert.equal(resolved.index,text.length,'the empty-text selection has moved to EOF');
  assert.deepEqual(positionAtOffset(localText.toString(),resolved.index),eof);
  assert.notDeepEqual(eof,start);
 }finally{local.destroy();remote.destroy();}
});

test('false does not consume the first sync; true normalizes before analysis and position',()=>firstSync());
test('later false/true reconnects preserve user cursor, selection and scroll but reset recovery',()=>reconnect());
test('closed callbacks do not touch editor, store or recovery before or after first sync',()=>{
 for(const alreadySynced of [false,true]){
  const h=harness();
  if(alreadySynced)h.emit(true);
  h.close();
  const before={view:h.view,state:h.state,events:h.events.slice(),initialSynced:h.initialSynced};
  h.emit(false);h.emit(true);h.emit(true);
  assert.deepEqual({view:h.view,state:h.state,events:h.events.slice(),initialSynced:h.initialSynced},before);
 }
});

// Mutate only the extracted string: production files and shared services stay untouched.
const normalize="editor.setPosition({lineNumber:1,column:1});editor.setScrollTop(0);";
for(const [name,before,after,verify]of [
 ['remove the initial-only guard','if(!initialSynced){','if(true){',reconnect],
 ['remove all initial normalization',normalize,'',firstSync],
 ['remove initial cursor normalization','editor.setPosition({lineNumber:1,column:1});','',firstSync],
 ['remove initial scroll normalization','editor.setScrollTop(0);','',firstSync],
]){
 test('negative control: '+name,()=>{
  assert.ok(code.includes(before),name+' mutation anchor exists');
  const mutant=code.replace(before,after);
  assert.notEqual(mutant,code);
  assert.throws(()=>verify(mutant),{name:'AssertionError'},name+' must fail behavioral assertions');
 });
}
