// 加载客户端更新原生桥：只在打包后的 Apple 芯片 macOS 应用中启用。
import { app } from 'electron';
import path from 'node:path';
import type { SparkleBridge } from '../core/client-update';

export function loadSparkleBridge(): { bridge: SparkleBridge | null; reason?: string } {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') return { bridge: null, reason: '客户端自动更新仅支持 Apple 芯片的 Mac' };
  if (!app.isPackaged) return { bridge: null, reason: '开发运行时不提供客户端自动更新' };
  const addon = path.join(process.resourcesPath, '..', 'Frameworks', 'beelite_sparkle.node');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(addon) as SparkleBridge;
    for (const k of ['init', 'probe', 'beginUpdate', 'installNow', 'cancel', 'cancelProbe'] as const) {
      if (typeof mod[k] !== 'function') return { bridge: null, reason: '客户端更新组件不完整' };
    }
    return { bridge: mod };
  } catch (err) {
    // 详细原因（可能含内部路径与堆栈）只写入控制台，界面显示简短说明
    console.error('[BeeLite] 客户端更新组件加载失败：', err);
    return { bridge: null, reason: '客户端更新组件无法加载，请重新下载安装艾泽魔方' };
  }
}
