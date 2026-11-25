import MarkdownIt from 'markdown-it';
import {katex} from '@mdit/plugin-katex';
import {previewLanguages} from './code-languages.js';
import {analyzeMarkdown} from './markdown-analysis.js';

const parser = new MarkdownIt({ html: false }).use(katex, {delimiters: 'all', mathFence: true});
const cache = new WeakMap();
const isWord = char => /[a-zA-Z0-9_]/.test(char ?? '');
const escaped = (text, index) => {
  let start = index;
  while (start > 0 && text[start - 1] === '\\') start--;
  return (index - start) % 2 === 1;
};

function documentBlocks(model) {
  const version = model.getVersionId();
  const previous = cache.get(model);
  if (previous?.version === version) return previous;
  // Use the preview's Markdown parser for fence width, containers, and closing rules.
  // Inline rules aren't needed here: we only use block ranges and fence info strings.
  const blocks = new Map();
  const tokens = [];
  parser.block.parse(model.getValue().replace(/\r\n?/g, '\n'), parser, {}, tokens);
  for (const item of tokens) {
    if (!['fence', 'code_block', 'inline', 'math_block'].includes(item.type) || !item.map) continue;
    for (let line = item.map[0] + 1; line <= item.map[1]; line++) blocks.set(line, item);
  }
  const result = { version, blocks };
  cache.set(model, result);
  return result;
}

function fenceLanguage(block, line, cursor) {
  const infoStart = line.length - block.info.length;
  const leading = /^[ \t]*/.exec(block.info)[0].length;
  const start = infoStart + leading;
  const id = /^[\w+-]*/.exec(line.slice(start))[0];
  if (cursor < start || cursor > start + id.length || !/^(?:[ \t]|$)/.test(line.slice(start + id.length))) return null;
  return { start, end: start + id.length, prefix: line.slice(start, cursor).toLowerCase() };
}

function displayBounds(model, blocks, row, cursor) {
  const block = blocks.get(row);
  if (block?.type === 'math_block') {
    if (block.markup !== '$$') return null;
    const startRow = block.map[0] + 1;
    const endRow = block.map[1];
    const start = model.getLineContent(startRow).indexOf('$$') + 2;
    const end = model.getLineContent(endRow).lastIndexOf('$$');
    if ((row === startRow && cursor < start) || (row === endRow && cursor > end)) return null;
    return { startRow, start, endRow, end };
  }
  // Preview needs a closing delimiter to emit a math token. During editing, also
  // recognize a top-level $$ opener that has not been closed yet.
  for (let n = row; n >= 1; n--) {
    const type = blocks.get(n)?.type;
    if (type === 'fence' || type === 'math_block') break;
    const line = model.getLineContent(n);
    const opener = /^ {0,3}\$\$(?!\$)(?!.*\$\$)/.exec(line);
    if (!opener || type === 'code_block') continue;
    const start = opener[0].length;
    if (n === row && cursor < start) return null;
    let endRow = row;
    while (endRow < model.getLineCount() && !['fence', 'math_block'].includes(blocks.get(endRow + 1)?.type)) endRow++;
    return { startRow: n, start, endRow, end: model.getLineContent(endRow).length };
  }
  return null;
}

