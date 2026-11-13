// 「诊断报告」页（0.3.0）：只在用户点击“生成报告 / 重新生成报告”时请求主进程生成一份冻结的预览，打开页面不读取任何东西。
// - 依赖只来自调用方给出的 ports（预览、保存、当前目标）；本模块不发 IPC、不读 state，也不传窗口身份或保存路径。
// - 报告 JSON 是主进程冻结的原文：全文按纯文本（textContent）显示，不重新序列化、不删改字段；摘要只读取固定枚举与数字。
// - 预览与保存状态是模块级单实例：重新打开页面仍显示原报告，并标明它是为哪个目标、在什么时间生成的。生成之后目标
//   变化过（包括 A→B→A）就持续提醒“这是之前生成的报告”，直到重新生成。
// - 生成或保存进行中本地保持忙碌直到原调用结束；结果按发起时的目标命名，不会以当前目标命名，也不会更新已销毁的界面。
// - 保存结果按固定代码给出中文说明，页面内持久显示；不回显任何错误原文。保存只提交 token，位置由主进程的系统对话框选择。

import type { DiagCleanup, DiagPreviewCode, DiagPreviewResult, DiagReason, DiagSaveFailCode, DiagSaveRejectCode, DiagSaveResult, DiagSectionState } from '../shared/diagnostic-types';
import { h, mount } from './dom.js';
import { formatDateTime } from './format.js';

/** 与主进程报告大小上限一致；超过它的预览不符合约定，不用于保存 */
const MAX_REPORT_BYTES = 512 * 1024;
/** setTimeout 可接受的最大延迟 */
const MAX_TIMER_MS = 2_147_483_647;

/** 当前目标：key 只用于比较，label 只用于显示（不会进入报告或保存请求） */
export interface DiagTarget {
  flavorId: number | null;
  key: string;
  label: string;
}

