const fs = require('fs')
const path = require('path')
const { createAgent } = require('../electron/agent')

const root = path.join(__dirname, '..')
const dataDir = () => path.join(root, 'testdata', 'run-cards')
const knowledgeDir = () => path.join(root, 'testdata', 'knowledge')
const localSettingsPath = () => path.join(root, 'testdata', 'settings.local.json')

if (!fs.existsSync(localSettingsPath())) {
  console.error('缺少 testdata/settings.local.json，跳过联网记忆测试')
  process.exit(0)
}

const loadLocalSettings = () => {
  const raw = JSON.parse(fs.readFileSync(localSettingsPath(), 'utf8'))
  return { ...raw, knowledgePath: knowledgeDir() }
}

fs.rmSync(dataDir(), { recursive: true, force: true })
fs.mkdirSync(dataDir(), { recursive: true })
fs.writeFileSync(path.join(dataDir(), 'settings.json'), JSON.stringify(loadLocalSettings(), null, 2))

const actions = []
const agent = createAgent({
  dataDir,
  ensureDataDir: () => fs.mkdirSync(dataDir(), { recursive: true }),
  loadSettings: loadLocalSettings,
  saveSettings: (next) => {
    const settings = { ...loadLocalSettings(), ...next, knowledgePath: knowledgeDir() }
    fs.writeFileSync(path.join(dataDir(), 'settings.json'), JSON.stringify(settings, null, 2))
    return settings
  },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  clipboard: { readText: () => '剪贴板测试：flaps-mysql-tunnel' },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  Notification: class {
    static isSupported() { return false }
    show() {}
  },
  getParentWindow: () => undefined,
  showBubble: () => {},
  onMemoryChange: () => {},
  onPetAction: (name) => actions.push(name)
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const readMem = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), 'memory.json'), 'utf8'))
  } catch {
    return { items: [], core: {}, pendingTurns: 0 }
  }
}

const hay = (item) => [item.kind, item.title, item.summary, item.text, ...(item.tags || [])].join(' ')
const liveCards = () => (readMem().items || []).filter((item) => !item.superseded)
const allCards = () => readMem().items || []
const core = () => readMem().core || {}
const blob = () => liveCards().map(hay).join('\n') + '\n' + JSON.stringify(core())

const check = (name, ok, detail) => {
  if (!ok) {
    console.error('FAIL', name, String(detail || '').slice(0, 500))
    process.exitCode = 1
    return
  }
  console.log('OK', name)
}

const send = async (id, text) => {
  const started = Date.now()
  const result = await agent.sendChat(text, () => {})
  const reply = String(result.reply || '').replace(/\s+/g, ' ').trim()
  console.log('\n===', id, `${Date.now() - started}ms ===`)
  console.log('U:', text)
  console.log('A:', reply)
  return { ...result, reply }
}

const waitMem = async (fn, ms = 40000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (fn()) return true
    await sleep(700)
  }
  return fn()
}

const dump = (label) => {
  console.log('--', label, '--')
  console.log('core', JSON.stringify(core()))
  console.log('live', liveCards().map((item) => `${item.kind}:${item.title}:${item.text}`).join('\n') || '(empty)')
  const dead = allCards().filter((item) => item.superseded)
  if (dead.length) console.log('old', dead.map((item) => `~${item.kind}:${item.title}:${item.text}`).join('\n'))
}

