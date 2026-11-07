// DOM 小工具：h() 创建元素、图标、toast 通知、确认对话框。全部使用 createElement + textContent。

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  text?: string;
  on?: Record<string, (e: any) => void>;
  attrs?: Record<string, string>;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'on') {
        for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) el.addEventListener(ev, fn);
      } else if (k === 'attrs') {
        for (const [a, av] of Object.entries(v as Record<string, string>)) el.setAttribute(a, av);
      } else {
        (el as unknown as Record<string, unknown>)[k] = v;
      }
    }
  }
  appendChildren(el, children);
  return el;
}

export function appendChildren(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

/** 清空并填充 */
export function mount(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  appendChildren(el, children);
}

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
}

const CDN_PREFIX = 'https://cdn8.newbeebox.com/';

export function isAllowedImage(url: string | null | undefined): url is string {
  return typeof url === 'string' && url.startsWith(CDN_PREFIX);
}

/** 插件图标：只加载白名单 CDN 图片，否则（或加载失败）显示首字母占位 */
export function modIcon(logo: string | null, name: string, size: 'sm' | 'md' | 'lg' = 'md'): HTMLElement {
  const placeholder = (): HTMLElement =>
    h('div', { class: `mod-icon mod-icon-${size} mod-icon-ph` }, (name.trim()[0] ?? '?').toUpperCase());
  if (!isAllowedImage(logo)) return placeholder();
  const img = h('img', { class: `mod-icon mod-icon-${size}`, src: logo, alt: '', loading: 'lazy', referrerPolicy: 'no-referrer', draggable: false });
  img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
  return img;
}

export function spinner(small = false): HTMLElement {
  return h('span', { class: small ? 'spinner spinner-sm' : 'spinner' });
}

// ---------- toast ----------

export type ToastKind = 'success' | 'error' | 'info' | 'warn';

export function toast(message: string, kind: ToastKind = 'info', ms?: number): void {
  const root = byId('toast-root');
  const timeout = ms ?? (kind === 'error' || kind === 'warn' ? 8000 : 4000);
  let timer = 0;
  const close = (): void => {
    window.clearTimeout(timer);
    el.classList.add('toast-out');
    window.setTimeout(() => el.remove(), 250);
  };
  const el = h('div', { class: `toast toast-${kind}`, attrs: { role: 'status' } },
    h('span', { class: 'toast-dot' }),
    h('div', { class: 'toast-msg', text: message }),
    h('button', { class: 'toast-close', title: '关闭', on: { click: close } }, '×'),
  );
  root.appendChild(el);
  timer = window.setTimeout(close, timeout);
  // 最多保留 5 条
  while (root.childElementCount > 5) root.firstElementChild?.remove();
}

// ---------- 确认对话框 ----------

export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string[];
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

export function confirmDialog(o: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const root = byId('modal-root');
    let done = false;
    const close = (v: boolean): void => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      overlay.classList.add('modal-out');
      window.setTimeout(() => overlay.remove(), 150);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(false);
      }
    };
    const okBtn = h('button', { class: o.danger ? 'btn btn-danger' : 'btn btn-primary', on: { click: () => close(true) } }, o.confirmText ?? '确定');
    const cancelBtn = h('button', { class: 'btn', on: { click: () => close(false) } }, o.cancelText ?? '取消');
    const overlay = h('div', { class: 'modal-overlay', on: { mousedown: (e: MouseEvent) => { if (e.target === overlay) close(false); } } },
      h('div', { class: 'modal', attrs: { role: 'dialog', 'aria-modal': 'true' } },
        h('div', { class: 'modal-title', text: o.title }),
        h('div', { class: 'modal-msg', text: o.message }),
        o.detail && o.detail.length > 0
          ? h('ul', { class: 'modal-detail' }, o.detail.map((d) => h('li', { text: d })))
          : null,
        h('div', { class: 'modal-actions' },
          cancelBtn,
          okBtn,
        ),
      ),
    );
    document.addEventListener('keydown', onKey, true);
    root.appendChild(overlay);
    // 危险操作默认聚焦“取消”，避免回车误删
    (o.danger ? cancelBtn : okBtn).focus();
  });
}
