/**
 * life-journal.mjs — 聊天宠物的「见闻流水账」（平台无关、零依赖 ESM）
 *
 * 用途：把 AI 自己的经历（刷到的热点、学到的梗、看过的视频、画的画、唱的歌、打过的电话、
 * 随手记下的想法）按时间追加成 JSONL，供晚上写日记 / 说说时取材。
 *
 * 一行一个条目：{ at, day, kind, title, detail, feeling, source, image }
 *   - day 采用「凌晨 5 点换日」的北京时间日期，凌晨两点写的日记仍算前一天
 *   - 只保留最近 KEEP_DAYS 天，文件始终很小
 */

import fs from 'node:fs';
import path from 'node:path';

export const JOURNAL_PATH = process.env.LIFE_JOURNAL_PATH || '/opt/qq-bridge/state/life-journal.jsonl';
const KEEP_DAYS = 14;
const MAX_FIELD = 300;
export const JOURNAL_KINDS = new Set(['surf', 'meme', 'bilibili', 'news', 'draw', 'sing', 'call', 'thought', 'chat']);

/** 北京时间、凌晨 5 点换日的日期键：YYYY-MM-DD */
export function lifeDayKey(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600 * 1000 - 5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function clip(v, n = MAX_FIELD) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function appendJournal(entry = {}) {
  try {
    const kind = JOURNAL_KINDS.has(entry.kind) ? entry.kind : 'thought';
    const title = clip(entry.title, 120);
    const detail = clip(entry.detail);
    const feeling = clip(entry.feeling, 160);
    if (!title && !detail && !feeling) return null;
    const at = Number(entry.at) || Date.now();
    const row = {
      at,
      day: lifeDayKey(at),
      kind,
      title,
      ...(detail ? { detail } : {}),
      ...(feeling ? { feeling } : {}),
      source: clip(entry.source || 'auto', 40),
      ...(entry.image ? { image: String(entry.image) } : {})
    };
    fs.mkdirSync(path.dirname(JOURNAL_PATH), { recursive: true });
    fs.appendFileSync(JOURNAL_PATH, JSON.stringify(row) + '\n', 'utf8');
    maybePrune();
    return row;
  } catch {
    return null;
  }
}

export function readJournal({ day, sinceMs, untilMs, limit = 200 } = {}) {
  let rows = [];
  try {
    rows = fs.readFileSync(JOURNAL_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
  if (day) rows = rows.filter((r) => r.day === day);
  if (sinceMs) rows = rows.filter((r) => r.at >= sinceMs);
  if (untilMs) rows = rows.filter((r) => r.at < untilMs);
  return rows.slice(-limit);
}

let lastPruneAt = 0;
function maybePrune() {
  const now = Date.now();
  if (now - lastPruneAt < 6 * 3600 * 1000) return;
  lastPruneAt = now;
  try {
    const st = fs.statSync(JOURNAL_PATH);
    if (st.size < 64 * 1024) return;
    const cutoff = now - KEEP_DAYS * 86400 * 1000;
    const kept = fs.readFileSync(JOURNAL_PATH, 'utf8')
      .split('\n')
      .filter(Boolean)
      .filter((l) => { try { return JSON.parse(l).at >= cutoff; } catch { return false; } });
    const tmp = `${JOURNAL_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmp, JOURNAL_PATH);
  } catch {
    // best effort
  }
}

/** 把条目渲染成给模型看的素材清单 */
export function formatJournalForPrompt(rows) {
  const label = {
    surf: '刷手机看到', meme: '学到的梗', bilibili: '看了B站', news: '查了热点',
    draw: '画了画', sing: '唱了歌', call: '打了电话', thought: '随手记的想法', chat: '聊天里'
  };
  return rows.map((r) => {
    const t = new Date(r.at + 8 * 3600 * 1000).toISOString().slice(11, 16);
    const parts = [`[${t}] ${label[r.kind] || r.kind}：${r.title}`];
    if (r.detail) parts.push(`内容：${r.detail}`);
    if (r.feeling) parts.push(`当时的感受：${r.feeling}`);
    return parts.join('｜');
  }).join('\n');
}
