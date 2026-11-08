// 客户端自身更新的状态机（不依赖 Electron，原生桥通过接口注入）。
// - check()：只探测（Sparkle checkForUpdateInformation），不会下载。
// - update()：用户点击“下载并更新”时唯一的授权入口；原生侧只在本次授权内才同意下载与安装。
// - 下载、验签、解压完成（ready）后：同步冻结写操作 → 等待已受理的写操作全部结束 → 复核本次尝试仍有效 → 才通知原生安装并重启。
// - 取消只在原生确认确有取消手段时生效（下载中、等待插件操作完成时）；解压阶段不提供取消。
// - 取消、出错或会话中已无新版本后，进入 ending 屏障：直到旧的用户检查周期真正结束（cycle-finished）才允许重新检查或更新，
//   避免旧周期的结束事件覆盖新的会话。取消或出错也会使当前尝试失效，早先等待排空的异步延续不会再触发安装。
// - 可更新的版本以“条目”保存：构建号、显示版本与纯文本更新说明来自原生同一事件、同一个已验证的 appcast 条目，整体替换，
//   不会拿另一个版本的说明。update() 绑定用户看到的构建号并传给原生；原生在授权会话中发现另一个构建时不下载，
//   上报 build-changed，本方结束该会话并展示新构建的说明，由用户重新点击。
// - 每个构建在本次启动中只主动提醒一次（notice）；“稍后”只记录已提醒，不取消、不跳过该版本。
import type { ClientUpdateState, ClientUpdateStatus, ReleaseNotesState } from '../shared/types';
import type { FreezeToken, MutationGate } from './gate';

/** 原生随更新条目上报的说明字段 */
export interface NotesFields {
  notes?: string;
  notesState?: string;
  notesTruncated?: boolean;
}

export type BridgeEvent =
  | ({ type: 'valid-update'; version: string; displayVersion: string } & NotesFields)
  | { type: 'no-update' }
  | { type: 'cycle-finished'; check: 'probe' | 'user' | 'background'; errorCode?: number; error?: string }
  | ({ type: 'update-found'; authorized: boolean; version: string; displayVersion: string } & NotesFields)
  /** 授权会话中服务器给出的构建与用户确认的不同：原生未下载，本次会话结束 */
  | ({ type: 'build-changed'; version: string; displayVersion: string } & NotesFields)
  | { type: 'download-start' }
  | { type: 'download-progress'; received: number; total: number }
  | { type: 'extracting'; percent?: number }
  | { type: 'ready' }
  | { type: 'installing' }
  | { type: 'not-found' }
  | { type: 'error'; message: string; code?: number }
  | { type: 'dismissed' };

/** 原生桥接口（由 beelite_sparkle.node 实现）；所有方法都必须在主线程调用 */
export interface SparkleBridge {
  init(onEvent: (json: string) => void): { ok: boolean; error?: string };
  probe(): boolean;
  /** expectedBuild：本次授权只对这个构建号有效 */
  beginUpdate(expectedBuild: string): boolean;
  installNow(): boolean;
  cancel(): boolean;
}

/** Sparkle 的 SUNoUpdateError */
const SU_NO_UPDATE_ERROR = 1001;

/** 构建号格式（与原生一致）；IPC 也用它校验界面传来的期望构建号 */
export const BUILD_RE = /^[0-9A-Za-z._+-]{1,64}$/;
/** 更新说明的最大长度（UTF-16 字符），与原生和发布脚本一致 */
export const MAX_NOTES_CHARS = 4000;

const NOTES_STATES: readonly ReleaseNotesState[] = ['ok', 'missing', 'unsupported', 'unverified'];

/** 一个已验证的可更新条目：构建号、显示版本与说明总是一起替换 */
interface Offer {
  build: string;
  display: string;
  notes: string | null;
  notesState: ReleaseNotesState;
  truncated: boolean;
}

