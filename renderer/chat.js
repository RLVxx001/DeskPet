const log = document.getElementById('log')
const form = document.getElementById('form')
const input = document.getElementById('text')
const memoryBox = document.getElementById('memory')
const memoryBtn = document.getElementById('memoryBtn')
const api = window.deskPet

let busy = false
let memoryOpen = false

const escapeHtml = (text) => String(text || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const formatInline = (text) => escapeHtml(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')

const toHtml = (text) => {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n')
  let html = ''
  let inList = false
  for (const line of lines) {
    const item = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)/)
    if (item) {
      if (!inList) {
        html += '<ul>'
        inList = true
      }
      html += `<li>${formatInline(item[1])}</li>`
      continue
    }
    if (inList) {
      html += '</ul>'
      inList = false
    }
    if (!line.trim()) continue
    html += `<p>${formatInline(line)}</p>`
  }
  if (inList) html += '</ul>'
  return html || `<p>${formatInline(text)}</p>`
}

const addMessage = (role, content, asHtml) => {
  const div = document.createElement('div')
  div.className = `msg ${role}`
  if (role === 'assistant' && asHtml !== false) div.innerHTML = toHtml(content)
  else div.textContent = content
  log.appendChild(div)
  return div
}

const render = (state) => {
  log.innerHTML = ''
  for (const item of state.messages || []) {
    addMessage(item.role, item.content)
  }
  if (state.status) {
    const status = document.createElement('div')
    status.className = 'msg status'
    status.textContent = state.status
    log.appendChild(status)
  }
  if (state.pending && state.stream) {
    addMessage('assistant', state.stream)
  } else if (state.pending && !state.status) {
    addMessage('assistant', '……', false)
  }
  log.scrollTop = log.scrollHeight
}

const CARD_LABELS = {
  identity: '身份',
  preference: '偏好',
  agreement: '约定',
  project: '项目',
  episode: '近况'
}

const renderMemory = (data) => {
  const items = data?.items || []
  const slots = data?.slots || []
  const liveCards = items.filter((item) => !item.superseded && !item.slot)
  const oldItems = items.filter((item) => item.superseded)
  memoryBox.innerHTML = ''

  const bar = document.createElement('div')
  bar.className = 'mem-bar'
  const hint = document.createElement('span')
  hint.className = 'empty'
  hint.textContent = '人设常驻。其余按卡片记现行说法。'
  const compact = document.createElement('button')
  compact.type = 'button'
  compact.textContent = '整理一下'
  compact.addEventListener('click', async () => {
    compact.disabled = true
    compact.textContent = '整理中…'
    try {
      const next = await api.compactMemory()
      renderMemory(next)
    } finally {
      compact.disabled = false
      compact.textContent = '整理一下'
    }
  })
  bar.append(hint, compact)
  memoryBox.appendChild(bar)

  const addSection = (title) => {
    const sec = document.createElement('div')
    sec.className = 'mem-sec'
    sec.textContent = title
    memoryBox.appendChild(sec)
  }

  const addSlotRow = (slot) => {
    const row = document.createElement('div')
    row.className = 'mem'
    const kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = slot.label
    const field = document.createElement('input')
    field.value = slot.value || ''
    field.placeholder = '还没记下'
    field.addEventListener('change', async () => {
      const next = await api.updateCore(slot.key, field.value)
      renderMemory(next)
    })
    row.append(kind, field)
    memoryBox.appendChild(row)
  }

  const addCard = (item, kindLabel) => {
    const card = document.createElement('div')
    card.className = 'card' + (Date.now() - Number(item.ts || 0) < 120000 ? ' fresh' : '')
    const top = document.createElement('div')
    top.className = 'card-top'
    const kind = document.createElement('span')
    kind.className = 'kind'
    kind.textContent = kindLabel
    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = item.title || item.summary || '记忆'
    top.append(kind, title)
    if (Date.now() - Number(item.ts || 0) < 120000 && !item.superseded) {
      const fresh = document.createElement('span')
      fresh.className = 'fresh-mark'
      fresh.textContent = '刚记下'
      top.append(fresh)
    }
    const del = document.createElement('button')
    del.type = 'button'
    del.textContent = item.superseded ? '删掉' : '忘掉'
    del.addEventListener('click', async () => {
      const next = await api.removeMemory(item.id)
      renderMemory(next)
    })
    top.append(del)
    const field = document.createElement('input')
    field.className = 'body'
    field.value = item.text || item.summary || ''
    field.readOnly = Boolean(item.superseded)
    field.addEventListener('change', async () => {
      const next = await api.updateMemory(item.id, field.value)
      renderMemory(next)
    })
    card.append(top, field)
    if (Array.isArray(item.tags) && item.tags.length) {
      const tags = document.createElement('div')
      tags.className = 'card-tags'
      tags.textContent = item.tags.join(' · ')
      card.append(tags)
    }
    memoryBox.appendChild(card)
  }

  addSection('核心印象')
  if (slots.length) {
    for (const slot of slots) addSlotRow(slot)
  }

  const groups = [
    ['identity', '身份'],
    ['preference', '偏好'],
    ['agreement', '约定'],
    ['project', '项目'],
    ['episode', '近况']
  ]
  let anyCard = false
  for (const [kind, label] of groups) {
    const rows = liveCards.filter((item) => (item.kind || 'agreement') === kind)
    if (!rows.length) continue
    anyCard = true
    addSection(label)
    for (const item of rows) addCard(item, CARD_LABELS[item.kind] || label)
  }
  if (!anyCard) {
    addSection('卡片')
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有卡片。稳定的事我会自己收进来。'
    memoryBox.appendChild(empty)
  }

  if (oldItems.length) {
    addSection('已经改口的')
    for (const item of oldItems) addCard(item, CARD_LABELS[item.kind] || '旧卡')
  }
}

api.getChat().then((state) => render(state))
api.getMemory().then(renderMemory)
api.onChat((state) => {
  render(state)
  busy = Boolean(state.pending)
})
api.onMemory(renderMemory)

memoryBtn.addEventListener('click', () => {
  memoryOpen = !memoryOpen
  memoryBox.classList.toggle('open', memoryOpen)
  memoryBtn.classList.toggle('active', memoryOpen)
  if (memoryOpen) api.getMemory().then(renderMemory)
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const text = input.value.trim()
  if (!text || busy) return
  input.value = ''
  busy = true
  const state = await api.sendChat(text)
  render(state)
  busy = Boolean(state.pending)
})

document.getElementById('close').addEventListener('click', () => api.closeChat())
document.getElementById('settings').addEventListener('click', () => api.openSettings())
input.focus()