export interface DiagnosticsPorts {
  /** 生成预览；本模块只使用 replace */
  preview(req: { flavorId: number | null; mode: 'replace' }): Promise<DiagPreviewResult>;
  /** 保存 token 对应的冻结预览；位置由主进程的系统对话框选择 */
  save(token: string): Promise<DiagSaveResult>;
  getTarget(): DiagTarget;
  /** 订阅目标变化（版本切换、绑定变化等），返回取消订阅 */
  onTargetChange(listener: () => void): () => void;
  /** 测试注入：时钟与计时器（默认 Date.now / window.setTimeout） */
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export interface DiagnosticsController {
  /** 目标可能变化时由调用方主动通知（与 onTargetChange 等效） */
  refreshTarget(): void;
  /** 取消订阅与计时器；之后到达的结果不再更新这个界面 */
  dispose(): void;
}

// ---------- 固定文案 ----------

const STATE_TEXT: Record<DiagSectionState, string> = {
  ok: '已采集',
  absent: '不存在',
  partial: '部分结果',
  unavailable: '无法采集',
  skipped: '未采集',
};

const REASON_TEXT: Record<DiagReason, string> = {
  absent: '文件或所在文件夹不存在',
  symlink: '是符号链接，未读取',
  'not-file': '不是普通文件，未读取',
  'too-large': '超过读取上限，未读取',
  io: '读取失败',
  'invalid-format': '内容格式不正确',
  'unsupported-schema': '格式版本未知（可能来自更新的版本）',
  changed: '读取期间发生变化',
  'parent-unsafe': '所在路径含符号链接或不是文件夹，未读取',
  'not-bound': '没有已绑定的目标目录，未检查',
  'settings-unavailable': '设置无法读取，未检查与游戏目录有关的部分',
  'pending-operation': '游戏目录有未完成的插件操作，未读取',
  'still-running': '健康检查仍在后台进行，本次报告没有包含它的结果（检查没有被取消）',
  busy: '另一个目标的健康检查仍在进行，本次没有启动新的检查',
  failed: '检查失败',
  mismatch: '检查结果与本次目标不符，或目标在生成期间发生变化，未采用',
};

const TARGET_TEXT: Record<string, string> = {
  bound: '已绑定游戏目录',
  'not-bound': '当前游戏版本没有绑定目录，报告只含应用摘要',
  'not-selected': '没有选择游戏版本，报告只含应用摘要',
  'settings-unavailable': '设置无法读取，报告只含应用摘要',
};

const HEALTH_STATUS_TEXT: Record<string, string> = {
  complete: '检查范围内已完成（不代表插件或游戏一定正常）',
  partial: '部分完成',
  unavailable: '无法检查',
};

const PREVIEW_CODE_TEXT: Record<DiagPreviewCode, string> = {
  busy: '另一项诊断操作正在进行，请稍后再试。',
  'preview-exists': '另一个窗口已有诊断预览。',
  stale: '生成期间游戏目录绑定或设置发生了变化。',
  'owner-gone': '窗口状态已失效。',
  'invalid-request': '请求无效（游戏版本未知）。',
  internal: '生成时出现内部错误。',
};

const REJECT_TEXT: Record<DiagSaveRejectCode, string> = {
  'token-invalid': '这份预览已失效（可能已被新的报告替换），没有保存。请重新生成报告。',
  'token-expired': '这份预览已过期，没有保存。请重新生成报告。',
  'owner-mismatch': '这份预览不属于当前窗口，没有保存。请重新生成报告。',
  'owner-gone': '窗口在选择位置期间已关闭或重新载入，没有保存。请重新生成报告。',
  busy: '另一项诊断操作正在进行，没有保存，请稍后重试。',
  'picker-failed': '无法打开保存对话框，没有保存，可以重试。',
  'invalid-path': '选择的保存位置无效，没有保存，请重新选择。',
  'protected-roots-unknown': '无法完整确认需要保护的位置（设置、备份或恢复记录无法读取），为安全起见没有保存。请先修复设置，预览已保留，可以之后重试。',
  'protected-location': '不能保存到游戏目录、艾泽魔方数据目录、应用程序、备份位置或恢复保护位置之内，没有保存。请选择其他文件夹。',
  'parent-unsafe': '所选文件夹或其上级不存在、是符号链接或替身，没有保存。请选择一个真实的文件夹（不要经过链接）。',
  'parent-changed': '所选文件夹在保存过程中被移动或替换，没有保存，请重新选择。',
  'protection-changed': '保存期间游戏目录绑定或备份配置发生了变化，没有保存。请等设置变更完成后重试，预览已保留。',
  exists: '该位置已有同名文件或文件夹，诊断报告不会覆盖它，没有保存。请换一个新的文件名。',
  internal: '保存前出现内部错误，没有保存，可以重试。',
};

const FAIL_TEXT: Record<DiagSaveFailCode, string> = {
  'create-failed': '无法正常创建报告文件',
  'identity-unknown': '无法确认新建文件的身份',
  'write-failed': '写入失败',
  'sync-failed': '写入磁盘（同步）失败',
  'close-failed': '关闭文件失败',
  'parent-sync-failed': '所在文件夹的同步失败',
  'parent-changed': '所在文件夹在写入过程中被移动或替换，已停止写入',
  'protection-changed': '写入期间游戏目录绑定或备份配置发生变化，已停止写入',
  'content-changed': '文件在写入过程中被其他程序改动或替换，已停止写入',
};

const CLEANUP_TEXT: Record<DiagCleanup, string> = {
  'not-created': '没有创建文件。',
  removed: '本次创建的文件已删除。',
  'removed-unsynced': '本次创建的文件已删除，但所在文件夹的同步未能确认。',
  absent: '本次创建的文件已不在原位置（可能被其他程序移动或删除），请自行检查。',
  'retained-unconfirmed': '所选位置留有一个无法确认内容的文件，艾泽魔方没有删除它，请自行检查。',
  'retained-replaced': '所选位置现在是另一个文件，艾泽魔方没有删除它，请自行检查。',
  'retained-parent-changed': '所在文件夹已被移动或替换，本次创建的文件现在的位置无法确认，艾泽魔方没有删除它，请自行检查。',
  'remove-failed': '本次创建的文件未能删除，仍留在所选位置，请自行检查。',
};

/** 保存后预览不可再用时的说明 */
const DEAD_TEXT: Partial<Record<DiagSaveRejectCode, string>> = {
  'token-expired': '这份预览已过期，不能再保存，请重新生成报告。',
  'token-invalid': '这份预览已失效，不能再保存，请重新生成报告。',
  'owner-mismatch': '这份预览不属于当前窗口，不能再保存，请重新生成报告。',
  'owner-gone': '这份预览所属的窗口已失效，不能再保存，请重新生成报告。',
};

const INTRO =
  '诊断报告只在你点击时生成：只读取插件目录（AddOns）中的 TOC，以及艾泽魔方自己的设置、安装记录和操作记录；不读取 WTF 配置内容，不修改任何文件，也不会上传。' +
  '报告会去掉原始路径、账号与角色名、插件名称与版本文字和错误原文，只保留应用版本、公开的数字编号、报告内的匿名编号和固定状态。' +
  '各部分分别读取，不是同一时刻的快照；健康检查只是磁盘上的静态线索，不代表游戏内一切正常。';

const SAVE_NOTE =
  '保存时会打开系统的保存对话框：只能保存为新文件，不会覆盖已有文件；请选择真实的文件夹（不要经过替身或符号链接），不能保存到游戏目录、艾泽魔方数据目录或备份位置之内。';

// ---------- 模块级单实例状态 ----------

type NoticeKind = 'success' | 'info' | 'warn' | 'error';

interface Notice {
  kind: NoticeKind;
  title: string;
  lines: string[];
}

interface Shown {
  token: string;
  json: string;
  bytes: number;
  expiresAt: number;
  /** 生成时的目标 */
  targetKey: string;
  targetLabel: string;
  generatedAt: number;
  /** 生成之后目标变化过（包括又变回来） */
  drifted: boolean;
  /** 不能再保存的原因（预览失效或不符合约定） */
  dead: string | null;
}

interface Store {
  shown: Shown | null;
  busy: 'generate' | 'save' | null;
  notice: Notice | null;
  /** 进行中的生成：发起时的目标与期间目标是否变化过（任何仍在显示的界面都会记录） */
  gen: { key: string; changed: boolean } | null;
}

const store: Store = { shown: null, busy: null, notice: null, gen: null };
const live = new Set<Controller>();

function notifyAll(): void {
  for (const c of live) c.update();
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

function mapped(table: Record<string, string>, v: unknown): string {
  return typeof v === 'string' && Object.hasOwn(table, v) ? table[v] : '未知状态';
}

// ---------- 摘要 ----------

function omittedText(o: unknown): string | null {
  if (!isObj(o)) return null;
  const limit = num(o.limit) ?? 0;
  const budget = num(o.byteBudget) ?? 0;
  const parts: string[] = [];
  if (limit > 0) parts.push(`${limit} 项因数量上限未列出`);
  if (budget > 0) parts.push(`${budget} 项因报告大小上限未列出`);
  return parts.length > 0 ? `另有 ${parts.join('，')}` : null;
}

function section(title: string, s: unknown, details: (string | null)[]): HTMLElement {
  const o = isObj(s) ? s : {};
  const state = mapped(STATE_TEXT, o.state);
  const tagClass = o.state === 'ok' ? 'tag' : o.state === 'partial' || o.state === 'unavailable' ? 'tag tag-warn' : 'tag tag-muted';
  return h('div', { class: 'diagnostic-section' },
    h('div', { class: 'diagnostic-section-head' }, h('span', { class: 'diagnostic-section-title', text: title }), h('span', { class: tagClass, text: state })),
    o.reason !== null && o.reason !== undefined ? h('div', { class: 'diagnostic-section-line', text: mapped(REASON_TEXT, o.reason) }) : null,
    details.filter((d): d is string => d !== null).map((d) => h('div', { class: 'diagnostic-section-line', text: d })),
  );
}

/** 只读取固定枚举与数字做摘要；格式不符时给固定说明（全文仍可查看） */
function renderSummary(json: string): HTMLElement {
  let r: unknown;
  try {
    r = JSON.parse(json);
  } catch {
    r = null;
  }
  if (!isObj(r) || r.format !== 'azercube-diagnostic' || r.schema !== 1) {
    return h('div', { class: 'banner banner-warn', text: '报告格式无法识别，无法显示摘要；下面仍显示收到的原文。' });
  }
  const app = isObj(r.app) ? r.app : {};
  const version = typeof app.version === 'string' && /^(\d{1,6}\.\d{1,6}\.\d{1,6}|unknown)$/.test(app.version) ? app.version : '未知';
  const target = isObj(r.target) ? r.target : {};
  const settings = isObj(r.settings) ? r.settings : {};
  const addons = isObj(r.addons) ? r.addons : {};
  const history = isObj(r.history) ? r.history : {};
  const health = isObj(r.health) ? r.health : {};
  const bound = Array.isArray(settings.boundFlavorIds) ? settings.boundFlavorIds.length : null;
  const items = Array.isArray(addons.items) ? addons.items.length : null;
  const failures = Array.isArray(history.recentFailures) ? history.recentFailures.length : null;
  const issues = Array.isArray(health.issues) ? health.issues.length : null;
  const counts = isObj(health.counts) ? health.counts : null;
  const n = (v: unknown): string => String(num(v) ?? '—');
  return h('div', { class: 'diagnostic-summary' },
    h('div', { class: 'diagnostic-summary-line', text: `应用版本 ${version} · ${mapped(TARGET_TEXT, target.state)}` }),
    h('div', { class: 'diagnostic-sections' },
      section('设置', settings, [bound !== null ? `已绑定 ${bound} 个已知游戏版本` : null, num(settings.unknownBindings) ? `另有 ${n(settings.unknownBindings)} 个未知版本的绑定` : null]),
      section('插件清单', addons, [
        addons.state === 'ok' || addons.state === 'partial' ? `登记插件 ${n(addons.total)} 个，列出 ${items ?? '—'} 个` : null,
        omittedText(addons.omitted),
      ]),
      section('操作记录', history, [
        history.state === 'ok' || history.state === 'partial' ? `本目录记录 ${n(history.total)} 条，列出最近失败或未确认 ${failures ?? '—'} 条` : null,
        num(history.invalidEntries) ? `${n(history.invalidEntries)} 条记录格式不正确，未统计` : null,
        omittedText(history.omitted),
      ]),
      section('健康检查', health, [
        typeof health.status === 'string' ? mapped(HEALTH_STATUS_TEXT, health.status) : null,
        counts ? `需要留意 ${n(counts.warning)} · 无法确认 ${n(counts.unknown)} · 参考信息 ${n(counts.info)}；列出 ${issues ?? '—'} 条` : null,
        omittedText(health.omitted),
      ]),
    ),
  );
}

// ---------- 结果说明 ----------

function previewFailure(r: DiagPreviewResult | null, hadOld: boolean): Notice {
  const why = r && r.status === 'rejected' && Object.hasOwn(PREVIEW_CODE_TEXT, r.code) ? PREVIEW_CODE_TEXT[r.code] : '生成请求没有正常完成。';
  return { kind: 'error', title: '没有生成新报告', lines: [why, hadOld ? '下面仍是之前生成的报告。' : '可以稍后重新生成。'] };
}

function saveNotice(r: DiagSaveResult | null): Notice {
  if (!r) return { kind: 'warn', title: '保存结果未知', lines: ['保存请求没有返回结果，无法确认是否已创建文件；请检查所选位置后再决定是否重试。'] };
  switch (r.status) {
    case 'saved':
      return {
        kind: 'success',
        title: '已保存',
        lines: [`报告已完整写入你选择位置的新文件（${r.bytes} 字节）。艾泽魔方不会主动上传它；如果所选文件夹由云盘软件同步，文件可能会被该软件同步。`],
      };
    case 'cancelled':
      return { kind: 'info', title: '已取消保存', lines: ['没有创建文件，预览仍保留。'] };
    case 'rejected':
      return { kind: 'warn', title: '没有保存', lines: [Object.hasOwn(REJECT_TEXT, r.code) ? REJECT_TEXT[r.code] : '没有保存。'] };
    case 'failed':
      return {
        kind: 'error',
        title: '保存失败',
        lines: [`${Object.hasOwn(FAIL_TEXT, r.code) ? FAIL_TEXT[r.code] : '保存失败'}。`, Object.hasOwn(CLEANUP_TEXT, r.cleanup) ? CLEANUP_TEXT[r.cleanup] : '无法确认所选位置的文件状态，请自行检查。'],
      };
    case 'unconfirmed':
      return { kind: 'warn', title: '保存结果无法确认', lines: ['报告已写入，但最终核对时发现文件或所在文件夹被改动，无法确认保存的内容与位置。文件已保留，请自行检查。'] };
    default:
      return { kind: 'warn', title: '保存结果未知', lines: ['收到无法识别的保存结果，请检查所选位置。'] };
  }
}

// ---------- 界面 ----------

class Controller {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (h: unknown) => void;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private timer: unknown = null;
  private timerFor: string | null = null;
  /** 已渲染到摘要与全文的预览 token */
  private renderedToken: string | null | undefined = undefined;

  private readonly genBtn: HTMLButtonElement;
  private readonly saveBtn: HTMLButtonElement;
  private readonly meta: HTMLElement;
  private readonly context: HTMLElement;
  private readonly noticeBox: HTMLElement;
  private readonly saveHint: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly pre: HTMLElement;

  constructor(
    container: HTMLElement,
    private readonly ports: DiagnosticsPorts,
  ) {
    this.now = ports.now ?? (() => Date.now());
    this.setTimer = ports.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
    this.clearTimer = ports.clearTimer ?? ((t) => window.clearTimeout(t as number));
    this.genBtn = h('button', { class: 'btn btn-primary', on: { click: () => void this.generate() } });
    this.saveBtn = h('button', { class: 'btn', on: { click: () => void this.save() } });
    this.meta = h('div', { class: 'diagnostic-meta' });
    this.context = h('div', { class: 'banner banner-warn diagnostic-context' });
    this.noticeBox = h('div', { class: 'diagnostic-notice', attrs: { role: 'status' } });
    this.saveHint = h('div', { class: 'diagnostic-save-hint' });
    this.summary = h('div', { class: 'diagnostic-summary-box' });
    this.pre = h('pre', { class: 'diagnostic-json', attrs: { tabindex: '0', 'aria-label': '诊断报告全文（JSON）' } });
    mount(container, h('div', { class: 'diagnostic-root' },
      h('div', { class: 'note diagnostic-intro', text: INTRO }),
      h('div', { class: 'diagnostic-actions' }, this.genBtn, this.saveBtn),
      this.meta,
      this.saveHint,
      this.context,
      this.noticeBox,
      this.summary,
      h('div', { class: 'diagnostic-save-note', text: SAVE_NOTE }),
      this.pre,
    ));
    this.unsubscribe = ports.onTargetChange(() => this.refreshTarget());
    live.add(this);
    // 重新打开页面：没有界面订阅期间目标可能已经变化，先按当前目标核对保留的报告再显示
    this.refreshTarget();
  }

  refreshTarget(): void {
    if (this.disposed) return;
    let key: string;
    try {
      key = this.ports.getTarget().key;
    } catch {
      this.update();
      return;
    }
    if (store.gen && key !== store.gen.key) store.gen.changed = true;
    const s = store.shown;
    if (s && !s.drifted && key !== s.targetKey) {
      s.drifted = true;
      notifyAll();
      return;
    }
    this.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    live.delete(this);
    this.unsubscribe();
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.timerFor = null;
  }

  /** 预览有效期到达时刷新（只为当前显示的预览设置一个计时器） */
  private armTimer(s: Shown | null): void {
    const token = s && !s.dead ? s.token : null;
    if (token === this.timerFor) return;
    this.cancelTimer();
    if (!s || token === null) return;
    const ms = Math.min(MAX_TIMER_MS, Math.max(0, s.expiresAt - this.now()));
    this.timerFor = token;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (!this.disposed) this.update();
    }, ms);
  }

