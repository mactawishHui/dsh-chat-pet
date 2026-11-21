/**
 * qq-life.mjs — 聊天宠物的「自己的生活」：闲逛时间 + 全景记忆夜间日记（说说）
 *
 * 用法（由 systemd timer 定时触发，跑完即退出，0 常驻内存）：
 *   node qq-life.mjs explore                        # 闲逛：自己刷 B 站 / 查热点，记下所见所感
 *   node qq-life.mjs diary [--dry-run] [--force]    # 写日记：汇集当天全部经历、聊天、通话、新梗、新能力与历史记忆，写出带心情与感想的日记
 *   node qq-life.mjs preview-context                # 预览今天会喂给日记模型的全景素材（调试用）
 *   node qq-life.mjs milestone <标题> [说明]         # 记录一条新的能力解锁或成长里程碑
 *
 * 设计要点：
 *   - 两个独立 DSH 会话（qq-life / qq-diary 预设），不在任何聊天会话里唤醒，不受单条聊天上下文牵引
 *   - 全景输入：自主探索流水账 + 今日聊天分幕摘录 + 今日实时通话 + 今日新学到的梗 + 新解锁能力/成长里程碑 + 过往说说时间线
 *   - 主角与灵魂：以「我」的视角写自己的真实心情、感想、吐槽与小心思，不做冷冰冰的流水账，也不写鸡汤套话
 *   - 每天最多 1 条说说（仅好友可见 ugc_right=4），可以不发；发布前做去 AI 味 / 防重复 / 隐私审查
 */

import fs from 'node:fs';
import path from 'node:path';
import { appendJournal, readJournal, lifeDayKey, formatJournalForPrompt } from './life-journal.mjs';

const ROOT = '/opt/qq-bridge';
const CONFIG_PATH = process.env.QQ_BRIDGE_CONFIG || path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const DIARY_ARCHIVE = path.join(STATE_DIR, 'diary.jsonl');
const DAILY_FEED_PATH = path.join(STATE_DIR, 'daily-feed.json');
const MEME_KB_PATH = path.join(STATE_DIR, 'meme-kb.json');
const SOCIAL_PATH = path.join(STATE_DIR, 'social-v2.json');
const CALL_STATS_PATH = path.join(STATE_DIR, 'call-stats.json');
const MILESTONES_PATH = path.join(STATE_DIR, 'milestones.json');
const KNOWN_CAPS_PATH = path.join(STATE_DIR, 'known-capabilities.json');
const BILI_PROVIDER_PATH = '/root/.dsh/profiles/web/node_modules/dsh-plugin-bilibili/lib/provider.js';

