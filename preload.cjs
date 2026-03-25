// preload.cjs - Electron preload script for secure IPC communication
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    selectImageFolder: () => ipcRenderer.invoke('select-image-folder'),
    isElectron: true
});