  private expired(s: Shown): boolean {
    return this.now() >= s.expiresAt;
  }

  async generate(): Promise<void> {
    if (this.disposed || store.busy) return;
    let t: DiagTarget;
    try {
      t = this.ports.getTarget();
    } catch {
      return;
    }
    const ports = this.ports;
    const gen = { key: t.key, changed: false };
    store.gen = gen;
    store.busy = 'generate';
    notifyAll();
    let r: DiagPreviewResult | null;
    try {
      r = await ports.preview({ flavorId: t.flavorId, mode: 'replace' });
    } catch {
      r = null;
    }
    if (store.gen === gen) store.gen = null;
    store.busy = null;
    if (r && r.status === 'ready' && typeof r.token === 'string' && r.token.length > 0 && typeof r.json === 'string') {
      const size = utf8Length(r.json);
      const fits = size === r.bytes && size <= MAX_REPORT_BYTES && Number.isFinite(r.expiresAt);
      // 结果按发起时的目标命名；生成期间目标变化过或现在已不同，即标为之前的报告（只读取目标，不更新已销毁的界面）
      let drifted = gen.changed;
      try {
        drifted = drifted || ports.getTarget().key !== t.key;
      } catch {
        drifted = true;
      }
      let generatedAt = this.now();
      try {
        const parsed: unknown = JSON.parse(r.json);
        if (isObj(parsed) && num(parsed.generatedAt) !== null) generatedAt = parsed.generatedAt as number;
      } catch {
        // 摘要会给出格式说明
      }
      store.shown = {
        token: r.token,
        json: r.json,
        bytes: size,
        expiresAt: r.expiresAt,
        targetKey: t.key,
        targetLabel: t.label,
        generatedAt,
        drifted,
        dead: fits ? null : '收到的报告不符合约定（大小不一致或超过上限），不能用于保存。请重新生成。',
      };
      store.notice = null;
    } else {
      store.notice = previewFailure(r, store.shown !== null);
    }
    notifyAll();
  }

