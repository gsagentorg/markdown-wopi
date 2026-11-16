import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('./src/workbench/session.js',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  const wrapPairs='),source.indexOf('  disposables.push(editor.onKeyDown(wrapSelection))'));
class Selection {
 constructor(a,b,c,d){
  Object.assign(this,{selectionStartLineNumber:a,selectionStartColumn:b,positionLineNumber:c,positionColumn:d});
  const backward=a>c||(a===c&&b>d);
  Object.assign(this,{startLineNumber:backward?c:a,startColumn:backward?d:b,endLineNumber:backward?a:c,endColumn:backward?b:d});
 }
 getStartPosition(){return {lineNumber:this.startLineNumber,column:this.startColumn};}
 getEndPosition(){return {lineNumber:this.endLineNumber,column:this.endColumn};}
 isEmpty(){return this.startLineNumber===this.endLineNumber&&this.startColumn===this.endColumn;}
}
function harness(text,readOnly=false,ranges,handlerCode=code){
 let selections=(ranges||[[1,1,text.split('\n').length,text.split('\n').at(-1).length+1]]).map(r=>new Selection(...r)),calls=0;
 const offset=p=>text.split('\n').slice(0,p.lineNumber-1).reduce((n,s)=>n+s.length+1,0)+p.column-1;
 const model={getOffsetAt:offset,getPositionAt(n){const lines=text.slice(0,n).split('\n');return {lineNumber:lines.length,column:lines.at(-1).length+1};},getValueInRange:s=>text.slice(offset(s.getStartPosition()),offset(s.getEndPosition()))};
 const editor={getSelections:()=>selections,executeEdits(_id,edits,endCursorState){
  calls++;
  const changes=edits.map(e=>({start:offset(e.range.getStartPosition()),end:offset(e.range.getEndPosition()),text:e.text})).sort((a,b)=>b.start-a.start);
  for(const e of changes)text=text.slice(0,e.start)+e.text+text.slice(e.end);
  selections=endCursorState([]);
 }};
 const handler=new Function('editor','model','monaco','snapshot',handlerCode+';return wrapSelection;')(editor,model,{Selection},()=>({readOnly}));
 return {press(key,extra={}){let prevented=false,stopped=false;handler({...extra,browserEvent:{key,...extra.browserEvent},preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});assert.equal(stopped,prevented);return prevented;},get text(){return text;},get calls(){return calls;},get selections(){return selections;},selected:()=>selections.map(s=>model.getValueInRange(s))};
}
function repeated(handlerCode=code){const h=harness('a+b',false,undefined,handlerCode);assert.equal(h.press('$'),true);assert.equal(h.text,'$a+b$');assert.deepEqual(h.selected(),['a+b']);h.press('$');assert.equal(h.text,'$$a+b$$');assert.deepEqual(h.selected(),['a+b']);}
function multi(handlerCode=code){
 const h=harness('one gap two\nthree end',false,[[2,6,1,9],[1,1,1,4]],handlerCode);
 h.press('$');assert.equal(h.text,'$one$ gap $two\nthree$ end');assert.deepEqual(h.selected(),['two\nthree','one']);
 assert.deepEqual(h.selections.map(s=>[s.selectionStartLineNumber,s.selectionStartColumn,s.positionLineNumber,s.positionColumn]),[[2,6,1,12],[1,2,1,5]]);
 h.press('$');assert.equal(h.text,'$$one$$ gap $$two\nthree$$ end');assert.deepEqual(h.selected(),['two\nthree','one']);assert.equal(h.calls,2);
 assert.deepEqual(h.selections.map(s=>[s.selectionStartLineNumber,s.selectionStartColumn,s.positionLineNumber,s.positionColumn]),[[2,6,1,15],[1,3,1,6]]);
}
function unchanged(readOnly,extra={},ranges,handlerCode=code){const h=harness('formula',readOnly,ranges,handlerCode);assert.equal(h.press('$',extra),false);assert.equal(h.text,'formula');assert.equal(h.calls,0);}
test('selected formula survives two dollar keystrokes with inner selection retained',()=>repeated());
test('multiline formula preserves exact inner selection through repeated wrapping',()=>{const h=harness('a+b\nc+d');h.press('$');assert.deepEqual(h.selected(),['a+b\nc+d']);h.press('$');assert.equal(h.text,'$$a+b\nc+d$$');assert.deepEqual(h.selected(),['a+b\nc+d']);});
test('all selections wrap atomically, retaining reverse direction and primary order',()=>multi());
test('read-only, composition and modified keys do not wrap',()=>{unchanged(true);for(const key of ['ctrlKey','metaKey','altKey']){unchanged(false,{[key]:true});unchanged(false,{browserEvent:{[key]:true}});}unchanged(false,{browserEvent:{isComposing:true}});unchanged(false,{browserEvent:{keyCode:229}});});
test('empty selections and mixed cursors leave default typing untouched',()=>{unchanged(false,{},[[1,3,1,3]]);unchanged(false,{},[[1,1,1,4],[1,6,1,6]]);});
test('existing emphasis wrapping remains available',()=>{for(const key of ['*','_','~']){const h=harness('text');h.press(key);assert.equal(h.text,key+'text'+key);assert.deepEqual(h.selected(),['text']);}});
test('pruneDrafts is imported from the draft store',()=>assert.ok(source.includes("import {pruneDrafts} from '../draft-store.js';")));
test('negative mutations are killed in memory without touching shared sources',()=>{
 const mutations=[
  ['drop secondary selections','const selections=editor.getSelections();','const selections=editor.getSelections().slice(0,1);',multi],
  ['lose direction','return backward?','return false?',multi],
  ['omit preceding edit offsets','sum+(other.end<=start?key.length+pair.length:0)','sum',multi],
  ['select delimiters','start+shift+key.length','start+shift',repeated],
  ['intercept empty cursors','selections.some(sel=>sel.isEmpty())','false',c=>unchanged(false,{},[[1,3,1,3]],c)],
  ['ignore readOnly','snapshot().readOnly','false',c=>unchanged(true,{},undefined,c)],
 ];
 for(const [name,before,after,verify] of mutations){assert.ok(code.includes(before),name+' mutation anchor exists');const mutant=code.replace(before,after);assert.throws(()=>verify(mutant),{name:'AssertionError'},name+' must fail regression assertions');}
});