/** 规范化原生上报的说明：只接受纯文本，去掉控制字符，超长截断并标记 */
export function normalizeNotes(f: NotesFields): { notes: string | null; notesState: ReleaseNotesState; truncated: boolean } {
  const declared = NOTES_STATES.includes(f.notesState as ReleaseNotesState) ? (f.notesState as ReleaseNotesState) : 'missing';
  if (declared !== 'ok') return { notes: null, notesState: declared, truncated: false };
  if (typeof f.notes !== 'string') return { notes: null, notesState: 'missing', truncated: false };
  // eslint-disable-next-line no-control-regex
  let text = f.notes.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!text) return { notes: null, notesState: 'missing', truncated: false };
  let truncated = f.notesTruncated === true;
  if (text.length > MAX_NOTES_CHARS) {
    text = text.slice(0, MAX_NOTES_CHARS);
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    truncated = true;
  }
  return { notes: text, notesState: 'ok', truncated };
}

function offerFrom(ev: { version: string; displayVersion: string } & NotesFields): Offer | null {
  if (typeof ev.version !== 'string' || !BUILD_RE.test(ev.version)) return null;
  const display = typeof ev.displayVersion === 'string' && ev.displayVersion.length > 0 && ev.displayVersion.length <= 64 ? ev.displayVersion : ev.version;
  const n = normalizeNotes(ev);
  return { build: ev.version, display, notes: n.notes, notesState: n.notesState, truncated: n.truncated };
}

const BUSY: ReadonlySet<ClientUpdateStatus> = new Set(['checking', 'downloading', 'extracting', 'waiting', 'installing']);

export interface ClientUpdaterOptions {
  bridge: SparkleBridge | null;
  gate: MutationGate;
  currentVersion: string;
  /** 不支持时展示给用户的原因 */
  unsupportedReason?: string;
  onState?: (s: ClientUpdateState) => void;
}

export class ClientUpdater {
  private status: ClientUpdateStatus = 'idle';
  private offer: Offer | null = null;
  /** 本次启动中已主动展示过说明的构建 */
  private readonly announced = new Set<string>();
  private notice = false;
  private rev = 0;
  private percent: number | null = null;
  private message: string | null = null;
  /** 当前授权更新的代次；取消、出错、完成都会递增使旧延续失效 */
  private attempt = 0;
  /**
   * none：没有进行中的原生会话；probe：探测中；update：已授权的更新会话；
   * ending：本方已结束（取消、出错、无新版本），等待原生的用户检查周期结束
   */
  private session: 'none' | 'probe' | 'update' | 'ending' = 'none';
  private probeFound: Offer | null = null;
  private probeNone = false;
  private token: FreezeToken | null = null;
  private bridge: SparkleBridge | null;

  constructor(private readonly opts: ClientUpdaterOptions) {
    this.bridge = opts.bridge;
    if (!this.bridge) {
      this.status = 'unsupported';
      this.message = opts.unsupportedReason ?? '当前环境不支持客户端自动更新';
    }
  }

  start(): void {
    if (!this.bridge) return;
    let r: { ok: boolean; error?: string };
    try {
      r = this.bridge.init((json) => this.onNative(json));
    } catch (err) {
      r = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!r.ok) {
      // 详细原因只写入控制台，界面显示简短说明
      console.error('[BeeLite] 客户端更新组件启动失败：', r.error ?? '未知错误');
      this.bridge = null;
      this.set('unsupported', { message: '客户端更新组件启动失败，请重新下载安装蜂简' });
    }
  }

  getState(): ClientUpdateState {
    const supported = this.bridge !== null;
    const idle = supported && this.session === 'none' && !BUSY.has(this.status);
    const o = this.offer;
    return {
      status: this.status,
      currentVersion: this.opts.currentVersion,
      availableVersion: o?.display ?? null,
      availableBuild: o?.build ?? null,
      releaseNotes: o?.notes ?? null,
      notesState: o?.notesState ?? null,
      notesTruncated: o?.truncated ?? false,
      notice: this.notice && o !== null,
      rev: this.rev,
      percent: this.percent,
      message: this.message,
      canCheck: idle,
      canUpdate: idle && o !== null && (this.status === 'available' || this.status === 'error'),
      canCancel: supported && this.session === 'update' && (this.status === 'downloading' || this.status === 'waiting'),
    };
  }

