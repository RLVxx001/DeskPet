const fs = require('fs')
const path = require('path')
const { cosine, rrf, chunkDocument, embedTexts } = require('./rag')

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.kimi.com/coding/v1',
  model: 'k3',
  apiKey: '',
  modelPath: '',
  modelName: '',
  knowledgePath: '',
  embeddingBaseUrl: 'https://llm-gt5z3xwlfx0rhwej.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
  embeddingModel: 'qwen3.7-text-embedding',
  embeddingApiKey: ''
}

const EXTRACT_PROMPT = [
  '你在维护桌宠的记忆卡片。对照已有目录，只处理用户亲口说的稳定事实。',
  '一张卡一件事，写现行说法，不要在卡里追加流水账。',
  'kind 只能是 identity身份 / preference偏好 / agreement约定 / project项目 / episode近况。',
  '核心槽 slot：name称呼、city住址、job职业、drink口味、vibe相处。对得上就填 slot，kind 用 identity 或 preference。',
  '填 slot 时 text 要短：称呼只写名字，住址只写城市，不要写成完整句子。',
  'title 由你起，短，像卡名；同类已有卡就 update，不要新建近重复。改口用 update。用户要忘掉用 delete。',
  '不要写入：寒暄、一时情绪、世界知识、这次问的技术问题、工具过程、提醒/闹钟、笔记原文、知识库文件名、验收点。对话里出现「来自某.md」的内容当笔记，不当记忆。',
  '截止日期、答应过的事用 agreement，正在做的事用 project。',
  '普通闲聊不要硬写卡。episode 最多 1 张，概括这几轮在聊什么，带日期。',
  '最多 4 个动作。没有就空数组。',
  '只输出 JSON：{"ops":[{"action":"add或update或delete","id":"已有id可空","kind":"identity或preference或agreement或project或episode","title":"不超过16字","tags":["标签"],"summary":"不超过28字","text":"不超过80字","slot":"name或city或job或drink或vibe或空","due":"截止日期可空"}]}'
].join('')

const COMPACT_PROMPT = [
  '你在整理桌宠的记忆卡片。目标是更少、更准的现行事实，不要编造。',
  '核心槽：name称呼 city住址 job职业 drink口味 vibe相处。填现行值，没有就空字符串。',
  '合并近重复；矛盾留最新；旧说法不要删光，系统会把未再出现的旧卡标作废。',
  '带 humanEdit 的卡是用户刚在面板改过的，不要改回。',
  '约定看截止日期，过期标在 text 里说明，不要因为久未提到就删。情景卡只留最近的。',
  '笔记知识不要写进来。',
  '只输出 JSON：{"core":{"name":"","city":"","job":"","drink":"","vibe":"","extra":[]},"ops":[{"action":"add或update或delete","id":"","kind":"","title":"","tags":[],"summary":"","text":"","slot":"","due":""}]}'
].join('')

const CORE_SLOTS = ['name', 'city', 'job', 'drink', 'vibe']
const CORE_LABELS = {
  name: '称呼',
  city: '住址',
  job: '职业',
  drink: '口味',
  vibe: '相处'
}
const CARD_KINDS = ['identity', 'preference', 'agreement', 'project', 'episode']
const CARD_LABELS = {
  identity: '身份',
  preference: '偏好',
  agreement: '约定',
  project: '项目',
  episode: '近况'
}
const CATALOG_INJECT_LIMIT = 24
const MEMORY_FLUSH_TURNS = 6
const EPISODE_KEEP = 12

const emptyCore = () => ({ name: '', city: '', job: '', drink: '', vibe: '', extra: [] })

const formatCore = (core) => {
  const c = { ...emptyCore(), ...(core || {}) }
  const lines = CORE_SLOTS
    .filter((key) => String(c[key] || '').trim())
    .map((key) => `- ${CORE_LABELS[key]}：${String(c[key]).trim()}`)
  const extra = (Array.isArray(c.extra) ? c.extra : [])
    .map((row) => String(row || '').trim())
    .filter(Boolean)
    .slice(0, 6)
  for (const row of extra) lines.push(`- ${row}`)
  return lines.join('\n')
}

const NOTE_EXTS = new Set(['.md', '.txt', '.markdown', '.json', '.csv'])
const PET_ACTIONS = ['walk', 'stop', 'sit', 'sleep', 'wave', 'nod', 'bow', 'jump', 'clap', 'stretch', 'think', 'dance', 'spin', 'idle']

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'remember',
      description: '记住关于用户或你们相处的一条稳定事实。不要记一时情绪或寒暄。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的短句' },
          kind: { type: 'string', enum: ['identity', 'preference', 'agreement', 'project', 'episode', 'profile', 'note'], description: 'identity身份 preference偏好 agreement约定 project项目 episode近况' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forget',
      description: '按关键词从本地记忆里删掉条目。用户要你忘掉某件事时必须调用；只口头说忘了，记忆不会变。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall',
      description: '从长期记忆里搜索。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'now',
      description: '获取当前本地日期时间。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_notes',
      description: '在知识库里定位笔记，返回带文件名的摘录。摘录可能不完整。要精确编号、原文、验收点时再 read_note。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: '打开知识库一篇笔记的原文。path 用 search_notes 返回的相对路径。涉及具体编号、标记、原文引用时必须调用，不要靠不完整摘录编造。',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'pet_action',
      description: '驱动桌面上 3D 身体做动作：walk, stop, sit, sleep, wave, nod, bow, jump, clap, stretch, think, dance, spin, idle。你描述自己坐下/走动/睡觉/挥手时必须调用，否则身体不会动。口头演完不算。',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string' } },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: '用系统浏览器打开 http/https 链接。必须调用才会打开；只说「已打开」不会真的打开。非 http/https 不要调。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: '写入本地通知。delayMinutes 或 at（如 18:30 / 2026-08-21 18:30）。用户要你到点叫他时必须调用，否则不会响。口头答应不算设好。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          delayMinutes: { type: 'number' },
          at: { type: 'string' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_clipboard',
      description: '读取当前剪贴板文字。这是剪贴板内容的唯一来源。用户让你看复制内容时必须调用；没调用就等于没看见，禁止编造复制了什么。',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索网上公开信息。闲聊不要搜。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }
  }
]

const TOOL_STATUS = {
  remember: '记下了',
  forget: '忘掉了',
  recall: '在想',
  now: '看了眼时间',
  search_notes: '在翻笔记',
  read_note: '在看笔记',
  pet_action: '动了一下',
  open_url: '打开链接',
  set_reminder: '设了提醒',
  read_clipboard: '看了剪贴板',
  web_search: '上网查了查'
}

const claimedToolsWithoutCall = (reply, usedNames, userText = '') => {
  const t = String(reply || '')
  const asked = String(userText || '')
  const used = usedNames instanceof Set ? usedNames : new Set(usedNames || [])
  const missing = []
  const rules = [
    {
      name: 'read_clipboard',
      strong: /你复制的是|剪贴板(里|上).{0,8}是|复制内容是|复制的内容是/,
      weak: /剪贴板|你复制/,
      topic: /剪贴|复制/
    },
    {
      name: 'set_reminder',
      strong: /已经(帮你)?设(好了|了)提醒|设好了提醒|提醒已经设好/,
      weak: /会提醒你|到点(叫|喊|提醒)你|(\d+|半)\s*(分钟|小时)后.{0,10}(喊|叫|提醒)/,
      topic: /提醒|闹钟|到点|分钟后|小时后|叫醒|叫我|喊我/
    },
    {
      name: 'forget',
      strong: /已经(忘了|忘掉|删掉|删了)|忘掉了|不记了|按你说的忘|删掉啦|记忆已经删/,
      weak: /忘了|删掉/,
      topic: /忘|别记|删掉|不要记/
    },
    {
      name: 'pet_action',
      strong: /已经(坐下|坐好|睡着|挥手)|坐好啦|挥啦|我(先)?(坐下|坐一会儿|去睡|睡着|眯一会儿)了/,
      weak: /我(先)?(坐下|坐一会儿|去睡|睡着|眯一会儿|挥手)/,
      topic: /坐下|坐着|走路|走走|挥|睡|跳|转|溜达|舞|鞠躬/
    },
    {
      name: 'open_url',
      strong: /已经(帮你)?打开(了|啦)?(网页|链接|浏览器)|帮你打开了/,
      weak: /打开啦|已经打开/,
      topic: /打开|网页|链接|浏览/
    }
  ]
  for (const rule of rules) {
    if (used.has(rule.name)) continue
    if (rule.strong.test(t) || (rule.weak.test(t) && rule.topic.test(asked))) {
      missing.push(rule.name)
    }
  }
  return missing
}