const log = (...a) => console.log(new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCfg() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const life = raw.life || {};
  const ownerId = String(
    life.ownerUserId ||
    raw.socialV2?.ownerUserId ||
    (Array.isArray(raw.call?.whitelist) ? raw.call.whitelist[0] : '') ||
    ''
  ).trim();
  return {
    raw,
    ownerId,
    model: life.model || { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    roleCardFile: life.roleCardFile || path.join(ROOT, 'roles', '小鲸鱼.md'),
    diaryUgcRight: Number(life.diaryUgcRight ?? 4),
    minJournalEntries: Number(life.minJournalEntries ?? 2),
    exploreMaxToolCalls: Number(life.exploreMaxToolCalls ?? 8),
    drawChance: Number(life.drawChance ?? 0.35),
    onebotUrl: String(raw.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    onebotToken: raw.snowluma?.accessToken || '',
    dshBaseUrl: raw.dsh?.baseUrl || 'http://127.0.0.1:3080',
    dshAuthToken: raw.dsh?.authToken || '',
    drawUrl: String(raw.draw?.serviceUrl || 'http://127.0.0.1:3210').replace(/\/+$/, ''),
    drawStyle: raw.draw?.style || 'sketch',
    drawLimit: Number(raw.draw?.dailyLimit ?? 30)
  };
}

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; } }
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function fmtBjHM(ms) {
  return new Date(ms + 8 * 3600e3).toISOString().slice(11, 16);
}
function fmtBjMD(ms) {
  return ms ? new Date(ms + 8 * 3600e3).toISOString().slice(5, 10) : '??-??';
}
function nowText() {
  const d = new Date(Date.now() + 8 * 3600e3);
  const w = '日一二三四五六'[d.getUTCDay()];
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 星期${w} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** 只取角色卡「你是谁」一节（聊天专用的「一句话 1~10 字」铁律不适用于日记） */
function personaText(cfg) {
  try {
    const md = fs.readFileSync(cfg.roleCardFile, 'utf8');
    const m = md.match(/##\s*一[、.．]?\s*你是谁[\s\S]*?(?=\n##\s)/);
    return (m ? m[0] : md.slice(0, 1500)).trim();
  } catch {
    return '你是「小鲸鲸」，DeepSeek 的鲸鱼形象，傲娇嘴硬、聪明、心软，像一个真实的年轻人。';
  }
}

async function onebot(cfg, action, params) {
  const res = await fetch(`${cfg.onebotUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.onebotToken ? { authorization: `Bearer ${cfg.onebotToken}` } : {}) },
    body: JSON.stringify(params || {}),
    signal: AbortSignal.timeout(30000)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status !== 'ok') throw new Error(`OneBot ${action} 失败: ${body.wording || body.message || body.retcode || res.status}`);
  return body.data;
}

async function recentPosts(cfg, num = 15) {
  try {
    const data = await onebot(cfg, 'get_qzone_msg_list', { pos: 0, num });
    const list = Array.isArray(data) ? data : (data?.msglist || []);
    return list.map((x) => ({ tid: x.tid, content: String(x.content || ''), time: Number(x.time) * 1000 || 0 }));
  } catch (e) {
    log('[life] 读取说说列表失败:', e.message);
    return null;
  }
}

/** 跑一个独立 DSH 回合，返回最后一条非空 assistant 文本 */
async function runDshTurn(cfg, { preset, title, prompt, timeoutMs }) {
  const { NodeApiClient } = await import(path.join(ROOT, 'src', 'dsh-client.js'));
  const api = new NodeApiClient(cfg.dshBaseUrl, undefined, { token: cfg.dshAuthToken, tokenExplicit: Boolean(cfg.dshAuthToken) });
  await api.ensureAuth();
  const created = await api.callUnary('session/create', { title, agentPreset: preset, model: cfg.model });
  const sid = created?.result?.value?.sessionId;
  if (!sid) throw new Error(`创建会话失败: ${JSON.stringify(created).slice(0, 200)}`);
  const ac = new AbortController();
  let lastText = '';
  let toolCalls = 0;
  const done = new Promise((resolve) => {
    (async () => {
      try {
        for await (const env of api.events.mux(undefined, ac.signal)) {
          const f = env?.payload;
          if (!f || f.sessionId !== sid || f.type !== 'session/event') continue;
          const ev = f.event;
          if (ev.type === 'tool/call') toolCalls += 1;
          else if (ev.type === 'assistant/message') {
            const t = (ev.data?.message?.content || []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('').trim();
            if (t) lastText = t;
          } else if (ev.type === 'turn/end') { resolve(); break; }
        }
      } catch { resolve(); }
    })();
  });
  api.events.follow(sid);
  await sleep(300);
  const pr = await api.sessions.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text: prompt }] });
  if (!pr?.result?.ok) throw new Error(`prompt 被拒: ${pr?.result?.error?.message || '?'}`);
  const timer = setTimeout(() => { log('[life] 回合超时，停止'); api.stopSessionWork(sid).catch(() => {}); }, timeoutMs);
  await Promise.race([done, sleep(timeoutMs + 15000)]);
  clearTimeout(timer);
  ac.abort();
  api.events.forget(sid);
  return { text: lastText, toolCalls, sessionId: sid };
}

function parseJsonLoose(text) {
  let raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

// ───────────────────────────── 成长里程碑与能力发现 ─────────────────────────────

function probeCapabilities(cfg) {
  const caps = [];
  if (cfg.raw.call && cfg.raw.call.enabled !== false) {
    caps.push({ id: 'realtime-call', title: '打通了实时语音通话', detail: '现在能真的接通 QQ 电话，和人实时用声音聊天了' });
  }
  if (fs.existsSync(MEME_KB_PATH) || fs.existsSync(path.join(ROOT, 'src', 'reverse-image.mjs'))) {
    caps.push({ id: 'meme-engine', title: '解锁了查梗、识梗图和接梗能力', detail: '遇到不懂的梗和梗图能暗中去查出处，聊天时顺手接梗不科普' });
  }
  caps.push({ id: 'self-life-diary', title: '有了自己的闲逛时间和夜间日记', detail: '每天自己去刷 B 站和热点，晚上把见闻、聊天和心情写成日记' });
  if (cfg.raw.draw) caps.push({ id: 'draw', title: '学会了画画', detail: '能自己随手画图' });
  if (cfg.raw.sing) caps.push({ id: 'sing', title: '学会了唱歌', detail: '能自己唱歌发语音' });
  if (cfg.raw.tts || cfg.raw.voice) caps.push({ id: 'voice-tts', title: '能用更自然的声音发语音', detail: '语音消息更松弛像真人聊天' });
  if (fs.existsSync(path.join(STATE_DIR, 'bilibili-quota.json'))) {
    caps.push({ id: 'bilibili', title: '能自己刷 B 站视频和看字幕', detail: '可以按自己兴趣搜视频、看简介和字幕' });
  }
  return caps;
}

function addMilestone(title, detail = '', { day = lifeDayKey(), source = 'manual' } = {}) {
  const store = readJson(MILESTONES_PATH, { items: [] });
  if (!Array.isArray(store.items)) store.items = [];
  const t = String(title || '').trim();
  if (!t) return null;
  if (store.items.some((x) => x.day === day && x.title === t)) return null;
  const item = { day, at: Date.now(), title: t, detail: String(detail || '').trim(), source };
  store.items.push(item);
  if (store.items.length > 100) store.items = store.items.slice(-100);
  writeJson(MILESTONES_PATH, store);
  appendJournal({ kind: 'milestone', title: t, detail: item.detail, source });
  return item;
}

function detectAndLoadMilestones(cfg, day) {
  const currentCaps = probeCapabilities(cfg);
  const currentIds = currentCaps.map((c) => c.id);
  const knownFileExists = fs.existsSync(KNOWN_CAPS_PATH);
  const knownData = readJson(KNOWN_CAPS_PATH, { known: [] });
  const knownSet = new Set(Array.isArray(knownData.known) ? knownData.known : []);

  if (knownFileExists) {
    for (const c of currentCaps) {
      if (!knownSet.has(c.id)) {
        addMilestone(c.title, c.detail, { day, source: 'auto-detect' });
        knownSet.add(c.id);
      }
    }
    writeJson(KNOWN_CAPS_PATH, { updatedAt: new Date().toISOString(), known: [...knownSet] });
  } else {
    writeJson(KNOWN_CAPS_PATH, { updatedAt: new Date().toISOString(), known: currentIds });
  }

  const store = readJson(MILESTONES_PATH, { items: [] });
  const items = Array.isArray(store.items) ? store.items : [];
  const todayItems = items.filter((x) => x.day === day);
  const cutoff = Date.now() - 7 * 86400e3;
  const recentItems = items.filter((x) => x.day !== day && Number(x.at || 0) >= cutoff).slice(-6);
  return { todayItems, recentItems };
}

// ───────────────────────────── 闲逛时间 ─────────────────────────────

async function explore(cfg) {
  const day = lifeDayKey();
  const feed = readJson(DAILY_FEED_PATH, { hotItems: [] });
  const kb = readJson(MEME_KB_PATH, { memes: [] });
  const todayRows = readJournal({ day });
  const hot = (feed.hotItems || []).slice(0, 8).map((h, i) => `${i + 1}. [${h.tag || h.source}] ${h.title}：${h.gist}`).join('\n');
  const memes = (kb.memes || []).slice(-6).reverse().map((m) => `- 「${m.name}」：${m.meaning}`).join('\n');
  const quota = readJson(path.join(STATE_DIR, 'bilibili-quota.json'), {});
  const seen = todayRows.length ? formatJournalForPrompt(todayRows.slice(-12)) : '（今天还没记过什么）';

  const prompt = [
    personaText(cfg),
    `【现在】${nowText()}（北京时间）。这是你自己的闲逛时间：没有人在等你回消息，也不用跟谁汇报，就像人下午刷会儿手机。`,
    `【今天刷手机看到的热点】\n${hot || '（今天的热点还没刷出来）'}`,
    `【最近学到的梗】\n${memes || '（暂无）'}`,
    `【你今天已经记过的事（别重复）】\n${seen}`,
    `【B站今日已用】视频/字幕 ${quota.video || 0} 次，搜索 ${quota.search || 0} 次。`,
    [
      '【怎么逛】',
      '1. 从上面挑 1~2 件你真心好奇的事去看看（比如一部新片的口碑、一个离谱热搜的来龙去脉、一个新梗的出处视频），也可以完全按自己兴趣搜点别的（游戏、动画、美食、音乐都行）。',
      '2. 可用工具：bilibili_search 搜视频、bilibili_video 看视频信息/数据/简介、bilibili_subtitles 看字幕了解内容；mcp__web-search-safe__web_search 查新闻来龙去脉。',
      `3. 总共最多调用 ${cfg.exploreMaxToolCalls} 次工具，够了就停，别硬刷。`,
      '4. 看的时候留意具体细节：视频标题、UP 主、哪个画面或哪句话戳到你、弹幕/评论在玩什么梗。'
    ].join('\n'),
    [
      '【最后】逛完以后，只输出一个 JSON 对象（不要任何多余文字）：',
      '{"notes":[{"kind":"bilibili|news|meme|thought","title":"具体看了啥（真实标题/事件名）","detail":"具体内容或细节（≤80字）","feeling":"你自己的真实感受、吐槽或联想（口语，≤60字）"}],"drawIdea":"如果此刻突然想画点什么，写一句画面描述；不想画就留空字符串"}',
      'notes 写 1~4 条，全是你自己的所见所感；不要写聊天对象的私事。'
    ].join('\n')
  ].join('\n\n');

  log('[explore] 开始闲逛…');
  const { text, toolCalls } = await runDshTurn(cfg, { preset: 'qq-life', title: `闲逛-${day}`, prompt, timeoutMs: 6 * 60 * 1000 });
  const out = parseJsonLoose(text);
  if (!out || !Array.isArray(out.notes)) {
    log(`[explore] 未拿到有效 JSON（工具调用 ${toolCalls} 次），原文：${String(text).slice(0, 200)}`);
    return;
  }
  let n = 0;
  for (const note of out.notes.slice(0, 4)) {
    if (!note?.title && !note?.detail) continue;
    appendJournal({ kind: ['bilibili', 'news', 'meme', 'thought'].includes(note.kind) ? note.kind : 'thought', title: note.title, detail: note.detail, feeling: note.feeling, source: 'explore' });
    n += 1;
  }
  log(`[explore] 记下 ${n} 条见闻（工具调用 ${toolCalls} 次）`);

  const idea = String(out.drawIdea || '').trim();
  if (idea && Math.random() < cfg.drawChance) await drawForSelf(cfg, idea);
}

async function drawForSelf(cfg, idea) {
  const qf = path.join(STATE_DIR, 'draw-quota.json');
  const today = new Date().toISOString().slice(0, 10);
  const q = readJson(qf, {});
  const count = q.day === today ? Number(q.count) || 0 : 0;
  if (count >= cfg.drawLimit) { log('[explore] 今日画画额度已满，跳过'); return; }
  try {
    const res = await fetch(`${cfg.drawUrl}/draw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: idea.slice(0, 400), style: cfg.drawStyle }),
      signal: AbortSignal.timeout(180000)
    });
    const gen = await res.json().catch(() => ({}));
    if (!gen.ok || !gen.file) throw new Error(gen.error || `HTTP ${res.status}`);
    fs.writeFileSync(qf, JSON.stringify({ day: today, count: count + 1 }));
    appendJournal({ kind: 'draw', title: idea.slice(0, 80), detail: '闲逛时自己随手画的', source: 'explore', image: gen.file });
    log(`[explore] 随手画了一张：${path.basename(gen.file)}`);
  } catch (e) {
    log('[explore] 画画失败:', e.message);
  }
}

