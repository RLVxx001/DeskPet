const fs = require('fs')
const path = require('path')

const toEmbeddingsUrl = (baseUrl) => {
  let base = String(baseUrl || '').trim().replace(/\/+$/, '')
  if (/\/embeddings$/i.test(base)) return base
  return `${base}/embeddings`
}

const cosine = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0
    const y = Number(b[i]) || 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

const rrf = (rankLists, k = 60) => {
  const scores = new Map()
  for (const list of rankLists) {
    list.forEach((id, index) => {
      scores.set(id, (scores.get(id) || 0) + 1 / (k + index + 1))
    })
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([id, score]) => ({ id, score }))
}

const splitWindow = (text, size, overlap) => {
  const t = String(text || '').trim()
  if (!t) return []
  if (t.length <= size) return [t]
  const out = []
  let i = 0
  while (i < t.length) {
    out.push(t.slice(i, i + size))
    if (i + size >= t.length) break
    i += Math.max(1, size - overlap)
  }
  return out
}

const chunkText = (text, size = 280, overlap = 50) => {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim()
  if (!clean) return []
  const paras = clean.split(/\n{2,}/)
  const parts = []
  let buf = ''
  for (const para of paras) {
    const next = buf ? `${buf}\n\n${para}` : para
    if (next.length <= size) buf = next
    else {
      if (buf) parts.push(...splitWindow(buf, size, overlap))
      buf = para
    }
  }
  if (buf) parts.push(...splitWindow(buf, size, overlap))
  return parts.map((item) => item.trim()).filter((item) => item.length >= 8)
}

const embedTexts = async (settings, texts) => {
  const list = (Array.isArray(texts) ? texts : [texts]).map((item) => String(item || '').slice(0, 6000))
  if (!list.length) return []
  const apiKey = String(settings.embeddingApiKey || '').trim()
  const rawModel = String(settings.embeddingModel || 'qwen3.7-text-embedding').trim()
  const model = /^qwen3\.?7[-_]?text[-_]?embedding$/i.test(rawModel) ? 'qwen3.7-text-embedding' : rawModel
  const baseUrl = String(settings.embeddingBaseUrl || '').trim()
  if (!apiKey || !baseUrl) throw new Error('还没填 embedding 接口')
  const url = toEmbeddingsUrl(baseUrl)
  const out = []
  for (let i = 0; i < list.length; i += 8) {
    const batch = list.slice(i, i + 8)
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        input: batch.length === 1 ? batch[0] : batch,
        encoding_format: 'float'
      }),
      signal: AbortSignal.timeout(30000)
    })
    const body = await response.text()
    if (!response.ok) {
      let msg = body.slice(0, 180)
      try {
        const parsed = JSON.parse(body)
        msg = parsed.error?.message || parsed.message || msg
      } catch {}
      throw new Error(msg)
    }
    const data = JSON.parse(body)
    const vectors = (data.data || [])
      .slice()
      .sort((a, b) => (a.index || 0) - (b.index || 0))
      .map((item) => item.embedding || [])
    if (vectors.length !== batch.length) throw new Error('embedding 条数对不上')
    out.push(...vectors)
  }
  return out
}

const headingOf = (text) => {
  const line = String(text || '').split('\n').find((row) => row.trim())
  if (!line) return ''
  const md = line.match(/^#{1,6}\s+(.+)/)
  if (md) return md[1].trim()
  return line.replace(/^[-*•]\s+/, '').trim().slice(0, 24)
}

const chunkDocument = (text, rel) => {
  const clean = String(text || '').replace(/\r\n/g, '\n').trim()
  const children = chunkText(clean)
  return children.map((child, i) => {
    const probe = child.slice(0, Math.min(40, child.length))
    const at = clean.indexOf(probe)
    const start = at >= 0 ? at : 0
    const parent = clean.slice(Math.max(0, start - 220), Math.min(clean.length, start + child.length + 420)).trim() || child
    const heading = headingOf(child) || headingOf(clean)
    const context = `出自《${rel}》${heading ? ` / ${heading}` : ''}`
    return {
      id: `${rel}#${i}`,
      rel,
      child,
      parent,
      heading,
      embedText: `${context}\n${child}`,
      cite: rel
    }
  })
}

module.exports = {
  cosine,
  rrf,
  chunkText,
  chunkDocument,
  embedTexts
}