const inventedTokens = (reply, grounded) => {
  const hay = String(grounded || '')
  const text = String(reply || '')
  const found = text.match(/TOKEN_\d+|UNIQUE_[A-Z0-9_]+|[A-Z]{2,}[A-Z0-9_-]{5,}|#[A-Fa-f0-9]{6}|[A-Z][a-z]+[A-Z][a-zA-Z]+/g) || []
  const missing = [...new Set(found)].filter((tok) => !hay.includes(tok))
  for (const m of text.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    const label = `${m[1]}月${m[2]}日`
    const iso = `${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
    if (hay.includes(label) || hay.includes(`${m[1]}月${m[2]}`) || hay.includes(iso)) continue
    missing.push(label)
  }
  for (const m of text.matchAll(/20\d{2}-\d{2}-\d{2}/g)) {
    if (!hay.includes(m[0])) missing.push(m[0])
  }
  return missing
}

const toCompletionsUrl = (baseUrl) => {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (!base) base = DEFAULT_SETTINGS.baseUrl
  if (/\/chat\/completions$/i.test(base)) return base
  if (/\/v1\/messages$/i.test(base)) return base.replace(/\/v1\/messages$/i, '/v1/chat/completions')
  if (/^https?:\/\/api\.kimi\.com\/coding$/i.test(base)) {
    return 'https://api.kimi.com/coding/v1/chat/completions'
  }
  if (/^https?:\/\/api\.moonshot\.(cn|ai)$/i.test(base)) return `${base}/v1/chat/completions`
  if (/kimi\.com|moonshot\./i.test(base) && !/\/v1$/i.test(base) && !/\/coding\/v1/i.test(base)) {
    return `${base}/v1/chat/completions`
  }
  return `${base}/chat/completions`
}

const normalizeBaseUrl = (baseUrl) => toCompletionsUrl(baseUrl).replace(/\/chat\/completions$/i, '')

const normalizeModel = (baseUrl, model) => {
  const m = String(model || '').trim()
  const coding = /api\.kimi\.com\/coding/i.test(String(baseUrl || ''))
  const moonshot = /moonshot\.(cn|ai)/i.test(String(baseUrl || ''))
  if (coding) {
    if (!m || /^kimi-k3$/i.test(m)) return 'k3'
    return m
  }
  if (moonshot) {
    if (!m || m === 'k3') return 'kimi-k3'
    return m
  }
  return m || DEFAULT_SETTINGS.model
}

const requestExtras = (model) => {
  if (/^k3/i.test(model) || /^kimi-k3/i.test(model)) return { temperature: 1, reasoning_effort: 'low' }
  if (/kimi-k2\.(5|6)/.test(model)) return { thinking: { type: 'disabled' } }
  return {}
}

const pickReplyText = (data) => {
  const msg = data?.choices?.[0]?.message || {}
  const content = msg.content
  if (typeof content === 'string' && content.trim()) return content.trim()
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || part?.content || '').join('').trim()
  }
  return String(msg.reasoning_content || '').trim()
}

const friendlyError = (status, body) => {
  let msg = String(body || '')
  try {
    const parsed = JSON.parse(body)
    msg = parsed.error?.message || parsed.message || msg
  } catch {}
  if (status === 404 || /not found/i.test(msg)) {
    return '接口路径不对。Kimi Code 请填 https://api.kimi.com/coding/v1 ，模型用 k3'
  }
  if (/temporarily unavailable|upstream/i.test(msg)) return 'Kimi 上游暂时不可用，过几秒再试'
  if (/coding agents|access_terminated/i.test(msg)) {
    return 'Kimi Code 接口有时只认编程工具。可改用开放平台 https://api.moonshot.cn/v1 ，模型 kimi-k3'
  }
  return msg.slice(0, 160)
}

const nid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6)

const readJson = (file, fallback) => {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(fallback)) return Array.isArray(data) ? data : fallback
    return { ...fallback, ...data }
  } catch {
    return Array.isArray(fallback) ? [...fallback] : { ...fallback }
  }
}

const tokens = (text) => {
  const t = String(text || '').toLowerCase()
  const out = new Set()
  for (const w of t.match(/[a-z0-9_]+/g) || []) out.add(w)
  const cjk = t.replace(/[^\u4e00-\u9fff]/g, '')
  for (let i = 0; i < cjk.length; i++) {
    out.add(cjk[i])
    if (i + 1 < cjk.length) out.add(cjk.slice(i, i + 2))
  }
  return [...out]
}

const scoreText = (hay, query) => {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return 0
  const h = String(hay || '').toLowerCase()
  let s = h.includes(q) ? 8 : 0
  const ht = new Set(tokens(h))
  for (const t of tokens(q)) {
    if (ht.has(t)) s += t.length > 1 ? 2 : 1
  }
  return s
}

const formatNow = () => {
  const d = new Date()
  const week = '日一二三四五六'[d.getDay()]
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const parseWhen = (args) => {
  if (Number.isFinite(Number(args.delayMinutes))) {
    return Date.now() + Math.max(0.2, Number(args.delayMinutes)) * 60 * 1000
  }
  const raw = String(args.at || '').trim()
  if (!raw) return Date.now() + 5 * 60 * 1000
  const normalized = raw.replace(/[年/.]/g, '-').replace(/[时分]/g, ':').replace(/日/g, ' ').replace(/秒/g, '')
  const m = normalized.match(/^(?:(\d{4}-\d{1,2}-\d{1,2})\s+)?(\d{1,2}):(\d{2})$/)
  if (!m) {
    const t = Date.parse(raw)
    return Number.isFinite(t) ? t : Date.now() + 5 * 60 * 1000
  }
  const now = new Date()
  const day = m[1] ? new Date(m[1] + 'T00:00:00') : now
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[2]), Number(m[3]), 0, 0)
  if (!m[1] && at.getTime() < Date.now() - 30 * 1000) at.setDate(at.getDate() + 1)
  return at.getTime()
}

const recencyWeight = (ts, halfLifeDays) => {
  const age = Math.max(0, (Date.now() - Number(ts || Date.now())) / 86400000)
  return Math.pow(0.5, age / Math.max(1, halfLifeDays))
}

const wantsHistory = (query) => /以前|之前|当时|原来|曾经|上次|昨天/.test(String(query || ''))

const needsImmediateMemory = (text) => {
  const t = String(text || '').trim()
  if (!t || t.length < 2) return false
  if (/^(你好|嗨|在吗|谢谢|嗯+|好的|哦+|👋)$/i.test(t)) return false
  return /记住|忘掉|忘记|别记|不要记|叫我|我叫(?!什么)|我姓|我.{0,6}住(?!哪)|搬(去|到)|截止日期|截止|下周三?要|以后都|以后别|不(太)?喝|约定|答应过/.test(t)
}

const normalizeCardKind = (kind, slot) => {
  if (CORE_SLOTS.includes(slot)) {
    return slot === 'drink' || slot === 'vibe' ? 'preference' : 'identity'
  }
  if (CARD_KINDS.includes(kind)) return kind
  if (kind === 'profile') return 'identity'
  if (kind === 'note') return 'agreement'
  return 'agreement'
}

const inferCardTitle = (text, kind, slot) => {
  if (slot && CORE_LABELS[slot]) return CORE_LABELS[slot]
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return CARD_LABELS[kind] || '记忆'
  return raw.slice(0, 16)
}

const migrateMemoryItem = (item) => {
  const row = { ...(item || {}) }
  const slot = CORE_SLOTS.includes(row.slot) ? row.slot : ''
  const kind = normalizeCardKind(row.kind, slot)
  const text = String(row.text || '').trim()
  const title = String(row.title || '').trim() || inferCardTitle(text, kind, slot)
  const summary = String(row.summary || '').trim() || text.slice(0, 28)
  const tags = Array.isArray(row.tags) ? row.tags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 4) : []
  if (slot && !tags.includes(CORE_LABELS[slot])) tags.unshift(CORE_LABELS[slot])
  return {
    ...row,
    kind,
    slot,
    title: title.slice(0, 16),
    summary: summary.slice(0, 40),
    text: text.slice(0, 240),
    tags
  }
}

const cardSearchText = (item) => [
  item.title,
  item.summary,
  item.text,
  ...(Array.isArray(item.tags) ? item.tags : []),
  CARD_LABELS[item.kind] || '',
  CORE_LABELS[item.slot] || ''
].filter(Boolean).join(' ')

const formatCardLine = (item) => {
  const label = CARD_LABELS[item.kind] || '记忆'
  const title = String(item.title || '').trim() || inferCardTitle(item.text, item.kind, item.slot)
  const body = String(item.summary || item.text || '').replace(/\s+/g, ' ').trim()
  return `- [${label}] ${title}：${body}`
}

const cardRecencyMultiplier = (item, query, now = Date.now()) => {
  const kind = normalizeCardKind(item.kind, item.slot)
  if (wantsHistory(query)) return 1
  if (kind === 'identity' || kind === 'preference') return 1
  if (kind === 'agreement') {
    const due = Number(item.dueAt || 0)
    if (due && due < now) return 1.08
    return 1
  }
  if (kind === 'project') return 0.75 + 0.25 * recencyWeight(item.ts, 90)
  if (kind === 'episode') return recencyWeight(item.ts, 10)
  return 1
}

const memoryRankScore = (item, query, semantic, now = Date.now()) => {
  const lexical = scoreText(cardSearchText(item), query) / 12
  const base = Math.max(lexical, Number(semantic) || 0)
  const recency = cardRecencyMultiplier(item, query, now)
  const importance = item.kind === 'identity' || item.slot ? 1.2 : item.kind === 'agreement' ? 1.15 : 1
  const live = item.superseded && !wantsHistory(query) ? 0.12 : 1
  return base * recency * importance * live
}

const createAgent = (ctx) => {
  const chatPath = () => path.join(ctx.dataDir(), 'chat.json')
  const memoryPath = () => path.join(ctx.dataDir(), 'memory.json')
  const reminderPath = () => path.join(ctx.dataDir(), 'reminders.json')
  const reminderTimers = new Map()

  const loadChat = () => {
    const data = readJson(chatPath(), { messages: [] })
    return Array.isArray(data.messages) ? data.messages : []
  }

  const saveChat = (messages) => {
    ctx.ensureDataDir()
    fs.writeFileSync(chatPath(), JSON.stringify({ messages }, null, 2))
  }

  const loadMemory = () => {
    const data = readJson(memoryPath(), { items: [], core: emptyCore() })
    return {
      items: (Array.isArray(data.items) ? data.items : []).map(migrateMemoryItem),
      core: { ...emptyCore(), ...(data.core && typeof data.core === 'object' ? data.core : {}) },
      lastHumanEdit: Number(data.lastHumanEdit || 0),
      lastCompact: Number(data.lastCompact || 0),
      pendingTurns: Number(data.pendingTurns || 0)
    }
  }

  const saveMemory = (memory) => {
    ctx.ensureDataDir()
    fs.writeFileSync(memoryPath(), JSON.stringify({
      core: { ...emptyCore(), ...(memory.core || {}) },
      items: Array.isArray(memory.items) ? memory.items : [],
      lastHumanEdit: Number(memory.lastHumanEdit || 0),
      lastCompact: Number(memory.lastCompact || 0),
      pendingTurns: Number(memory.pendingTurns || 0)
    }, null, 2))
  }

  const getMemory = () => {
    const memory = loadMemory()
    const items = memory.items
      .slice()
      .sort((a, b) => Number(a.superseded || 0) - Number(b.superseded || 0) || (b.ts || 0) - (a.ts || 0))
      .map(({ embedding, ...item }) => item)
    return {
      core: memory.core,
      items,
      slots: CORE_SLOTS.map((key) => ({
        key,
        label: CORE_LABELS[key],
        value: String(memory.core[key] || '')
      }))
    }
  }

  const pruneCards = (items) => {
    const now = Date.now()
    const next = items.map(migrateMemoryItem)
    const liveEpisodes = next
      .filter((row) => row.kind === 'episode' && !row.superseded)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    liveEpisodes.slice(EPISODE_KEEP).forEach((row) => {
      row.superseded = true
      row.supersededAt = now
    })
    const keep = next.filter((row) => row.kind === 'identity' || row.kind === 'preference' || row.slot)
    const rest = next.filter((row) => !keep.includes(row))
    const live = rest.filter((row) => !row.superseded)
    const dead = rest
      .filter((row) => row.superseded)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 40)
    if (live.length <= 80) return [...keep, ...live, ...dead]
    const keptLive = live
      .slice()
      .sort((a, b) => {
        const sa = (a.humanEdit ? 2 : 0) + (a.kind === 'agreement' ? 1 : 0) + recencyWeight(a.ts, 60)
        const sb = (b.humanEdit ? 2 : 0) + (b.kind === 'agreement' ? 1 : 0) + recencyWeight(b.ts, 60)
        return sa - sb
      })
      .slice(-80)
    return [...keep, ...keptLive, ...dead]
  }

  const setCoreSlot = (memory, slot, text) => {
    if (!CORE_SLOTS.includes(slot)) return
    memory.core = { ...emptyCore(), ...(memory.core || {}) }
    memory.core[slot] = String(text || '').trim().slice(0, 40)
  }

  const clearCoreIfMatch = (memory, query) => {
    memory.core = { ...emptyCore(), ...(memory.core || {}) }
    for (const slot of CORE_SLOTS) {
      const cur = String(memory.core[slot] || '')
      if (cur && scoreText(cur, query) > 0) memory.core[slot] = ''
    }
  }

  const addMemory = async (text, kind, opts = {}) => {
    const memory = loadMemory()
    const next = String(text || '').trim()
    if (!next) return '没有可记的内容'
    const slot = CORE_SLOTS.includes(opts.slot) ? opts.slot : ''
    if (memory.items.some((item) => item.text === next && !item.superseded)) {
      if (slot) {
        setCoreSlot(memory, slot, next)
        saveMemory(memory)
      }
      return '这条已经记过了'
    }
    const cardKind = normalizeCardKind(kind, slot)
    const item = migrateMemoryItem({
      id: nid(),
      kind: cardKind,
      text: next.slice(0, 240),
      title: String(opts.title || '').trim() || inferCardTitle(next, cardKind, slot),
      summary: String(opts.summary || '').trim() || next.slice(0, 28),
      tags: opts.tags,
      ts: Date.now(),
      superseded: false,
      slot,
      humanEdit: Boolean(opts.human),
      dueAt: Number(opts.dueAt || 0) || undefined
    })
    try {
      const [vec] = await embedTexts(ctx.loadSettings(), [cardSearchText(item)])
      item.embedding = vec
    } catch {}
    for (const old of memory.items) {
      if (old.superseded || old.id === item.id) continue
      if (slot && old.slot === slot) {
        old.superseded = true
        old.supersededAt = Date.now()
        old.supersededBy = item.id
        continue
      }
      if (old.kind !== item.kind) continue
      const lex = scoreText(old.text, next)
      let sem = 0
      if (old.embedding && item.embedding) sem = cosine(old.embedding, item.embedding)
      if (sem >= 0.82 || lex >= 12) {
        old.superseded = true
        old.supersededAt = Date.now()
        old.supersededBy = item.id
      }
    }
    memory.items.push(item)
    if (slot) setCoreSlot(memory, slot, item.text)
    if (opts.human) memory.lastHumanEdit = Date.now()
    saveMemory({ ...memory, items: pruneCards(memory.items) })
    ctx.onMemoryChange?.()
    return '已记住：' + next.slice(0, 80)
  }

  const updateMemory = async (id, text, opts = {}) => {
    const memory = loadMemory()
    const item = memory.items.find((row) => row.id === id)
    if (!item) return getMemory()
    const next = String(text || '').trim().slice(0, 240)
    if (!next) return getMemory()
    item.text = next
    item.summary = String(opts.summary || next).trim().slice(0, 40)
    if (opts.title) item.title = String(opts.title).trim().slice(0, 16)
    else if (!item.title) item.title = inferCardTitle(next, item.kind, item.slot)
    if (Array.isArray(opts.tags)) item.tags = opts.tags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 4)
    if (Number(opts.dueAt)) item.dueAt = Number(opts.dueAt)
    if (opts.kind) item.kind = normalizeCardKind(opts.kind, item.slot)
    item.ts = Date.now()
    item.superseded = false
    if (CORE_SLOTS.includes(opts.slot)) item.slot = opts.slot
    if (opts.human) {
      item.humanEdit = true
      memory.lastHumanEdit = Date.now()
    }
    try {
      const [vec] = await embedTexts(ctx.loadSettings(), [cardSearchText(item)])
      item.embedding = vec
    } catch {}
    if (item.slot) setCoreSlot(memory, item.slot, next)
    saveMemory(memory)
    ctx.onMemoryChange?.()
    return getMemory()
  }

  const removeMemory = (id) => {
    const memory = loadMemory()
    const gone = memory.items.find((item) => item.id === id)
    memory.items = memory.items.filter((item) => item.id !== id)
    if (gone?.slot && String(memory.core[gone.slot] || '') === String(gone.text || '')) {
      setCoreSlot(memory, gone.slot, '')
    }
    saveMemory(memory)
    ctx.onMemoryChange?.()
    return getMemory()
  }

  const forgetMemory = (query) => {
    const memory = loadMemory()
    const hit = memory.items.filter((item) => scoreText(item.text, query) > 0)
    if (!hit.length) {
      const before = formatCore(memory.core)
      clearCoreIfMatch(memory, query)
      if (formatCore(memory.core) === before) return '记忆里没有和这个相关的'
      saveMemory(memory)
      ctx.onMemoryChange?.()
      return '已忘掉相关核心印象'
    }
    const ids = new Set(hit.map((item) => item.id))
    memory.items = memory.items.filter((item) => !ids.has(item.id))
    clearCoreIfMatch(memory, query)
    saveMemory(memory)
    ctx.onMemoryChange?.()
    return '已忘掉：' + hit.map((item) => item.text).join('；')
  }

  const updateCore = async (slot, text) => {
    if (!CORE_SLOTS.includes(slot)) return getMemory()
    const next = String(text || '').trim().slice(0, 40)
    const memory = loadMemory()
    setCoreSlot(memory, slot, next)
    memory.lastHumanEdit = Date.now()
    const live = memory.items.find((item) => item.slot === slot && !item.superseded)
    saveMemory(memory)
    if (live) {
      if (next) await updateMemory(live.id, next, { slot, human: true })
      else removeMemory(live.id)
    } else if (next) {
      await addMemory(next, 'profile', { slot, human: true })
    }
    return getMemory()
  }

  const knowledgeDir = () => {
    const settings = ctx.loadSettings()
    if (settings.knowledgePath && fs.existsSync(settings.knowledgePath)) return settings.knowledgePath
    const dir = path.join(ctx.dataDir(), 'knowledge')
    fs.mkdirSync(dir, { recursive: true })
    const guide = path.join(dir, '使用说明.txt')
    if (!fs.existsSync(guide)) {
      fs.writeFileSync(
        guide,
        '把备忘、项目说明、会议纪要放到这个文件夹。\n支持 .md .txt .markdown .json .csv\n聊天时直接问我就行，我会自己翻。\n'
      )
    }
    return dir
  }

  const listNoteFiles = (dir = knowledgeDir(), prefix = '', out = []) => {
    if (out.length >= 500) return out
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    for (const entry of entries) {
      if (out.length >= 500) break
      if (entry.name.startsWith('.')) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) listNoteFiles(full, rel, out)
      else if (NOTE_EXTS.has(path.extname(entry.name).toLowerCase())) out.push({ rel, full })
    }
    return out
  }

  const knowledgeInfo = () => ({
    path: knowledgeDir(),
    files: listNoteFiles().map((file) => file.rel)
  })

  const indexPath = () => path.join(ctx.dataDir(), 'knowledge-index.json')
  const loadIndex = () => {
    try {
      return JSON.parse(fs.readFileSync(indexPath(), 'utf8'))
    } catch {
      return { files: {}, model: '' }
    }
  }
  const saveIndex = (index) => {
    ctx.ensureDataDir()
    fs.writeFileSync(indexPath(), JSON.stringify(index))
  }

  let indexJob = null
  const rebuildIndex = async () => {
    const settings = ctx.loadSettings()
    if (!settings.embeddingApiKey) return loadIndex()
    const files = listNoteFiles()
    const index = loadIndex()
    if (index.model && index.model !== settings.embeddingModel) index.files = {}
    if (index.version !== 2) {
      index.files = {}
      index.version = 2
    }
    index.model = settings.embeddingModel || 'qwen3.7-text-embedding'
    index.files = index.files || {}
    const keep = new Set(files.map((file) => file.rel))
    for (const rel of Object.keys(index.files)) {
      if (!keep.has(rel)) delete index.files[rel]
    }
    for (const file of files) {
      let st
      try {
        st = fs.statSync(file.full)
      } catch {
        continue
      }
      const prev = index.files[file.rel]
      if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && Array.isArray(prev.chunks)) continue
      let body = ''
      try {
        body = fs.readFileSync(file.full, 'utf8')
      } catch {
        continue
      }
      const pieces = chunkDocument(body, file.rel)
      if (!pieces.length) {
        index.files[file.rel] = { mtimeMs: st.mtimeMs, size: st.size, chunks: [] }
        continue
      }
      try {
        const vectors = await embedTexts(settings, pieces.map((chunk) => chunk.embedText))
        index.files[file.rel] = {
          mtimeMs: st.mtimeMs,
          size: st.size,
          chunks: pieces.map((chunk, i) => ({
            id: chunk.id,
            rel: chunk.rel,
            child: chunk.child,
            parent: chunk.parent,
            heading: chunk.heading,
            cite: chunk.cite,
            embedText: chunk.embedText,
            embedding: vectors[i]
          }))
        }
      } catch (error) {
        console.error('[knowledge-index]', file.rel, error.message)
      }
    }
    saveIndex(index)
    return index
  }

  const ensureIndex = async () => {
    if (!indexJob) indexJob = rebuildIndex().finally(() => { indexJob = null })
    return indexJob
  }

  const flattenChunks = (index) => {
    const out = []
    for (const file of Object.values(index.files || {})) {
      for (const chunk of file.chunks || []) out.push(chunk)
    }
    return out
  }

  const rewriteQuery = async (text) => {
    const q = String(text || '').trim()
    if (!q || q.length < 4 || /^(你好|嗨|在吗|谢谢|嗯+|好的|哦+)$/.test(q)) return q
    if (!/那个|这[个件]|上次|刚才|上面|这事|之前那|它/.test(q)) return q
    const settings = ctx.loadSettings()
    if (!settings.apiKey) return q
    try {
      const baseUrl = normalizeBaseUrl(settings.baseUrl)
      const model = normalizeModel(baseUrl, settings.model)
      const result = await completeOnce({
        url: toCompletionsUrl(baseUrl),
        apiKey: settings.apiKey,
        payload: {
          model,
          temperature: 1,
          max_tokens: 80,
          stream: false,
          messages: [
            { role: 'system', content: '把用户的话改写成适合检索个人笔记和记忆的独立中文问句。已经独立就原样输出。不要解释，只输出问句。' },
            { role: 'user', content: q }
          ],
          ...requestExtras(model)
        }
      })
      const next = String(result.content || '').trim().split('\n')[0]
      return next || q
    } catch {
      return q
    }
  }

  const chunkBody = (chunk) => chunk.child || chunk.text || ''
  const chunkParent = (chunk) => chunk.parent || chunk.child || chunk.text || ''

  const searchKnowledge = async (query, limit = 5) => {
    const raw = String(query || '').trim()
    if (!raw) return []
    const q = await rewriteQuery(raw)
    await ensureIndex()
    const chunks = flattenChunks(loadIndex())
    if (!chunks.length) return []
    const keywordRank = chunks
      .map((chunk) => ({
        chunk,
        s: scoreText(chunk.rel, q) * 2 + scoreText(chunk.embedText || chunkBody(chunk), q)
      }))
      .filter((row) => row.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
    let vectorRank = []
    try {
      const settings = ctx.loadSettings()
      if (settings.embeddingApiKey) {
        const [qv] = await embedTexts(settings, [q])
        vectorRank = chunks
          .map((chunk) => ({ chunk, s: cosine(qv, chunk.embedding) }))
          .filter((row) => row.s > 0.22)
          .sort((a, b) => b.s - a.s)
          .slice(0, 20)
      }
    } catch {}
    const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]))
    const fused = rrf([
      vectorRank.map((row) => row.chunk.id),
      keywordRank.map((row) => row.chunk.id)
    ])
    const picked = []
    const seen = new Set()
    for (const row of fused) {
      const chunk = byId.get(row.id)
      if (!chunk) continue
      const key = (chunk.rel || '') + ':' + chunkBody(chunk).slice(0, 48)
      if (seen.has(key)) continue
      seen.add(key)
      picked.push(chunk)
      if (picked.length >= limit) break
    }
    if (!picked.length) return keywordRank.slice(0, limit).map((row) => row.chunk)
    return picked
  }

  const formatNoteHits = (hits) => {
    if (!hits.length) return ''
    return hits
      .map((hit) => {
        const body = String(chunkParent(hit) || '').replace(/\s+/g, ' ').trim().slice(0, 420)
        return `来源：${hit.cite || hit.rel}\n${body}`
      })
      .join('\n\n')
  }

  const safeNotePath = (rel) => {
    const root = fs.realpathSync(knowledgeDir())
    const resolved = fs.realpathSync(path.resolve(root, String(rel || '')))
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error('只能读知识库里的文件')
    }
    if (!NOTE_EXTS.has(path.extname(resolved).toLowerCase())) {
      throw new Error('这种文件我不读')
    }
    return resolved
  }

  const searchNotes = async (query) => {
    const hits = await searchKnowledge(query, 5)
    if (!hits.length) {
      const empty = listNoteFiles().length === 0
      return empty ? '知识库还是空的，把笔记丢进文件夹就行。' : '没搜到相关笔记。'
    }
    return formatNoteHits(hits)
  }

  const readNote = (rel) => {
    const full = safeNotePath(rel)
    const text = fs.readFileSync(full, 'utf8').trim()
    if (!text) return '这篇是空的'
    return `来源：${path.basename(full)}\n${text.slice(0, 6000)}`
  }

  const recallHybrid = async (query, limit = 6) => {
    const items = loadMemory().items
    if (!items.length) return []
    const q = await rewriteQuery(query)
    const history = wantsHistory(q)
    const pool = history ? items : items.filter((item) => !item.superseded)
    const scoped = pool.length ? pool : items
    let semantic = new Map()
    try {
      const withVec = scoped.filter((item) => Array.isArray(item.embedding) && item.embedding.length)
      if (withVec.length && ctx.loadSettings().embeddingApiKey) {
        const [qv] = await embedTexts(ctx.loadSettings(), [q])
        for (const item of withVec) semantic.set(item.id, cosine(qv, item.embedding))
      }
    } catch {}
    return scoped
      .map((item) => ({ item, s: memoryRankScore(item, q, semantic.get(item.id) || 0) }))
      .filter((row) => row.s > 0.08)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((row) => row.item)
  }

  const recallMemory = async (query) => {
    const ranked = await recallHybrid(query, 6)
    if (!ranked.length) return '没有搜到相关记忆'
    return ranked.map((item) => `${formatCardLine(item)}${item.superseded ? '（已被更新）' : ''}`).join('\n')
  }

  const loadReminders = () => {
    const data = readJson(reminderPath(), { items: [] })
    return Array.isArray(data.items) ? data.items : []
  }

  const saveReminders = (items) => {
    ctx.ensureDataDir()
    fs.writeFileSync(reminderPath(), JSON.stringify({ items }, null, 2))
  }

  const fireReminder = (item) => {
    reminderTimers.delete(item.id)
    const left = loadReminders().filter((row) => row.id !== item.id)
    saveReminders(left)
    try {
      if (ctx.Notification?.isSupported?.()) {
        new ctx.Notification({ title: '桌宠', body: item.text }).show()
      }
    } catch {}
    ctx.showBubble(String(item.text || '').slice(0, 18) || '到点了')
    ctx.onPetAction('wave')
  }

  const scheduleReminder = (item) => {
    if (reminderTimers.has(item.id)) {
      clearTimeout(reminderTimers.get(item.id))
      reminderTimers.delete(item.id)
    }
    const delay = item.at - Date.now()
    if (delay <= 0) {
      fireReminder(item)
      return
    }
    const timer = setTimeout(() => fireReminder(item), Math.min(delay, 2147483647))
    if (typeof timer.unref === 'function') timer.unref()
    reminderTimers.set(item.id, timer)
  }

  const restoreReminders = () => {
    const items = loadReminders().filter((item) => item.at && item.text)
    saveReminders(items)
    for (const item of items) scheduleReminder(item)
  }

  const addReminder = (args) => {
    const text = String(args.text || '').trim()
    if (!text) return '提醒内容是空的'
    const at = parseWhen(args)
    const item = { id: nid(), text: text.slice(0, 120), at }
    const items = loadReminders().concat(item).slice(-40)
    saveReminders(items)
    scheduleReminder(item)
    const when = new Date(at)
    const pad = (n) => String(n).padStart(2, '0')
    return `好，${when.getMonth() + 1}月${when.getDate()}日 ${pad(when.getHours())}:${pad(when.getMinutes())} 叫你：${text}`
  }

  const pickKnowledgeDir = async () => {
    const result = await ctx.dialog.showOpenDialog(ctx.getParentWindow?.() || undefined, {
      title: '选择知识库文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return knowledgeInfo()
    ctx.saveSettings({ ...ctx.loadSettings(), knowledgePath: result.filePaths[0] })
    return knowledgeInfo()
  }

  const openKnowledgeDir = async () => {
    const dir = knowledgeDir()
    await ctx.shell.openPath(dir)
    return knowledgeInfo()
  }

  const buildSystemPrompt = async (userText, notes) => {
    const memory = loadMemory()
    const coreText = formatCore(memory.core)
    const live = memory.items.filter((item) => !item.superseded)
    const noteCount = listNoteFiles().length
    const hits = Array.isArray(notes) ? notes : []
    const lines = [
      '你是用户桌面上的一只 3D 桌宠。你们永远只有这一段关系，不要当成客服或通用助手。',
      '说话短，像人，一次一两句。不要列功能清单，不要解释你有哪些能力。',
      '没有工具返回就等于没做、没看见：身体动作必须 pet_action，剪贴板必须 read_clipboard，提醒必须 set_reminder，忘掉必须 forget，打开链接必须 open_url。不要假装已经完成。用户让你动身体时，无论回话多短，都要调用 pet_action。',
      '知识库已索引，需要内容时 search_notes 定位；摘录可能不完整。涉及编号、标记、原文时再 read_note。摘录和原文都没有的值禁止编造。多条笔记冲突时只根据更贴这次提问的那条说。',
      '用了笔记时用人话提一下来源文件名。用了工具后直接对人说话，不要说调用了什么。闲聊不要硬用工具。',
      `现在是 ${formatNow()}。知识库里大约有 ${noteCount} 篇笔记。`
    ]
    if (coreText) lines.push('长期印象：\n' + coreText)
    if (live.length && live.length <= CATALOG_INJECT_LIMIT) {
      lines.push('记忆卡片：\n' + live.map(formatCardLine).join('\n'))
    } else if (live.length) {
      const identity = live.filter((item) => item.kind === 'identity' || item.slot)
      if (identity.length) lines.push('身份卡片：\n' + identity.map(formatCardLine).join('\n'))
      const related = await recallHybrid(userText, 4)
      const seen = new Set(identity.map((item) => item.id))
      const extra = related.filter((item) => !seen.has(item.id))
      if (wantsHistory(userText)) {
        const episode = live
          .filter((item) => item.kind === 'episode' && !seen.has(item.id))
          .sort((a, b) => (b.ts || 0) - (a.ts || 0))[0]
        if (episode && !extra.some((item) => item.id === episode.id)) extra.push(episode)
      }
      if (extra.length) lines.push('可能相关的记忆：\n' + extra.map(formatCardLine).join('\n'))
    }
    if (hits.length) lines.push('可能相关的笔记摘录（可能不完整）：\n' + formatNoteHits(hits))
    return lines.join('\n\n')
  }

  const localReply = (text) => {
    const t = text.trim()
    if (/走|散步|逛/.test(t)) {
      ctx.onPetAction('walk')
      return '那我去旁边转转。'
    }
    if (/停|别走|回来/.test(t)) {
      ctx.onPetAction('stop')
      return '好，我就在这儿。'
    }
    if (/坐下|坐着/.test(t)) {
      ctx.onPetAction('sit')
      return '那我坐一会儿。'
    }
    if (/睡|困/.test(t)) {
      ctx.onPetAction('sleep')
      return '那我眯一会儿。'
    }
    if (/你好|嗨|在吗|hi|hello/i.test(t)) return '在。我一直都在桌角。'
    if (/名字|叫什么/.test(t)) return '还没正式名字。你想叫我什么都行。'
    if (/好看|可爱|喜欢/.test(t)) return '那我再站近一点好了。'
    if (/设置|api|模型/i.test(t)) return '菜单栏图标右键可以填 API，填了我就真能聊。'
    if (/笔记|知识库/.test(t)) return '设置里可以打开知识库文件夹。把东西丢进去，填了 Key 我就能翻。'
    const fallbacks = ['嗯。', '我听着呢。', '然后呢？', '好，我记下了。', '……我还在。']
    return fallbacks[Math.floor(Math.random() * fallbacks.length)]
  }

  const executeTool = async (name, args) => {
    try {
      if (name === 'remember') return addMemory(args.text, args.kind)
      if (name === 'forget') return forgetMemory(args.query)
      if (name === 'recall') return await recallMemory(args.query)
      if (name === 'now') return formatNow()
      if (name === 'search_notes') return searchNotes(args.query)
      if (name === 'read_note') return readNote(args.path)
      if (name === 'pet_action') {
        const action = String(args.action || '').trim().toLowerCase()
        if (!PET_ACTIONS.includes(action)) return '这个动作我不会'
        ctx.onPetAction(action)
        if (action === 'sleep') compactMemories('sleep').catch((error) => console.error('[memory-compact]', error.message))
        return action === 'walk' ? '开始散步' : action === 'stop' ? '停下了' : `做了 ${action}`
      }
      if (name === 'open_url') {
        const url = String(args.url || '').trim()
        if (!/^https?:\/\//i.test(url)) return '只能打开 http/https 链接'
        await ctx.shell.openExternal(url)
        return '已经打开：' + url
      }
      if (name === 'set_reminder') return addReminder(args)
      if (name === 'read_clipboard') {
        const text = String(ctx.clipboard.readText() || '').trim()
        if (!text) return '剪贴板是空的'
        return text.slice(0, 4000)
      }
      if (name === 'web_search') return await webSearch(String(args.query || '').trim())
      return '我不会这个'
    } catch (error) {
      return '没做成：' + String(error.message || error).slice(0, 160)
    }
  }

  const parseJsonObject = (raw) => {
    const text = String(raw || '').trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return {}
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return {}
    }
  }

  const dedupeSlotItems = (memory) => {
    for (const slot of CORE_SLOTS) {
      const lives = memory.items.filter((item) => item.slot === slot && !item.superseded)
      if (lives.length <= 1) continue
      lives.sort((a, b) => (b.ts || 0) - (a.ts || 0))
      const keep = lives[0]
      for (const extra of lives.slice(1)) {
        extra.superseded = true
        extra.supersededAt = Date.now()
        extra.supersededBy = keep.id
      }
    }
  }

  const applyMemoryOps = async (ops) => {
    const list = Array.isArray(ops) ? ops : []
    for (const op of list.slice(0, 6)) {
      const action = String(op.action || '').toLowerCase()
      const text = String(op.text || op.summary || '').trim()
      const slot = CORE_SLOTS.includes(op.slot) ? op.slot : ''
      const kind = normalizeCardKind(op.kind, slot)
      const id = String(op.id || '')
      const tags = Array.isArray(op.tags) ? op.tags : []
      const title = String(op.title || '').trim()
      const summary = String(op.summary || '').trim()
      const dueAt = Date.parse(String(op.due || ''))
      const opts = {
        slot,
        title,
        summary,
        tags,
        dueAt: Number.isFinite(dueAt) ? dueAt : 0
      }
      if (action === 'delete') {
        if (id) removeMemory(id)
        else if (text) forgetMemory(text)
        else if (slot) await updateCore(slot, '')
        continue
      }
      if (action !== 'add' && action !== 'update') continue
      if (!text) continue
      if (action === 'update' && id && loadMemory().items.some((item) => item.id === id)) {
        await updateMemory(id, text, opts)
        if (slot) {
          const memory = loadMemory()
          setCoreSlot(memory, slot, text)
          saveMemory(memory)
          ctx.onMemoryChange?.()
        }
        continue
      }
      await addMemory(text, kind, opts)
    }
    const memory = loadMemory()
    dedupeSlotItems(memory)
    if (!formatCore(memory.core)) {
      const liveProf = memory.items.filter((item) => (item.kind === 'identity' || item.slot) && !item.superseded)
      if (liveProf.length) memory.core.extra = liveProf.slice(0, 4).map((item) => item.summary || item.text).filter(Boolean)
    }
    saveMemory({ ...memory, items: pruneCards(memory.items) })
    ctx.onMemoryChange?.()
  }

  const compactMemories = async (reason = 'auto') => {
    const settings = ctx.loadSettings()
    if (!settings.apiKey) return getMemory()
    const memory = loadMemory()
    const live = memory.items.filter((item) => !item.superseded)
    if (reason !== 'manual' && live.length < 4) return getMemory()
    if (reason !== 'manual' && Date.now() - Number(memory.lastCompact || 0) < 45000) return getMemory()
    const baseUrl = normalizeBaseUrl(settings.baseUrl)
    const model = normalizeModel(baseUrl, settings.model)
    const catalog = memory.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      tags: item.tags || [],
      summary: item.summary || item.text,
      slot: item.slot || '',
      superseded: Boolean(item.superseded),
      humanEdit: Boolean(item.humanEdit)
    }))
    const result = await completeOnce({
      url: toCompletionsUrl(baseUrl),
      apiKey: settings.apiKey,
      payload: {
        model,
        temperature: 1,
        max_tokens: 700,
        stream: false,
        messages: [
          { role: 'system', content: COMPACT_PROMPT },
          {
            role: 'user',
            content: `原因：${reason}\n当前核心：${JSON.stringify(memory.core)}\n卡片目录：${JSON.stringify(catalog).slice(0, 8000)}`
          }
        ],
        ...requestExtras(model)
      }
    })
    const data = parseJsonObject(result.content)
    const next = loadMemory()
    if (data.core && typeof data.core === 'object') {
      for (const slot of CORE_SLOTS) {
        if (typeof data.core[slot] !== 'string') continue
        const liveSlot = next.items.find((item) => item.slot === slot && item.humanEdit && !item.superseded)
        if (liveSlot && Date.now() - Number(liveSlot.ts || 0) < 10 * 60 * 1000) continue
        setCoreSlot(next, slot, data.core[slot])
      }
      if (Array.isArray(data.core.extra)) next.core.extra = data.core.extra.map((row) => String(row || '').trim()).filter(Boolean).slice(0, 6)
      saveMemory(next)
    }
    await applyMemoryOps(data.ops)
    const saved = loadMemory()
    saved.lastCompact = Date.now()
    saveMemory(saved)
    ctx.onMemoryChange?.()
    return getMemory()
  }

  const catalogForLlm = (memory) => memory.items
    .filter((item) => !item.superseded)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      title: item.title,
      tags: item.tags || [],
      summary: item.summary || item.text,
      slot: item.slot || '',
      humanEdit: Boolean(item.humanEdit)
    }))

  const recentTranscript = (limit = 12) => loadChat()
    .slice(-limit)
    .map((row) => `${row.role === 'user' ? '用户' : '桌宠'}：${String(row.content || '').slice(0, 240)}`)
    .join('\n')

  let consolidating = false
  let consolidateAgain = false
  const reconcileMemories = async (userText, reply, meta = {}) => {
    if (/刚才没说成/.test(String(reply || ''))) return
    const settings = ctx.loadSettings()
    if (!settings.apiKey) return
    if (consolidating) {
      consolidateAgain = true
      return
    }
    consolidating = true
    try {
      do {
        consolidateAgain = false
        const baseUrl = normalizeBaseUrl(settings.baseUrl)
        const model = normalizeModel(baseUrl, settings.model)
        const usedTools = Array.isArray(meta.usedTools) ? meta.usedTools : []
        const usedNotes = usedTools.includes('search_notes') || usedTools.includes('read_note')
        const noteText = String(meta.noteText || '').trim().slice(0, 800)
        const memory = loadMemory()
        const extra = [
          usedNotes ? '本轮翻过笔记。笔记里出现的内容不要写成记忆。' : '若近期对话在翻笔记，笔记内容和验收点不要写成记忆卡。',
          noteText ? `本轮见到的笔记摘录：\n${noteText}` : '',
          usedTools.length ? `本轮用过的工具：${usedTools.join('、')}` : '',
          `当前核心印象：${JSON.stringify(memory.core)}`,
          `卡片目录：${JSON.stringify(catalogForLlm(memory)).slice(0, 3500)}`,
          `近期对话：\n${recentTranscript(12)}`,
          userText ? `最近一句用户：${userText}` : '',
          reply ? `最近一句桌宠：${String(reply).slice(0, 400)}` : ''
        ].filter(Boolean).join('\n')
        const result = await completeOnce({
          url: toCompletionsUrl(baseUrl),
          apiKey: settings.apiKey,
          payload: {
            model,
            temperature: 1,
            max_tokens: 500,
            stream: false,
            messages: [
              { role: 'system', content: EXTRACT_PROMPT },
              { role: 'user', content: extra }
            ],
            ...requestExtras(model)
          }
        })
        const data = parseJsonObject(result.content)
        const ops = Array.isArray(data.ops) ? data.ops : []
        await applyMemoryOps(ops)
        const saved = loadMemory()
        saved.pendingTurns = 0
        saveMemory(saved)
        const liveRest = saved.items.filter((item) => !item.superseded && item.kind !== 'identity' && item.kind !== 'preference').length
        if (liveRest >= 80) await compactMemories('pressure')
      } while (consolidateAgain)
    } finally {
      consolidating = false
    }
  }

  const flushMemories = async (reason = 'flush') => {
    const memory = loadMemory()
    const pending = Number(memory.pendingTurns || 0)
    if (!pending) return getMemory()
    if (reason !== 'close' && reason !== 'immediate' && pending < MEMORY_FLUSH_TURNS) return getMemory()
    await reconcileMemories('', '', { usedTools: [] })
    return getMemory()
  }

  const scheduleMemory = (userText, reply, meta) => {
    const memory = loadMemory()
    memory.pendingTurns = Number(memory.pendingTurns || 0) + 1
    saveMemory(memory)
    const immediate = needsImmediateMemory(userText)
    if (immediate || memory.pendingTurns >= MEMORY_FLUSH_TURNS) {
      reconcileMemories(userText, reply, meta).catch((error) => console.error('[memory-extract]', error.message))
    }
  }

  const completeOnce = async ({ url, apiKey, payload, onDelta }) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(90000)
    })
    const ctype = response.headers.get('content-type') || ''
    if (!response.ok) {
      const body = await response.text()
      throw new Error(friendlyError(response.status, body))
    }
    if (payload.stream && /event-stream|octet-stream|ndjson/i.test(ctype)) {
      return readSse(response, onDelta)
    }
    if (payload.stream) {
      const preview = await response.text()
      if (preview.includes('data:')) {
        return parseSseBuffer(preview, onDelta)
      }
      const data = JSON.parse(preview)
      return fromMessage(data, onDelta)
    }
    const data = JSON.parse(await response.text())
    return fromMessage(data, onDelta)
  }

  const fromMessage = (data, onDelta) => {
    const msg = data?.choices?.[0]?.message || {}
    const content = pickReplyText(data)
    if (content && onDelta) onDelta(content)
    return {
      content,
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      finish: data?.choices?.[0]?.finish_reason || ''
    }
  }

  const parseSseBuffer = (raw, onDelta) => {
    const toolCalls = []
    let content = ''
    let finish = ''
    for (const line of String(raw).split('\n')) {
      const parsed = parseSseLine(line, toolCalls)
      if (!parsed) continue
      if (parsed.finish) finish = parsed.finish
      if (parsed.text) {
        content += parsed.text
        onDelta?.(parsed.text)
      }
    }
    return { content: content.trim(), toolCalls: toolCalls.filter((item) => item?.function?.name), finish }
  }

  const parseSseLine = (line, toolCalls) => {
    const trimmed = String(line || '').trim()
    if (!trimmed.startsWith('data:')) return null
    const data = trimmed.slice(5).trim()
    if (!data || data === '[DONE]') return null
    let json
    try {
      json = JSON.parse(data)
    } catch {
      return null
    }
    const choice = json.choices?.[0] || {}
    const delta = choice.delta || {}
    let text = ''
    if (typeof delta.content === 'string') text = delta.content
    else if (Array.isArray(delta.content)) {
      text = delta.content.map((part) => part?.text || part?.content || '').join('')
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const i = Number.isInteger(tc.index) ? tc.index : toolCalls.length
        if (!toolCalls[i]) toolCalls[i] = { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (tc.id) toolCalls[i].id = tc.id
        if (tc.type) toolCalls[i].type = tc.type
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments
      }
    }
    return { text, finish: choice.finish_reason || '' }
  }

  const readSse = async (response, onDelta) => {
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const toolCalls = []
    let buf = ''
    let content = ''
    let finish = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        const parsed = parseSseLine(line, toolCalls)
        if (!parsed) continue
        if (parsed.finish) finish = parsed.finish
        if (parsed.text) {
          content += parsed.text
          onDelta?.(parsed.text)
        }
      }
    }
    if (buf.trim()) {
      const parsed = parseSseLine(buf, toolCalls)
      if (parsed?.text) {
        content += parsed.text
        onDelta?.(parsed.text)
      }
      if (parsed?.finish) finish = parsed.finish
    }
    return { content: content.trim(), toolCalls: toolCalls.filter((item) => item?.function?.name), finish }
  }

  const chatWithModel = async (messages, userText, onUpdate) => {
    const settings = ctx.loadSettings()
    if (!settings.apiKey) {
      const reply = localReply(userText)
      const usedPetAction = /走|散步|逛|停|别走|回来|坐下|坐着|睡|困/.test(userText)
      return { reply, usedPetAction, usedTools: usedPetAction ? ['pet_action'] : [], noteText: '' }
    }

    const baseUrl = normalizeBaseUrl(settings.baseUrl)
    const model = normalizeModel(baseUrl, settings.model)
    if (baseUrl !== settings.baseUrl || model !== settings.model) {
      ctx.saveSettings({ ...settings, baseUrl, model })
    }
    const url = toCompletionsUrl(baseUrl)
    const noteHits = await searchKnowledge(userText, 3)
    const noteText = formatNoteHits(noteHits)
    const llmMessages = [
      { role: 'system', content: await buildSystemPrompt(userText, noteHits) },
      ...messages.slice(-24).map(({ role, content }) => ({ role, content }))
    ]

    let usedPetAction = false
    let useTools = true
    let streamText = ''
    let repairCount = 0
    const usedToolNames = new Set()
    const toolOutputs = []

    const groundedText = () => [
      userText,
      noteText,
      formatNow(),
      ...toolOutputs,
      ...loadMemory().items.filter((item) => !item.superseded).map((item) => item.text)
    ].join('\n')

    const pushUpdate = (status) => {
      onUpdate?.({
        messages,
        pending: true,
        stream: streamText,
        status: status || ''
      })
    }

    for (let round = 0; round < 5; round++) {
      const payload = {
        model,
        temperature: 0.7,
        max_tokens: 640,
        stream: true,
        messages: llmMessages,
        ...requestExtras(model)
      }
      if (useTools) payload.tools = TOOLS

      let result
      try {
        streamText = ''
        result = await completeOnce({
          url,
          apiKey: settings.apiKey,
          payload,
          onDelta: (text) => {
            streamText += text
            pushUpdate('')
          }
        })
      } catch (error) {
        const msg = String(error.message || error)
        if (useTools && /tool|function calling|tools|not supported|unsupported|unknown field|invalid.*?param/i.test(msg)) {
          useTools = false
          continue
        }
        if (payload.stream && /stream|event-stream|sse/i.test(msg)) {
          payload.stream = false
          result = await completeOnce({
            url,
            apiKey: settings.apiKey,
            payload,
            onDelta: (text) => {
              streamText += text
              pushUpdate('')
            }
          })
        } else {
          throw error
        }
      }

      if (result.toolCalls?.length) {
        const toolCalls = result.toolCalls.map((call, i) => ({
          id: call.id || `call_${i}`,
          type: 'function',
          function: {
            name: call.function?.name || '',
            arguments: typeof call.function?.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments || {})
          }
        }))
        llmMessages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: toolCalls
        })
        for (const call of toolCalls) {
          const name = call.function?.name || ''
          if (name === 'pet_action') usedPetAction = true
          if (name) usedToolNames.add(name)
          pushUpdate(TOOL_STATUS[name] || '在忙')
          let args = {}
          try {
            args = JSON.parse(call.function?.arguments || '{}')
          } catch {
            args = {}
          }
          const output = await executeTool(name, args)
          toolOutputs.push(String(output || ''))
          ctx.onTool?.(name, args, output)
          llmMessages.push({
            role: 'tool',
            tool_call_id: call.id,
            name,
            content: String(output || '')
          })
        }
        continue
      }

      const reply = result.content || '……'
      if (useTools && repairCount < 2 && round < 4) {
        const missing = claimedToolsWithoutCall(reply, usedToolNames, userText)
        const invented = inventedTokens(reply, groundedText())
        if (missing.length || invented.length) {
          repairCount += 1
          const bits = []
          if (missing.length) {
            bits.push(`你像已经做了这些事，但没有调用工具：${missing.join('、')}。没有工具结果就等于没做、没看见。请先调用对应工具，再用一两句对人说。`)
          }
          if (invented.length) {
            bits.push(`这些具体值在笔记原文和工具返回里都没有：${invented.join('、')}。不要编。不够就 read_note，没有就说没有。`)
          }
          llmMessages.push({ role: 'assistant', content: reply })
          llmMessages.push({ role: 'user', content: bits.join('\n') + '\n不要解释规则。' })
          continue
        }
      }
      return { reply, usedPetAction, usedTools: [...usedToolNames], noteText }
    }
    return { reply: '我有点绕住了，你再说一次。', usedPetAction, usedTools: [...usedToolNames], noteText }
  }

  const sendChat = async (text, onUpdate) => {
    const content = String(text || '').trim()
    const messages = loadChat()
    if (!content) return { messages, pending: false }
    messages.push({ role: 'user', content, ts: Date.now() })
    saveChat(messages)
    onUpdate?.({ messages, pending: true, stream: '', status: '' })
    try {
      const { reply, usedPetAction, usedTools, noteText } = await chatWithModel(messages, content, onUpdate)
      messages.push({ role: 'assistant', content: reply, ts: Date.now() })
      saveChat(messages.slice(-80))
      const next = { messages: loadChat(), pending: false }
      onUpdate?.(next)
      scheduleMemory(content, reply, { usedTools, noteText })
      ensureIndex().catch((error) => console.error('[knowledge-index]', error.message))
      return { ...next, reply, usedPetAction, usedTools }
    } catch (error) {
      const fail = `刚才没说成：${error.message}`
      messages.push({ role: 'assistant', content: fail, ts: Date.now() })
      saveChat(messages.slice(-80))
      const next = { messages: loadChat(), pending: false }
      onUpdate?.(next)
      return { ...next, reply: fail, usedPetAction: false }
    }
  }

  return {
    sendChat,
    loadChat,
    getMemory,
    removeMemory,
    updateMemory,
    addMemory,
    forgetMemory,
    recallMemory,
    compactMemories,
    flushMemories,
    updateCore,
    searchNotes,
    readNote,
    knowledgeInfo,
    pickKnowledgeDir,
    openKnowledgeDir,
    restoreReminders,
    warmIndex: () => ensureIndex().catch((error) => console.error('[knowledge-index]', error.message))
  }
}

const webSearch = async (query) => {
  if (!query) return '没有搜索词'
  const chunks = []
  try {
    const wiki = await fetch(
      'https://zh.wikipedia.org/w/api.php?action=opensearch&limit=3&namespace=0&format=json&origin=*&search=' + encodeURIComponent(query),
      { signal: AbortSignal.timeout(8000) }
    )
    const data = await wiki.json()
    const titles = data[1] || []
    const descs = data[2] || []
    const urls = data[3] || []
    for (let i = 0; i < titles.length; i++) {
      chunks.push(`${titles[i]}：${descs[i] || ''} ${urls[i] || ''}`.trim())
    }
  } catch {}
  try {
    const ddg = await fetch(
      'https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=' + encodeURIComponent(query),
      { signal: AbortSignal.timeout(8000) }
    )
    const data = await ddg.json()
    if (data.AbstractText) chunks.push(data.AbstractText)
    for (const topic of data.RelatedTopics || []) {
      if (topic.Text) chunks.push(topic.Text)
      else if (Array.isArray(topic.Topics)) {
        for (const child of topic.Topics.slice(0, 2)) {
          if (child.Text) chunks.push(child.Text)
        }
      }
    }
  } catch {}
  const unique = [...new Set(chunks.map((item) => item.trim()).filter(Boolean))]
  return unique.slice(0, 6).join('\n\n') || '没搜到靠谱的，你可以换个说法。'
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeBaseUrl,
  normalizeModel,
  createAgent,
  needsImmediateMemory,
  normalizeCardKind,
  migrateMemoryItem,
  cardRecencyMultiplier,
  memoryRankScore,
  formatCardLine,
  CATALOG_INJECT_LIMIT,
  CARD_KINDS
}