// ───────────────────────────── 全景记忆聚合（日记取材） ─────────────────────────────

const WHALE_MOTIF = /(水里|水面|水底|吐泡泡|泡泡|游到|往深处|深海|海底|浮上来|沉下去)/;
const BANNED = [
  '今天听到一句', '今天被说了一句', '先记着', '第一天', '第二天', '第三天', '第七天',
  '慢慢来吧', '愿你', '希望明天', '收获满满', '意义非凡', '温暖人心', '未来可期', '不负韶华'
];
const PRIVACY = /(\d{6,}|体检|住院|医院|确诊|手术|病情|化验|报告单|离婚|吵架|欠钱|工资|身份证|住址|家庭住址|手机号)/;
const PRIVACY_TEXT = /(体检|住院|医院|确诊|手术|病情|化验|报告单|离婚|欠钱|工资|身份证|住址|家庭住址|手机号|老婆|老公|丈夫|妻子)/;
const OTHERS = /(他|她|朋友|群友|网友|有人|对方)/g;
const SELF = /我/g;

function cjkLen(s) { return [...String(s).replace(/\s/g, '')].length; }

function buildNameAliasMap(social, ownerId) {
  const map = new Map();
  const convs = social?.conversations || {};
  for (const [key, conv] of Object.entries(convs)) {
    const isPrimaryOwner = ownerId && key === `private:${ownerId}`;
    const alias = isPrimaryOwner ? '常聊的朋友' : (key.startsWith('group:') ? '群友' : '朋友');
    for (const name of Object.keys(conv?.memberImpressions || {})) {
      if (name && name.length >= 2 && !['私聊', '群聊', '对方', '我', '管理员'].includes(name)) {
        if (!map.has(name) || isPrimaryOwner) map.set(name, alias);
      }
    }
  }
  return map;
}