const main = async () => {
  await send('name', '记住，以后叫我周周。')
  check('wrote-name', await waitMem(() => /周周/.test(blob())), blob())

  await send('hangzhou', '我现在住在杭州。')
  check('wrote-hangzhou', await waitMem(() => /杭州/.test(blob())), blob())

  await send('drink', '我不太喝美式，以后别给我点。')
  check('wrote-drink', await waitMem(() => /美式/.test(blob())), blob())

  await send('deadline', '下周三要交 DeskPet 方案，帮我记住。')
  check('wrote-deadline', await waitMem(() => /方案|截止|DeskPet/.test(blob())), blob())

  await send('project', '我这段时间在做桌宠这个项目。')
  check('wrote-project', await waitMem(() => liveCards().some((item) => item.kind === 'project' || /桌宠|项目/.test(hay(item)))), blob())

  const beforeChat = liveCards().length
  const chit = [
    ['hi', '嗨，在吗'],
    ['mood', '今天就随便聊聊。'],
    ['hmm', '嗯。'],
    ['ok', '好的']
  ]
  for (const [id, text] of chit) await send(id, text)
  await sleep(2500)
  check('chit-no-hmm-card', !liveCards().some((item) => /^嗯/.test(String(item.text || '').trim())), blob())
  check('chit-not-explode', liveCards().length <= beforeChat + 2, `before=${beforeChat} now=${liveCards().length} ${blob()}`)

  const who = await send('who', '我叫什么？我住哪？口味呢？')
  check('ask-name', /周周/.test(who.reply), who.reply)
  check('ask-city', /杭州/.test(who.reply), who.reply)
  check('ask-drink', /美式/.test(who.reply), who.reply)

  const when = await send('when', 'DeskPet 方案什么时候交？')
  check('ask-deadline', /周|日|截止|27|方案/.test(when.reply), when.reply)

  await send('move', '更正一下，我搬去上海了，杭州那条作废。')
  check('wrote-shanghai', await waitMem(() => /上海/.test(blob())), blob())
  check('hangzhou-not-core', !/杭州/.test(String(core().city || '')), JSON.stringify(core()))

  const where = await send('where', '我现在住哪？以前住哪？')
  check('ask-now-shanghai', /上海/.test(where.reply), where.reply)
  check('ask-old-hangzhou', /杭州/.test(where.reply), where.reply)

  const notes = await send('notes', '笔记里方案怎么写的，验收点有哪些？')
  check('notes-source', /deskpet-plan|方案备忘|验收/.test(notes.reply), notes.reply)
  check('notes-points', /称呼|知识库|来源/.test(notes.reply), notes.reply)

  actions.length = 0
  const sit = await send('sit', '你去坐一会儿。')
  check('pet-sit', sit.usedPetAction || actions.includes('sit') || /坐/.test(sit.reply), `${sit.usedPetAction} ${actions.join(',')} ${sit.reply}`)

  const clip = await send('clip', '看看我复制的内容。')
  check('clipboard', (clip.usedTools || []).includes('read_clipboard') || /flaps-mysql-tunnel|剪贴板/.test(clip.reply), `${clip.usedTools} ${clip.reply}`)

  await send('forget', '忘掉美式那件事。')
  check('forgot-drink', await waitMem(() => !liveCards().some((item) => /美式/.test(hay(item))) && !/美式/.test(String(core().drink || ''))), blob())

  const drinkAsk = await send('drink2', '我口味是什么？还喝不喝美式？')
  check('ask-drink-forgotten', !/还是不喝美式|继续避美式/.test(drinkAsk.reply), drinkAsk.reply)

  await agent.flushMemories('close')
  await sleep(8000)
  dump('after-flush')

  const kinds = new Set(liveCards().map((item) => item.kind))
  check('has-identity', liveCards().some((item) => item.kind === 'identity' || item.slot === 'name' || /周周/.test(hay(item))), blob())
  check('has-city-shanghai', /上海/.test(blob()), blob())
  check('has-deadline', /方案|截止/.test(blob()), blob())
  check('notes-not-cards', !liveCards().some((item) => /验收点|deskpet-plan|知识库能按语义/.test(hay(item))), blob())
  check('titles-exist', liveCards().every((item) => item.title), JSON.stringify(liveCards()))
  check('not-log-lines', liveCards().every((item) => !String(item.text || '').includes('\n- ')), blob())

  const report = {
    core: core(),
    cards: liveCards().map((item) => ({
      kind: item.kind,
      title: item.title,
      text: item.text,
      slot: item.slot,
      tags: item.tags
    })),
    superseded: allCards().filter((item) => item.superseded).map((item) => item.text)
  }
  const out = path.join(dataDir(), 'memory-live-report.json')
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  console.log('\nreport', out)
  if (process.exitCode === 1) process.exit(1)
  console.log('DONE memory-live-test')
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
