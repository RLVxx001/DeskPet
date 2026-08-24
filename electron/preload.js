const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('deskPet', {
  loadModel: () => ipcRenderer.invoke('pet:load-model'),
  loadAnimations: () => ipcRenderer.invoke('pet:load-animations'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', ignore),
  moveBy: (dx, dy) => ipcRenderer.send('pet:move-by', { dx, dy }),
  quit: () => ipcRenderer.send('pet:quit'),
  showMenu: () => ipcRenderer.send('pet:context-menu'),
  clicked: () => ipcRenderer.send('pet:clicked'),
  openChat: () => ipcRenderer.send('pet:open-chat'),
  openSettings: () => ipcRenderer.send('pet:open-settings'),
  pickModel: () => ipcRenderer.invoke('pet:pick-model'),
  resetModel: () => ipcRenderer.invoke('pet:reset-model'),
  onMode: (callback) => {
    ipcRenderer.on('pet:set-mode', (_event, payload) => callback(payload))
  },
  onReloadModel: (callback) => {
    ipcRenderer.on('pet:reload-model', () => callback())
  },
  getChat: () => ipcRenderer.invoke('chat:get'),
  sendChat: (text) => ipcRenderer.invoke('chat:send', text),
  onChat: (callback) => {
    ipcRenderer.on('chat:updated', (_event, payload) => callback(payload))
  },
  getMemory: () => ipcRenderer.invoke('memory:get'),
  removeMemory: (id) => ipcRenderer.invoke('memory:remove', id),
  updateMemory: (id, text) => ipcRenderer.invoke('memory:update', { id, text }),
  updateCore: (slot, text) => ipcRenderer.invoke('memory:core', { slot, text }),
  compactMemory: () => ipcRenderer.invoke('memory:compact'),
  onMemory: (callback) => {
    ipcRenderer.on('memory:updated', (_event, payload) => callback(payload))
  },
  getKnowledge: () => ipcRenderer.invoke('knowledge:info'),
  pickKnowledge: () => ipcRenderer.invoke('knowledge:pick'),
  openKnowledge: () => ipcRenderer.invoke('knowledge:open'),
  closeChat: () => ipcRenderer.send('chat:close'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (payload) => ipcRenderer.invoke('settings:save', payload),
  closeSettings: () => ipcRenderer.send('settings:close')
})
