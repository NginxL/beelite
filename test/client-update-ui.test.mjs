// 侧栏客户端更新区域：进度刷新时按钮必须保持同一个 DOM 元素（焦点与点击不丢失），点击取消能调用 clientCancel。
// 使用极简假 DOM（只实现被用到的接口），导入 tsc 编译出的 dist/web/renderer/client-update.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

class FakeClassList {
  constructor(el) {
    this.el = el;
  }
  get set() {
    return new Set(this.el.className.split(/\s+/).filter(Boolean));
  }
  contains(c) {
    return this.set.has(c);
  }
  toggle(c, force) {
    const s = this.set;
    const on = force === undefined ? !s.has(c) : force;
    if (on) s.add(c);
    else s.delete(c);
    this.el.className = [...s].join(' ');
    return on;
  }
  add(c) {
    this.toggle(c, true);
  }
  remove(c) {
    this.toggle(c, false);
  }
}

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }
  appendChild(c) {
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  replaceChildren(...cs) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const c of cs) this.appendChild(c);
  }
}

class FakeText extends FakeNode {
  constructor(t) {
    super();
    this.data = String(t);
  }
  get textContent() {
    return this.data;
  }
}

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.title = '';
    this.disabled = false;
    this.listeners = {};
    this.attrs = {};
    this.classList = new FakeClassList(this);
    const props = {};
    this.style = { setProperty: (k, v) => (props[k] = v), props };
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.replaceChildren(new FakeText(v));
  }
  get firstChild() {
    return this.childNodes[0] ?? null;
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] ??= []).push(fn);
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  click() {
    if (this.disabled) return;
    for (const fn of this.listeners.click ?? []) fn({ target: this });
  }
  all() {
    return [this, ...this.childNodes.filter((c) => c instanceof FakeElement).flatMap((c) => c.all())];
  }
  isConnectedTo(root) {
    let n = this;
    while (n) {
      if (n === root) return true;
      n = n.parentNode;
    }
    return false;
  }
}

const root = new FakeElement('div');
globalThis.document = {
  createElement: (t) => new FakeElement(t),
  createTextNode: (t) => new FakeText(t),
  getElementById: (id) => (id === 'client-update' ? root : new FakeElement('div')),
};

let stateListener = null;
const calls = [];
const base = { currentVersion: '0.9.1', availableVersion: '0.9.2', percent: null, message: null, canCheck: false, canUpdate: false, canCancel: false };
const downloading = (percent) => ({ ...base, status: 'downloading', percent, canCancel: true });
globalThis.window = {
  beelite: {
    clientState: async () => ({ ...base, status: 'available', canCheck: true, canUpdate: true }),
    clientUpdate: async () => (calls.push('update'), downloading(0)),
    clientCheck: async () => (calls.push('check'), { ...base, status: 'checking' }),
    clientCancel: async () => (calls.push('cancel'), { ...base, status: 'available', message: '已取消更新', canCheck: true, canUpdate: true }),
    onClientState: (cb) => ((stateListener = cb), () => undefined),
  },
};

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(here, '..', 'dist', 'web', 'renderer', 'client-update.js'));
const tick = () => new Promise((r) => setImmediate(r));
const button = (label) => root.all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
const shown = (el) => !el.classList.contains('hidden');

test('进度刷新不重建按钮：取消按钮在多次进度事件中保持同一元素，点击后调用 clientCancel', async () => {
  mod.initClientUpdate();
  await tick();
  const update = button('下载并更新');
  const cancel = button('取消');
  assert.ok(update && cancel);
  assert.equal(shown(update), true);
  assert.equal(shown(cancel), false);

  update.click();
  await tick();
  assert.deepEqual(calls, ['update']);
  assert.equal(button('下载并更新'), update, '点击后按钮仍是同一元素');

  for (let p = 1; p <= 30; p++) {
    stateListener(downloading(p));
    assert.equal(button('取消'), cancel, `第 ${p} 次进度后取消按钮应为同一元素`);
    assert.ok(cancel.isConnectedTo(root), '取消按钮始终在文档中');
  }
  assert.equal(shown(cancel), true);
  assert.equal(cancel.disabled, false);
  const status = root.all().find((e) => e.className.includes('client-status'));
  assert.match(status.textContent, /30%/);

  // 模拟“按下后、松开前又来了一次进度刷新”，随后点击仍作用在同一元素上
  stateListener(downloading(31));
  cancel.click();
  await tick();
  assert.deepEqual(calls, ['update', 'cancel']);
  assert.equal(shown(cancel), false, '取消成功后隐藏取消按钮');
  assert.equal(button('下载并更新'), update);
  assert.equal(shown(update), true);
});