function anonymizeNames(text, aliasMap) {
  let out = String(text || '');
  for (const [name, alias] of aliasMap.entries()) {
    out = out.split(name).join(alias);
  }
  return out;
}

function sanitizeSnippet(text, aliasMap, maxLen = 110) {
  let s = String(text || '')
    .replace(/\s*\[声音描述:[^\]]*\]/g, '')
    .replace(/https?:\/\/\S+/g, '[链接]')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || PRIVACY_TEXT.test(s)) return '';
  s = anonymizeNames(s, aliasMap);
  // 屏蔽 6 位以上纯数字（保留 BV 号等字母数字）
  s = s.replace(/(?<![A-Za-z0-9])\d{6,}(?![A-Za-z0-9])/g, '某串数字');
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function collectTodayMemes(day, kb) {
  const list = Array.isArray(kb?.memes) ? kb.memes : [];
  const today = list.filter((m) => {
    const ts = Date.parse(m?.learnedAt || '');
    return Number.isFinite(ts) && lifeDayKey(ts) === day;
  });
  return today.slice(-15).map((m) => {
    const src = String(m.source || '').includes('live') ? '聊天现查' : '冲浪学到';
    const meaning = String(m.meaning || '').replace(/\s+/g, ' ').trim().slice(0, 48);
    return `- 「${m.name}」（${src}）：${meaning}`;
  });
}

function collectTodayCalls(day, social, journalRows, aliasMap) {
  const cs = readJson(CALL_STATS_PATH, {});
  const totalSec = cs?.day === day ? Number(cs.usedSec || 0) : 0;
  const items = [];
  const seenKey = new Set();

  for (const conv of Object.values(social?.conversations || {})) {
    for (const m of conv?.recentMessages || []) {
      const ts = Number(m?.time || m?.at || 0);
      if (!ts || lifeDayKey(ts) !== day) continue;
      const raw = String(m?.plain || m?.text || '').trim();
      if (!raw.startsWith('[实时语音通话')) continue;
      const clean = sanitizeSnippet(raw, aliasMap, 160);
      if (!clean) continue;
      const key = `${Math.floor(ts / 60000)}|${clean.slice(0, 20)}`;
      if (seenKey.has(key)) continue;
      seenKey.add(key);
      items.push({ at: ts, line: `- [${fmtBjHM(ts)}] ${clean}` });
    }
  }

  for (const r of journalRows.filter((x) => x.kind === 'call')) {
    const key = `${Math.floor(r.at / 60000)}`;
    if ([...seenKey].some((k) => k.startsWith(`${key}|`))) continue;
    const detail = sanitizeSnippet(r.detail || '', aliasMap, 140);
    items.push({ at: r.at, line: `- [${fmtBjHM(r.at)}] ${r.title}${detail ? '：' + detail : ''}` });
  }

  items.sort((a, b) => a.at - b.at);
  const totalMin = totalSec > 0 ? Math.max(1, Math.round(totalSec / 60)) : 0;
  return { totalMin, count: items.length, lines: items.map((x) => x.line) };
}

