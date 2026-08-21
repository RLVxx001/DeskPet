const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, dialog, shell, clipboard, Notification } = require('electron')
const fs = require('fs')
const path = require('path')
const { DEFAULT_SETTINGS, normalizeBaseUrl, normalizeModel, createAgent } = require('./agent')

app.commandLine.appendSwitch('enable-transparent-visuals')

let petWindow = null
let chatWindow = null
let settingsWindow = null
let bubbleWindow = null
let tray = null
let ignoreMouse = true
let mode = 'idle'
let walkDir = -1
let walkTimer = null
let idleTimer = null
let bubbleTimer = null
let autoWalk = false

const WINDOW_WIDTH = 108
const WINDOW_HEIGHT = 186
const CHAT_WIDTH = 360
const CHAT_HEIGHT = 520
const BUBBLE_WIDTH = 180
const BUBBLE_HEIGHT = 64

const bundledModelPath = () => path.join(__dirname, '..', 'assets', 'models', 'avatar.vrm')
const customModelPath = () => path.join(dataDir(), 'avatar.vrm')
const dataDir = () => path.join(app.getPath('userData'), 'deskpet')
const settingsPath = () => path.join(dataDir(), 'settings.json')

const ensureDataDir = () => {
  fs.mkdirSync(dataDir(), { recursive: true })
}

const readJson = (file, fallback) => {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch {
    return { ...fallback }
  }
}

const loadSettings = () => readJson(settingsPath(), DEFAULT_SETTINGS)

const saveSettings = (next) => {
  ensureDataDir()
  const current = readJson(settingsPath(), DEFAULT_SETTINGS)
  const merged = { ...current, ...next }
  const baseUrl = normalizeBaseUrl(String(merged.baseUrl || '').trim() || DEFAULT_SETTINGS.baseUrl)
  const settings = {
    baseUrl,
    model: normalizeModel(baseUrl, merged.model),
    apiKey: String(merged.apiKey || '').trim(),
    modelPath: String(merged.modelPath || '').trim(),
    modelName: String(merged.modelName || '').trim(),
    knowledgePath: String(merged.knowledgePath || '').trim(),
    embeddingBaseUrl: String(merged.embeddingBaseUrl || DEFAULT_SETTINGS.embeddingBaseUrl).trim(),
    embeddingModel: String(merged.embeddingModel || DEFAULT_SETTINGS.embeddingModel).trim(),
    embeddingApiKey: String(merged.embeddingApiKey || '').trim()
  }
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  return settings
}

const resolveModelPath = () => {
  const custom = loadSettings().modelPath
  if (custom && fs.existsSync(custom)) return custom
  return bundledModelPath()
}

const currentModelLabel = () => {
  const settings = loadSettings()
  if (settings.modelPath && fs.existsSync(settings.modelPath)) {
    return settings.modelName || path.basename(settings.modelPath)
  }
  return '默认角色'
}

const reloadPetModel = () => {
  petWindow?.webContents.send('pet:reload-model')
}

const importModelFile = (src) => {
  if (!src || !fs.existsSync(src) || !/\.vrm$/i.test(src)) {
    throw new Error('请选择一个 .vrm 文件')
  }
  ensureDataDir()
  fs.copyFileSync(src, customModelPath())
  const current = loadSettings()
  saveSettings({
    ...current,
    modelPath: customModelPath(),
    modelName: path.basename(src)
  })
  reloadPetModel()
  showBubble('换成新形象了')
  return currentModelLabel()
}

const resetModel = () => {
  const current = loadSettings()
  saveSettings({ ...current, modelPath: '', modelName: '' })
  try { fs.unlinkSync(customModelPath()) } catch {}
  reloadPetModel()
  showBubble('回到默认形象')
  return currentModelLabel()
}

const pickModelFile = async () => {
  const result = await dialog.showOpenDialog(petWindow || undefined, {
    title: '选择 VRM 角色',
    filters: [{ name: 'VRM 角色', extensions: ['vrm'] }],
    properties: ['openFile']
  })
  if (result.canceled || !result.filePaths[0]) return currentModelLabel()
  return importModelFile(result.filePaths[0])
}

const createTrayIcon = () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAQAAAC1+jfqAAAAOUlEQVR4nGNgGGjAiAJEQPgfCv5D4X8o/A+F/6HwPxT+h8L/UPgfCv9D4X8o/A+F/6HwPxT+hwIGygEAZOQK2oR7yT8AAAAASUVORK5CYII=',
    'base64'
  )
  const image = nativeImage.createFromBuffer(png)
  if (process.platform === 'darwin') image.setTemplateImage(true)
  return image
}

const sendMode = () => {
  petWindow?.webContents.send('pet:set-mode', { mode, dir: walkDir })
}

const petBounds = () => petWindow?.getBounds()

