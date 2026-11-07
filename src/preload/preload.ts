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
  unbindProfile: (flavorId) => invoke('profile:unbind', flavorId),
  localState: (flavorId) => invoke('local:state', flavorId),
  checkUpdates: (flavorId) => invoke('addon:check', flavorId),
  install: (modId, flavorId) => invoke('addon:install', modId, flavorId),
  update: (modId, flavorId, force) => invoke('addon:update', modId, flavorId, force),
  updateAll: (flavorId) => invoke('addon:updateAll', flavorId),
  uninstallProject: (modId, flavorId) => invoke('addon:uninstall', modId, flavorId),
  uninstallFolder: (folder, flavorId) => invoke('addon:uninstallFolder', folder, flavorId),
  restore: (entryId, flavorId) => invoke('trash:restore', entryId, flavorId),
  purge: (entryId, flavorId) => invoke('trash:purge', entryId, flavorId),
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
