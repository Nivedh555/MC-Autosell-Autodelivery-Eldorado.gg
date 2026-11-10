'use strict';
const { contextBridge, ipcRenderer } = require('electron');
if (process.isMainFrame) {
  contextBridge.exposeInMainWorld('desktop', Object.freeze({
    getState: () => ipcRenderer.invoke('desktop:state'),
    start: value => ipcRenderer.invoke('desktop:start', value),
    importWorkspace: () => ipcRenderer.invoke('desktop:import'),
    action: value => ipcRenderer.invoke('desktop:action', value),
    onState: callback => {
      if (typeof callback !== 'function') throw Error('A callback is required');
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('desktop:state', listener);
      return () => ipcRenderer.removeListener('desktop:state', listener);
    }
  }));
}
