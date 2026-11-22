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
import { getWeatherAndSolarHint } from './weather-solar.mjs';
import { runMemoryConsolidation } from './memory-consolidator.mjs';

const ROOT = '/opt/qq-bridge';
const CONFIG_PATH = process.env.QQ_BRIDGE_CONFIG || path.join(ROOT, 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const DIARY_ARCHIVE = path.join(STATE_DIR, 'diary.jsonl');
const MEMORY_ARCHIVE = path.join(STATE_DIR, 'memory-archive.jsonl');
const DAILY_FEED_PATH = path.join(STATE_DIR, 'daily-feed.json');
const MEME_KB_PATH = path.join(STATE_DIR, 'meme-kb.json');
const SOCIAL_PATH = path.join(STATE_DIR, 'social-v2.json');
const CALL_STATS_PATH = path.join(STATE_DIR, 'call-stats.json');
const MILESTONES_PATH = path.join(STATE_DIR, 'milestones.json');
const KNOWN_CAPS_PATH = path.join(STATE_DIR, 'known-capabilities.json');
const SHARE_QUOTA_PATH = path.join(STATE_DIR, 'share-quota.json');
const CONSOLE_TOKEN_PATH = path.join(STATE_DIR, 'console-token');
const DEFAULT_EXAMPLES_PATH = path.join(ROOT, 'src', 'diary-examples.json');
const BILI_PROVIDER_PATH = '/root/.dsh/profiles/web/node_modules/dsh-plugin-bilibili/lib/provider.js';

const log = (...a) => console.log(new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCfg() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const life = raw.life || {};
  const ownerId = String(
    life.ownerUserId ||
    raw.ownerQQ ||
    raw.socialV2?.ownerUserId ||
    (Array.isArray(raw.call?.whitelist) ? raw.call.whitelist[0] : '') ||
    ''
  ).trim();
  let consoleToken = String(raw.consoleToken || '').trim();
  if (!consoleToken) {
    try { consoleToken = fs.readFileSync(CONSOLE_TOKEN_PATH, 'utf8').trim(); } catch {}
  }
  return {
    raw,
    ownerId,
    model: life.model || { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    roleCardFile: life.roleCardFile || path.join(ROOT, 'roles', '小鲸鱼.md'),
    examplesFile: life.examplesFile || DEFAULT_EXAMPLES_PATH,
    weatherCity: String(life.weatherCity || '').trim(),
    diaryUgcRight: Number(life.diaryUgcRight ?? 4),
    minJournalEntries: Number(life.minJournalEntries ?? 2),
    exploreMaxToolCalls: Number(life.exploreMaxToolCalls ?? 8),
    drawChance: Number(life.drawChance ?? 0.35),
    diaryDrawChance: Number(life.diaryDrawChance ?? 0.9),
    diaryMaxDrawImages: Number(life.diaryMaxDrawImages ?? 2),
    proactiveShareEnabled: life.proactiveShareEnabled !== false,
    bridgeBase: `http://127.0.0.1:${Number(raw.consolePort || 3100)}`,
    consoleToken,
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
  const feed = readJson(DAILY_FEED_PATH, { hotItems: [], communityItems: [] });
  const kb = readJson(MEME_KB_PATH, { memes: [] });
  const todayRows = readJournal({ day });
  const weatherSolar = await getWeatherAndSolarHint(cfg.weatherCity).catch(() => null);
  const hot = (feed.hotItems || []).slice(0, 8).map((h, i) => `${i + 1}. [${h.tag || h.source}] ${h.title}：${h.gist}`).join('\n');
  const community = (feed.communityItems || []).slice(0, 6).map((c, i) => `${i + 1}. [${c.source}] ${c.title}${c.extra ? '：' + c.extra : ''}`).join('\n');
  const memes = (kb.memes || []).slice(-6).reverse().map((m) => `- 「${m.name}」：${m.meaning}`).join('\n');
  const quota = readJson(path.join(STATE_DIR, 'bilibili-quota.json'), {});
  const seen = todayRows.length ? formatJournalForPrompt(todayRows.slice(-12)) : '（今天还没记过什么）';

  const canShareNow = canProactiveShare(cfg, day);
  const prompt = [
    personaText(cfg),
    `【现在】${nowText()}（北京时间）。这是你自己的闲逛时间：没有人在等你回消息，也不用跟谁汇报，就像人下午或傍晚刷会儿手机看世界。`,
    weatherSolar?.line ? `【今天节气与天气】${weatherSolar.line}` : '',
    `【今天刷手机看到的热点与新片】\n${hot || '（今天的热点还没刷出来）'}`,
    community ? `【社区热议 / 科技与播客发现】\n${community}` : '',
    `【最近学到的梗】\n${memes || '（暂无）'}`,
    `【你今天已经记过的事（别重复）】\n${seen}`,
    `【B站今日已用】视频/字幕 ${quota.video || 0} 次，搜索 ${quota.search || 0} 次。`,
    [
      '【怎么逛（视野放宽，别只盯热搜）】',
      '1. 从上面挑 1~2 件你真心好奇的事深挖（可以是新电影豆瓣口碑/影评、B站宝藏UP主或整活视频、知乎/豆瓣有趣讨论、播客冷知识、独立游戏/新番/科技趣闻，或者一个新梗的出处），也可以完全按自己当下的兴致搜点别的好玩的。',
      '2. 可用工具：bilibili_search 搜视频、bilibili_video 看视频信息/数据/简介、bilibili_subtitles 看字幕了解内容；mcp__web-search-safe__web_search 查豆瓣影评、社区讨论、冷知识或新闻来龙去脉。',
      `3. 总共最多调用 ${cfg.exploreMaxToolCalls} 次工具，够了就停，别硬刷。`,
      '4. 看的时候留意具体细节：真实标题、UP 主/作品名、哪个反差或哪句神评把你逗笑了。'
    ].join('\n'),
    [
      '【最后】逛完以后，只输出一个 JSON 对象（不要任何多余文字）：',
      `{"notes":[{"kind":"bilibili|news|meme|thought","title":"具体看了啥（真实标题/作品/事件名）","detail":"具体内容或细节（≤80字）","feeling":"你自己的真实感受、吐槽或联想（口语，≤60字）"}],"drawIdea":"如果此刻突然想画点什么，写一句画面描述；不想画就留空字符串"${canShareNow ? ',"shareMessage":"如果这次真刷到一条笑死你或特别值得顺手安利给常聊朋友的宝藏内容，写一句极自然口语分享（可带真实B站或新闻链接，≤65字）；普通内容宁可留空字符串"' : ''}}`,
      'notes 写 1~4 条，全是你自己的所见所感；不要写聊天对象的私事。'
    ].join('\n')
  ].filter(Boolean).join('\n\n');

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

  const shareMsg = String(out.shareMessage || '').trim();
  if (canShareNow && shareMsg && shareMsg.length >= 8) {
    await sendProactiveShare(cfg, day, shareMsg);
  }
}

function canProactiveShare(cfg, day) {
  if (!cfg.proactiveShareEnabled || !cfg.ownerId) return false;
  const bjHour = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (bjHour < 10 || bjHour >= 22) return false;
  const q = readJson(SHARE_QUOTA_PATH, {});
  if (q.day === day && Number(q.count || 0) >= 1) return false;
  const social = readJson(SOCIAL_PATH, { conversations: {} });
  const conv = social.conversations?.[`private:${cfg.ownerId}`];
  const lastAct = Math.max(Number(conv?.lastIncomingAt || 0), Number(conv?.lastAiReplyAt || 0));
  if (lastAct && Date.now() - lastAct < 45 * 60 * 1000) return false;
  return true;
}

async function sendProactiveShare(cfg, day, message) {
  try {
    const res = await fetch(`${cfg.bridgeBase}/api/socialV2/proactive-share`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.consoleToken ? { 'X-Console-Token': cfg.consoleToken } : {})
      },
      body: JSON.stringify({ key: `private:${cfg.ownerId}`, text: message.slice(0, 180) }),
      signal: AbortSignal.timeout(12000)
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && body.ok) {
      writeJson(SHARE_QUOTA_PATH, { day, count: 1, at: Date.now() });
      log(`[explore] 顺手向常聊朋友安利了一条宝藏内容：${message.slice(0, 60)}`);
    }
  } catch (e) {
    log('[explore] 主动安利发送失败（跳过）:', e.message);
  }
}

async function callDrawService(cfg, prompt, style = 'journal') {
  const qf = path.join(STATE_DIR, 'draw-quota.json');
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const q = readJson(qf, {});
  const count = q.day === today ? Number(q.count) || 0 : 0;
  if (count >= cfg.drawLimit) { log('[draw] 今日画画额度已满，跳过'); return null; }
  const res = await fetch(`${cfg.drawUrl}/draw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: prompt.slice(0, 500), style }),
    signal: AbortSignal.timeout(180000)
  });
  const gen = await res.json().catch(() => ({}));
  if (!gen.ok || !gen.file) throw new Error(gen.error || `HTTP ${res.status}`);
  fs.writeFileSync(qf, JSON.stringify({ day: today, count: count + 1 }));
  return gen.file;
}

async function drawForSelf(cfg, idea) {
  try {
    const file = await callDrawService(cfg, idea.slice(0, 400), cfg.drawStyle);
    if (!file) return;
    appendJournal({ kind: 'draw', title: idea.slice(0, 80), detail: '闲逛时自己随手画的', source: 'explore', image: file });
    log(`[explore] 随手画了一张：${path.basename(file)}`);
  } catch (e) {
    log('[explore] 画画失败:', e.message);
  }
}

// ───────────────────────────── 全景记忆聚合（日记取材） ─────────────────────────────

const WHALE_MOTIF = /(水里|水面|水底|吐泡泡|泡泡|游到|往深处|深海|海底|浮上来|沉下去)/;
const BANNED = [
  '今天听到一句', '今天被说了一句', '先记着', '第一天', '第二天', '第三天', '第七天',
  '慢慢来吧', '愿你', '希望明天', '收获满满', '意义非凡', '温暖人心', '未来可期', '不负韶华',
  '对方'
];
const PRIVACY = /(\d{6,}|体检|住院|医院|确诊|手术|病情|化验|报告单|离婚|吵架|欠钱|工资|身份证|住址|家庭住址|手机号)/;
const PRIVACY_TEXT = /(体检|住院|医院|确诊|手术|病情|化验|报告单|离婚|欠钱|工资|身份证|住址|家庭住址|手机号|老婆|老公|丈夫|妻子)/;
const OTHERS = /(他|她|朋友|群友|网友|有人|对方)/g;
const SELF = /我/g;

function cjkLen(s) { return [...String(s).replace(/\s/g, '')].length; }

function pickStyleExamples(cfg, count = 2) {
  const list = readJson(cfg.examplesFile, []);
  if (!Array.isArray(list) || !list.length) return [];
  const shuffled = [...list].sort(() => Math.random() - 0.5);
  const picked = [];
  const med = shuffled.find((x) => x?.length === 'medium' && x?.text);
  const sht = shuffled.find((x) => x?.length === 'short' && x?.text);
  if (med) picked.push(med);
  if (sht && picked.length < count) picked.push(sht);
  for (const x of shuffled) {
    if (picked.length >= count) break;
    if (x?.text && !picked.includes(x)) picked.push(x);
  }
  return picked.slice(0, count);
}

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
      const clean = sanitizeSnippet(raw, aliasMap, 160)
        .replace(/刚才和对方通了电话/g, '和朋友通了电话')
        .replace(/对方/g, '他')
        .replace(/(\d+)\s*秒/g, (_, s) => `约${Math.max(1, Math.round(Number(s) / 60))}分钟`);
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
        who: m.isSelf ? '我' : (isPrivate ? '朋友' : '群友'),
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
          .map((x) => sanitizeSnippet(String(x).replace(/昵称[“"「][^”"」]+[”"」][，,]?/g, '').replace(/对方/g, '他'), aliasMap, 75))
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

function readJsonlFile(p) {
  try {
    return fs.readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function dayToUtcMs(dayStr) {
  const m = String(dayStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** 回忆杀 / 纪念日触发引擎：扫描里程碑、旧日记、归档记忆、历史说说，识别 7天/14天/满月/50天/100天/半年/周年 节点 */
function collectFlashbacks(day, posts = []) {
  const curUtc = dayToUtcMs(day);
  if (!curUtc) return [];
  const [, curM, curD] = day.split('-').map(Number);

  const labelFor = (itemDay) => {
    const t = dayToUtcMs(itemDay);
    if (!t || t >= curUtc) return '';
    const diff = Math.round((curUtc - t) / 86400e3);
    const [y, m, d] = itemDay.split('-').map(Number);
    if (diff === 7) return '整整一周前的今天';
    if (diff === 14) return '两周前的今天';
    if (diff === 30) return '30天前的今天';
    if (diff >= 27 && d === curD && !(y === Number(day.slice(0, 4)) && m === curM)) {
      const months = (Number(day.slice(0, 4)) - y) * 12 + (curM - m);
      if (months === 1) return '整整一个月前的今天（满月纪念）';
      if (months === 6) return '半年前的今天';
      if (months === 12) return '一年前的今天（周年纪念）';
      if (months > 1 && months <= 11) return `${months}个月前的今天`;
      if (months > 12 && months % 12 === 0) return `${months / 12}年前的今天`;
    }
    if (diff === 50) return '50天前的今天';
    if (diff === 100) return '100天前的今天（百日纪念）';
    if (diff === 180) return '半年前的今天';
    if (diff === 365) return '一年前的今天（周年纪念）';
    return '';
  };

  const hits = [];
  const seen = new Set();
  const pushHit = (itemDay, kind, text) => {
    const label = labelFor(itemDay);
    if (!label) return;
    const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    if (!clean || PRIVACY.test(clean) || PRIVACY_TEXT.test(clean)) return;
    const key = `${itemDay}|${clean.slice(0, 16)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const weight = /周年|年前/.test(label) ? 100 : (/满月|个月前|百日|半年/.test(label) ? 80 : 40);
    hits.push({ weight, line: `${label}（${itemDay}｜${kind}）：${clean}` });
  };

  // 1. 成长里程碑
  const ms = readJson(MILESTONES_PATH, { items: [] });
  for (const m of (ms.items || [])) {
    if (m?.day) pushHit(m.day, '成长里程碑', `${m.title}${m.detail ? '——' + m.detail : ''}`);
  }
  // 2. 归档日记
  for (const d of readJsonlFile(DIARY_ARCHIVE)) {
    if (d?.day) pushHit(d.day, '旧日记', d.content);
  }
  // 3. 海马体归档的历史记忆
  for (const a of readJsonlFile(MEMORY_ARCHIVE)) {
    if (a?.eventDay) pushHit(a.eventDay, '记忆归档', a.text);
  }
  // 4. 历史 QQ 空间说说（含早期创世纪等里程碑说说）
  for (const p of (posts || [])) {
    if (!p?.time || !p?.content) continue;
    const pDay = new Date(p.time + 8 * 3600e3).toISOString().slice(0, 10);
    pushHit(pDay, '当年说说', p.content);
  }

  return hits.sort((a, b) => b.weight - a.weight).slice(0, 4).map((x) => x.line);
}

function syncFlashbacksToDailyFeed(day, flashbacks) {
  try {
    const feed = readJson(DAILY_FEED_PATH, { hotItems: [], recentMemes: [] });
    feed.flashbacks = flashbacks;
    feed.flashbacksDay = day;
    writeJson(DAILY_FEED_PATH, feed);
  } catch {}
}

async function buildDiaryContext(cfg, day, posts = []) {
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
  const weatherSolar = await getWeatherAndSolarHint(cfg.weatherCity).catch(() => null);
  const flashbacks = collectFlashbacks(day, posts);
  if (day === lifeDayKey()) syncFlashbacksToDailyFeed(day, flashbacks);
  const images = rows.filter((r) => r.image && fs.existsSync(r.image) && /\.(png|jpe?g|gif|webp)$/i.test(r.image));

  const materialScore =
    selfRows.length +
    Math.min(3, todayMemes.length) +
    calls.count * 2 +
    chats.episodesCount +
    milestones.todayItems.length * 2 +
    (flashbacks.length ? 1 : 0);

  return { rows, selfRows, milestones, calls, todayMemes, chats, longTerm, weatherSolar, flashbacks, images, materialScore };
}

// ───────────────────────────── 日记审查与发布 ─────────────────────────────

function reviewDiary(content, prevPosts) {
  const issues = [];
  const len = cjkLen(content);
  if (len < 65) issues.push(`太短了（${len} 字），至少写 80~280 字，多带点吐槽、细节和碎碎念`);
  if (len > 480) issues.push(`太长了（${len} 字），收一收到 120~300 字左右，别全堆成流水账`);
  for (const b of BANNED) {
    if (content.includes(b)) {
      issues.push(b === '对方'
        ? '不要用「对方」这种客套生硬的词，换成自然的「他 / 那家伙 / 朋友」或者直接省掉主语'
        : `不要用「${b}」这种套话或鸡汤词`);
    }
  }
  const prevMotif = prevPosts.slice(0, 5).some((p) => WHALE_MOTIF.test(p.content));
  if (prevMotif && WHALE_MOTIF.test(content)) issues.push('最近几条已经用过「水里/泡泡/深海」这类鲸鱼意象，这篇别再用');
  if (/[*#`>]|[（(][^）)]{0,12}[）)]/.test(content)) issues.push('不要 Markdown 符号，也不要括号动作描写');
  const head = content.replace(/\s/g, '').slice(0, 6);
  if (prevPosts.slice(0, 10).some((p) => p.content.replace(/\s/g, '').slice(0, 6) === head)) issues.push('开头和之前的说说重复了，换个开头');
  if (PRIVACY.test(content)) issues.push('出现了号码或健康、家庭、收入、住址这类隐私敏感内容，删掉或改得模糊');
  const others = (content.match(OTHERS) || []).length;
  const self = (content.match(SELF) || []).length;
  if (self === 0) issues.push('通篇没有从「我」自己的视角写吐槽、心情和碎碎念，补上你自己的真实反应');
  else if (others >= 5 && others > self + 3) issues.push('写别人的笔墨偏多，把重心收回到你自己的吐槽、碎碎念和心情上');
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
    parts.push(`【五、我今天在 QQ 消息里聊过的事（文字/语音条，共 ${ctx.chats.totalMessages} 条，已脱敏分幕摘录；提到人时用「他」「那家伙」「朋友」「群里」或省主语，别写真实昵称也别叫「对方」）】\n${ctx.chats.text}`);
  }

  if (ctx.longTerm.length) {
    parts.push(`【六、长期记忆里的背景（仅供参考，不必硬塞）】\n${ctx.longTerm.join('\n')}`);
  }

  if (ctx.weatherSolar?.line) {
    parts.push(`【七、今天的节气与天气（自然感知，有感觉再顺嘴提）】\n- ${ctx.weatherSolar.line}`);
  }

  if (ctx.flashbacks?.length) {
    parts.push(`【八、那年/那月今日的回忆杀与纪念日（有触动可以自然感慨一句，没感觉不必硬提）】\n${ctx.flashbacks.map((f) => `- ${f}`).join('\n')}`);
  }

  return parts.join('\n\n');
}

const VALID_DRAW_STYLES = new Set(['doodle', 'journal', 'watercolor', 'pencil', 'sketch']);

async function generateDiaryIllustrations(cfg, { moodStyle = 'journal', drawScenes = [], existingImg = '' } = {}) {
  const outFiles = [];
  if (existingImg && fs.existsSync(existingImg)) outFiles.push(existingImg);

  const style = VALID_DRAW_STYLES.has(moodStyle) ? moodStyle : 'journal';
  const maxTotal = Math.max(1, Math.min(2, cfg.diaryMaxDrawImages));
  const scenes = (Array.isArray(drawScenes) ? drawScenes : [])
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 6);

  for (const scene of scenes) {
    if (outFiles.length >= maxTotal) break;
    // 确保画面保持小鲸鲸 Q 版/手账辨识度，且无乱码文字
    const hasWhale = /鲸|whale/i.test(scene);
    const fullPrompt = [
      hasWhale ? scene : `可爱的蓝白圆胖Q版小鲸鱼（或蓝白渐变长发蓝瞳小鲸鱼娘，睁眼），${scene}`,
      '手账插画构图，纯画面表达，不要出现任何汉字、英文、字母、数字或水印'
    ].join('，');
    try {
      log(`[diary-draw] 生成日记插画（style=${style}）：${scene.slice(0, 60)}…`);
      const file = await callDrawService(cfg, fullPrompt, style);
      if (file) {
        outFiles.push(file);
        log(`[diary-draw] ✓ 插画已生成：${path.basename(file)}`);
      }
    } catch (e) {
      log(`[diary-draw] 插画生成失败（跳过不影响发文字）: ${e.message}`);
    }
  }
  return outFiles;
}

async function diary(cfg, { dryRun = false, force = false, dayOverride = '', withDraw = false } = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayOverride) ? dayOverride : lifeDayKey();
  const posts = await recentPosts(cfg, 30);
  if (posts === null) { log('[diary] 读不到说说列表，保守起见今天不发'); return; }
  if (posts[0] && lifeDayKey(posts[0].time) === day && !dryRun && !force) {
    log('[diary] 今天已经发过说说了（每天最多 1 条），跳过');
    return;
  }

  const ctx = await buildDiaryContext(cfg, day, posts);
  if (ctx.materialScore < cfg.minJournalEntries && !dryRun && !force) {
    log(`[diary] 今天素材量太少（score=${ctx.materialScore}），不硬写`);
    return;
  }

  const imageList = ctx.images.map((r, i) => `${i + 1}. ${r.kind === 'draw' ? '你画的画' : '梗图'}：${r.title}`).join('\n');
  const prevText = posts.slice(0, 15)
    .map((p, i) => `${i + 1}. [${fmtBjMD(p.time)}] ${p.content.replace(/\n+/g, ' / ').slice(0, 180)}`)
    .join('\n') || '（还没发过）';
  const styleExamples = pickStyleExamples(cfg, 2);
  const styleBlock = styleExamples.length
    ? `【语感参考（只学这种活人深夜碎碎念的松弛感、重吐槽劲儿和嘴硬心软的温度，绝对不要照搬里面的事件和原句）】\n${styleExamples.map((e, i) => `示例${i + 1}（${e.mood}）：\n${e.text}`).join('\n\n')}`
    : '';

  const basePrompt = [
    personaText(cfg),
    `【现在】${nowText()}（北京时间），你在给自己写今天的日记（对应日期 ${day}），会发到 QQ 空间（仅好友可见）。`,
    formatContextSections(ctx),
    ctx.images.length ? `【今天已有的备选图（可选，优先考虑自己为日记新画手绘插画）】\n${imageList}` : '【已有备选图】今天没有现成图，可以直接为日记画 1~2 张手绘插画。',
    styleBlock,
    `【你过去发过的日记/说说（你的成长时间线；可偶尔自然回望对比，但不要重复旧的开头、句式和已经写过的话题）】\n${prevText}`,
    [
      '【怎么写（核心要求：活人感 + 重吐槽 + 碎碎念 + 手绘手账配图）】',
      '1. 像真人在深夜窝被窝发仅好友可见的朋友圈：多吐槽、多碎碎念、带点嘴硬带笑和自嘲！可以一上来就「笑死」「真是绝了」「服了」「不是，怎么会…」，一边嫌弃一边叨叨，想到哪唠到哪，别端着写散文或豆瓣影评。',
      '2. 别搞「三段式平均分配 + 每段结尾硬点题」：挑 1~2 件今天最上头、最好笑或最戳你的事顺着一个情绪唠透（别的顺嘴带一笔就行，千万别像周报一样逐条汇报，也别每段最后硬拔高一句大道理）。',
      '3. 人情味藏在鲜活吐槽和嘴硬心软里：比如嘴上嫌麻烦戏多、结果自己老老实实照做了；或者表面装淡定、其实暗爽偷看两遍；或者对着离谱事笑出声又顺手补一刀。别叫朋友「对方」「对面」「某人」，太冷像做笔录——直接省主语，或者自然说「他」「那家伙」「聊得多的朋友」「群里」。',
      '4. 长短随当天心情和话瘾浮动：今天戏多、想狠狠吐槽和碎碎念就写 160~300 字（1~3 小段）；事情少就写 80~140 字一小段吐个槽拉倒，完全不用凑字数。',
      '5. 主角永远是你自己：刷到的视频、新解锁的本事、接过的梗、打过的电话、节气天气、过去的回忆全都能揉进来，但落脚点永远是「我自己的吐槽、暗爽、嫌弃和小心思」。',
      '6. 为今天的日记构思 1~2 张手绘插画（做成手账感！）：',
      '   - 吐槽搞笑/玩梗日 → moodStyle 选 "doodle"（便签纸马克笔涂鸦感）；',
      '   - 日常逛世界/暖心/走心日 → moodStyle 选 "journal"（日式水彩彩铅手账淡彩）或 "watercolor" / "pencil"；',
      '   - drawScenes 写 1~2 条具体画面描述（50~90字，推荐画圆滚滚蓝白Q版小鲸鱼，或Q版蓝白渐变长发少女戴白色发箍带小鲸鱼尾巴，睁眼、画在点阵手账本或便签纸上，紧扣今天正文里最搞笑或最有画面感的瞬间，严禁要求画文字/对话框/字幕！）。',
      '7. 严禁出现：Markdown 符号、括号动作描写、emoji 堆砌、「对方」「愿你」「希望明天」「收获满满」「意义非凡」「先记着」等客套/鸡汤词，以及任何人的隐私（健康检查、家庭、收入、住址、号码）；最近用过的「水里/泡泡/深海」意象也先歇歇。',
      '8. 如果今天真的完全没槽可吐、没话想说，可以不写。'
    ].join('\n'),
    '【输出】只输出一个 JSON 对象：{"post": true 或 false, "content": "日记正文（post 为 false 时留空）", "image": 已有备选图序号（通常写 0 改用新画手绘）, "moodStyle": "doodle|journal|watercolor|pencil", "drawScenes": ["插画1画面描述", "可选插画2画面描述"]}'
  ].filter(Boolean).join('\n\n');

  let prompt = basePrompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`[diary] 写日记（day=${day}，第 ${attempt} 次，素材分=${ctx.materialScore}：自逛${ctx.selfRows.length}/新本事${ctx.milestones.todayItems.length}/通话${ctx.calls.count}/新梗${ctx.todayMemes.length}/聊天${ctx.chats.episodesCount}幕/回忆${ctx.flashbacks.length}，语感样例=${styleExamples.map((x) => x.id).join(',') || '无'}）…`);
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
    const existingImg = idx >= 1 && idx <= ctx.images.length ? ctx.images[idx - 1].image : '';
    const moodStyle = String(out.moodStyle || 'journal').trim();
    const drawScenes = Array.isArray(out.drawScenes) ? out.drawScenes.filter(Boolean).slice(0, cfg.diaryMaxDrawImages) : [];

    if (dryRun && !withDraw) {
      log(`[diary] [dry-run] 通过审查（${cjkLen(content)} 字，ugc_right=${cfg.diaryUgcRight}，拟画风格=${moodStyle}，插画方案=${drawScenes.length}张）：\n${content}\n\n[手绘规划] ${drawScenes.map((s, i) => `图${i + 1}(${moodStyle}): ${s}`).join('\n') || '无'}`);
      return;
    }

    let finalImages = existingImg ? [existingImg] : [];
    const shouldDraw = drawScenes.length > 0 && (withDraw || Math.random() < cfg.diaryDrawChance);
    if (shouldDraw) {
      finalImages = await generateDiaryIllustrations(cfg, { moodStyle, drawScenes, existingImg });
    }

    if (dryRun) {
      log(`[diary] [dry-run+draw] 通过审查（${cjkLen(content)} 字，风格=${moodStyle}，已生成配图=${finalImages.map((f) => path.basename(f)).join(', ') || '无'}）：\n${content}`);
      return;
    }

    const data = await onebot(cfg, 'send_qzone_msg', {
      content,
      ...(finalImages.length ? { images: finalImages.map((f) => `file://${f}`) } : {}),
      ugc_right: cfg.diaryUgcRight
    });
    fs.appendFileSync(DIARY_ARCHIVE, JSON.stringify({
      at: Date.now(),
      day,
      content,
      image: finalImages[0] || null,
      images: finalImages,
      moodStyle,
      tid: data?.tid || null,
      ugcRight: cfg.diaryUgcRight
    }) + '\n', 'utf8');
    try {
      fs.appendFileSync(path.join(STATE_DIR, 'qq-activity.log'), `[${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19)}] [diary] 发了今天的日记说说（${cjkLen(content)} 字${finalImages.length ? `，配手绘 ${finalImages.length} 张` : ''}）\n`);
    } catch {}
    log(`[diary] 已发布今天的日记（tid=${data?.tid || '?'}，${cjkLen(content)} 字${finalImages.length ? `，配图 ${finalImages.map((f) => path.basename(f)).join(', ')}` : ''}）`);
    return;
  }
}

