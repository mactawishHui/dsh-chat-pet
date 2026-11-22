/**
 * memory-consolidator.mjs — 睡眠海马体记忆整理模块（零常驻内存，平台解耦）
 *
 * 用途：每天夜里（通常在写完日记后）像人类睡眠整理海马体一样，自动代谢 `social-v2.json` 中的长期记忆：
 *   1. 去重合并：把高度重叠的碎片印象合并为精炼条目（如多条重复的饮食/事件记录合为一条）
 *   2. 时间锚定：给具体事件打上明确日期 [YYYY-MM-DD]，彻底消灭「昨天/明天/快过生日」类跨天乌龙
 *   3. 过期代谢：把已过期的临时约定与旧待办移出活跃区，归档到 `state/memory-archive.jsonl`（永不丢失，供回忆杀引擎检索）
 *   4. 零竞态写回：优先通过宿主 `POST /api/socialV2/consolidate` 更新内存态并落盘，避免被运行中的桥接服务覆盖
 *
 * 用法：
 *   node memory-consolidator.mjs [--dry-run] [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import { lifeDayKey } from './life-journal.mjs';

const ROOT = '/opt/qq-bridge';
const CONFIG_PATH = process.env.QQ_BRIDGE_CONFIG || path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const SOCIAL_PATH = path.join(STATE_DIR, 'social-v2.json');
const ARCHIVE_PATH = path.join(STATE_DIR, 'memory-archive.jsonl');
const CONSOLIDATE_STATE_PATH = path.join(STATE_DIR, 'memory-consolidate-state.json');
const CONSOLE_TOKEN_PATH = path.join(STATE_DIR, 'console-token');

const log = (...a) => console.log(new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function beijingDateStr(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600e3);
  return d.toISOString().slice(0, 10);
}

function loadCfg() {
  const raw = readJson(CONFIG_PATH, {});
  const life = raw.life || {};
  const consolePort = Number(raw.consolePort || 3100);
  let consoleToken = String(raw.consoleToken || '').trim();
  if (!consoleToken) {
    try { consoleToken = fs.readFileSync(CONSOLE_TOKEN_PATH, 'utf8').trim(); } catch {}
  }
  return {
    model: life.model || { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    dshBaseUrl: raw.dsh?.baseUrl || 'http://127.0.0.1:3080',
    dshAuthToken: raw.dsh?.authToken || '',
    bridgeBase: `http://127.0.0.1:${consolePort}`,
    consoleToken
  };
}

function parseJsonLoose(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

async function runDshJson(cfg, { title, prompt, timeoutMs = 120000 }) {
  const { NodeApiClient } = await import(path.join(ROOT, 'src', 'dsh-client.js'));
  const api = new NodeApiClient(cfg.dshBaseUrl, undefined, { token: cfg.dshAuthToken, tokenExplicit: Boolean(cfg.dshAuthToken) });
  await api.ensureAuth();
  const created = await api.callUnary('session/create', { title, agentPreset: 'qq-diary', model: cfg.model });
  const sid = created?.result?.value?.sessionId;
  if (!sid) throw new Error('创建记忆整理会话失败');

  const ac = new AbortController();
  let lastText = '';
  const done = new Promise((resolve) => {
    (async () => {
      try {
        for await (const env of api.events.mux(undefined, ac.signal)) {
          const f = env?.payload;
          if (!f || f.sessionId !== sid || f.type !== 'session/event') continue;
          const ev = f.event;
          if (ev.type === 'assistant/message') {
            const t = (ev.data?.message?.content || []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('').trim();
            if (t) lastText = t;
          } else if (ev.type === 'turn/end') { resolve(); break; }
        }
      } catch { resolve(); }
    })();
  });
  api.events.follow(sid);
  await sleep(250);
  const pr = await api.sessions.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text: prompt }] });
  if (!pr?.result?.ok) throw new Error(`prompt 被拒: ${pr?.result?.error?.message || '?'}`);
  const timer = setTimeout(() => api.stopSessionWork(sid).catch(() => {}), timeoutMs);
  await Promise.race([done, sleep(timeoutMs + 10000)]);
  clearTimeout(timer);
  ac.abort();
  api.events.forget(sid);
  return parseJsonLoose(lastText);
}

function shouldConsolidateConv(conv) {
  const impressions = conv?.memberImpressions || {};
  const traitCount = Object.values(impressions).reduce((s, v) => s + (Array.isArray(v?.traits) ? v.traits.length : 0), 0);
  const topicsCount = Array.isArray(conv?.activeTopics) ? conv.activeTopics.length : 0;
  const thoughtsCount = Array.isArray(conv?.pendingThoughts) ? conv.pendingThoughts.length : 0;
  return traitCount >= 2 || topicsCount >= 1 || thoughtsCount >= 1;
}

async function consolidateOneConv(cfg, convKey, conv, todayStr) {
  const impressions = conv?.memberImpressions || {};
  const activeTopics = Array.isArray(conv?.activeTopics) ? conv.activeTopics : [];
  const pendingThoughts = Array.isArray(conv?.pendingThoughts) ? conv.pendingThoughts : [];

  const compactInput = {
    today: todayStr,
    conversation: convKey,
    memberImpressions: Object.fromEntries(
      Object.entries(impressions).map(([who, info]) => [
        who,
        {
          traits: Array.isArray(info?.traits) ? info.traits : [],
          updatedDay: info?.updatedAt ? beijingDateStr(info.updatedAt) : (info?.lastSeenAt ? beijingDateStr(info.lastSeenAt) : '未知')
        }
      ])
    ),
    activeTopics: activeTopics.map((t) => ({
      text: String(t?.text || '').trim(),
      lastMentionDay: t?.lastMentionAt ? beijingDateStr(t.lastMentionAt) : '未知',
      participants: Array.isArray(t?.participants) ? t.participants : []
    })).filter((t) => t.text),
    pendingThoughts: pendingThoughts.map((p) => (typeof p === 'string' ? p : String(p?.text || ''))).filter(Boolean)
  };

  const prompt = [
    '你是 AI 聊天宠物的「睡眠海马体记忆整理器」。你的工作不是改写人设，而是把长期记忆梳理干净、准确、不重复、不留过期定时炸弹。',
    `【当前准确北京时间日期】${todayStr}`,
    `【待整理的会话记忆】\n${JSON.stringify(compactInput, null, 2)}`,
    [
      '【整理规则（必须严格遵守）】',
      '1. 去重合并：同一人名下如果有多条重复或高度重叠的印象（例如多次记录同一次吃辣肚子疼、同一件事的不同说法），合并成 1 条信息最完整、表述最精炼的条目。',
      '2. 消灭相对时间词：绝对不允许保留裸露的「今天」「昨天」「明天」「后天」「最近」「那周」「快到了」而不标具体日期！',
      '   - 明确是一次性事件的，务必结合 updatedDay/lastMentionDay 改写成带日期的锚点，例如 `[2026-11-21] 吃两勺魔鬼辣螺蛳粉配四包辣条肚子疼两小时`。',
      '   - 稳定长期特质（性格、长期爱好、身份关系、固定生日日期如「生日是11月2日，2026年已过完」）保持简洁清晰，不重复堆砌。',
      '3. 过期代谢归档：',
      '   - 已经过期的临时约定/旧提醒（例如 3 天前说的「明天做深蹲/明天出门/昨天要干嘛」已成过去，或明显已完结的一次性小事），从 traits / activeTopics / pendingThoughts 移出，放入 archived 数组。',
      '   - 仍在生效的持续性目标（例如正在减肥提醒锻炼）、或今天/明天尚未履行的约定，务必保留！',
      '4. 绝不捏造任何原数据里没有的新事实；绝不删空某个人的全部印象（每人保留 1~15 条最核心印象）；保留原人名键不变。',
      '5. 严格只输出一个 JSON 对象，不要任何多余文字：',
      '{"memberImpressions":{"原人名":["整理后的印象1","整理后的印象2"]},"activeTopics":[{"text":"仍有效的待跟进话题","participants":["人名"]}],"pendingThoughts":["仍有效的未完念头"],"archived":[{"person":"人名或会话","eventDay":"YYYY-MM-DD或空","text":"被归档的旧记忆/已完结事件","reason":"重复合并/已过期"}]}'
    ].join('\n')
  ].join('\n\n');

  const out = await runDshJson(cfg, { title: `记忆整理-${convKey}-${todayStr}`, prompt });
  if (!out || typeof out !== 'object' || typeof out.memberImpressions !== 'object') {
    throw new Error('模型未返回合法 JSON');
  }

  // 安全合并：保留原始元数据（interactionCount / lastSeenAt / updatedAt），防止误删任何人
  const nextImpressions = {};
  for (const [who, oldInfo] of Object.entries(impressions)) {
    const oldTraits = Array.isArray(oldInfo?.traits) ? oldInfo.traits : [];
    const proposed = Array.isArray(out.memberImpressions[who])
      ? out.memberImpressions[who].map((x) => String(x || '').trim()).filter(Boolean).slice(0, 15)
      : null;
    const safeTraits = proposed && proposed.length >= 1 ? proposed : oldTraits;
    nextImpressions[who] = {
      ...oldInfo,
      traits: safeTraits,
      consolidatedAt: Date.now()
    };
  }

  const nextTopics = Array.isArray(out.activeTopics)
    ? out.activeTopics
        .map((t) => {
          const text = String(t?.text || '').trim();
          if (!text) return null;
          const prev = activeTopics.find((old) => old?.text === text) || activeTopics[0] || {};
          return {
            text,
            lastMentionAt: Number(prev.lastMentionAt) || Date.now(),
            participants: Array.isArray(t?.participants) ? t.participants.filter(Boolean) : (prev.participants || []),
            pendingQuestion: String(prev.pendingQuestion || '')
          };
        })
        .filter(Boolean)
        .slice(0, 6)
    : activeTopics;

  const nextThoughts = Array.isArray(out.pendingThoughts)
    ? out.pendingThoughts.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 6)
    : pendingThoughts;

  const archived = Array.isArray(out.archived)
    ? out.archived
        .map((a) => ({
          archivedAt: Date.now(),
          day: todayStr,
          convKey,
          person: String(a?.person || '').trim(),
          eventDay: /^\d{4}-\d{2}-\d{2}$/.test(String(a?.eventDay || '')) ? String(a.eventDay) : '',
          text: String(a?.text || '').trim(),
          reason: String(a?.reason || '代谢归档').trim()
        }))
        .filter((a) => a.text)
    : [];

  return { nextImpressions, nextTopics, nextThoughts, archived };
}

async function applyToBridgeOrDisk(cfg, convKey, patch, socialFallback) {
  // 优先走 qq-bridge 内存热更新路由，绝不与运行中桥接产生覆盖竞态
  try {
    const res = await fetch(`${cfg.bridgeBase}/api/socialV2/consolidate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.consoleToken ? { 'X-Console-Token': cfg.consoleToken } : {})
      },
      body: JSON.stringify({ key: convKey, ...patch }),
      signal: AbortSignal.timeout(10000)
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) return 'bridge';
  } catch {}

  // 若 qq-bridge 未运行，兜底安全写入磁盘
  if (socialFallback?.conversations?.[convKey]) {
    socialFallback.conversations[convKey].memberImpressions = patch.memberImpressions;
    socialFallback.conversations[convKey].activeTopics = patch.activeTopics;
    socialFallback.conversations[convKey].pendingThoughts = patch.pendingThoughts;
    return 'disk';
  }
  return 'skip';
}

export async function runMemoryConsolidation({ dryRun = false, force = false } = {}) {
  const cfg = loadCfg();
  const day = lifeDayKey();
  const todayStr = beijingDateStr();
  const prevState = readJson(CONSOLIDATE_STATE_PATH, {});
  if (prevState.lastDay === day && !dryRun && !force) {
    log(`[memory] 今日 (${day}) 已整理过记忆，跳过`);
    return { skipped: true };
  }

  const social = readJson(SOCIAL_PATH, null);
  if (!social?.conversations) {
    log('[memory] 未找到 social-v2.json，跳过');
    return { skipped: true };
  }

  if (!dryRun) {
    try { fs.copyFileSync(SOCIAL_PATH, `${SOCIAL_PATH}.bak.consolidate`); } catch {}
  }

  let touchedConvs = 0;
  let totalBefore = 0;
  let totalAfter = 0;
  let totalArchived = 0;
  let needDiskWrite = false;

  for (const [convKey, conv] of Object.entries(social.conversations)) {
    if (!shouldConsolidateConv(conv)) continue;
    const beforeCount = Object.values(conv.memberImpressions || {}).reduce((s, v) => s + (v?.traits?.length || 0), 0);
    totalBefore += beforeCount;
    try {
      log(`[memory] 整理 ${convKey}（当前印象 ${beforeCount} 条，话题 ${(conv.activeTopics || []).length} 条）…`);
      const res = await consolidateOneConv(cfg, convKey, conv, todayStr);
      const afterCount = Object.values(res.nextImpressions).reduce((s, v) => s + (v?.traits?.length || 0), 0);
      totalAfter += afterCount;
      totalArchived += res.archived.length;

      if (dryRun) {
        log(`[memory] [dry-run] ${convKey}: 印象 ${beforeCount} → ${afterCount} 条，归档 ${res.archived.length} 条`);
        for (const [who, info] of Object.entries(res.nextImpressions)) {
          log(`  👤 ${who}:`);
          for (const t of info.traits) log(`     - ${t}`);
        }
        if (res.nextTopics.length) {
          log(`  📌 保留话题: ${res.nextTopics.map((x) => x.text).join(' | ')}`);
        }
        if (res.archived.length) {
          log(`  📦 归档代谢: ${res.archived.map((x) => `[${x.reason}] ${x.text}`).join(' | ')}`);
        }
      } else {
        const mode = await applyToBridgeOrDisk(cfg, convKey, {
          memberImpressions: res.nextImpressions,
          activeTopics: res.nextTopics,
          pendingThoughts: res.nextThoughts
        }, social);
        if (mode === 'disk') needDiskWrite = true;
        if (res.archived.length) {
          fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true });
          fs.appendFileSync(ARCHIVE_PATH, res.archived.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
        }
        touchedConvs += 1;
        log(`[memory] ✓ ${convKey} 已写回(${mode})：印象 ${beforeCount} → ${afterCount} 条，归档 ${res.archived.length} 条`);
      }
    } catch (err) {
      log(`[memory] 整理 ${convKey} 失败（已跳过保护原数据）: ${err?.message ?? err}`);
      totalAfter += beforeCount;
    }
  }

  if (!dryRun && needDiskWrite) {
    const tmp = `${SOCIAL_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(social, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, SOCIAL_PATH);
  }
  if (!dryRun) {
    writeJson(CONSOLIDATE_STATE_PATH, { lastDay: day, at: Date.now(), touchedConvs, totalBefore, totalAfter, totalArchived });
  }
  log(`[memory] 整理完成：印象 ${totalBefore} → ${totalAfter} 条，归档 ${totalArchived} 条`);
  return { touchedConvs, totalBefore, totalAfter, totalArchived };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMemoryConsolidation({
    dryRun: process.argv.includes('--dry-run'),
    force: process.argv.includes('--force')
  }).then(() => process.exit(0)).catch((err) => {
    console.error('[memory] fatal:', err?.stack || err);
    process.exit(1);
  });
}
