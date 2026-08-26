const assert = require('assert')
const {
  needsImmediateMemory,
  normalizeCardKind,
  migrateMemoryItem,
  cardRecencyMultiplier,
  memoryRankScore,
  formatCardLine,
  CATALOG_INJECT_LIMIT
} = require('../electron/agent')

const now = Date.parse('2026-08-26T12:00:00')

const check = (name, ok, detail) => {
  if (!ok) {
    console.error('FAIL', name, detail || '')
    process.exitCode = 1
    return
  }
  console.log('OK', name)
}

check('immediate-name', needsImmediateMemory('记住，以后叫我周周'))
check('immediate-city', needsImmediateMemory('我现在住在杭州。'))
check('immediate-drink', needsImmediateMemory('我不太喝美式，以后别给我点。'))
check('immediate-forget', needsImmediateMemory('忘掉杭州。'))
check('immediate-deadline', needsImmediateMemory('下周三要交 DeskPet 方案，帮我记住。'))
check('skip-hi', !needsImmediateMemory('👋'))
check('skip-who', !needsImmediateMemory('你是谁'))
check('skip-ask-name', !needsImmediateMemory('我叫什么？我住哪？'))
check('skip-hmm', !needsImmediateMemory('嗯。'))

check('kind-slot-name', normalizeCardKind('note', 'name') === 'identity')
check('kind-slot-drink', normalizeCardKind('', 'drink') === 'preference')
check('kind-legacy-note', normalizeCardKind('note') === 'agreement')
check('kind-legacy-profile', normalizeCardKind('profile') === 'identity')

const old = migrateMemoryItem({
  id: '1',
  kind: 'profile',
  text: '叫我周周',
  slot: 'name',
  ts: now
})
check('migrate-kind', old.kind === 'identity', old.kind)
check('migrate-title', old.title === '称呼', old.title)
check('migrate-summary', old.summary.includes('周周'), old.summary)

const identity = { kind: 'identity', slot: 'name', text: '叫我周周', title: '称呼', ts: now - 200 * 86400000 }
const episodeOld = { kind: 'episode', text: '上周聊过提醒', title: '近况', ts: now - 30 * 86400000 }
const episodeNew = { kind: 'episode', text: '今天聊过方案', title: '近况', ts: now }
const agreement = { kind: 'agreement', text: '周五交方案', title: '截止日期', ts: now - 40 * 86400000, dueAt: now + 3 * 86400000 }

check('decay-identity', cardRecencyMultiplier(identity, '我叫什么', now) === 1)
check('decay-agreement', cardRecencyMultiplier(agreement, '方案哪天交', now) === 1)
check('decay-episode-old-low', cardRecencyMultiplier(episodeOld, '最近聊啥', now) < 0.2)
check('decay-episode-history', cardRecencyMultiplier(episodeOld, '以前聊过什么', now) === 1)

const episodeScoreNew = memoryRankScore(episodeNew, '最近聊什么', 0.4, now)
const episodeScoreOld = memoryRankScore(episodeOld, '最近聊什么', 0.4, now)
check('rank-episode-new-wins', episodeScoreNew > episodeScoreOld, `${episodeScoreNew} vs ${episodeScoreOld}`)

const line = formatCardLine(old)
check('format-line', line.includes('[身份]') && line.includes('称呼'), line)
check('catalog-limit', CATALOG_INJECT_LIMIT === 24)

assert.ok(process.exitCode !== 1, 'memory card unit tests failed')
console.log('DONE memory-card-test')