  /** 界面已展示该构建的更新说明（自动弹出后点“稍后”或关闭）：本次启动不再主动提醒；不取消、不跳过该版本 */
  ackNotice(build: string): ClientUpdateState {
    if (this.offer?.build === build) {
      this.announced.add(build);
      if (this.notice) {
        this.notice = false;
        this.emit();
      }
    }
    return this.getState();
  }

  /** 设置新的可更新条目；本次启动中没提醒过的构建标记为待提醒 */
  private setOffer(o: Offer | null): void {
    this.offer = o;
    this.notice = o !== null && !this.announced.has(o.build);
  }

  /** 只检查是否有新版本，不下载 */
  check(): ClientUpdateState {
    const s = this.getState();
    if (!this.bridge || !s.canCheck) return s;
    this.probeFound = null;
    this.probeNone = false;
    if (!this.bridge.probe()) {
      this.set('error', { message: '暂时无法检查更新，请稍后重试' });
      return this.getState();
    }
    this.session = 'probe';
    this.set('checking', { message: null });
    return this.getState();
  }

  /**
   * 用户点击“下载并更新”：授权本次下载、验签、安装并重启。
   * expectedBuild 是用户看到的构建号（经 IPC 必须提供）；与当前可更新的构建不同时不开始更新。
   */
  update(expectedBuild?: string): ClientUpdateState {
    const s = this.getState();
    if (!this.bridge || !s.canUpdate || !this.offer) return s;
    if (expectedBuild !== undefined && expectedBuild !== this.offer.build) {
      this.set(this.status, { message: '新版本信息已变化，请查看最新的更新说明后再更新' });
      return this.getState();
    }
    const build = this.offer.build;
    this.announced.add(build);
    this.notice = false;
    this.attempt++;
    if (!this.bridge.beginUpdate(build)) {
      this.set('error', { percent: null, message: '暂时无法开始更新，请稍后重试' });
      return this.getState();
    }
    this.session = 'update';
    this.set('downloading', { percent: 0, message: null });
    return this.getState();
  }

  /** 取消：只有原生确认确实执行了取消才生效；否则保持当前状态，等待后续事件 */
  cancel(): ClientUpdateState {
    const s = this.getState();
    if (!this.bridge || !s.canCancel) return s;
    if (!this.bridge.cancel()) return this.getState();
    this.attempt++;
    this.releaseFreeze();
    this.session = 'ending';
    this.set('available', { percent: null, message: '已取消更新' });
    return this.getState();
  }

  private onNative(json: string): void {
    let ev: BridgeEvent;
    try {
      ev = JSON.parse(json) as BridgeEvent;
    } catch {
      return;
    }
    this.handle(ev);
  }