function inlineCodeRanges(text) {
  const runs = [...text.matchAll(/`+/g)];
  const nextAtWidth = new Map();
  const closers = runs.map(() => null);
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i];
    closers[i] = nextAtWidth.get(run[0].length);
    nextAtWidth.set(run[0].length, i);
  }
  const ranges = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    const isEscaped = escaped(text, run.index);
    let close = closers[i];
    if (isEscaped) {
      // A Markdown escape consumes one backtick, not an entire run.
      if (run[0].length === 1) continue;
      close = runs.findIndex((next, j) => j > i && next[0].length === run[0].length - 1);
      if (close === -1) continue;
    }
    if (close === undefined) continue;
    ranges.push([run.index + Number(isEscaped), runs[close].index + runs[close][0].length]);
    i = close;
  }
  return ranges;
}

function inlineBounds(line, cursor, code) {
  let opener = null;
  for (const dollars of line.matchAll(/\$+/g)) {
    const at = dollars.index;
    const width = dollars[0].length;
    if (code.some(([start, end]) => at >= start && at < end) || escaped(line, at)) continue;
    if (opener && opener.width === width && (width === 2 || !isWord(line[at + width]))) {
      if (cursor >= opener.start && cursor <= at) return { start: opener.start, end: at };
      opener = null;
    } else if (at < cursor) {
      opener = width <= 2 && (width === 2 || !isWord(line[at - 1])) ? { start: at + width, width } : null;
    } else break;
  }
  // A numeric, unclosed `$…` looks like currency. Wait for an actual closer.
  if (opener && cursor >= opener.start && !/^\s*\d/.test(line.slice(opener.start))) {
    return { start: opener.start, end: line.length };
  }
  return null;
}

const commands = [
  ['frac', '{$1}{$2}$0'], ['sqrt', '{$1}$0'], ['sum', '_{$1}^{$2}$0'],
  ['prod', '_{$1}^{$2}$0'], ['int', '_{$1}^{$2}$0'], ['lim', '_{$1}$0'],
  ['text', '{$1}$0'], ['mathrm', '{$1}$0'], ['mathbf', '{$1}$0'], ['mathbb', '{$1}$0'],
  ['vec', '{$1}$0'], ['hat', '{$1}$0'], ['bar', '{$1}$0'], ['overline', '{$1}$0'],
  ...'begin alpha beta gamma delta epsilon theta lambda mu pi rho sigma phi omega Gamma Delta Theta Lambda Pi Sigma Phi Omega sin cos tan log ln exp min max infty cdot times pm leq geq neq approx equiv to rightarrow leftarrow implies in notin subseteq cup cap partial nabla ldots cdots'.split(' ').map(name => [name]),
];
const environments = ['aligned', 'gathered', 'cases', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix', 'smallmatrix'];

function hasMatchingEnd(body, name) {
  let depth = 0;
  for (const match of body.matchAll(/(?<!\\)(?:\\\\)*(%[^\n]*|\\(begin|end)\s*\{([A-Za-z*]+)\})/g)) {
    if (match[3] !== name) continue;
    if (match[2] === 'begin') depth++;
    else if (depth === 0) return true;
    else depth--;
  }
  return false;
}

function mathCompletions(model, row, line, cursor, block, blocks, candidate) {
  let code = [];
  if (block?.type === 'inline') {
    // Markdown backtick spans may continue across soft line breaks, but not blocks.
    const lines = [];
    for (let n = block.map[0] + 1; n <= block.map[1]; n++) lines.push(model.getLineContent(n));
    const offset = lines.slice(0, row - block.map[0] - 1).reduce((sum, line) => sum + line.length + 1, 0);
    code = inlineCodeRanges(lines.join('\n')).map(([start, end]) => [start - offset, end - offset]);
    if (code.some(([start, end]) => candidate.index >= start && cursor <= end)) return [];
  }
  let math = displayBounds(model, blocks, row, cursor);
  const display = !!math;
  if (!math) {
    if (block?.type !== 'inline') return [];
    const inline = inlineBounds(line, cursor, code);
    if (!inline) return [];
    math = { ...inline, startRow: row, endRow: row };
  }
  if ((row === math.startRow && candidate.index < math.start) || escaped(line, candidate.index)) return [];
  const currentEnd = row === math.endRow ? math.end : line.length;
  const after = line.slice(cursor, currentEnd);
  const [, environment, command] = candidate;
  if (environment !== undefined) {
    const start = cursor - environment.length;
    const end = cursor + /^[a-zA-Z]*\}?/.exec(after)[0].length;
    const remainder = [];
    for (let n = row; n <= math.endRow; n++) {
      const content = model.getLineContent(n);
      remainder.push(content.slice(n === row ? end : 0, n === math.endRow ? math.end : content.length));
    }
    const body = remainder.join('\n');
    return environments.filter(name => name.startsWith(environment)).map(name => {
      const finish = `\\end{${name}}`;
      const insertText = hasMatchingEnd(body, name) ? `${name}}$0`
        : display ? `${name}}\n\t$1\n${finish}$0` : `${name}}$1${finish}$0`;
      return { label: name, detail: 'KaTeX environment', insertText, start, end, kind: 'Snippet', snippet: true };
    });
  }
  const end = cursor + /^[a-zA-Z]*/.exec(after)[0].length;
  return commands.filter(([name]) => name.startsWith(command)).map(([name, args]) => ({
    label: '\\' + name, detail: 'KaTeX', insertText: '\\' + name + (args ?? ''),
    start: candidate.index, end, kind: args ? 'Snippet' : 'Function', snippet: !!args,
  }));
}

// null leaves ordinary Markdown completions alone; [] claims a context without matches.
export function markdownCompletions(model, { lineNumber: row, column }) {
  const line = model.getLineContent(row);
  const cursor = column - 1;
  const candidate = /\\(?:begin\{([a-zA-Z]*)|([a-zA-Z]*))$/.exec(line.slice(0, cursor));
  if (!candidate && !/[`~]{3}/.test(line)) return null;
  const { blocks } = documentBlocks(model);
  const block = blocks.get(row);
  if (block?.type === 'fence') {
    if (row !== block.map[0] + 1) return [];
    const language = fenceLanguage(block, line, cursor);
    if (!language) return [];
    const { start, end, prefix } = language;
    return previewLanguages().flatMap(({ id, aliases }) => {
      const match = id.startsWith(prefix) ? id : aliases.find(alias => alias.startsWith(prefix));
      return match ? [{ label: id, filterText: match, detail: 'Preview language', insertText: id, start, end, kind: 'Value' }] : [];
    });
  }
  return candidate ? mathCompletions(model, row, line, cursor, block, blocks, candidate) : null;
}