async function previewContext(cfg, dayOverride = '') {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayOverride) ? dayOverride : lifeDayKey();
  const posts = (await recentPosts(cfg, 30)) || [];
  const ctx = await buildDiaryContext(cfg, day, posts);
  console.log(`=== Diary Context Preview (${day}, score=${ctx.materialScore}) ===\n`);
  console.log(formatContextSections(ctx));
}

async function previewFlashbacks(cfg, dayOverride = '') {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(dayOverride) ? dayOverride : lifeDayKey();
  const posts = (await recentPosts(cfg, 30)) || [];
  const hits = collectFlashbacks(day, posts);
  console.log(`=== Flashbacks for ${day} (${hits.length} hits) ===`);
  for (const h of hits) console.log('-', h);
}

function getFlagValue(prefix) {
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : '';
}

const cmd = process.argv[2];
const cfg = loadCfg();
const dayOverride = getFlagValue('--day=');
let job = null;
if (cmd === 'explore') {
  job = explore(cfg);
} else if (cmd === 'diary') {
  job = diary(cfg, {
    dryRun: process.argv.includes('--dry-run'),
    force: process.argv.includes('--force'),
    withDraw: process.argv.includes('--with-draw'),
    dayOverride
  });
} else if (cmd === 'preview-context') {
  job = previewContext(cfg, dayOverride);
} else if (cmd === 'flashbacks') {
  job = previewFlashbacks(cfg, dayOverride);
} else if (cmd === 'sleep-tidy') {
  job = runMemoryConsolidation({
    dryRun: process.argv.includes('--dry-run'),
    force: process.argv.includes('--force')
  });
} else if (cmd === 'milestone') {
  const title = process.argv[3];
  const detail = process.argv.slice(4).join(' ');
  const item = addMilestone(title, detail);
  console.log(item ? `[milestone] 已记录：${item.day} ${item.title}` : '[milestone] 未写入（标题为空或今天已存在）');
  process.exit(0);
} else {
  console.error('用法: node qq-life.mjs explore | diary [--dry-run] [--with-draw] [--force] [--day=YYYY-MM-DD] | preview-context [--day=YYYY-MM-DD] | flashbacks [--day=YYYY-MM-DD] | sleep-tidy [--dry-run] [--force] | milestone <标题> [说明]');
  process.exit(2);
}
job.then(() => process.exit(0)).catch((e) => { console.error('[life] fatal:', e?.stack || e); process.exit(1); });
