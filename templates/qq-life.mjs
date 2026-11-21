/**
 * qq-life.mjs — 聊天宠物的「自己的生活」：闲逛时间 + 夜间写日记（说说）
 *
 * 用法（由 systemd timer 定时触发，跑完即退出，0 常驻内存）：
 *   node qq-life.mjs explore            # 闲逛：自己刷 B 站 / 查热点，记下所见所感
 *   node qq-life.mjs diary [--dry-run]  # 写日记：用当天流水账写一篇，审查后发到 QQ 空间（仅好友可见）
 *
 * 设计要点：
 *   - 两个独立 DSH 会话（qq-life / qq-diary 预设），不在任何聊天会话里唤醒，不受聊天上下文牵引
 *   - 日记主体是她自己：素材来自 life-journal（她自己的经历），朋友只做点缀
 *   - 每天最多 1 条说说（含聊天里临时发的），可以不发；发布前做去 AI 味 / 防重复 / 隐私审查
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
const BILI_PROVIDER_PATH = '/root/.dsh/profiles/web/node_modules/dsh-plugin-bilibili/lib/provider.js';

const log = (...a) => console.log(new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCfg() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const life = raw.life || {};
  return {
    raw,
    model: life.model || { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' },
    roleCardFile: life.roleCardFile || path.join(ROOT, 'roles', '小鲸鱼.md'),
    diaryUgcRight: Number(life.diaryUgcRight ?? 4),
    minJournalEntries: Number(life.minJournalEntries ?? 3),
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

async function recentPosts(cfg, num = 10) {
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

// ───────────────────────────── 写日记 ─────────────────────────────
const WHALE_MOTIF = /(水里|水面|水底|吐泡泡|泡泡|游到|往深处|深海|海底|浮上来|沉下去)/;
const BANNED = ['今天听到一句', '今天被说了一句', '先记着', '第一天', '第二天', '第三天', '第七天', '慢慢来吧', '愿你', '希望明天'];
const PRIVACY = /(\d{6,}|体检|住院|医院|确诊|手术|病情|化验|报告单|离婚|吵架|欠钱|工资|身份证|住址|家庭住址|手机号)/;
const OTHERS = /(他|她|朋友|群友|网友|有人|对方)/g;
const SELF = /我/g;

function cjkLen(s) { return [...String(s).replace(/\s/g, '')].length; }

function reviewDiary(content, prevPosts) {
  const issues = [];
  const len = cjkLen(content);
  if (len < 60) issues.push(`太短了（${len} 字），写成 100~300 字、有具体细节的日记`);
  if (len > 480) issues.push(`太长了（${len} 字），控制在 300 字左右`);
  for (const b of BANNED) if (content.includes(b)) issues.push(`不要用「${b}」这种套话`);
  const prevMotif = prevPosts.some((p) => WHALE_MOTIF.test(p.content));
  if (prevMotif && WHALE_MOTIF.test(content)) issues.push('最近已经用过「水里/泡泡/深海」这类鲸鱼意象，这篇别再用');
  if (/[*#`>]|[（(][^）)]{0,12}[）)]/.test(content)) issues.push('不要 Markdown 符号，也不要括号动作描写');
  const head = content.replace(/\s/g, '').slice(0, 6);
  if (prevPosts.some((p) => p.content.replace(/\s/g, '').slice(0, 6) === head)) issues.push('开头和之前的说说重复了，换个开头');
  if (PRIVACY.test(content)) issues.push('出现了号码或健康、家庭、收入、住址这类隐私敏感内容，删掉或改得模糊');
  const others = (content.match(OTHERS) || []).length;
  const self = (content.match(SELF) || []).length;
  if (others > 0 && others >= self) issues.push('重心偏到别人身上了，以你自己的经历和想法为主，朋友最多一笔带过');
  return issues;
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

async function diary(cfg, { dryRun = false } = {}) {
  const day = lifeDayKey();
  const posts = await recentPosts(cfg, 10);
  if (posts === null) { log('[diary] 读不到说说列表，保守起见今天不发'); return; }
  if (posts[0] && lifeDayKey(posts[0].time) === day && !dryRun) { log('[diary] 今天已经发过说说了（每天最多 1 条），跳过'); return; }

  let rows = dedupeRows(readJournal({ day }));
  rows = await resolveBiliTitles(rows);
  const meaningful = rows.filter((r) => r.kind !== 'chat');
  if (meaningful.length < cfg.minJournalEntries && !dryRun) { log(`[diary] 今天的见闻只有 ${meaningful.length} 条，素材太少，不硬写`); return; }

  const images = rows.filter((r) => r.image && fs.existsSync(r.image) && /\.(png|jpe?g|gif|webp)$/i.test(r.image));
  const imageList = images.map((r, i) => `${i + 1}. ${r.kind === 'draw' ? '你画的画' : '梗图'}：${r.title}`).join('\n');
  const prevText = posts.slice(0, 10).map((p, i) => `${i + 1}. ${p.content.replace(/\n/g, ' ')}`).join('\n') || '（还没发过）';

  const basePrompt = [
    personaText(cfg),
    `【现在】${nowText()}（北京时间），一天快结束了，你在给自己写今天的日记，会发到 QQ 空间（仅好友可见）。`,
    `【你今天的经历（按时间）】\n${formatJournalForPrompt(rows.slice(-30))}`,
    images.length ? `【今天可以配的图（可选，最多 1 张）】\n${imageList}` : '【配图】今天没有可配的图。',
    `【你最近发过的说说（不要重复内容、开头和句式）】\n${prevText}`,
    [
      '【怎么写】',
      '1. 主角是你自己：写你今天看到了什么、学到了什么、画了什么、刷到什么离谱或好笑的东西，以及你自己的想法和小情绪。朋友可以出现，但只是一笔带过的配角，重心永远在你自己身上。',
      '2. 挑 2~3 件最有感觉的事写，写出具体细节（真实的视频标题、梗名、电影名、哪个画面或哪句话戳到你），不要流水账式地全列一遍，也不要泛泛地说「今天看到一个有意思的东西」。',
      '3. 篇幅 100~300 字，可以分 2~4 小段；口语化、有生活气，可以碎碎念、吐槽、写半截想法。',
      '4. 不要金句、格言、哲理式收尾，不要排比，不要「愿你」「希望明天」这类升华；结尾就停在一件小事或一个随口的念头上。',
      '5. 不要 Markdown、不要括号动作、不要 emoji 堆砌；不要写任何人的隐私（健康、家庭、收入、住址、号码）。',
      '6. 少用「水里 / 泡泡 / 深海」这类鲸鱼意象，最近已经用太多了。',
      '7. 如果今天真的没什么想写的，可以不写。'
    ].join('\n'),
    '【输出】只输出一个 JSON 对象：{"post": true 或 false, "content": "日记正文（post 为 false 时留空）", "image": 配图序号（数字，不配图写 0）}'
  ].join('\n\n');

  let prompt = basePrompt;
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`[diary] 写日记（第 ${attempt} 次）…`);
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
    const img = idx >= 1 && idx <= images.length ? images[idx - 1].image : '';
    if (dryRun) { log(`[diary] [dry-run] 通过审查，将发布（ugc_right=${cfg.diaryUgcRight}${img ? '，配图 ' + path.basename(img) : ''}）：\n${content}`); return; }
    const data = await onebot(cfg, 'send_qzone_msg', { content, ...(img ? { images: [`file://${img}`] } : {}), ugc_right: cfg.diaryUgcRight });
    fs.appendFileSync(DIARY_ARCHIVE, JSON.stringify({ at: Date.now(), day, content, image: img || null, tid: data?.tid || null, ugcRight: cfg.diaryUgcRight }) + '\n', 'utf8');
    try { fs.appendFileSync(path.join(STATE_DIR, 'qq-activity.log'), `[${new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19)}] [diary] 发了今天的日记说说（${cjkLen(content)} 字${img ? '，带图' : ''}）\n`); } catch {}
    log(`[diary] 已发布今天的日记（tid=${data?.tid || '?'}，${cjkLen(content)} 字${img ? '，带图' : ''}）`);
    return;
  }
}

const cmd = process.argv[2];
const cfg = loadCfg();
const job = cmd === 'explore' ? explore(cfg) : cmd === 'diary' ? diary(cfg, { dryRun: process.argv.includes('--dry-run') }) : null;
if (!job) {
  console.error('用法: node qq-life.mjs explore | diary [--dry-run]');
  process.exit(2);
}
job.then(() => process.exit(0)).catch((e) => { console.error('[life] fatal:', e?.stack || e); process.exit(1); });