const placeNearPet = (win, width, height, side) => {
  if (!win || !petWindow) return
  const bounds = petBounds()
  const display = screen.getDisplayMatching(bounds)
  const work = display.workArea
  let x = side === 'left' ? bounds.x - width - 10 : bounds.x + Math.round((bounds.width - width) / 2)
  let y = side === 'left' ? bounds.y + bounds.height - height : bounds.y - height - 6
  x = Math.min(Math.max(x, work.x), work.x + work.width - width)
  y = Math.min(Math.max(y, work.y), work.y + work.height - height)
  win.setPosition(Math.round(x), Math.round(y))
}

const layoutCompanions = () => {
  if (chatWindow && !chatWindow.isDestroyed() && chatWindow.isVisible()) {
    placeNearPet(chatWindow, CHAT_WIDTH, CHAT_HEIGHT, 'left')
  }
  if (bubbleWindow && !bubbleWindow.isDestroyed() && bubbleWindow.isVisible()) {
    placeNearPet(bubbleWindow, BUBBLE_WIDTH, BUBBLE_HEIGHT, 'top')
  }
}

const stopWalk = () => {
  if (walkTimer) {
    clearInterval(walkTimer)
    walkTimer = null
  }
  autoWalk = false
  if (mode === 'walk') {
    mode = 'idle'
    sendMode()
  }
}

const startWalk = (fromIdle = false) => {
  if (!petWindow) return
  autoWalk = fromIdle
  mode = 'walk'
  sendMode()
  if (walkTimer) clearInterval(walkTimer)
  let last = Date.now()
  walkTimer = setInterval(() => {
    if (!petWindow) return
    const now = Date.now()
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const [x, y] = petWindow.getPosition()
    const display = screen.getDisplayMatching(petWindow.getBounds())
    const work = display.workArea
    const minX = work.x
    const maxX = work.x + work.width - WINDOW_WIDTH
    let nextX = x + walkDir * 72 * dt
    if (nextX <= minX) {
      nextX = minX
      walkDir = 1
      sendMode()
    } else if (nextX >= maxX) {
      nextX = maxX
      walkDir = -1
      sendMode()
    }
    petWindow.setPosition(Math.round(nextX), y)
    layoutCompanions()
  }, 32)
}

const scheduleIdleWalk = () => {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (mode === 'idle' && petWindow?.isVisible() && !draggingNow()) startWalk(true)
    setTimeout(() => {
      if (autoWalk) stopWalk()
      scheduleIdleWalk()
    }, 5000 + Math.random() * 4000)
  }, 18000 + Math.random() * 14000)
}

let dragLock = false
const draggingNow = () => dragLock