  async save(): Promise<void> {
    const s = store.shown;
    if (this.disposed || store.busy || !s || s.dead || this.expired(s)) return;
    store.busy = 'save';
    store.notice = null;
    notifyAll();
    let r: DiagSaveResult | null;
    try {
      r = await this.ports.save(s.token);
    } catch {
      r = null;
    }
    store.busy = null;
    if (r && r.previewKept === false && store.shown === s && !s.dead) {
      s.dead = r.status === 'rejected' && DEAD_TEXT[r.code] ? (DEAD_TEXT[r.code] as string) : '这份预览已不能再保存，请重新生成报告。';
    }
    store.notice = saveNotice(r);
    notifyAll();
  }

  update(): void {
    if (this.disposed) return;
    const s = store.shown;
    const busy = store.busy;
    this.genBtn.disabled = busy !== null;
    this.genBtn.textContent = busy === 'generate' ? '生成中…' : s ? '重新生成报告' : '生成报告';
    const expired = s ? this.expired(s) : false;
    const saveable = !!s && !s.dead && !expired;
    this.saveBtn.disabled = busy !== null || !saveable;
    this.saveBtn.textContent = busy === 'save' ? '保存中…' : '保存报告…';

    this.meta.hidden = !s;
    if (s) this.meta.textContent = `报告目标：${s.targetLabel} · 生成于 ${formatDateTime(s.generatedAt)} · ${s.bytes} 字节`;

    const hint = !s ? '' : s.dead ? s.dead : expired ? '这份预览已过期，不能再保存，请重新生成报告。' : '';
    this.saveHint.hidden = hint === '';
    this.saveHint.textContent = hint;

    let ctx = '';
    if (s && s.drifted) {
      const cur = this.ports.getTarget();
      ctx = cur.key !== s.targetKey
        ? `当前目标已变化，下面是之前为「${s.targetLabel}」生成的报告，不代表当前目标。需要当前目标的报告请重新生成。`
        : `生成之后目标曾经变化，下面是之前为「${s.targetLabel}」生成的报告，可能已不是当前状态。需要最新报告请重新生成。`;
    }
    this.context.hidden = ctx === '';
    this.context.textContent = ctx;

    const n = store.notice;
    this.noticeBox.hidden = !n;
    if (n) {
      this.noticeBox.className = `diagnostic-notice banner ${n.kind === 'error' ? 'banner-error' : n.kind === 'warn' ? 'banner-warn' : `diagnostic-notice-${n.kind}`}`;
      mount(this.noticeBox, h('div', { class: 'diagnostic-notice-title', text: n.title }), n.lines.map((l) => h('div', { text: l })));
    }

    // 摘要与全文只在预览本身变化时重建，目标变化或状态刷新不重置滚动与选择
    const token = s ? s.token : null;
    if (token !== this.renderedToken) {
      this.renderedToken = token;
      if (s) {
        mount(this.summary, renderSummary(s.json));
        this.pre.textContent = s.json;
        this.pre.hidden = false;
      } else {
        mount(this.summary, h('div', { class: 'state-box small' },
          h('div', { class: 'state-title', text: '尚未生成报告' }),
          h('div', { class: 'state-msg', text: '点击“生成报告”后会在这里显示摘要与完整内容；没有绑定游戏目录或设置无法读取时也可以生成应用摘要。' }),
        ));
        this.pre.textContent = '';
        this.pre.hidden = true;
      }
    }
    this.armTimer(s);
  }
}

/**
 * 在 container 中建立诊断报告页面。不会自动生成；重复调用（例如重新打开页面）共用同一份预览状态，
 * 不再使用的界面应调用 dispose。
 */
export function initDiagnostics(container: HTMLElement, ports: DiagnosticsPorts): DiagnosticsController {
  const c = new Controller(container, ports);
  return { refreshTarget: () => c.refreshTarget(), dispose: () => c.dispose() };
}
