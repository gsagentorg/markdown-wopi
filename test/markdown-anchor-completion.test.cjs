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
  return { at, ...preview };
}

const doc = '# 设计原则\n\n## 当前迭代\n\n### 一小段代码\n\n## 当前迭代\n\n[跳转](#¦)\n';

test('replaces only the typed anchor prefix and keeps the closing parenthesis', async () => {
  const { at } = await setup();
  const items = at('# 甲\n\n[跳转](#甲¦)\n');
  const [item] = items;
  assert.equal(item.label, '#甲');
  assert.equal(item.insertText, '甲');
  assert.deepEqual({ ...item.range }, { startLineNumber: 3, startColumn: 7, endLineNumber: 3, endColumn: 8 });
});

test('detail shows level, section path and duplicate ordinals', async () => {
  const { at } = await setup();
  const items = at(doc);
  const byId = Object.fromEntries(items.map(item => [item.insertText, item]));
  assert.equal(byId['设计原则'].detail, '设计原则');
  assert.equal(byId['当前迭代'].detail, '设计原则 > 当前迭代');
  assert.equal(byId['当前迭代-1'].detail, '设计原则 > 当前迭代（第 2 个同名）');
  assert.equal(byId['一小段代码'].detail, '设计原则 > 当前迭代 > 一小段代码');
});

test('filter text carries the heading text so CJK typing matches the slug', async () => {
  const { at } = await setup();
  const items = at('# 设计原则\n\n[跳转](#设计¦)\n');
  const [item] = items;
  assert.equal(item.filterText.startsWith('设计原则'), true);
});

test('inserted ids are the ids the preview emits, including punctuation and repeats', async () => {
  const { at, renderMarkdown } = await setup();
  const headings = ['结论：为什么？', '结论：为什么？', 'a_b c'];
  const source = headings.map(text => '# ' + text).join('\n\n') + '\n\n[跳](#¦)\n';
  const items = at(source);
  const html = renderMarkdown(headings.map(text => '# ' + text).join('\n\n'));
  const ids = [...html.matchAll(/<h1 [^>]*id="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(items.map(item => item.insertText), ids);
  const detail = items[0].detail;
  assert.equal(detail, '结论：为什么？');
});

test('stays quiet inside fenced and indented code and in plain prose', async () => {
  const { at } = await setup();
  const fence = '`'.repeat(3);
  for (const source of [fence + '\n[a](#¦)\n' + fence + '\n\n# 甲\n', '    [a](#¦)\n\n# 甲\n']) {
    assert.ok(!at(source).some(item => item.kind === monaco.languages.CompletionItemKind.Reference), source);
  }
  const prose = at('普通段落 (#甲¦ 不是链接)\n\n# 甲\n');
  assert.ok(!prose.some(item => item.label === '#甲'));
});
