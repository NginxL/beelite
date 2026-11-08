// 极简假 DOM：只实现渲染层操作函数（h、toast、confirmDialog）用到的接口，供渲染层回归测试使用。
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
    if (c.parentNode) c.remove();
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  replaceChildren(...cs) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    for (const c of cs) this.appendChild(c);
  }
  remove() {
    if (!this.parentNode) return;
    const p = this.parentNode;
    p.childNodes = p.childNodes.filter((c) => c !== this);
    this.parentNode = null;
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

export class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.title = '';
    this.disabled = false;
    this.listeners = {};
    this.attrs = {};
    this.classList = new FakeClassList(this);
    this.style = { setProperty: () => undefined };
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(v) {
    this.replaceChildren(new FakeText(v));
  }
  get childElementCount() {
    return this.childNodes.filter((c) => c instanceof FakeElement).length;
  }
  get firstElementChild() {
    return this.childNodes.find((c) => c instanceof FakeElement) ?? null;
  }
  addEventListener(ev, fn) {
    (this.listeners[ev] ??= []).push(fn);
  }
  removeEventListener(ev, fn) {
    this.listeners[ev] = (this.listeners[ev] ?? []).filter((f) => f !== fn);
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  focus() {}
  click() {
    if (this.disabled) return;
    for (const fn of this.listeners.click ?? []) fn({ target: this, stopPropagation() {} });
  }
  all() {
    return [this, ...this.childNodes.filter((c) => c instanceof FakeElement).flatMap((c) => c.all())];
  }
  /** 只支持 “.类名” 选择器 */
  querySelector(sel) {
    return this.all().find((e) => e !== this && e.classList.contains(sel.slice(1))) ?? null;
  }
}

/** 安装全局 document / window；返回固定的根元素 */
export function installFakeDom(beelite) {
  const roots = new Map();
  const docListeners = {};
  globalThis.document = {
    createElement: (t) => new FakeElement(t),
    createTextNode: (t) => new FakeText(t),
    getElementById: (id) => {
      if (!roots.has(id)) roots.set(id, new FakeElement('div'));
      return roots.get(id);
    },
    addEventListener: (ev, fn) => (docListeners[ev] ??= []).push(fn),
    removeEventListener: (ev, fn) => (docListeners[ev] = (docListeners[ev] ?? []).filter((f) => f !== fn)),
  };
  // 动画与 toast 的计时器不需要真正执行
  globalThis.window = { beelite, setTimeout: () => 0, clearTimeout: () => undefined };
  return {
    modalRoot: () => globalThis.document.getElementById('modal-root'),
    toastRoot: () => globalThis.document.getElementById('toast-root'),
  };
}

/** 当前打开（未关闭）的模态框 */
export function openModals(dom) {
  return dom.modalRoot().childNodes.filter((o) => !o.classList.contains('modal-out'));
}

/** 在唯一打开的模态框中找到并点击指定文字的按钮 */
export function clickModalButton(dom, label) {
  const open = openModals(dom);
  if (open.length !== 1) throw new Error(`应恰好有一个打开的模态框，实际 ${open.length}`);
  const btn = open[0].all().find((e) => e.tagName === 'BUTTON' && e.textContent === label);
  if (!btn) throw new Error(`模态框中没有按钮：${label}`);
  btn.click();
}

export function toasts(dom) {
  return dom.toastRoot().childNodes.map((t) => t.textContent);
}