const createChildWindow = (width, height, fileName, options = {}) => {
  const win = new BrowserWindow({
    width,
    height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: options.focusable !== false,
    roundedCorners: true,
    hiddenInMissionControl: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(path.join(__dirname, '..', 'dist', fileName))
  return win
}

const showBubble = (text) => {
  if (!bubbleWindow || bubbleWindow.isDestroyed()) {
    bubbleWindow = createChildWindow(BUBBLE_WIDTH, BUBBLE_HEIGHT, 'bubble.html', { focusable: false })
    bubbleWindow.once('ready-to-show', () => {
      bubbleWindow.webContents.send('chat:updated', { bubble: text })
      placeNearPet(bubbleWindow, BUBBLE_WIDTH, BUBBLE_HEIGHT, 'top')
      bubbleWindow.showInactive()
    })
  } else {
    bubbleWindow.webContents.send('chat:updated', { bubble: text })
    placeNearPet(bubbleWindow, BUBBLE_WIDTH, BUBBLE_HEIGHT, 'top')
    bubbleWindow.showInactive()
  }
  if (bubbleTimer) clearTimeout(bubbleTimer)
  bubbleTimer = setTimeout(() => {
    if (bubbleWindow && !bubbleWindow.isDestroyed()) bubbleWindow.hide()
  }, 2600)
}

const showChat = () => {
  if (!chatWindow || chatWindow.isDestroyed()) {
    chatWindow = createChildWindow(CHAT_WIDTH, CHAT_HEIGHT, 'chat.html')
    chatWindow.once('ready-to-show', () => {
      placeNearPet(chatWindow, CHAT_WIDTH, CHAT_HEIGHT, 'left')
      chatWindow.show()
      chatWindow.focus()
    })
  } else {
    placeNearPet(chatWindow, CHAT_WIDTH, CHAT_HEIGHT, 'left')
    chatWindow.show()
    chatWindow.focus()
  }
}

const showSettings = () => {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createChildWindow(360, 640, 'settings.html')
    settingsWindow.once('ready-to-show', () => {
      const bounds = petBounds() || screen.getPrimaryDisplay().workArea
      settingsWindow.setPosition(Math.round(bounds.x - 330), Math.round(bounds.y))
      settingsWindow.show()
      settingsWindow.focus()
    })
  } else {
    settingsWindow.show()
    settingsWindow.focus()
  }
}

const sendAction = (name) => {
  if (name === 'walk') {
    startWalk()
    refreshMenus()
    return
  }
  stopWalk()
  petWindow?.webContents.send('pet:set-mode', { mode: name, dir: walkDir })
}

const actionMenu = () => ([
  { label: '聊天', click: () => showChat() },
  {
    label: mode === 'walk' ? '停下' : '散步',
    click: () => {
      if (mode === 'walk') stopWalk()
      else startWalk()
      refreshMenus()
    }
  },
  {
    label: '动作',
    submenu: [
      { label: '动作演示（全看一遍）', click: () => sendAction('demo') },
      { type: 'separator' },
      { label: '招手', click: () => sendAction('wave') },
      { label: '点头', click: () => sendAction('nod') },
      { label: '鞠躬', click: () => sendAction('bow') },
      { label: '跳一下', click: () => sendAction('jump') },
      { label: '拍手', click: () => sendAction('clap') },
      { label: '伸懒腰', click: () => sendAction('stretch') },
      { label: '思考', click: () => sendAction('think') },
      { label: '跳舞', click: () => sendAction('dance') },
      { label: '转个圈', click: () => sendAction('spin') },
      { label: '坐下', click: () => sendAction('sit') },
      { label: '睡觉', click: () => sendAction('sleep') },
      { type: 'separator' },
      { label: '回到待机', click: () => sendAction('idle') }
    ]
  },
  { type: 'separator' },
  {
    label: petWindow?.isVisible() ? '隐藏' : '显示',
    click: () => {
      if (!petWindow) return
      if (petWindow.isVisible()) {
        stopWalk()
        petWindow.hide()
        chatWindow?.hide()
        bubbleWindow?.hide()
      } else petWindow.showInactive()
      refreshMenus()
    }
  },
  { label: '换形象…', click: () => { pickModelFile().catch((error) => showBubble(error.message)) } },
  { label: '设置', click: () => showSettings() },
  { type: 'separator' },
  { label: '退出', click: () => app.quit() }
])

const refreshMenus = () => {
  tray?.setContextMenu(Menu.buildFromTemplate(actionMenu()))
}

const createPetWindow = () => {
  const display = screen.getPrimaryDisplay()
  const work = display.workArea
  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: Math.round(work.x + work.width - WINDOW_WIDTH - 24),
    y: Math.round(work.y + work.height - WINDOW_HEIGHT - 8),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    roundedCorners: false,
    hiddenInMissionControl: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    }
  })

  win.setAlwaysOnTop(true, 'floating')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true, { forward: true })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level >= 2) console.error('[renderer]', message, sourceId, line)
  })
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  win.once('ready-to-show', () => win.showInactive())
  return win
}

const createTray = () => {
  tray = new Tray(createTrayIcon())
  tray.setToolTip('桌宠')
  refreshMenus()
  tray.on('click', () => {
    if (!petWindow) return
    if (petWindow.isVisible()) {
      stopWalk()
      petWindow.hide()
      chatWindow?.hide()
      bubbleWindow?.hide()
    } else petWindow.showInactive()
    refreshMenus()
  })
}

const notifyChat = (payload) => {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send('chat:updated', payload)
  }
}

const notifyMemory = () => {
  if (chatWindow && !chatWindow.isDestroyed()) {
    chatWindow.webContents.send('memory:updated', agent.getMemory())
  }
}

const agent = createAgent({
  dataDir,
  ensureDataDir,
  loadSettings,
  saveSettings,
  dialog,
  clipboard,
  shell,
  Notification,
  getParentWindow: () => settingsWindow || chatWindow || petWindow,
  showBubble: (text) => showBubble(text),
  onMemoryChange: () => notifyMemory(),
  onPetAction: (name) => {
    if (name === 'walk') {
      startWalk()
      refreshMenus()
      return
    }
    if (name === 'stop') {
      stopWalk()
      refreshMenus()
      return
    }
    sendAction(name)
    refreshMenus()
  }
})

