const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    openSettings: () => ipcRenderer.invoke('open-settings'),
    chatStream: (messages) => ipcRenderer.invoke('chat-stream', messages),
    onChatChunk: (cb) => ipcRenderer.on('chat-chunk', (_, chunk) => cb(chunk)),
    onceChatDone: (cb) => ipcRenderer.once('chat-done', () => cb()),
    onceChatError: (cb) => ipcRenderer.once('chat-error', (_, err) => cb(err)),
    removeChatListeners: () => {
        ipcRenderer.removeAllListeners('chat-chunk');
        ipcRenderer.removeAllListeners('chat-done');
        ipcRenderer.removeAllListeners('chat-error');
    },
    moveWindow: (dx, dy) => ipcRenderer.invoke('move-window', dx, dy),
    resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', width, height),
    clearMemory: () => ipcRenderer.invoke('clear-memory'),
    showContextMenu: () => ipcRenderer.send('show-context-menu'),
    scanModels: () => ipcRenderer.invoke('scan-models'),
    importModel: () => ipcRenderer.invoke('import-model'),
    deleteModel: (virtualPath) => ipcRenderer.invoke('delete-model', virtualPath),
    switchModel: (modelPath) => ipcRenderer.invoke('switch-model', modelPath),
    onConfigUpdated: (cb) => ipcRenderer.on('config-updated', (_, config) => cb(config)),
    onModelChanged: (cb) => ipcRenderer.on('model-changed', (_, modelPath) => cb(modelPath)),
});
