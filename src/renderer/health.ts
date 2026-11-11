// 我的插件页的「健康检查」：只在用户点击“开始检查 / 重新检查”时请求主进程做一次只读扫描，打开标签页不读取任何东西。
// - 不经过 runWrite / refreshLocal（它们会读取本地状态，可能恢复事务与清理），检查结束也不刷新本地列表。
// - 结果按 目标（版本 + 目录）+ 请求序号 采用；回复属于旧目标或已有更新的请求时丢弃，切换版本或目录后不显示旧结果。
// - 检查之后本界面看到插件写操作结束（安装、更新、卸载、恢复等）时，结果标为“上次检查、可能已过期”。
// - 提示说明按纯文本显示（textContent），列表有界、可滚动。

import type { HealthIssue, HealthReport, HealthSeverity } from '../shared/types';
import { h, mount, spinner } from './dom.js';
import { errMsg, formatDateTime } from './format.js';
import { api, emit, state, targetKey, type Target } from './state.js';

const SEVERITY_TEXT: Record<HealthSeverity, string> = {
  warning: '需要留意',
  unknown: '无法确认',
  info: '参考信息',
};

const SEVERITY_CLASS: Record<HealthSeverity, string> = {
  warning: 'tag tag-warn',
  unknown: 'tag tag-muted',
  info: 'tag',
};

interface HealthView {
  key: string;
  report: HealthReport | null;
  error: string | null;
  /** 检查发起时的写操作计数 */
  epoch: number;
}

let shown: HealthView | null = null;
/** 进行中的检查（目标键与序号）；同一目标不重复发起 */
let pending: { key: string; seq: number } | null = null;
let seq = 0;

/** 当前目标进行中的检查 */
export function healthChecking(t: Target): boolean {
  return pending?.key === targetKey(t);
}

/** 当前显示的结果（只属于当前目标；测试与其他模块只读） */
export function shownHealth(t: Target): { report: HealthReport | null; error: string | null; stale: boolean } | null {
  if (!shown || shown.key !== targetKey(t)) return null;
  return { report: shown.report, error: shown.error, stale: shown.epoch !== state.writeEpoch };
}

/** 用户点击开始 / 重新检查：同一目标已有进行中的检查时不再发起 */
export async function runHealthCheck(t: Target): Promise<void> {
  noteHealthTarget(t);
  const key = targetKey(t);
  if (pending?.key === key) return;
  const my = ++seq;
  const epoch = state.writeEpoch;
  pending = { key, seq: my };
  emit('local');
  try {
    const report = await api().healthCheck(t.flavorId, t.root);
    if (my !== seq) return;
    // 回复必须属于发起时的目标
    if (targetKey({ flavorId: report.flavorId, root: report.root }) !== key) return;
    shown = { key, report, error: null, epoch };
  } catch (err) {
    if (my !== seq) return;
    shown = { key, report: null, error: errMsg(err), epoch };
  } finally {
    if (pending?.seq === my) {
      pending = null;
      emit('local');
    }
  }
}

/** 切换版本或目录：丢弃显示的结果，进行中的检查回复到达时也被丢弃 */
export function resetHealth(): void {
  seq++;
  shown = null;
  pending = null;
}

/** 最近一次看到的当前目标（版本 + 目录）；null 表示没有当前目标 */
let lastTarget: string | null = null;

/**
 * 每次本地状态变化时调用：当前目标与上次不同（同一版本换绑、解除绑定、外部修改设置后刷新、读取失败而没有当前目标）
 * 即丢弃结果并作废进行中的检查，之后切回原目标也不会复活旧结果。目标不变的普通刷新不清除结果
 */
export function noteHealthTarget(t: Target | null): void {
  const key = t ? targetKey(t) : null;
  if (key === lastTarget) return;
  lastTarget = key;
  resetHealth();
}

const SCOPE_FALLBACK = '只检查 AddOns 一级目录与按当前游戏版本选中的顶层 TOC，不会修改任何文件，也不会自动修复。';

