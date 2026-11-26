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


// Resolve a fence info string to the grammar the preview would highlight with.
export function previewGrammar(language) {
  const tag = String(language || '').trim().split(/\s+/)[0].toLowerCase();
  if (!tag) return null;
  const direct = hljs.getLanguage(tag);
  if (direct) return tag;
  for (const id of hljs.listLanguages()) {
    const grammar = hljs.getLanguage(id);
    if ((grammar.aliases || []).includes(tag)) return id;
  }
  return null;
}

// Keywords published by that same grammar, so code-body suggestions cannot drift
// from what the preview considers a keyword.
export function previewKeywords(language) {
  const id = previewGrammar(language);
  if (!id) return [];
  const keywords = hljs.getLanguage(id).keywords;
  const words = [];
  const add = word => {
    word = String(word || '').trim();
    if (/^[A-Za-z_][\w$]{1,39}$/.test(word) && !words.includes(word)) words.push(word);
  };
  const push = value => {
    if (Array.isArray(value)) value.forEach(add);
    else if (typeof value === 'string') value.split(/\s+/).forEach(add);
  };
  // Bundlers may hand back either the authored lists (group -> words) or the
  // compiled map (word -> [group, relevance]); accept both shapes.
  const entries = keywords && typeof keywords === 'object' ? Object.entries(keywords) : [];
  const compiled = entries.length > 0 && entries.every(([, value]) =>
    Array.isArray(value) && typeof value[0] === 'string' && (value.length === 1 || typeof value[1] === 'number'));
  if (typeof keywords === 'string') push(keywords);
  else if (compiled) entries.forEach(([word]) => { if (!word.startsWith('$')) add(word); });
  else entries.forEach(([group, value]) => { if (group !== '$pattern') push(value); });
  return words.sort((a, b) => a.localeCompare(b));
}
