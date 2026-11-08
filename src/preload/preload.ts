// 沙箱 preload：只暴露固定的窄接口，界面拿不到 ipcRenderer、Node 或任何文件路径能力。
// 注意：sandbox 模式下 preload 只能 require('electron')，因此本文件不引用项目内其他运行时模块。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { BeeLiteApi, ClientUpdateState, TaskEvent } from '../shared/types';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: BeeLiteApi = {
  clientState: () => invoke('client:state'),
  clientCheck: () => invoke('client:check'),
  clientUpdate: () => invoke('client:update'),
  clientCancel: () => invoke('client:cancel'),
  onClientState: (cb) => {
    const listener = (_e: IpcRendererEvent, st: ClientUpdateState) => cb(st);
    ipcRenderer.on('client:event', listener);
    return () => {
      ipcRenderer.removeListener('client:event', listener);
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
  update: (modId, flavorId, force, root) => invoke('addon:update', modId, flavorId, force, root),
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
};

contextBridge.exposeInMainWorld('beelite', api);
