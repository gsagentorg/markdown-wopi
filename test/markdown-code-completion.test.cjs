const test = require('node:test');
const assert = require('node:assert/strict');

const dependencies = Promise.all([
  import('../client/src/monaco-features.js'),
  import('../client/src/code-languages.js'),
]);

const monaco = {
  languages: {
    setMonarchTokensProvider() {}, registerDocumentSymbolProvider: () => ({ dispose() {} }),
    registerCompletionItemProvider(language, provider) {
      assert.equal(language, 'markdown');
      this.provider = provider;
      return { dispose() {} };
    },
    CompletionItemKind: { Function: 1, Value: 11, Keyword: 17, Reference: 18, Snippet: 28 },
    CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
  },
  Range: class Range {
    constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
      Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn });
    }
  },
};

async function setup() {
  const [{ registerMarkdown }, code] = await dependencies;
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
  return { at, provider, ...code };
}

const fence = '`'.repeat(3);
const keywordsOf = items => items.filter(item => item.kind === monaco.languages.CompletionItemKind.Keyword);

test('offers the grammar keywords for the fence language and replaces only the typed word', async () => {
  const { at, previewKeywords } = await setup();
  const items = at(fence + 'js\ncon¦\n' + fence + '\n');
  const [item] = items.filter(entry => entry.label === 'const');
  assert.ok(item, 'const suggested');
  assert.equal(item.insertText, 'const');
  assert.equal(item.detail, 'keyword');
  assert.deepEqual({ ...item.range }, { startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 4 });
  assert.deepEqual(items.map(entry => entry.label), previewKeywords('js'));
});

test('aliases and extra info-string words resolve to the same grammar', async () => {
  const { at } = await setup();
  const py = at(fence + 'py\n  de¦\n' + fence + '\n');
  assert.ok(py.some(item => item.label === 'def'));
  const titled = at(fence + 'js title="x"\ncon¦\n' + fence + '\n');
  assert.ok(titled.some(item => item.label === 'const'));
});

test('stays quiet for unknown languages, plain prose, inline code and closing markers', async () => {
  const { at } = await setup();
  const sources = [
    fence + 'notalanguage\ncon¦\n' + fence + '\n',
    'plain con¦ text\n',
    '`con¦`\n',
    fence + 'js\ncon\n' + fence.slice(0, 2) + '¦\n',
    fence + 'js\n\n¦\n' + fence + '\n',
    '    con¦\n',
  ];
  for (const source of sources) {
    assert.deepEqual(keywordsOf(at(source)), [], source);
  }
});

test('does not suggest keywords on the opening fence line', async () => {
  const { at } = await setup();
  assert.deepEqual(keywordsOf(at(fence + 'js¦\nconst x = 1\n' + fence + '\n')), []);
});
