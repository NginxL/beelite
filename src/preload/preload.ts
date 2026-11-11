// 沙箱 preload：只暴露固定的窄接口，界面拿不到 ipcRenderer、Node 或任何文件路径能力。
// 注意：sandbox 模式下 preload 只能 require('electron')，因此本文件不引用项目内其他运行时模块。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { ActivitySnapshot, AddonWatchSnapshot, BackupTaskSnapshot, BeeLiteApi, ClientUpdateState, HistoryStatusView, TaskEvent } from '../shared/types';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: BeeLiteApi = {
  clientState: () => invoke('client:state'),
  clientCheck: () => invoke('client:check'),
  clientUpdate: (expectedBuild) => invoke('client:update', expectedBuild),
  clientCancel: () => invoke('client:cancel'),
  clientAckNotice: (build) => invoke('client:ackNotice', build),
  onClientState: (cb) => {
    const listener = (_e: IpcRendererEvent, st: ClientUpdateState) => cb(st);
    ipcRenderer.on('client:event', listener);
    return () => {
      ipcRenderer.removeListener('client:event', listener);
    };
  },
  watchState: () => invoke('addon:watchState'),
  onAddonWatch: (cb) => {
    const listener = (_e: IpcRendererEvent, s: AddonWatchSnapshot) => cb(s);
    ipcRenderer.on('addon:watch', listener);
    return () => {
      ipcRenderer.removeListener('addon:watch', listener);
    };
  },
  getConfig: () => invoke('config:get'),
  search: (q) => invoke('mods:search', q),
  detail: (modId, flavorId) => invoke('mods:detail', modId, flavorId),
  latestFile: (modId, flavorId) => invoke('mods:latest', modId, flavorId),
  listProfiles: () => invoke('profile:list'),
  bindProfile: (flavorId) => invoke('profile:bind', flavorId),
  unbindProfile: (flavorId, root) => invoke('profile:unbind', flavorId, root),
  localState: (flavorId) => invoke('local:state', flavorId),
  checkUpdates: (flavorId, root) => invoke('addon:check', flavorId, root),
  install: (modId, flavorId, root) => invoke('addon:install', modId, flavorId, root),
  update: (modId, flavorId, force, expected, root) => invoke('addon:update', modId, flavorId, force, expected, root),
  updateAll: (flavorId, root) => invoke('addon:updateAll', flavorId, root),
  uninstallProject: (modId, flavorId, root) => invoke('addon:uninstall', modId, flavorId, root),
  uninstallFolder: (folder, flavorId, root) => invoke('addon:uninstallFolder', folder, flavorId, root),
  restore: (entryId, flavorId, root) => invoke('trash:restore', entryId, flavorId, root),
  purge: (entryId, flavorId, root) => invoke('trash:purge', entryId, flavorId, root),
  cancelTask: (taskId) => invoke('task:cancel', taskId),
  onTask: (cb) => {
    const listener = (_e: IpcRendererEvent, ev: TaskEvent) => cb(ev);
    ipcRenderer.on('task:event', listener);
    return () => {
      ipcRenderer.removeListener('task:event', listener);
    };
  },
  activityState: () => invoke('addon:activityState'),
  onActivity: (cb) => {
    const listener = (_e: IpcRendererEvent, s: ActivitySnapshot) => cb(s);
    ipcRenderer.on('addon:activity', listener);
    return () => {
      ipcRenderer.removeListener('addon:activity', listener);
    };
  },
  setPaused: (modId, flavorId, paused, root) => invoke('policy:set', modId, flavorId, paused, root),
  reloadPolicy: () => invoke('policy:reload'),
  historyList: (flavorId, root) => invoke('history:list', flavorId, root),
  historyRetry: () => invoke('history:retry'),
  historyStatus: () => invoke('history:status'),
  healthCheck: (flavorId, root) => invoke('health:check', flavorId, root),
  onHistoryStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, s: HistoryStatusView) => cb(s);
    ipcRenderer.on('history:status', listener);
    return () => {
      ipcRenderer.removeListener('history:status', listener);
    };
  },
  // WTF 配置备份：只传游戏版本、期望目录、备份编号、任务编号与备份范围（纯数据，由主进程严格校验）；保存位置由主进程的选择框决定
  backupTaskState: () => invoke('backup:taskState'),
  onBackupTask: (cb) => {
    const listener = (_e: IpcRendererEvent, s: BackupTaskSnapshot) => cb(s);
    ipcRenderer.on('backup:task', listener);
    return () => {
      ipcRenderer.removeListener('backup:task', listener);
    };
  },
  backupState: (flavorId, root) => invoke('backup:state', flavorId, root),
  backupConfigure: (flavorId, root) => invoke('backup:configure', flavorId, root),
  backupDisable: (flavorId, root) => invoke('backup:disable', flavorId, root),
  backupCatalog: (flavorId, root) => invoke('backup:catalog', flavorId, root),
  backupRun: (flavorId, root, scope) => invoke('backup:run', flavorId, root, scope),
  backupVerify: (flavorId, root, snapshotId) => invoke('backup:verify', flavorId, root, snapshotId),
  backupCancel: (taskId, flavorId, root) => invoke('backup:cancel', taskId, flavorId, root),
  backupReveal: (flavorId, root, snapshotId) => invoke('backup:reveal', flavorId, root, snapshotId),
};

contextBridge.exposeInMainWorld('beelite', api);
