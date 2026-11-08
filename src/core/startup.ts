// 启动恢复：处理各已绑定目录中残留的未完成事务。由主进程 start() 调用。
// - 整个过程计入写操作闸门，结束后释放，之后才启用客户端更新；
// - 设置文件无法读取或不合法时只记录并跳过本次恢复，不抛出，保证窗口与客户端更新照常启动；
//   界面读取本地状态时会显示同样的错误并提供重试。
import { errorMessage } from './errors';
import type { MutationGate } from './gate';
import type { SettingsStore } from './profiles';

export interface StartupRecoveryDeps {
  gate: MutationGate;
  settings: SettingsStore;
  recover: (root: string) => Promise<unknown>;
  /** 恢复之前执行的准备步骤（测试绑定），失败只记录 */
  prepare?: () => Promise<void>;
  warn?: (...args: unknown[]) => void;
}

export async function recoverBoundRoots(d: StartupRecoveryDeps): Promise<{ settingsError: string | null }> {
  const warn = d.warn ?? (() => undefined);
  const release = d.gate.enter();
  try {
    if (d.prepare) await d.prepare().catch((err) => warn('[BeeLite] 测试绑定失败：', err));
    let bindings: Record<string, string>;
    try {
      bindings = (await d.settings.load()).bindings;
    } catch (err) {
      warn('[BeeLite] 设置无法读取，跳过本次启动恢复：', err);
      return { settingsError: errorMessage(err) };
    }
    for (const root of new Set(Object.values(bindings))) {
      await d.recover(root).catch((err) => warn('[BeeLite] 恢复检查失败：', err));
    }
    return { settingsError: null };
  } finally {
    release();
  }
}