// Reference labels come from `[label]: url` definitions the preview renders as links.
function linkDefinitions(model, blocks) {
  const definitions = [];
  const count = model.getLineCount();
  for (let n = 1; n <= count; n++) {
    const block = blocks.get(n);
    if (block && ['fence', 'code_block', 'html_block'].includes(block.type)) continue;
    const match = /^ {0,3}\[([^\[\]]+)\]:[ \t]*(\S+)/.exec(model.getLineContent(n));
    if (!match) continue;
    const label = match[1].trim().replace(/\s+/g, ' ');
    // `[^x]: …` is not a link label: the preview has no footnote support.
    if (!label || label.startsWith('^')) continue;
    definitions.push({ label, url: match[2] });
  }
  return definitions;
}

// Resolve inline-code spans to the current row so `[text][` inside code stays quiet.
function inlineCodeOnLine(model, block, row) {
  if (block?.type !== 'inline') return [];
  const lines = [];
  for (let n = block.map[0] + 1; n <= block.map[1]; n++) lines.push(model.getLineContent(n));
  const offset = lines.slice(0, row - block.map[0] - 1).reduce((sum, line) => sum + line.length + 1, 0);
  const width = model.getLineContent(row).length;
  return inlineCodeRanges(lines.join('\n'))
    .map(([start, end]) => [start - offset, end - offset])
    .filter(([start, end]) => end > 0 && start < width)
    .map(([start, end]) => [Math.max(0, start), Math.min(width, end)]);
}

// `[text][label` completes labels defined anywhere in the document; the closing `]` is left alone.
export function referenceCompletions(model, { lineNumber: row, column }) {
  const line = model.getLineContent(row);
  const cursor = column - 1;
  const fragment = /\[([^\[\]]*)\]\[([^\[\]]*)$/.exec(line.slice(0, cursor));
  if (!fragment) return null;
  const { blocks } = documentBlocks(model);
  const block = blocks.get(row);
  if (block && ['fence', 'code_block', 'html_block', 'math_block'].includes(block.type)) return [];
  const start = cursor - fragment[2].length;
  const code = inlineCodeOnLine(model, block, row);
  if (code.some(([from, to]) => start >= from && start < to)) return [];
  if (block?.type === 'inline' && inlineBounds(line, cursor, code)) return [];
  const prefix = fragment[2].trim().replace(/\s+/g, ' ').toLowerCase();
  const shorten = value => (value.length > 80 ? value.slice(0, 79) + '…' : value);
  return linkDefinitions(model, blocks)
    .filter(({ label }) => label.toLowerCase().startsWith(prefix))
    .map(({ label, url }) => ({
      label, detail: shorten(url), insertText: label, start, end: cursor, kind: 'Reference',
    }));
}

// `[text](#head` completes the slugs the preview generates for this document.
export function anchorCompletions(model, { lineNumber: row, column }) {
  const line = model.getLineContent(row);
  const cursor = column - 1;
  const fragment = /\]\(#([^\s)]*)$/.exec(line.slice(0, cursor));
  if (!fragment) return null;
  const { blocks } = documentBlocks(model);
  const block = blocks.get(row);
  if (block && ['fence', 'code_block', 'html_block', 'math_block'].includes(block.type)) return [];
  const start = cursor - fragment[1].length;
  const stack = [];
  const seen = new Map();
  return analyzeMarkdown(model.getValue()).headings.map(heading => {
    while (stack.length && stack.at(-1).level >= heading.level) stack.pop();
    const trail = [...stack.map(item => item.text), heading.text].filter(Boolean).join(' › ');
    stack.push(heading);
    const ordinal = (seen.get(heading.text) ?? 0) + 1;
    seen.set(heading.text, ordinal);
    // Nested headings are indented by level so duplicates stay visually distinct.
    const detail = `H${heading.level} · ${trail}` + (ordinal > 1 ? ` · 同名 #${ordinal}` : '');
    return {
      label: '#' + heading.id, filterText: heading.id + ' ' + heading.text, detail,
      insertText: heading.id, start, end: cursor, kind: 'Reference',
    };
  });
}

export const markdownCompletionTriggers = ['\\', '{', '`', '~', '['];

export function toMonacoCompletionItems(monaco, row, items) {
  return {
    // Refresh after each keystroke so suffix ranges and alias matches remain correct.
    incomplete: items.length > 0,
    suggestions: items.map(({ start, end, kind, snippet, ...item }) => ({
      ...item,
      kind: monaco.languages.CompletionItemKind[kind],
      range: new monaco.Range(row, start + 1, row, end + 1),
      ...(snippet ? { insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet } : {}),
    })),
  };
}
