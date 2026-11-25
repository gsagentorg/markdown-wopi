import hljs from 'highlight.js/lib/common';
export function highlightCode(code, language) {
  if(typeof code!=='string'||code.length>200000)return '';
  const lang=String(language||'').trim().split(/\s+/)[0].toLowerCase();
  if(!lang||lang.length>40||!hljs.getLanguage(lang))return '';
  try{return hljs.highlight(code,{language:lang,ignoreIllegals:true}).value;}catch{return '';}
}

// Use the same registered grammars (and their aliases) as preview highlighting.
export function previewLanguages() {
  return hljs.listLanguages().map(id => ({id, aliases: hljs.getLanguage(id).aliases || []}));
}
