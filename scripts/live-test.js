const fs = require('fs')
const path = require('path')
const { createAgent } = require('../electron/agent')

const root = path.join(__dirname, '..')
const dataDir = () => path.join(root, 'testdata', 'run')
const knowledgeDir = () => path.join(root, 'testdata', 'knowledge')
const localSettingsPath = () => path.join(root, 'testdata', 'settings.local.json')
const settingsPath = () => path.join(dataDir(), 'settings.json')
const memoryPath = () => path.join(dataDir(), 'memory.json')

const loadLocalSettings = () => {
  if (!fs.existsSync(localSettingsPath())) {
    throw new Error('缺少 testdata/settings.local.json，先复制 settings.local.json.example 并填 Key')
  }
  const raw = JSON.parse(fs.readFileSync(localSettingsPath(), 'utf8'))
  return {
    ...raw,
    knowledgePath: knowledgeDir()
  }
}

const loadSettings = () => {
  try {
    return { ...loadLocalSettings(), ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')), knowledgePath: knowledgeDir() }
  } catch {
    return loadLocalSettings()
  }
}

const saveSettings = (next) => {
  fs.mkdirSync(dataDir(), { recursive: true })
  const settings = { ...loadLocalSettings(), ...next, knowledgePath: knowledgeDir() }
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
  return settings
}

const memoryTexts = () => {
  try {
    const data = JSON.parse(fs.readFileSync(memoryPath(), 'utf8'))
    return (data.items || []).map((item) => ({
      kind: item.kind,
      text: item.text,
      superseded: Boolean(item.superseded)
    }))
  } catch {
    return []
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

fs.mkdirSync(dataDir(), { recursive: true })
saveSettings(loadLocalSettings())

const agent = createAgent({
  dataDir,
  ensureDataDir: () => fs.mkdirSync(dataDir(), { recursive: true }),
  loadSettings,
  saveSettings,
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  clipboard: { readText: () => '剪贴板测试：flaps-mysql-tunnel' },
  shell: {
    openExternal: async (url) => {
      console.log('[open_url]', url)
    },
    openPath: async (dir) => {
      console.log('[openPath]', dir)
      return ''
    }
  },
  Notification: class {
    static isSupported() { return false }
    show() {}
  },
  getParentWindow: () => undefined,
  showBubble: (text) => console.log('[bubble]', text),
  onMemoryChange: () => {},
  onPetAction: (name) => console.log('[pet_action]', name)
})

const turns = [
  { id: 'name', text: '记住，以后叫我周周。' },
  { id: 'hangzhou', text: '我现在住在杭州。' },
  { id: 'shanghai', text: '更正一下，我搬去上海了，杭州那条作废。' },
  { id: 'who', text: '我叫什么？我现在住哪？' },
  { id: 'deadline', text: '下周三要交 DeskPet 方案，帮我记住。' },
  { id: 'rewrite', text: '那个方案截止日期是什么时候？' },
  { id: 'notes', text: '笔记里方案怎么写的，验收点有哪些？' },
  { id: 'now', text: '现在几点了？' },
  { id: 'sit', text: '你去坐一会儿。' },
  { id: 'clip', text: '看看我复制的内容。' },
  { id: 'job', text: '你还记得我是做什么的吗？' },
  { id: 'smalltalk', text: '嗯。' },
  { id: 'forget', text: '忘掉杭州。' },
  { id: 'where2', text: '我住哪？以前住哪？' }
]

const main = async () => {
  const report = []
  console.log('dataDir', dataDir())
  console.log('memory_before', JSON.stringify(memoryTexts(), null, 2))
  await agent.warmIndex()
  for (const turn of turns) {
    const started = Date.now()
    const result = await agent.sendChat(turn.text, () => {})
    const reply = String(result.reply || '').replace(/\s+/g, ' ').trim()
    await sleep(7000)
    const mem = memoryTexts()
    const row = {
      id: turn.id,
      user: turn.text,
      reply: reply.slice(0, 240),
      ms: Date.now() - started,
      usedPetAction: Boolean(result.usedPetAction),
      memory: mem
    }
    report.push(row)
    console.log('\n===', turn.id, '===')
    console.log('U:', turn.text)
    console.log('A:', row.reply)
    console.log('mem:', mem.map((item) => `${item.superseded ? '~' : ''}${item.kind}:${item.text}`).join(' | ') || '(empty)')
  }
  const out = path.join(dataDir(), 'live-test-report.json')
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log('\nDONE', out)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
