// qq-life-tools.mjs — 「闲逛时间」会话的工具边界（DSH agent preset 子行）
//
// 只放行只读的「看世界」工具：B 站搜索 / 视频信息 / 字幕，以及安全联网搜索。
// 与 qq-tool-restrict 共用 B 站日配额文件（state/bilibili-quota.json），闲逛不会把聊天时的额度吃光到失控。
// 看过的视频会顺手记进见闻流水账（state/life-journal.jsonl），晚上写日记时取材。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'qq-life-tools'
export const inject = ['tools']

const ALLOW_CANDIDATES = [
  'bilibili_search', 'bilibili_video', 'bilibili_subtitles',
  'mcp__web-search-safe__web_search'
]
const ALLOW_SET = new Set(ALLOW_CANDIDATES)

const STATE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'state')
const BILI_QUOTA_FILE = path.join(STATE_DIR, 'bilibili-quota.json')
const JOURNAL_FILE = path.join(STATE_DIR, 'life-journal.jsonl')
const BILI_DAILY_VIDEO_LIMIT = Number(process.env.QQ_BILIBILI_DAILY_VIDEO_LIMIT) || 20
const BILI_DAILY_SEARCH_LIMIT = Number(process.env.QQ_BILIBILI_DAILY_SEARCH_LIMIT) || 40

function localDay() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function lifeDayKey(ts = Date.now()) {
  return new Date(ts + 8 * 3600 * 1000 - 5 * 3600 * 1000).toISOString().slice(0, 10)
}

function biliQuota(toolName) {
  const isVideo = toolName === 'bilibili_video' || toolName === 'bilibili_subtitles'
  const isSearch = toolName === 'bilibili_search'
  if (!isVideo && !isSearch) return null
  const today = localDay()
  let data = { day: today, video: 0, search: 0 }
  try {
    const raw = JSON.parse(fs.readFileSync(BILI_QUOTA_FILE, 'utf8'))
    if (raw && raw.day === today) data = { day: today, video: Number(raw.video) || 0, search: Number(raw.search) || 0 }
  } catch {}
  if (isVideo && data.video >= BILI_DAILY_VIDEO_LIMIT) return `今天的 B 站视频额度用完了（${BILI_DAILY_VIDEO_LIMIT} 个/天），换个方式逛逛或者直接记下感受。`
  if (isSearch && data.search >= BILI_DAILY_SEARCH_LIMIT) return `今天的 B 站搜索额度用完了（${BILI_DAILY_SEARCH_LIMIT} 次/天）。`
  if (isVideo) data.video += 1
  else data.search += 1
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(BILI_QUOTA_FILE, JSON.stringify(data))
  } catch {}
  return null
}

function parseArgs(exec) {
  const raw = exec?.arguments ?? exec?.input ?? exec?.args
  if (!raw) return {}
  if (typeof raw === 'string') { try { return JSON.parse(raw) } catch { return {} } }
  return typeof raw === 'object' ? raw : {}
}

function journalBiliVideo(exec) {
  if (exec?.name !== 'bilibili_video') return
  const args = parseArgs(exec)
  const bvid = String(args.bvid || args.id || args.url || '').match(/BV[0-9A-Za-z]{10}/)?.[0]
  if (!bvid) return
  try {
    const at = Date.now()
    fs.appendFileSync(JOURNAL_FILE, JSON.stringify({ at, day: lifeDayKey(at), kind: 'bilibili', title: bvid, source: 'explore-tool' }) + '\n', 'utf8')
  } catch {}
}

export function apply(ctx) {
  const tryRestrict = (list) => { ctx.tools.restrict({ allow: list }); return true }
  try {
    tryRestrict(ALLOW_CANDIDATES)
  } catch {
    try { tryRestrict(ALLOW_CANDIDATES.filter((n) => n.startsWith('bilibili_'))) } catch (error) {
      console.error('[qq-life-tools] restrict failed:', error?.message ?? error)
    }
  }
  ctx.tools.guard((exec) => {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || !ALLOW_SET.has(toolName)) {
      return `闲逛时间只能用 B 站搜索/视频/字幕和联网搜索，"${toolName}" 不可用。`
    }
    const denied = biliQuota(toolName)
    if (denied) return denied
    journalBiliVideo(exec)
    return undefined
  })
}