let chatting = false

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide()

  petWindow = createPetWindow()
  createTray()
  scheduleIdleWalk()
  agent.restoreReminders()
  agent.warmIndex()

  ipcMain.handle('pet:load-model', () => {
    const modelPath = resolveModelPath()
    if (!fs.existsSync(modelPath)) {
      throw new Error('缺少示例角色：assets/models/avatar.vrm')
    }
    return fs.readFileSync(modelPath)
  })

  ipcMain.on('pet:ignore-mouse', (_event, nextIgnore) => {
    const ignore = Boolean(nextIgnore)
    if (ignore === ignoreMouse || !petWindow) return
    ignoreMouse = ignore
    petWindow.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined)
  })

  ipcMain.on('pet:move-by', (_event, payload) => {
    if (!petWindow) return
    dragLock = true
    stopWalk()
    const dx = Number(payload?.dx) || 0
    const dy = Number(payload?.dy) || 0
    if (!dx && !dy) return
    const [x, y] = petWindow.getPosition()
    const display = screen.getDisplayMatching(petWindow.getBounds())
    const work = display.workArea
    const nextX = Math.min(Math.max(x + dx, work.x - 40), work.x + work.width - 40)
    const nextY = Math.min(Math.max(y + dy, work.y - 20), work.y + work.height - 40)
    petWindow.setPosition(Math.round(nextX), Math.round(nextY))
    layoutCompanions()
  })

  ipcMain.on('pet:clicked', () => {
    dragLock = false
    petWindow?.webContents.send('pet:set-mode', { mode: 'wave', dir: walkDir })
    const lines = ['嗯？', '我在。', '怎么了']
    showBubble(lines[Math.floor(Math.random() * lines.length)])
  })

  ipcMain.on('pet:context-menu', () => {
    refreshMenus()
    Menu.buildFromTemplate(actionMenu()).popup({ window: petWindow })
  })

  ipcMain.on('pet:open-chat', () => showChat())
  ipcMain.on('pet:open-settings', () => showSettings())
  ipcMain.on('chat:close', () => chatWindow?.hide())
  ipcMain.on('settings:close', () => settingsWindow?.hide())
  ipcMain.on('pet:quit', () => app.quit())

  ipcMain.handle('chat:get', () => ({ messages: agent.loadChat() }))
  ipcMain.handle('memory:get', () => agent.getMemory())
  ipcMain.handle('memory:remove', (_event, id) => agent.removeMemory(String(id || '')))
  ipcMain.handle('memory:update', (_event, payload) => agent.updateMemory(String(payload?.id || ''), String(payload?.text || '')))
  ipcMain.handle('memory:core', (_event, payload) => agent.updateCore(String(payload?.slot || ''), String(payload?.text || '')))
  ipcMain.handle('memory:compact', () => agent.compactMemories('manual'))
  ipcMain.handle('knowledge:info', () => agent.knowledgeInfo())
  ipcMain.handle('knowledge:pick', () => agent.pickKnowledgeDir())
  ipcMain.handle('knowledge:open', () => agent.openKnowledgeDir())
  ipcMain.handle('settings:get', () => {
    const settings = loadSettings()
    const knowledge = agent.knowledgeInfo()
    return {
      baseUrl: normalizeBaseUrl(settings.baseUrl),
      model: normalizeModel(settings.baseUrl, settings.model),
      apiKey: settings.apiKey ? '••••••' : '',
      modelName: currentModelLabel(),
      knowledgePath: knowledge.path,
      embeddingBaseUrl: settings.embeddingBaseUrl || DEFAULT_SETTINGS.embeddingBaseUrl,
      embeddingModel: settings.embeddingModel || DEFAULT_SETTINGS.embeddingModel,
      embeddingApiKey: settings.embeddingApiKey ? '••••••' : ''
    }
  })
  ipcMain.handle('settings:save', (_event, payload) => {
    const current = loadSettings()
    const apiKey = !payload?.apiKey || payload.apiKey.includes('•') ? current.apiKey : payload.apiKey
    const embeddingApiKey = !payload?.embeddingApiKey || String(payload.embeddingApiKey).includes('•')
      ? current.embeddingApiKey
      : payload.embeddingApiKey
    return saveSettings({
      ...current,
      ...payload,
      apiKey,
      embeddingApiKey,
      modelPath: current.modelPath,
      modelName: current.modelName,
      knowledgePath: payload?.knowledgePath || current.knowledgePath
    })
  })
  ipcMain.handle('pet:pick-model', () => pickModelFile())
  ipcMain.handle('pet:reset-model', () => resetModel())

  ipcMain.handle('chat:send', async (_event, text) => {
    const content = String(text || '').trim()
    if (!content) return { messages: agent.loadChat(), pending: false }
    if (chatting) return { messages: agent.loadChat(), pending: true }
    chatting = true
    try {
      const result = await agent.sendChat(content, notifyChat)
      if (result.reply) showBubble(String(result.reply).slice(0, 18))
      if (!result.usedPetAction) {
        petWindow?.webContents.send('pet:set-mode', { mode: 'wave', dir: walkDir })
      }
      return { messages: result.messages, pending: false }
    } finally {
      chatting = false
    }
  })
})

app.on('window-all-closed', () => app.quit())

app.on('before-quit', () => {
  stopWalk()
  if (idleTimer) clearTimeout(idleTimer)
  if (tray) {
    tray.destroy()
    tray = null
  }
})
