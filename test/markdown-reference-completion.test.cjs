const test = require('node:test');
const assert = require('node:assert/strict');

const dependencies = Promise.all([
  import('../client/src/monaco-features.js'),
  import('../client/src/preview.js'),
]);

const monaco = {
  languages: {
    setMonarchTokensProvider() {}, registerDocumentSymbolProvider: () => ({ dispose() {} }),
    registerCompletionItemProvider(language, provider) {
      assert.equal(language, 'markdown');
      this.provider = provider;
      return { dispose() {} };
    },
    CompletionItemKind: { Function: 1, Value: 11, Reference: 18, Snippet: 28 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
  Range: class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  },
};

async function setup() {
  const [{ registerMarkdown }, preview] = await dependencies;
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
  return { at, provider, ...preview };
}

const fence = '`'.repeat(3);

test('completes labels from document definitions and replaces only the typed prefix', async () => {
  const { at, provider } = await setup();
  assert.ok(provider.triggerCharacters.includes('['));
  const items = at('See [x][ref¦-a] and more.\n\n[ref-a]: https://example.com/a\n');
  const [item] = items.filter(entry => entry.label === 'ref-a');
  assert.ok(item, JSON.stringify(items.map(i => i.label)));
  assert.equal(item.insertText, 'ref-a');
  assert.equal(item.kind, monaco.languages.CompletionItemKind.Reference);
  assert.equal(item.detail, 'https://example.com/a');
  assert.deepEqual({ ...item.range }, { startLineNumber: 1, startColumn: 9, endLineNumber: 1, endColumn: 12 });
});

test('matching is case-insensitive and keeps the canonical label spelling', async () => {
  const { at } = await setup();
  const items = at('See [x][refb¦].\n\n[refB]: https://example.com/b\n');
  assert.deepEqual(items.map(entry => entry.label), ['refB']);
  assert.equal(items[0].insertText, 'refB');
});

test('an empty second bracket offers every definition, including collapsed references', async () => {
  const { at } = await setup();
  const items = at('See [x][¦].\n\n[a]: https://a.example\n[b]: https://b.example\n');
  assert.deepEqual(items.map(entry => entry.label), ['a', 'b']);
});

test('stays quiet in code, math, footnote labels, and closed references', async () => {
  const { at } = await setup();
  const sources = [
    fence + '\n[a][ref¦]\n' + fence + '\n\n[ref]: https://example.com\n',
    '`[a][ref¦]`\n\n[ref]: https://example.com\n',
    '$$\n[a][ref¦]\n$$\n\n[ref]: https://example.com\n',
    'See [a][ref¦] here.\n\n[^note]: https://example.com\n',
    'See [a][ref]¦ here.\n\n[ref]: https://example.com\n',
    'See [a](ref¦).\n\n[ref]: https://example.com\n',
  ];
  for (const source of sources) {
    assert.ok(!at(source).some(entry => entry.detail?.startsWith('https://')), source);
  }
});

test('definitions inside fenced code are not offered', async () => {
  const { at } = await setup();
  const items = at('See [x][¦].\n\n' + fence + '\n[hidden]: https://hidden.example\n' + fence + '\n');
  assert.deepEqual(items, []);
});

test('the preview renders the completed reference as the definition target', async () => {
  const { renderMarkdown } = await setup();
  const html = renderMarkdown('See [a][refB].\n\n[refB]: https://example.com/b\n');
  assert.match(html, /href="https:\/\/example\.com\/b"/);
});