export function renderHealth(t: Target | null): HTMLElement {
  const box = h('div', { class: 'tab-content scroll' });
  if (!t) {
    mount(box, h('div', { class: 'state-box' },
      h('div', { class: 'state-title', text: '请先选择游戏目录' }),
      h('div', { class: 'state-msg', text: '健康检查针对当前游戏版本绑定的目录。' }),
    ));
    return box;
  }
  const checking = healthChecking(t);
  const view = shownHealth(t);
  const report = view?.report ?? null;
  const intro = h('div', { class: 'note', text: '只读检查：只在点击时读取插件目录与 TOC，不修改、不修复、不下载，不读取 WTF。结果是磁盘上的静态线索，不代表游戏内的加载情况。' });
  const button = h('button', {
    class: 'btn btn-primary',
    disabled: checking,
    on: { click: () => void runHealthCheck(t) },
  }, checking ? [spinner(true), '检查中'] : view ? '重新检查' : '开始检查');
  const head = h('div', { class: 'health-head' }, button,
    view?.report ? h('span', { class: 'check-info', text: `${view.stale ? '上次检查' : '检查时间'} ${formatDateTime(view.report.checkedAt)}` }) : null,
  );

  const parts: HTMLElement[] = [];
  if (view?.stale) parts.push(h('div', { class: 'banner banner-warn', text: '检查之后有插件管理操作，以下是上次的结果，可能已过期，请重新检查。' }));
  if (!view) {
    parts.push(h('div', { class: 'state-box small', text: checking ? '正在检查…' : '尚未检查。点击“开始检查”读取当前目录的插件与 TOC。' }));
    parts.push(h('div', { class: 'health-scope', text: `检查范围：${SCOPE_FALLBACK}` }));
  } else if (view.error) {
    parts.push(h('div', { class: 'banner banner-error', text: `检查失败：${view.error}` }));
    parts.push(h('div', { class: 'health-scope', text: `检查范围：${SCOPE_FALLBACK}` }));
  } else if (report) {
    parts.push(...reportParts(report));
  }
  mount(box, intro, head, parts);
  return box;
}

const STATUS_TEXT: Record<HealthReport['status'], string> = {
  complete: '已完成范围内的检查，不代表游戏内运行正常',
  partial: '部分完成（有内容未能检查或已截断）',
  unavailable: '无法检查',
};

function reportParts(r: HealthReport): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(h('div', { class: 'health-ref', text: r.reference.interfaceNumber === null
    ? '适配参考版本未知，本次未比较 Interface。'
    : `适配参考 Interface ${r.reference.interfaceNumber}（来自插件库配置，不是本机游戏实测；不一致不代表不能运行）` }));
  out.push(h('div', { class: `health-status health-${r.status}`, text: STATUS_TEXT[r.status] }));
  if (r.message) out.push(h('div', { class: r.status === 'unavailable' ? 'banner banner-error' : r.status === 'partial' ? 'banner banner-warn' : 'health-message', text: r.message }));
  out.push(h('div', { class: 'health-counts', text: `需要留意 ${r.counts.warning} · 无法确认 ${r.counts.unknown} · 参考信息 ${r.counts.info}${r.truncated.issues ? `（只列出前 ${r.issues.length} 条）` : ''}` }));
  out.push(h('div', { class: 'health-scope', text: `检查范围：${r.scope}` }));
  if (r.issues.length) out.push(h('div', { class: 'row-list health-list' }, r.issues.map(issueRow)));
  return out;
}

function issueRow(i: HealthIssue): HTMLElement {
  return h('div', { class: 'row health-row' },
    h('span', { class: SEVERITY_CLASS[i.severity], text: SEVERITY_TEXT[i.severity] }),
    h('div', { class: 'row-main' },
      i.folder ? h('div', { class: 'row-name mono', text: i.folder }) : null,
      h('div', { class: 'health-issue', text: i.message }),
    ),
  );
}
