const test = require('node:test');
const assert = require('node:assert/strict');

const dependencies = Promise.all([
  import('../client/src/monaco-features.js'),
  import('../client/src/code-languages.js'),
  import('../client/src/preview.js'),
  import('monaco-editor/editor/contrib/snippet/browser/snippetParser.js'),
]);

const monaco = {
  languages: {
    setMonarchTokensProvider() {}, registerDocumentSymbolProvider: () => ({ dispose() {} }),
    registerCompletionItemProvider(language, provider) {
      assert.equal(language, 'markdown');
      this.provider = provider;
      return { dispose() {} };
    },
    CompletionItemKind: { Function: 1, Value: 11, Snippet: 28 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
  Range: class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  },
};

async function setup() {
  const [{ registerMarkdown }, code, preview, { SnippetParser }] = await dependencies;
  const registration = registerMarkdown(monaco);
  const provider = monaco.languages.provider;
  registration.destroy();
  function at(marked) {
    const [before, after] = marked.split('¦');
    assert.notEqual(after, undefined, 'include a cursor marker');
    const source = before + after;
    const lines = source.split(/\r?\n/);
    const lineNumber = before.split(/\r?\n/).length;
    const column = before.slice(before.lastIndexOf('\n') + 1).length + 1;
    const model = {
      getVersionId: () => 1,
      getValue: () => source,
      getLineCount: () => lines.length,
      getLineContent: n => lines[n - 1],
      getWordUntilPosition: () => ({ startColumn: column }),
    };
    return provider.provideCompletionItems(model, { lineNumber, column }).suggestions;
  }
  const parse = item => new SnippetParser().parse(item.insertText);
  return { at, provider, parse, ...code, ...preview };
}

const tex = String.raw;
const fence = '`'.repeat(3);

test('native provider triggers and replaces only the LaTeX command; frac tabs through both arguments', async () => {
  const { at, provider, parse } = await setup();
  for (const char of ['\\', '{', '`', '~']) assert.ok(provider.triggerCharacters.includes(char));
  assert.ok(at('前 $\\¦$').some(item => item.label === '\\alpha'));
  const [frac] = at(tex`前 $\fr¦ac+x$ 后`);
  assert.equal(frac.label, '\\frac');
  assert.equal(frac.insertTextRules, monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet);
  assert.deepEqual({ ...frac.range }, { startLineNumber: 1, startColumn: 4, endLineNumber: 1, endColumn: 9 });
  const parsed = parse(frac);
  assert.equal(parsed.toString(), '\\frac{}{}');
  assert.deepEqual(parsed.placeholders.map(p => p.index), [1, 2, 0]);
});

test('math works in preview-compatible inline/display forms, including an unclosed display block', async () => {
  const { at } = await setup();
  for (const source of [tex`$ \fr¦ $`, tex`$2+\fr¦$`, tex`Before $$\fr¦$$ after`, tex`$$\fr¦$$`, '$$\n\\fr¦\n$$', '$$\r\n  \\fr¦\r\n$$', 'Heading\n\n$$\n    \\fr¦', '> $$\n> \\fr¦\n> $$']) {
    assert.ok(at(source).some(item => item.label === '\\frac'), source);
  }
});

test('does not offer formulas in prose, escaped dollars, currency, or code', async () => {
  const { at } = await setup();
  for (const source of [tex`prose \fr¦`, tex`\$x \fr¦$`, tex`cost $5 with \fr¦`, tex`$5 and $10 with \fr¦`, tex`$x$ outside \fr¦`, tex`$x \\fr¦$`, '`$\\fr¦$`', '`` a ` $\\fr¦$ ``', '`multi\n$\\fr¦$ line`', '    $\\fr¦$', fence + 'py\n$\\fr¦$\n' + fence, '~~~~\n~~~\n$$\n\\fr¦\n~~~~', '> ' + fence + '\n> $\\fr¦$\n> ' + fence]) {
    assert.ok(!at(source).some(item => item.detail?.startsWith('KaTeX')), source);
  }
});

test('environments insert a body Tab stop; all offered environments render in the preview', async () => {
  const { at, parse, renderMarkdown } = await setup();
  const entries = at('$$\n\\begin{¦}\n$$');
  assert.ok(entries.find(item => item.label === 'aligned'));
  assert.ok(entries.find(item => item.label === 'cases'));
  for (const item of entries) {
    assert.deepEqual({ ...item.range }, { startLineNumber: 2, startColumn: 8, endLineNumber: 2, endColumn: 9 });
    const snippet = parse(item);
    assert.deepEqual(snippet.placeholders.map(p => p.index), [1, 0]);
    assert.equal(snippet.toString(), `${item.label}}\n\t\n\\end{${item.label}}`);
    const html = renderMarkdown(`$$\n\\begin{${snippet.toString().replace('\t', '\tx')}\n$$`);
    assert.match(html, /katex-display/, item.label);
    assert.doesNotMatch(html, /katex-error/, item.label);
  }
  const [item] = at(tex`$\begin{cas¦es}$`);
  assert.equal(parse(item).toString(), 'cases}\\end{cases}');
  assert.deepEqual(parse(item).placeholders.map(p => p.index), [1, 0]);
});

test('preserves the matching environment end but ignores comments, escaped ends, and ends outside the formula', async () => {
  const { at, parse } = await setup();
  const aligned = text => at(text).find(item => item.label === 'aligned');
  for (const source of ['$$\n\\begin{al¦}\na&=b\n\\end{aligned}\n$$', tex`$\begin{al¦}a=b\end{aligned}$`, '$$\n\\begin{al¦}\na&=b\n\\% \\end{aligned}\n$$']) {
    assert.equal(parse(aligned(source)).toString(), 'aligned}', source);
  }
  for (const source of ['$$\n\\begin{al¦}\n% \\end{aligned}\n$$', tex`$\begin{al¦}a=b$ \end{aligned}`, tex`$\begin{al¦}a=b\\end{aligned}$`, '$$\n\\begin{al¦}\n\\begin{aligned}\na&=b\n\\end{aligned}\n$$']) {
    assert.match(parse(aligned(source)).toString(), /\\end\{aligned\}/, source);
  }
});

test('fence language IDs come from the preview registry; suffix and alias edits preserve the rest of the opener', async () => {
  const { at, previewLanguages, highlightCode } = await setup();
  const all = at(fence + '¦').map(item => item.label);
  assert.deepEqual(all.sort(), previewLanguages().map(entry => entry.id).sort());
  const python = at(fence + '  py¦thon extra').find(item => item.label === 'python');
  assert.equal(python.insertText, 'python');
  assert.deepEqual({ ...python.range }, { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 12 });
  const js = at('> ~~~~js¦').find(item => item.label === 'javascript');
  assert.equal(js.filterText, 'js');
  assert.ok(highlightCode('const x = 1;', js.insertText));
  for (const source of [fence + 'not_a_preview_language¦', fence + 'py extra¦', fence + 'py\njs¦\n' + fence, fence + 'py\n' + fence + '¦', '````\n' + fence + 'py¦\n````', '~~~\n' + fence + 'py¦\n~~~']) {
    assert.ok(!at(source).some(item => item.detail === 'Preview language'), source);
  }
});
