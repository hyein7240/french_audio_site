const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../js/editor.js'), 'utf8');
const gitSha = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const lesson = (number, title) => ({ lesson: number, title, sections: [] });
const script = value => `window.LESSONS.push(${JSON.stringify(value)});`;

class Element {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.nodes = new Map();
    this.attributes = new Map();
    this.events = new Map();
    this.classList = { toggle() {}, add() {}, remove() {} };
  }
  set innerHTML(value) { this.children = []; }
  querySelector(selector) {
    if (!this.nodes.has(selector)) this.nodes.set(selector, new Element());
    return this.nodes.get(selector);
  }
  append(...children) { this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(name, callback) { this.events.set(name, callback); }
  showModal() {}
  close() {}
}

async function openEditor({ prefix = '', truncated = false } = {}) {
  const initial = [lesson(1, '1차시'), lesson(11, '단어장3')];
  const nodes = new Map();
  const element = selector => {
    if (!nodes.has(selector)) nodes.set(selector, new Element());
    return nodes.get(selector);
  };
  const saved = [];
  const requests = [];
  const remote = new Map([
    [`${prefix}data/lessons/manifest.js`, 'window.LESSON_FILES = [1, 10, 11];'],
    ...[...initial, lesson(10, '단어장2')].map(l => [`${prefix}data/lessons/lesson${l.lesson}.js`, script(l)])
  ]);
  const config = { owner: 'test-owner', repo: 'test-repo', branch: 'main', path: prefix.replace(/\/$/, '') };
  let context;
  const head = {
    appendChild(node) {
      requests.push(node.src);
      queueMicrotask(() => {
        const pathname = node.src.split('?')[0];
        if (pathname.endsWith('/manifest.js')) {
          context.window.LESSON_FILES = initial.map(l => l.lesson);
        } else {
          const n = Number(pathname.match(/lesson(\d+)\.js$/)?.[1]);
          const found = initial.find(l => l.lesson === n);
          if (!found) { node.onerror(); return; }
          vm.runInContext(script(found), context);
        }
        node.onload();
      });
    }
  };
  const fetch = async (url, options = {}) => {
    const endpoint = new URL(url).pathname;
    let result;
    if (endpoint === '/graphql') {
      const input = JSON.parse(options.body).variables.input;
      saved.push(input);
      for (const f of input.fileChanges.additions) remote.set(f.path, Buffer.from(f.contents, 'base64').toString('utf8'));
      for (const f of input.fileChanges.deletions) remote.delete(f.path);
      result = { data: { createCommitOnBranch: { commit: { oid: 'saved', url: 'https://example.test/commit/saved' } } } };
    } else if (endpoint.includes('/git/ref/heads/')) {
      result = { object: { sha: 'parent' } };
    } else if (endpoint.endsWith('/git/commits/parent')) {
      result = { tree: { sha: 'remote-tree' } };
    } else if (endpoint.endsWith('/git/trees/remote-tree')) {
      result = { truncated, tree: [...remote].map(([path, text]) => ({ path, type: 'blob', sha: gitSha(text) })) };
    } else {
      throw new Error(`Unexpected request: ${url}`);
    }
    return { ok: true, status: 200, json: async () => result };
  };
  context = vm.createContext({
    window: {}, document: { querySelector: element, createElement: () => new Element(), head },
    crypto: webcrypto, TextEncoder, Uint8Array, Blob,
    localStorage: { getItem: key => key === 'frenchLessonGithubConfig' ? JSON.stringify(config) : null },
    sessionStorage: { getItem: () => 'test-token' },
    fetch, addEventListener() {},
    setTimeout: () => 0, clearTimeout() {},
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    URL, Date, console
  });
  vm.runInContext(source, context);
  for (let i = 0; i < 30 && element('#lesson-list').children.length !== 2; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(element('#lesson-list').children.length, 2, 'initial lessons loaded');
  function selectThirdBook() {
    const button = element('#lesson-list').children.find(b => b.querySelector('.label').textContent === '단어장3');
    assert.ok(button);
    button.onclick();
  }
  async function save() { await element('#github-save').onclick(); }
  function manifestNumbers() {
    const context = { window: {} };
    vm.runInNewContext(remote.get(`${prefix}data/lessons/manifest.js`), context);
    return Array.from(context.window.LESSON_FILES);
  }
  return { element, selectThirdBook, save, saved, remote, manifestNumbers, requests };
}

test('saving an older editor preserves a lesson added after the editor opened', async () => {
  const editor = await openEditor();
  editor.selectThirdBook();
  editor.element('#lesson-title').oninput({ target: { value: '단어장3 수정' } });
  await editor.save();
  assert.equal(editor.saved.length, 1);
  assert.deepEqual(editor.manifestNumbers(), [1, 10, 11]);
  assert.ok(editor.remote.has('data/lessons/lesson10.js'));
  assert.equal(editor.saved[0].fileChanges.deletions.length, 0);
  assert.match(editor.remote.get('data/lessons/lesson11.js'), /단어장3 수정/);
});

test('explicitly deleting a loaded lesson preserves an unseen remote lesson', async () => {
  const editor = await openEditor();
  editor.selectThirdBook();
  editor.element('#delete-lesson').onclick();
  const dialog = editor.element('#confirm-dialog');
  dialog.returnValue = 'confirm';
  dialog.onclose();
  await editor.save();
  assert.deepEqual(editor.manifestNumbers(), [1, 10]);
  assert.ok(editor.remote.has('data/lessons/lesson10.js'));
  assert.ok(!editor.remote.has('data/lessons/lesson11.js'));
});

test('renumbering a lesson removes its old file and preserves unseen lessons', async () => {
  const editor = await openEditor();
  editor.selectThirdBook();
  editor.element('#lesson-number').onchange({ target: { value: '12' } });
  await editor.save();
  assert.deepEqual(editor.manifestNumbers(), [1, 10, 12]);
  assert.ok(editor.remote.has('data/lessons/lesson12.js'));
  assert.ok(!editor.remote.has('data/lessons/lesson11.js'));
});

test('lesson preservation also works for a nested site directory', async () => {
  const editor = await openEditor({ prefix: 'docs.site/' });
  await editor.save();
  assert.deepEqual(editor.manifestNumbers(), [1, 10, 11]);
  assert.ok(editor.remote.has('docs.site/data/lessons/lesson10.js'));
});

test('an incomplete repository tree cannot be used for saving or deletions', async () => {
  const editor = await openEditor({ truncated: true });
  await editor.save();
  assert.equal(editor.saved.length, 0);
  assert.ok(editor.remote.has('data/lessons/lesson10.js'));
});

test('each editor load refreshes the manifest and lesson script URLs together', async () => {
  const editor = await openEditor();
  const versions = editor.requests.map(src => new URL(src, 'https://example.test/').searchParams.get('v'));
  assert.equal(versions.length, 3);
  assert.ok(versions.every(Boolean));
  assert.equal(new Set(versions).size, 1);
});

test('the learner view loads the restored vocabulary and connects all 112 audio cards', async () => {
  const root = path.join(__dirname, '..');
  const nodes = new Map();
  const requests = [];
  const played = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  let context;
  class Audio {
    constructor(src) { this.src = src; this.paused = false; played.push(this); }
    addEventListener() {}
    play() { return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  context = vm.createContext({
    window: {}, location: { hash: '#10' }, history: { replaceState() {} }, Audio,
    document: {
      getElementById: element,
      createElement: () => new Element(),
      head: { appendChild(node) {
        requests.push(node.src);
        queueMicrotask(() => {
          vm.runInContext(fs.readFileSync(path.join(root, node.src.split('?')[0]), 'utf8'), context);
          node.onload();
        });
      } }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/app.js'), 'utf8'), context);
  for (let i = 0; i < 50 && element('content').children.length !== 9; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(element('current').textContent, '현재 선택: 단어장2');
  assert.equal(element('content').children.length, 9);
  const cards = element('content').children.flatMap(section => section.children[1].children);
  assert.equal(cards.length, 112);
  const book = context.window.LESSONS.find(l => l.title === '단어장2');
  const items = book.sections.flatMap(s => s.items);
  for (let i = 0; i < cards.length; i++) {
    assert.equal(cards[i].children[1].textContent, items[i].text);
    cards[i].events.get('click')();
    assert.equal(played.at(-1).src, `audio/lesson10/${items[i].audio}`);
    assert.ok(fs.existsSync(path.join(root, played.at(-1).src)));
    assert.equal(cards[i].getAttribute('aria-pressed'), 'true');
    if (i > 0) {
      assert.equal(played[i - 1].paused, true);
      assert.equal(cards[i - 1].getAttribute('aria-pressed'), 'false');
    }
  }
  assert.ok(element('tabs').children.some(tab => tab.textContent === '단어장2' && tab.getAttribute('aria-selected') === 'true'));
  assert.ok(requests.every(src => new URL(src, 'https://example.test/').searchParams.has('v')));
});