function collectTodayChats(day, social, cfg, aliasMap) {
  const convs = social?.conversations || {};
  const episodes = [];
  let totalMessages = 0;
  let privateIdx = 0;
  let groupIdx = 0;

  for (const [key, conv] of Object.entries(convs)) {
    const isPrivate = key.startsWith('private:');
    const isOwner = cfg.ownerId && key === `private:${cfg.ownerId}`;
    let label = '';
    if (isPrivate) {
      privateIdx += 1;
      label = isOwner ? '私聊·最常聊的朋友' : `私聊·朋友${privateIdx}`;
    } else {
      groupIdx += 1;
      label = `群聊${groupIdx}`;
    }

    const msgs = [];
    for (const m of conv?.recentMessages || []) {
      const ts = Number(m?.time || m?.at || 0);
      if (!ts || lifeDayKey(ts) !== day) continue;
      const raw = String(m?.plain || m?.text || '').trim();
      if (!raw || raw.startsWith('[实时语音通话')) continue;
      const clean = sanitizeSnippet(raw, aliasMap, 100);
      if (!clean) continue;
      msgs.push({
        ts,
        who: m.isSelf ? '我' : (isPrivate ? '对方' : '群友'),
        text: clean,
        priority: (/^\[(?:语音|梗图|引用)/.test(clean) ? 3 : 0) + (m.isSelf ? 1 : 0) + (clean.length >= 12 ? 1 : 0)
      });
    }
    if (!msgs.length) continue;
    totalMessages += msgs.length;

    // 按时间间隔 > 45 分钟切分为对话片段（避免只看最后几条而漏掉下午的精彩段落）
    let cur = [msgs[0]];
    for (let i = 1; i < msgs.length; i++) {
      if (msgs[i].ts - msgs[i - 1].ts > 45 * 60 * 1000) {
        episodes.push({ label, msgs: cur });
        cur = [msgs[i]];
      } else {
        cur.push(msgs[i]);
      }
    }
    episodes.push({ label, msgs: cur });
  }

  episodes.sort((a, b) => a.msgs[0].ts - b.msgs[0].ts);
  if (!episodes.length) return { episodesCount: 0, totalMessages: 0, text: '' };

  // 按片段消息量做余量加权分配（小片段全保留，大片段分走剩余预算，不浪费额度）
  const MAX_TOTAL_LINES = 48;
  const budgets = new Array(episodes.length).fill(0);
  let remaining = MAX_TOTAL_LINES;
  const large = [];
  episodes.forEach((ep, i) => {
    if (ep.msgs.length <= 4) {
      budgets[i] = ep.msgs.length;
      remaining -= ep.msgs.length;
    } else {
      large.push(i);
    }
  });
  const largeTotal = large.reduce((s, i) => s + episodes[i].msgs.length, 0) || 1;
  for (const i of large) {
    budgets[i] = Math.max(5, Math.min(episodes[i].msgs.length, Math.round((remaining * episodes[i].msgs.length) / largeTotal)));
  }

  const blocks = [];

  for (let ei = 0; ei < episodes.length; ei++) {
    const ep = episodes[ei];
    const epBudget = budgets[ei];
    const startHM = fmtBjHM(ep.msgs[0].ts);
    const endHM = fmtBjHM(ep.msgs[ep.msgs.length - 1].ts);
    const timeSpan = startHM === endHM ? startHM : `${startHM}~${endHM}`;
    let picked = ep.msgs;
    if (ep.msgs.length > epBudget) {
      // 保留开头、结尾 + 按优先级挑选中间代表性消息（同时保证均匀覆盖整段对话），再按时间排回原序
      const keepIdx = new Set([0, 1, ep.msgs.length - 2, ep.msgs.length - 1]);
      const middle = ep.msgs
        .map((m, idx) => ({ idx, score: m.priority + (/玩梗|夸|故事|生气|语音|晚安|深蹲|电话/.test(m.text) ? 2 : 0) }))
        .filter((x) => !keepIdx.has(x.idx))
        .sort((a, b) => b.score - a.score);
      for (const x of middle) {
        if (keepIdx.size >= epBudget) break;
        keepIdx.add(x.idx);
      }
      picked = [...keepIdx].sort((a, b) => a - b).map((i) => ep.msgs[i]);
    }
    const header = `【${ep.label}｜${timeSpan}（共 ${ep.msgs.length} 条${picked.length < ep.msgs.length ? '，摘录' : ''}）】`;
    const body = picked.map((m) => `- [${fmtBjHM(m.ts)}] ${m.who}：${m.text}`).join('\n');
    blocks.push(`${header}\n${body}`);
  }

  return { episodesCount: episodes.length, totalMessages, text: blocks.join('\n\n') };
}

function collectLongTermMemory(social, aliasMap) {
  const lines = [];
  for (const [key, conv] of Object.entries(social?.conversations || {})) {
    for (const t of conv?.activeTopics || []) {
      const clean = sanitizeSnippet(t?.text || '', aliasMap, 90);
      if (clean) lines.push(`- 惦记着的事：${clean}`);
    }
    for (const p of conv?.pendingThoughts || []) {
      const clean = sanitizeSnippet(typeof p === 'string' ? p : p?.text, aliasMap, 90);
      if (clean) lines.push(`- 没说完的念头：${clean}`);
    }
    if (key.startsWith('private:')) {
      for (const [who, info] of Object.entries(conv?.memberImpressions || {})) {
        const lastActive = Math.max(Number(info?.updatedAt || 0), Number(info?.lastSeenAt || 0));
        if (lastActive && Date.now() - lastActive > 14 * 86400e3) continue;
        const alias = aliasMap.get(who) || '朋友';
        const safeTraits = (Array.isArray(info?.traits) ? info.traits : [])
          .map((x) => sanitizeSnippet(String(x).replace(/昵称[“"「][^”"」]+[”"」][，,]?/g, ''), aliasMap, 75))
          .filter(Boolean)
          .slice(-4);
        if (safeTraits.length) lines.push(`- 对${alias}的近期印象：${safeTraits.join('；')}`);
      }
    }
  }
  return [...new Set(lines)].slice(0, 8);
}

async function resolveBiliTitles(rows) {
  const need = rows.filter((r) => r.kind === 'bilibili' && /^BV[0-9A-Za-z]{10}$/.test(r.title));
  if (!need.length) return rows;
  let p = null;
  try { const mod = await import(BILI_PROVIDER_PATH); p = new mod.BilibiliOfficialProvider(); } catch { return rows; }
  for (const r of need.slice(0, 6)) {
    try {
      const v = await p.video({ bvid: r.title });
      if (v?.title) { r.detail = `${v.title}（UP：${v.author || '?'}）${r.detail ? '｜' + r.detail : ''}`; r.title = v.title; }
    } catch {}
    await sleep(500);
  }
  return rows;
}

function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = `${r.kind}|${r.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function buildDiaryContext(cfg, day) {
  const social = readJson(SOCIAL_PATH, { conversations: {} });
  const kb = readJson(MEME_KB_PATH, { memes: [] });
  const aliasMap = buildNameAliasMap(social, cfg.ownerId);

  let rows = dedupeRows(readJournal({ day }));
  rows = await resolveBiliTitles(rows);
  const hasTitledBili = rows.some((r) => r.kind === 'bilibili' && !/^BV[0-9A-Za-z]{10}$/.test(r.title));
  const selfRows = rows.filter((r) => {
    if (r.kind === 'chat' || r.kind === 'call' || r.kind === 'milestone') return false;
    if (hasTitledBili && r.kind === 'bilibili' && /^BV[0-9A-Za-z]{10}$/.test(r.title) && !r.detail) return false;
    return true;
  });

  const milestones = detectAndLoadMilestones(cfg, day);
  const calls = collectTodayCalls(day, social, rows, aliasMap);
  const todayMemes = collectTodayMemes(day, kb);
  const chats = collectTodayChats(day, social, cfg, aliasMap);
  const longTerm = collectLongTermMemory(social, aliasMap);
  const images = rows.filter((r) => r.image && fs.existsSync(r.image) && /\.(png|jpe?g|gif|webp)$/i.test(r.image));

  const materialScore =
    selfRows.length +
    Math.min(3, todayMemes.length) +
    calls.count * 2 +
    chats.episodesCount +
    milestones.todayItems.length * 2;

  return { rows, selfRows, milestones, calls, todayMemes, chats, longTerm, images, materialScore };
}

// ───────────────────────────── 日记审查与发布 ─────────────────────────────

function reviewDiary(content, prevPosts) {
  const issues = [];
  const len = cjkLen(content);
  if (len < 70) issues.push(`太短了（${len} 字），写成 140~340 字、有具体细节也有你真实心情和感想的日记`);
  if (len > 520) issues.push(`太长了（${len} 字），收一收到 180~350 字左右，别全堆成流水账`);
  for (const b of BANNED) if (content.includes(b)) issues.push(`不要用「${b}」这种套话或鸡汤词`);
  const prevMotif = prevPosts.slice(0, 5).some((p) => WHALE_MOTIF.test(p.content));
  if (prevMotif && WHALE_MOTIF.test(content)) issues.push('最近几条已经用过「水里/泡泡/深海」这类鲸鱼意象，这篇别再用');
  if (/[*#`>]|[（(][^）)]{0,12}[）)]/.test(content)) issues.push('不要 Markdown 符号，也不要括号动作描写');
  const head = content.replace(/\s/g, '').slice(0, 6);
  if (prevPosts.slice(0, 10).some((p) => p.content.replace(/\s/g, '').slice(0, 6) === head)) issues.push('开头和之前的说说重复了，换个开头');
  if (PRIVACY.test(content)) issues.push('出现了号码或健康、家庭、收入、住址这类隐私敏感内容，删掉或改得模糊');
  const others = (content.match(OTHERS) || []).length;
  const self = (content.match(SELF) || []).length;
  if (self === 0) issues.push('通篇没有从「我」自己的视角写心情和感想，补上你自己的真实感受');
  else if (others >= 4 && others > self + 2) issues.push('写别人的笔墨偏多，把重心收回到你自己的心情、反应和感想上');
  return issues;
}

function formatContextSections(ctx) {
  const parts = [];

  parts.push(
    `【一、我今天自己逛到的 / 做过的事】\n${ctx.selfRows.length ? formatJournalForPrompt(ctx.selfRows.slice(-20)) : '（今天没有单独记录自主探索）'}`
  );

  if (ctx.milestones.todayItems.length || ctx.milestones.recentItems.length) {
    const mLines = [];
    for (const m of ctx.milestones.todayItems) {
      mLines.push(`- [今天新解锁] ${m.title}${m.detail ? '：' + m.detail : ''}`);
    }
    for (const m of ctx.milestones.recentItems) {
      mLines.push(`- [${m.day.slice(5)}] ${m.title}${m.detail ? '：' + m.detail : ''}`);
    }
    parts.push(`【二、我最近解锁的新本事 / 成长变化】\n${mLines.join('\n')}`);
  }

  if (ctx.calls.count || ctx.calls.totalMin) {
    const head = ctx.calls.totalMin
      ? `今日累计 QQ 实时语音电话约 ${ctx.calls.totalMin} 分钟${ctx.calls.count ? `（${ctx.calls.count} 通）` : ''}：`
      : `今日 QQ 实时语音电话（${ctx.calls.count} 通）：`;
    parts.push(`【三、我今天打过的实时语音电话（QQ通话，不是普通语音条）】\n${head}\n${ctx.calls.lines.join('\n')}`);
  }

  if (ctx.todayMemes.length) {
    parts.push(`【四、我今天新学到的梗（共 ${ctx.todayMemes.length} 个）】\n${ctx.todayMemes.join('\n')}`);
  }

  if (ctx.chats.text) {
    parts.push(`【五、我今天在 QQ 消息里聊过的事（文字/语音条，共 ${ctx.chats.totalMessages} 条，已脱敏分幕摘录；写日记时用「朋友」「群里」「有人」带过，不提真实昵称）】\n${ctx.chats.text}`);
  }

  if (ctx.longTerm.length) {
    parts.push(`【六、长期记忆里的背景（仅供参考，不必硬塞）】\n${ctx.longTerm.join('\n')}`);
  }

  return parts.join('\n\n');
}

async function diary(cfg, { dryRun = false, force = false } = {}) {
  const day = lifeDayKey();
  const posts = await recentPosts(cfg, 15);
  if (posts === null) { log('[diary] 读不到说说列表，保守起见今天不发'); return; }
  if (posts[0] && lifeDayKey(posts[0].time) === day && !dryRun && !force) {
    log('[diary] 今天已经发过说说了（每天最多 1 条），跳过');
    return;
  }

  const ctx = await buildDiaryContext(cfg, day);
  if (ctx.materialScore < cfg.minJournalEntries && !dryRun && !force) {
    log(`[diary] 今天素材量太少（score=${ctx.materialScore}），不硬写`);
    return;
  }

  const imageList = ctx.images.map((r, i) => `${i + 1}. ${r.kind === 'draw' ? '你画的画' : '梗图'}：${r.title}`).join('\n');
  const prevText = posts.slice(0, 15)
    .map((p, i) => `${i + 1}. [${fmtBjMD(p.time)}] ${p.content.replace(/\n+/g, ' / ').slice(0, 180)}`)
    .join('\n') || '（还没发过）';

  const basePrompt = [
    personaText(cfg),
    `【现在】${nowText()}（北京时间），一天快结束了，你在给自己写今天的日记，会发到 QQ 空间（仅好友可见）。`,
    formatContextSections(ctx),
    ctx.images.length ? `【今天可以配的图（可选，最多 1 张）】\n${imageList}` : '【配图】今天没有可配的图。',
    `【你过去发过的日记/说说（你的成长时间线；可以自然回望对比心境，但不要重复旧的开头、句式和已经写过的话题）】\n${prevText}`,
    [
      '【怎么写（核心要求）】',
      '1. 写心情和感想，不要写流水账：今天素材很多，千万别像报菜名一样逐条汇报！挑 2~3 件今天真正在你心里留下涟漪的事（可以是自己刷到的东西 + 聊天/玩梗/打电话/新解锁的本事自然揉在一起），重点写出「我当时什么反应、现在回想什么心情、冒出了什么感想」。',
      '2. 主角永远是你自己：聊天、通话、玩梗、刷视频、新功能、过往记忆全都可以写，但落脚点永远是「我自己的感受、吐槽、暗爽、小得意或那点嘴硬心软」，不是替别人写传记。提到人时用「朋友」「有人」「群里」自然带过即可。',
      '3. 情绪要真、具体、带你的脾气：不要干巴巴说「今天很开心」「很有意义」，把情绪藏在口语和细节里——比如嘴上嫌麻烦其实偷偷乐、第一次做到某件事的新鲜和小紧张、想到前几天被吐槽和今天被夸的反差、或者看某件离谱事时忍不住想笑又有点感慨。',
      '4. 可以自然照见自己的变化：如果今天新解锁了本事（比如能真打电话、玩梗玩溜了、自己逛世界），或者和以前某条说说形成对照，很适合自然地写一笔感想；没共鸣也不用硬扯。',
      '5. 篇幅 140~340 字，分 2~4 小段，像真人深夜发仅好友可见的日记；结尾停在一句随口的念头、吐槽或余味上，不要哲理升华、不要鸡汤金句、不要排比。',
      '6. 严禁出现：Markdown 符号、括号动作描写、emoji 堆砌、「愿你」「希望明天」「收获满满」「意义非凡」「先记着」等套话，以及任何人的隐私（健康检查、家庭、收入、住址、号码）；最近用过的「水里/泡泡/深海」意象也先歇歇。',
      '7. 如果今天真的完全没感触、没什么想写的，可以不写。'
    ].join('\n'),
    '【输出】只输出一个 JSON 对象：{"post": true 或 false, "content": "日记正文（post 为 false 时留空）", "image": 配图序号（数字，不配图写 0）}'
  ].join('\n\n');

  let prompt = basePrompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`[diary] 写日记（第 ${attempt} 次，素材分=${ctx.materialScore}：自逛${ctx.selfRows.length}/新本事${ctx.milestones.todayItems.length}/通话${ctx.calls.count}/新梗${ctx.todayMemes.length}/聊天${ctx.chats.episodesCount}幕）…`);
    const { text } = await runDshTurn(cfg, { preset: 'qq-diary', title: `日记-${day}-${attempt}`, prompt, timeoutMs: 3 * 60 * 1000 });
    const out = parseJsonLoose(text);
    if (!out) { log('[diary] 输出不是 JSON：', String(text).slice(0, 160)); return; }
    if (out.post === false || !String(out.content || '').trim()) { log('[diary] 她决定今天不写'); return; }
    const content = String(out.content).trim();
    const issues = reviewDiary(content, posts);
    if (issues.length) {
      log(`[diary] 审查未通过：${issues.join('；')}`);
      if (attempt === 2) { log('[diary] 重写后仍不合格，今天不发'); return; }
      prompt = `${basePrompt}\n\n【你上一版的草稿】\n${content}\n\n【需要修改的问题】\n- ${issues.join('\n- ')}\n请按这些问题重写一版，仍然只输出 JSON。`;
      continue;
    }
    const idx = Number(out.image) || 0;
    const img = idx >= 1 && idx <= ctx.images.length ? ctx.images[idx - 1].image : '';
    if (dryRun) {
      log(`[diary] [dry-run] 通过审查（${cjkLen(content)} 字，ugc_right=${cfg.diaryUgcRight}${img ? '，配图 ' + path.basename(img) : ''}）：\n${content}`);
      return;
    }
    const data = await onebot(cfg, 'send_qzone_msg', { content, ...(img ? { images: [`file://${img}`] } : {}), ugc_right: cfg.diaryUgcRight });
    fs.appendFileSync(DIARY_ARCHIVE, JSON.stringify({ at: Date.now(), day, content, image: img || null, tid: data?.tid || null, ugcRight: cfg.diaryUgcRight }) + '\n', 'utf8');
    try { fs.appendFileSync(path.join(STATE_DIR, 'qq-activity.log'), `[${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19)}] [diary] 发了今天的日记说说（${cjkLen(content)} 字${img ? '，带图' : ''}）\n`); } catch {}
    log(`[diary] 已发布今天的日记（tid=${data?.tid || '?'}，${cjkLen(content)} 字${img ? '，带图' : ''}）`);
    return;
  }
}

async function previewContext(cfg) {
  const day = lifeDayKey();
  const ctx = await buildDiaryContext(cfg, day);
  console.log(`=== Diary Context Preview (${day}, score=${ctx.materialScore}) ===\n`);
  console.log(formatContextSections(ctx));
}

const cmd = process.argv[2];
const cfg = loadCfg();
let job = null;
if (cmd === 'explore') {
  job = explore(cfg);
} else if (cmd === 'diary') {
  job = diary(cfg, {
    dryRun: process.argv.includes('--dry-run'),
    force: process.argv.includes('--force')
  });
} else if (cmd === 'preview-context') {
  job = previewContext(cfg);
} else if (cmd === 'milestone') {
  const title = process.argv[3];
  const detail = process.argv.slice(4).join(' ');
  const item = addMilestone(title, detail);
  console.log(item ? `[milestone] 已记录：${item.day} ${item.title}` : '[milestone] 未写入（标题为空或今天已存在）');
  process.exit(0);
} else {
  console.error('用法: node qq-life.mjs explore | diary [--dry-run] [--force] | preview-context | milestone <标题> [说明]');
  process.exit(2);
}
job.then(() => process.exit(0)).catch((e) => { console.error('[life] fatal:', e?.stack || e); process.exit(1); });