  /** 处理原生事件（测试可直接调用） */
  handle(ev: BridgeEvent): void {
    if (this.session === 'ending') {
      // 屏障：忽略旧会话的残余事件，直到它的用户检查周期结束
      if (ev.type === 'cycle-finished' && ev.check === 'user') {
        this.session = 'none';
        this.emit();
      }
      return;
    }
    switch (ev.type) {
      case 'valid-update':
        if (this.session === 'probe') this.probeFound = offerFrom(ev);
        return;
      case 'no-update':
        if (this.session === 'probe') this.probeNone = true;
        return;
      case 'cycle-finished':
        return this.onCycleFinished(ev);
      case 'update-found':
        // 原生只在构建号与授权一致时才 authorized；版本与说明保持用户确认时的条目，不在会话中途替换
        return;
      case 'build-changed':
        if (this.session === 'update') {
          this.attempt++;
          this.releaseFreeze();
          this.session = 'ending';
          const next = offerFrom(ev);
          if (next) this.setOffer(next);
          const v = next ? `v${next.display}` : '另一个版本';
          this.set('available', { percent: null, message: `服务器上的新版本已变为 ${v}，未下载；请查看更新说明后重新点击更新` });
        }
        return;
      case 'download-start':
        if (this.session === 'update') this.set('downloading', { percent: 0 });
        return;
      case 'download-progress':
        if (this.session === 'update' && this.status === 'downloading') {
          this.set('downloading', { percent: ev.total > 0 ? Math.min(100, Math.round((ev.received / ev.total) * 100)) : null });
        }
        return;
      case 'extracting':
        if (this.session === 'update' && (this.status === 'downloading' || this.status === 'extracting')) this.set('extracting', { percent: ev.percent ?? null });
        return;
      case 'ready':
        if (this.session === 'update' && (this.status === 'downloading' || this.status === 'extracting')) void this.onReady(this.attempt);
        return;
      case 'installing':
        if (this.session === 'update') this.set('installing', { percent: null, message: '正在安装并重新启动…' });
        return;
      case 'not-found':
        if (this.session === 'update') {
          this.attempt++;
          this.releaseFreeze();
          this.session = 'ending';
          this.setOffer(null);
          this.set('up-to-date', { percent: null, message: null });
        }
        return;
      case 'error':
        if (this.session === 'update') this.fail(`更新失败：${ev.message}`, 'ending');
        return;
      case 'dismissed':
        return;
    }
  }

  private onCycleFinished(ev: Extract<BridgeEvent, { type: 'cycle-finished' }>): void {
    if (ev.check === 'probe' && this.session === 'probe') {
      this.session = 'none';
      if (this.probeFound) {
        this.setOffer(this.probeFound);
        this.set('available', { message: null });
      } else if (this.probeNone || ev.errorCode === SU_NO_UPDATE_ERROR) {
        this.setOffer(null);
        this.set('up-to-date', { message: null });
      } else {
        this.set('error', { message: `检查更新失败：${ev.error ?? '未知错误'}` });
      }
      return;
    }
    if (ev.check === 'user' && this.session === 'update') {
      // 安装已开始时，会话结束由应用退出收尾
      if (this.status === 'installing') return;
      if (ev.errorCode === SU_NO_UPDATE_ERROR) {
        this.attempt++;
        this.releaseFreeze();
        this.session = 'none';
        this.setOffer(null);
        this.set('up-to-date', { percent: null, message: null });
      } else {
        this.fail(ev.error ? `更新失败：${ev.error}` : '更新未完成，请重试', 'none');
      }
    }
  }

  private async onReady(gen: number): Promise<void> {
    const { token, drained } = this.opts.gate.freezeAndDrain();
    this.releaseFreeze();
    this.token = token;
    const waiting = this.opts.gate.activeCount > 0;
    this.set('waiting', { percent: null, message: waiting ? '等待插件操作完成…' : '准备安装…' });
    await drained;
    // 等待期间若已取消、出错或开始了新的尝试，则不安装
    if (gen !== this.attempt || this.status !== 'waiting' || this.session !== 'update' || !this.bridge) return;
    this.set('installing', { message: '正在安装并重新启动…' });
    // 返回 false 通常是原生已因错误结束会话（错误事件尚在队列中）；该会话已开始过，须等它的周期结束才允许重试
    if (!this.bridge.installNow()) this.fail('安装未能开始，请重试', 'ending');
  }

  /** 使当前尝试失效并解冻；next 为失败后的会话状态（原生周期尚未结束时用 ending） */
  private fail(message: string, next: 'none' | 'ending'): void {
    this.attempt++;
    this.releaseFreeze();
    this.session = next;
    this.set('error', { percent: null, message });
  }

  private releaseFreeze(): void {
    if (this.token) {
      this.opts.gate.unfreeze(this.token);
      this.token = null;
    }
  }

  private emit(): void {
    this.rev++;
    this.opts.onState?.(this.getState());
  }

  private set(status: ClientUpdateStatus, patch: { percent?: number | null; message?: string | null } = {}): void {
    this.status = status;
    if ('percent' in patch) this.percent = patch.percent ?? null;
    if ('message' in patch) this.message = patch.message ?? null;
    this.emit();
  }
}
