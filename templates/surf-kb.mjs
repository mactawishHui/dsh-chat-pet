import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serperGoogleSearch } from './reverse-image.mjs';

const execFileAsync = promisify(execFile);

export const ROOT = '/opt/qq-bridge';
export const DAILY_FEED_PATH = path.join(ROOT, 'state', 'daily-feed.json');
export const MEME_KB_PATH = path.join(ROOT, 'state', 'meme-kb.json');
export const MEME_DIR = path.join(ROOT, 'audio', 'memes');
export const DASHSCOPE_KEY_PATH = '/opt/qq-tts/apikey.txt';
export const PROXY_URL = 'http://127.0.0.1:7890';

const MOEGIRL_CATEGORIES = [
  'Category:中国网络流行语句',
  'Category:弹幕网站成句',
  'Category:ACG圈成句',
  'Category:迷因'
];

const BILI_PROVIDER_PATH = '/root/.dsh/profiles/web/node_modules/dsh-plugin-bilibili/lib/provider.js';
const BILI_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
let biliProviderSingleton = null;

async function getBiliProvider() {
  if (biliProviderSingleton) return biliProviderSingleton;
  try {
    const mod = await import(BILI_PROVIDER_PATH);
    biliProviderSingleton = new mod.BilibiliOfficialProvider();
    return biliProviderSingleton;
  } catch {
    return null;
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBiliVideoContext(bvid) {
  const p = await getBiliProvider();
  if (!p || !bvid) return null;
  try {
    const v = await p.video({ bvid });
    const cookie = [...(p.anonymousCookies?.entries?.() || [])].map(([k, val]) => `${k}=${val}`).join('; ');
    const headers = { 'User-Agent': BILI_UA, ...(cookie ? { Cookie: cookie } : {}) };
    const [tagRes, replyRes] = await Promise.all([
      fetch(`https://api.bilibili.com/x/tag/archive/tags?bvid=${encodeURIComponent(bvid)}`, { headers, signal: AbortSignal.timeout(8000) })
        .then((r) => r.json()).catch(() => ({})),
      v.aid
        ? fetch(`https://api.bilibili.com/x/v2/reply?type=1&oid=${encodeURIComponent(v.aid)}&sort=2&ps=5&pn=1`, { headers, signal: AbortSignal.timeout(8000) })
            .then((r) => r.json()).catch(() => ({}))
        : Promise.resolve({})
    ]);
    const tags = (tagRes?.data || []).slice(0, 12).map((x) => x.tag_name).filter(Boolean);
    const comments = (replyRes?.data?.replies || []).slice(0, 5)
      .map((c) => String(c?.content?.message || '').replace(/\s+/g, ' ').trim().slice(0, 160))
      .filter(Boolean);
    return {
      bvid,
      url: `https://www.bilibili.com/video/${bvid}`,
      title: String(v.title || '').trim(),
      author: String(v.author || '').trim(),
      desc: String(v.description || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      tags,
      comments
    };
  } catch {
    return null;
  }
}

function extractMemeNameFromBiliTitle(title) {
  let s = String(title || '').trim();
  // 去掉前后【梗指南】【白给梗科普】等括号前缀后缀
  s = s.replace(/【[^】]*(?:梗指南|梗百科|梗科普|白给|科普|热梗)[^】]*】/g, '').trim();
  const m = s.match(/^(.+?)(?:到底)?是什么梗/);
  if (m && m[1]) s = m[1].trim();
  s = s.replace(/^[“"「『《]+|[”"」』》？?!！：:\s]+$/g, '').trim();
  // 过滤太泛或站内吃瓜标题
  if (!s || s.length < 2 || s.length > 20 || /梗指南|道歉|炸体育场/.test(s)) return '';
  return s;
}

async function lookupMemeViaBilibili(query) {
  const p = await getBiliProvider();
  if (!p) return null;
  const kw = /是什么梗/.test(query) ? query : `${query} 是什么梗`;
  let items = [];
  try {
    const r = await p.search({ keyword: kw, page: 1, pageSize: 6 });
    items = r?.items || [];
  } catch {
    return null;
  }
  if (!items.length) return null;

  // 优先选专业解梗 UP 主或标题含“是什么梗”的视频
  const ranked = items.map((it) => {
    let score = 0;
    const t = String(it.title || '');
    const a = String(it.author || '');
    if (/梗指南|梗百科|梗科普|万恶之源/.test(a + t)) score += 40;
    if (/是什么梗|啥梗|科普/.test(t)) score += 25;
    if (t.toLowerCase().includes(query.toLowerCase())) score += 30;
    return { it, score };
  }).sort((a, b) => b.score - a.score);

  const snippets = [];
  for (const { it } of ranked.slice(0, 4)) {
    const desc = String(it.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);
    snippets.push(`- [${it.author}] ${it.title} (${it.bvid})${desc ? ' | 简介: ' + desc : ''}`);
  }

  // 并发拉取排名第 1 个科普视频详情 + Serper Google 交叉佐证（防止 B 站标题党或敏感梗被过滤导致望文生义）
  const [detail, googleHits] = await Promise.all([
    (async () => {
      if (!ranked[0]?.it?.bvid) return null;
      await sleepMs(400);
      return fetchBiliVideoContext(ranked[0].it.bvid);
    })(),
    serperGoogleSearch(`${query} 是什么梗 出处`, { num: 4 }).catch(() => [])
  ]);

  const googleSection = Array.isArray(googleHits) && googleHits.length
    ? `\n全网（知乎/百科/B站）交叉佐证摘要：\n${googleHits.map((x, i) => `${i + 1}. ${x.title} — ${x.snippet}`).join('\n')}`
    : '';

  const evidence = [
    `用户查询的梗：${query}`,
    `B站搜索「${kw}」命中的视频列表：`,
    ...snippets,
    detail ? `\n重点科普视频详情：\n标题：${detail.title}\nUP主：${detail.author}\n链接：${detail.url}\n简介：${detail.desc}\n标签：${detail.tags.join('、')}\n热评：\n${detail.comments.map((c) => '  * ' + c).join('\n')}` : '',
    googleSection
  ].filter(Boolean).join('\n');

  const sys = [
    '你是 B 站与中文互联网热梗解析器。严格依据下面真实的 B 站搜索结果、视频标签、热评与全网交叉佐证提炼梗知识 JSON。',
    '要求：',
    '1. 严禁望文生义（例如把日语空耳按中文字面乱解），也严禁把毫不相干的动漫角色/台词张冠李戴！若全网交叉佐证给出了明确出处（含空耳/鬼畜/恶搞语境），必须以交叉佐证为准；线索不足或毫不相干则返回 {"found": false}。',
    '2. 若确切能从视频标题/标签/热评中确认这个梗，严格只输出 JSON 对象：',
    '- found: true',
    '- name: 字符串（最常用的梗名）',
    '- aliases: 字符串数组（常见别名/原句/谐音，最多 4 个）',
    '- origin: 字符串（结合视频线索总结的具体出处/背景，≤80字）',
    '- meaning: 字符串（核心笑点/情绪含义，≤75字）',
    '- usage: 字符串（网友怎么自然玩梗/接梗，附 1 句简短例句，≤80字）',
    '- replies: 字符串数组（2~4 句别人抛这个梗时最地道的“接梗下句/名台词/捧哏回话”，用于直接入戏接梗而不是科普）',
    '- mood: 字符串数组（适用情绪标签，2~4个）',
    '- searchKeywords: 字符串数组（去中文表情包库搜图的 1~2 个精准短词，避免无意义字面拆词）'
  ].join('\n');

  const parsed = await callDashScopeJson(sys, evidence, { maxTokens: 650, timeoutMs: 22000 });
  if (parsed && parsed.found === true && parsed.name && parsed.meaning) {
    return {
      ...parsed,
      biliUrl: detail?.url || (ranked[0]?.it?.bvid ? `https://www.bilibili.com/video/${ranked[0].it.bvid}` : '')
    };
  }
  return null;
}

async function fetchFreshBiliMemeCandidates(limit = 6) {
  const p = await getBiliProvider();
  if (!p) return [];
  const results = [];
  for (const kw of ['梗指南', '白给梗科普']) {
    try {
      const r = await p.search({ keyword: kw, page: 1, pageSize: 8, order: 'pubdate' });
      for (const it of (r?.items || [])) {
        const memeName = extractMemeNameFromBiliTitle(it.title);
        if (memeName && it.bvid && !results.some((x) => x.memeName === memeName)) {
          results.push({ memeName, bvid: it.bvid, title: it.title, author: it.author });
        }
        if (results.length >= limit) break;
      }
    } catch {
      // ignore occasional rate limit
    }
    if (results.length >= limit) break;
    await sleepMs(1200);
  }
  return results;
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

async function curlText(url, { proxy = false, timeoutSec = 10, headers = {} } = {}) {
  const args = ['-sS', '-L', '--max-time', String(timeoutSec), '-A', 'Mozilla/5.0 (compatible; DSH-ChatPet/1.0)'];
  if (proxy) args.push('-x', PROXY_URL);
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push(url);
  const { stdout } = await execFileAsync('curl', args, { maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

async function curlDownload(url, destPath, { proxy = false, timeoutSec = 12, maxBytes = 4 * 1024 * 1024 } = {}) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part.${process.pid}`;
  const args = ['-sS', '-L', '--max-time', String(timeoutSec), '--max-filesize', String(maxBytes), '-A', 'Mozilla/5.0', '-o', tmp, '-w', '%{http_code}'];
  if (proxy) args.push('-x', PROXY_URL);
  args.push(url);
  try {
    const { stdout } = await execFileAsync('curl', args, { timeout: (timeoutSec + 3) * 1000 });
    const code = Number(String(stdout).trim());
    if (code !== 200 || !fs.existsSync(tmp)) {
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
    const st = fs.statSync(tmp);
    if (st.size < 1024 || st.size > maxBytes) {
      try { fs.unlinkSync(tmp); } catch {}
      return false;
    }
    fs.renameSync(tmp, destPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
    return false;
  }
}

async function callDashScopeJson(systemPrompt, userPrompt, { maxTokens = 1000, timeoutMs = 25000, enableSearch = false } = {}) {
  let apiKey = '';
  try { apiKey = fs.readFileSync(DASHSCOPE_KEY_PATH, 'utf8').trim(); } catch {}
  if (!apiKey) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const payload = {
      model: 'qwen-plus-latest',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.3,
      max_tokens: maxTokens,
      enable_thinking: false
    };
    if (enableSearch) {
      payload.enable_search = true;
      payload.search_options = { forced_search: true, search_strategy: 'pro' };
    }
    const resp = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: ac.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    let raw = String(data?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const sObj = raw.indexOf('{');
    const sArr = raw.indexOf('[');
    let start = -1;
    let end = -1;
    if (sObj >= 0 && (sArr < 0 || sObj < sArr)) {
      start = sObj; end = raw.lastIndexOf('}');
    } else if (sArr >= 0) {
      start = sArr; end = raw.lastIndexOf(']');
    }
    if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
    return JSON.parse(raw);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── 1. 抓取公开实时热点（B站热门 / 豆瓣电影 / 头条热榜）────────────────────────
async function fetchBilibiliPopular() {
  try {
    const txt = await curlText('https://api.bilibili.com/x/web-interface/popular?ps=12&pn=1', { timeoutSec: 8 });
    const list = JSON.parse(txt)?.data?.list || [];
    return list.slice(0, 12).map((v) => ({
      source: 'B站热门',
      title: String(v.title || '').trim(),
      extra: `${v.owner?.name || ''} · ${v.tname || ''}${v.rcmd_reason?.content ? ' · ' + v.rcmd_reason.content : ''}`.trim(),
      url: v.bvid ? `https://www.bilibili.com/video/${v.bvid}` : ''
    })).filter((x) => x.title);
  } catch {
    return [];
  }
}

async function fetchDoubanHotMovies() {
  try {
    const txt = await curlText('https://movie.douban.com/j/search_subjects?type=movie&tag=%E7%83%AD%E9%97%A8&page_limit=10&page_start=0', { timeoutSec: 8 });
    const list = JSON.parse(txt)?.subjects || [];
    return list.slice(0, 10).map((m) => ({
      source: '豆瓣热门电影',
      title: `《${String(m.title || '').trim()}》`,
      extra: m.rate ? `评分 ${m.rate}` : '新片热议',
      url: String(m.url || '')
    })).filter((x) => x.title.length > 2);
  } catch {
    return [];
  }
}

async function fetchToutiaoHot() {
  try {
    const txt = await curlText('https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', { timeoutSec: 8 });
    const list = JSON.parse(txt)?.data || [];
    return list.slice(0, 12).map((x) => ({
      source: '全网热榜',
      title: String(x.Title || '').trim(),
      extra: x.LabelDesc || '',
      url: String(x.Url || '')
    })).filter((x) => x.title);
  } catch {
    return [];
  }
}

// ── 2. 萌娘百科公开 MediaWiki API（经本地代理）────────────────────────────────
async function moegirlApi(params) {
  const qs = new URLSearchParams({ ...params, format: 'json' }).toString();
  const txt = await curlText(`https://moegirl.uk/api.php?${qs}`, { proxy: true, timeoutSec: 12 });
  return JSON.parse(txt);
}

async function fetchMoegirlCategoryTitles(category, limit = 15) {
  try {
    const data = await moegirlApi({
      action: 'query',
      list: 'categorymembers',
      cmtitle: category,
      cmlimit: String(limit),
      cmsort: 'timestamp',
      cmdir: 'desc'
    });
    return (data?.query?.categorymembers || [])
      .map((x) => String(x.title || '').trim())
      .filter((t) => t && !t.startsWith('Category:') && !t.startsWith('Template:') && !t.includes('列表') && !t.includes('导航'));
  } catch {
    return [];
  }
}

async function searchMoegirlTitle(query) {
  try {
    const data = await moegirlApi({
      action: 'query',
      list: 'search',
      srsearch: query,
      srnamespace: '0',
      srlimit: '5'
    });
    return (data?.query?.search || []).map((x) => String(x.title || '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchMoegirlWikitext(title) {
  try {
    const data = await moegirlApi({
      action: 'parse',
      page: title,
      prop: 'wikitext'
    });
    const raw = data?.parse?.wikitext?.['*'] || '';
    return raw.slice(0, 3500);
  } catch {
    return '';
  }
}

// ── 3. MemeCub 官方中文表情包/梗图搜索（免 Key 直连）──────────────────────────
export async function searchMemeCub(query, limit = 3) {
  try {
    const qs = new URLSearchParams({ q: query, limit: String(limit) }).toString();
    const txt = await curlText(`https://memecub.com/api/v1/search?${qs}`, { proxy: false, timeoutSec: 10 });
    const items = JSON.parse(txt)?.data || [];
    return items.filter((it) => it && it.url && it.profane !== true);
  } catch {
    return [];
  }
}

function cleanMemeSearchQuery(str) {
  return String(str || '')
    .replace(/oo|xx|OO|XX/g, '')
    .replace(/[？?！!。，,、()（）《》\[\]【】]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
}

async function fetchAndSaveMemeImage(memeName, searchKeywords = []) {
  const candidates = [];
  for (const kw of [memeName, ...searchKeywords]) {
    const c = cleanMemeSearchQuery(kw);
    if (c && c.length >= 2 && !candidates.includes(c)) candidates.push(c);
  }
  for (const q of candidates.slice(0, 2)) {
    const items = await searchMemeCub(q, 3);
    if (!items.length) continue;
    const picked = items.find((it) => it.title_zh || (Array.isArray(it.tags_zh) && it.tags_zh.length)) || items[0];
    const extRaw = String(picked.format || path.extname(picked.url || '').replace('.', '') || 'jpg').toLowerCase();
    const ext = ['gif', 'png', 'jpg', 'jpeg', 'webp'].includes(extRaw) ? extRaw : 'jpg';
    const fileName = `${picked.id}.${ext}`;
    const dest = path.join(MEME_DIR, fileName);
    if (!fs.existsSync(dest)) {
      const ok = await curlDownload(picked.url, dest, { proxy: false, timeoutSec: 12 });
      if (!ok) continue;
    }
    return {
      imageFile: dest,
      imageId: picked.id,
      imageTitle: picked.title_zh || picked.title || memeName,
      imageDesc: String(picked.description || '').slice(0, 220),
      imageTags: Array.isArray(picked.tags_zh) && picked.tags_zh.length ? picked.tags_zh.slice(0, 8) : (picked.tags || []).slice(0, 8),
      matchedQuery: q
    };
  }
  return null;
}

async function distillMemeFromWikitext(title, wikitext, userQuery = '') {
  const sys = [
    '你是中文互联网文化与梗解析器。根据萌娘百科词条的原始 wikitext，提炼出给聊天机器人用的简洁 JSON。',
    '严格只输出 JSON 对象，包含字段：',
    '- relevant: 布尔值（若给出了用户查询词，判断这个词条是否**确实就是**用户查的那个梗/别名/出处；如果只是凑巧含一两个相同字、实际毫不相干，必须返回 false！）',
    '- name: 字符串（最常用的梗名）',
    '- aliases: 字符串数组（常见别名/谐音/变体，最多 4 个）',
    '- origin: 字符串（一句话出处/背景，≤60字）',
    '- meaning: 字符串（核心含义/笑点，≤60字）',
    '- usage: 字符串（网友平时在什么语境下自然玩这个梗，附 1 句简短例句，≤70字）',
    '- replies: 字符串数组（2~4 句别人抛这个梗时最地道的“接梗下句/名台词/捧哏回话”，用于直接入戏接梗）',
    '- mood: 字符串数组（适用情绪/场景标签，如 吐槽/嘲讽/震惊/装傻/离谱/催更/玩梗，2~4个）',
    '- searchKeywords: 字符串数组（用于去中文表情包库搜索对应梗图的 1~3 个最核心短词，2~6字，去掉 oo/xx 占位符）'
  ].join('\n');
  const prompt = userQuery
    ? `用户查询词：${userQuery}\n候选萌娘百科词条名：${title}\n\nWikitext：\n${wikitext}`
    : `词条名：${title}\n\nWikitext：\n${wikitext}`;
  const parsed = await callDashScopeJson(sys, prompt, { maxTokens: 520 });
  if (parsed) {
    if (userQuery && parsed.relevant === false) return { relevant: false };
    if (parsed.name && parsed.meaning) return { ...parsed, relevant: true };
  }
  if (userQuery) return { relevant: false };
  const plain = wikitext.replace(/\{\{[^}]*\}\}/g, '').replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1').replace(/'''?/g, '').replace(/\s+/g, ' ').trim();
  return {
    relevant: true,
    name: title,
    aliases: [],
    origin: '萌娘百科收录网络梗',
    meaning: plain.slice(0, 80) || title,
    usage: '群聊接梗或吐槽时自然使用',
    mood: ['玩梗'],
    searchKeywords: [cleanMemeSearchQuery(title)]
  };
}

async function callDashScopeNativeSearchJson(systemPrompt, userPrompt, { maxTokens = 700, timeoutMs = 28000 } = {}) {
  let apiKey = '';
  try { apiKey = fs.readFileSync(DASHSCOPE_KEY_PATH, 'utf8').trim(); } catch {}
  if (!apiKey) return null;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'qwen-plus-latest',
        input: {
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ]
        },
        parameters: {
          result_format: 'message',
          temperature: 0.2,
          max_tokens: maxTokens,
          enable_search: true,
          search_options: {
            forced_search: true,
            enable_source: true,
            search_strategy: 'standard'
          }
        }
      }),
      signal: ac.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const sources = data?.output?.search_info?.search_results || [];
    let raw = String(data?.output?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const sObj = raw.indexOf('{');
    const eObj = raw.lastIndexOf('}');
    if (sObj >= 0 && eObj > sObj) raw = raw.slice(sObj, eObj + 1);
    const parsed = JSON.parse(raw);
    return { parsed, sourceCount: sources.length };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function lookupMemeViaWebSearch(query) {
  let googleSnippets = '';
  try {
    const sp = await serperGoogleSearch(`${query} 是什么梗 出处`, { num: 6 });
    if (Array.isArray(sp) && sp.length) {
      googleSnippets = sp.map((x, i) => `${i + 1}. ${x.title}\n   ${x.snippet}`).join('\n');
    }
  } catch {
    // fallback to DashScope native search below
  }

  const sys = [
    '你是中文互联网网络热梗（B站/抖音/三国杀/ACG/空耳/游戏圈等）核查解析器。',
    '必须基于搜索结果与准确已知事实作答，严禁胡编或把毫不相干的词条硬拼接进来！',
    '如果确实不知道该梗的确切出处，或搜索结果都毫不相干，必须返回 {"found": false}，绝不瞎编。',
    '若确切知道/查到出处，严格只输出 JSON 对象：',
    '- found: true',
    '- name: 字符串（最常用的梗名）',
    '- aliases: 字符串数组（常见别名/空耳原文/完整台词，最多 4 个）',
    '- origin: 字符串（具体准确出处：作品/游戏/宣传片/原句或空耳来源，≤80字）',
    '- meaning: 字符串（核心笑点/表达的情绪含义，≤75字）',
    '- usage: 字符串（网友怎么自然玩这个梗，≤80字）',
    '- replies: 字符串数组（2~4 句别人直接抛这个梗时最地道的“接梗下句/名台词/捧哏回话”，用于直接入戏接梗，不要写解释）',
    '- mood: 字符串数组（适用情绪标签，2~4个）',
    '- searchKeywords: 字符串数组（用于搜对应表情包的 1~2 个精准短词，必须是该梗本身或对应角色，不要拆成无关字面词）'
  ].join('\n');

  if (googleSnippets) {
    const parsed = await callDashScopeJson(
      sys,
      `要核查的网络梗：「${query}」\n\nGoogle 实时搜索结果：\n${googleSnippets}\n\n请基于以上真实搜索结果提炼 JSON（若搜索结果完全无关则返回 {"found": false}）。`,
      { maxTokens: 700, timeoutMs: 22000 }
    );
    if (parsed && parsed.found === true && parsed.name && parsed.meaning) return parsed;
  }

  const res = await callDashScopeNativeSearchJson(
    sys,
    `请核查并解析网络梗「${query}」的确切出处、含义、接梗下句与玩梗方式。不确定就返回 {"found": false}。`,
    { maxTokens: 700, timeoutMs: 28000 }
  );
  const parsed = res?.parsed;
  if (parsed && parsed.found === true && parsed.name && parsed.meaning) return parsed;
  return null;
}

export async function saveUserTaughtMeme({ name, origin = '', meaning = '', usage = '', replies = [], aliases = [], mood = ['玩梗'], fetchImage = true, log = () => {} }) {
  const cleanName = String(name || '').trim();
  if (!cleanName || !String(meaning || origin).trim()) throw new Error('梗名和解释不能为空');
  const kb = loadMemeKb();
  const img = fetchImage ? await fetchAndSaveMemeImage(cleanName, [cleanName, ...aliases]) : null;
  const entry = {
    id: makeMemeId(cleanName),
    wikiTitle: '',
    name: cleanName,
    aliases: Array.isArray(aliases) ? aliases.filter(Boolean).slice(0, 5) : [],
    origin: String(origin || '').trim(),
    meaning: String(meaning || origin || '').trim(),
    usage: String(usage || '聊天接梗时自然使用').trim(),
    replies: Array.isArray(replies) ? replies.filter(Boolean).slice(0, 4) : [],
    mood: Array.isArray(mood) && mood.length ? mood.slice(0, 4) : ['玩梗'],
    searchKeywords: [cleanName],
    source: 'user-taught',
    imageFile: img?.imageFile || null,
    imageId: img?.imageId || null,
    imageTitle: img?.imageTitle || null,
    imageDesc: img?.imageDesc || null,
    imageTags: img?.imageTags || [],
    learnedAt: new Date().toISOString()
  };
  const idx = kb.memes.findIndex((m) => m.id === entry.id || m.name === entry.name);
  if (idx >= 0) kb.memes[idx] = entry;
  else kb.memes.push(entry);
  saveMemeKb(kb);
  log(`[meme] 已记下新教的梗：「${entry.name}」${entry.imageFile ? '（已配梗图）' : ''}`);
  return presentMeme(entry);
}

function loadMemeKb() {
  const kb = readJson(MEME_KB_PATH, { updatedAt: null, memes: [] });
  if (!Array.isArray(kb.memes)) kb.memes = [];
  return kb;
}

function saveMemeKb(kb) {
  kb.updatedAt = new Date().toISOString();
  if (kb.memes.length > 400) kb.memes = kb.memes.slice(-400);
  writeJsonAtomic(MEME_KB_PATH, kb);
}

function makeMemeId(name) {
  return `m_${Buffer.from(name).toString('hex').slice(0, 10)}`;
}

// ── 4. 核心入口：每日定时冲浪 + 萌娘学梗 + 自动配梗图 ─────────────────────────
export async function runDailySurf({ maxNewMemes = 5, log = console.log } = {}) {
  log('[surf] 开始刷今日热点与萌娘百科梗库…');
  const [bili, douban, toutiao] = await Promise.all([
    fetchBilibiliPopular(),
    fetchDoubanHotMovies(),
    fetchToutiaoHot()
  ]);
  const rawHot = [...douban.slice(0, 8), ...bili.slice(0, 10), ...toutiao.slice(0, 10)];
  log(`[surf] 抓到原始热点：豆瓣电影 ${douban.length}、B站 ${bili.length}、头条 ${toutiao.length}`);

  let curatedItems = [];
  if (rawHot.length) {
    const sys = [
      '你是聊天宠物的“刷手机筛选器”。从下面原始热点中，挑出 8~10 条最适合熟人私聊/群聊随口吐槽或分享的内容。',
      '优先偏好：电影/口碑新片、B站爆火整活视频、游戏/科技趣闻、有趣的生活/社会热梗；跳过枯燥的纯政务/股票/广告内容。',
      '输出严格 JSON 数组，每项包含：source（来源）, title（精简标题≤28字）, gist（一句话看点或自然吐槽角度≤45字）, tag（电影/B站/热梗/生活/游戏/科技 之一）。'
    ].join('\n');
    const rawText = rawHot.map((x, i) => `${i + 1}. [${x.source}] ${x.title}${x.extra ? ' (' + x.extra + ')' : ''}`).join('\n');
    const res = await callDashScopeJson(sys, rawText, { maxTokens: 1100 });
    if (Array.isArray(res) && res.length) {
      curatedItems = res.slice(0, 10).map((it) => ({
        source: String(it.source || ''),
        title: String(it.title || '').trim(),
        gist: String(it.gist || '').trim(),
        tag: String(it.tag || '热点')
      })).filter((it) => it.title);
    }
  }
  if (!curatedItems.length) {
    curatedItems = rawHot.slice(0, 8).map((x) => ({
      source: x.source,
      title: x.title.slice(0, 32),
      gist: x.extra || '今日热门',
      tag: x.source.includes('电影') ? '电影' : (x.source.includes('B站') ? 'B站' : '热点')
    }));
  }

  // 双引擎自动学新梗：1) B站「梗指南/梗科普」最新视频（最新短视频梗） + 2) 萌娘百科分类（经典/ACG梗）
  const kb = loadMemeKb();
  const existingNames = new Set(kb.memes.map((m) => String(m.name || '').toLowerCase()));
  const existingOrig = new Set(kb.memes.map((m) => String(m.wikiTitle || '').toLowerCase()));

  const newlyLearned = [];
  const biliQuota = Math.max(1, Math.floor(maxNewMemes / 2));

  // 引擎 A：B站解梗 UP 主最新投稿
  const biliCandidates = await fetchFreshBiliMemeCandidates(biliQuota + 4);
  for (const cand of biliCandidates) {
    if (newlyLearned.length >= biliQuota) break;
    if (existingNames.has(cand.memeName.toLowerCase())) continue;
    await sleepMs(1000);
    const info = await lookupMemeViaBilibili(cand.memeName);
    if (!info || !info.name) continue;
    if (existingNames.has(info.name.toLowerCase())) continue;
    const img = await fetchAndSaveMemeImage(info.name, info.searchKeywords || [info.name]);
    const entry = {
      id: makeMemeId(info.name),
      wikiTitle: '',
      name: info.name,
      aliases: Array.isArray(info.aliases) ? info.aliases : [],
      origin: info.origin || '',
      meaning: info.meaning || '',
      usage: info.usage || '',
      replies: Array.isArray(info.replies) ? info.replies.filter(Boolean).slice(0, 4) : [],
      mood: Array.isArray(info.mood) ? info.mood : ['玩梗'],
      searchKeywords: Array.isArray(info.searchKeywords) ? info.searchKeywords : [info.name],
      source: 'bilibili',
      biliUrl: info.biliUrl || `https://www.bilibili.com/video/${cand.bvid}`,
      imageFile: img?.imageFile || null,
      imageId: img?.imageId || null,
      imageTitle: img?.imageTitle || null,
      imageDesc: img?.imageDesc || null,
      imageTags: img?.imageTags || [],
      learnedAt: new Date().toISOString()
    };
    kb.memes.push(entry);
    existingNames.add(entry.name.toLowerCase());
    newlyLearned.push(entry);
    log(`[surf] 从B站学到新梗：「${entry.name}」${entry.imageFile ? ' + 已配梗图(' + path.basename(entry.imageFile) + ')' : ' (暂未匹配到图)'}`);
  }

  // 引擎 B：萌娘百科最新/经典词条
  const pool = [];
  for (const cat of MOEGIRL_CATEGORIES) {
    const titles = await fetchMoegirlCategoryTitles(cat, 15);
    for (const t of titles) {
      if (!existingOrig.has(t.toLowerCase()) && !existingNames.has(t.toLowerCase()) && !pool.includes(t)) {
        pool.push(t);
      }
    }
  }

  for (const title of pool) {
    if (newlyLearned.length >= maxNewMemes) break;
    const wikitext = await fetchMoegirlWikitext(title);
    if (!wikitext || wikitext.length < 60) continue;
    const info = await distillMemeFromWikitext(title, wikitext);
    const img = await fetchAndSaveMemeImage(info.name || title, info.searchKeywords || [title]);
    const entry = {
      id: makeMemeId(info.name || title),
      wikiTitle: title,
      name: info.name || title,
      aliases: Array.isArray(info.aliases) ? info.aliases : [],
      origin: info.origin || '',
      meaning: info.meaning || '',
      usage: info.usage || '',
      replies: Array.isArray(info.replies) ? info.replies.filter(Boolean).slice(0, 4) : [],
      mood: Array.isArray(info.mood) ? info.mood : ['玩梗'],
      searchKeywords: Array.isArray(info.searchKeywords) ? info.searchKeywords : [],
      source: 'moegirl',
      imageFile: img?.imageFile || null,
      imageId: img?.imageId || null,
      imageTitle: img?.imageTitle || null,
      imageDesc: img?.imageDesc || null,
      imageTags: img?.imageTags || [],
      learnedAt: new Date().toISOString()
    };
    kb.memes.push(entry);
    newlyLearned.push(entry);
    log(`[surf] 从萌娘学到新梗：「${entry.name}」${entry.imageFile ? ' + 已配梗图(' + path.basename(entry.imageFile) + ')' : ' (暂未匹配到图)'}`);
  }
  if (newlyLearned.length) saveMemeKb(kb);

  const feed = {
    updatedAt: new Date().toISOString(),
    day: new Date().toISOString().slice(0, 10),
    hotItems: curatedItems,
    recentMemes: kb.memes.slice(-8).reverse().map((m) => ({
      id: m.id,
      name: m.name,
      meaning: m.meaning,
      usage: m.usage,
      replies: Array.isArray(m.replies) ? m.replies.slice(0, 3) : [],
      hasImage: Boolean(m.imageFile && fs.existsSync(m.imageFile))
    }))
  };
  writeJsonAtomic(DAILY_FEED_PATH, feed);
  log(`[surf] 完成：今日热点 ${curatedItems.length} 条，本次新学梗 ${newlyLearned.length} 个（总梗库 ${kb.memes.length} 个，其中带图 ${kb.memes.filter((m) => m.imageFile && fs.existsSync(m.imageFile)).length} 个）`);
  return { feed, newlyLearnedCount: newlyLearned.length, totalMemes: kb.memes.length };
}

// ── 5. 供桥接与 MCP 工具调用的查询与发图辅助 ─────────────────────────────────
export function readDailyFeed() {
  return readJson(DAILY_FEED_PATH, { updatedAt: null, hotItems: [], recentMemes: [] });
}

export function formatDailyFeedHint() {
  const feed = readDailyFeed();
  const hots = (feed.hotItems || []).slice(0, 6);
  const memes = (feed.recentMemes || []).slice(0, 4);
  if (!hots.length && !memes.length) return '';
  const lines = ['【你今天刷手机随手看到的（聊天有契机再自然提，绝不要像新闻播报）】'];
  for (const h of hots) {
    lines.push(`- [${h.tag || h.source}] ${h.title}：${h.gist}`);
  }
  if (memes.length) {
    lines.push('【最近新学的梗（对方抛梗直接接下句或发对应梗图，别当百科老师科普出处）】');
    for (const m of memes) {
      const rep = Array.isArray(m.replies) && m.replies.length ? `｜接梗例：「${m.replies[0]}」` : '';
      lines.push(`- 「${m.name}」${m.hasImage ? '[有梗图 id=' + m.id + ']' : ''}：${m.meaning}${rep}`);
    }
  }
  return lines.join('\n');
}

function scoreMemeMatch(m, qLower) {
  let s = 0;
  const name = String(m.name || '').toLowerCase();
  const wiki = String(m.wikiTitle || '').toLowerCase();
  if (m.id === qLower || name === qLower || wiki === qLower) s += 100;
  else if (name.includes(qLower) || qLower.includes(name)) s += 50;
  for (const a of (m.aliases || [])) {
    const al = String(a || '').toLowerCase();
    if (al === qLower) s += 80;
    else if (al.includes(qLower) || qLower.includes(al)) s += 35;
  }
  for (const t of [...(m.mood || []), ...(m.imageTags || []), ...(m.searchKeywords || [])]) {
    const tl = String(t || '').toLowerCase();
    if (tl && (tl.includes(qLower) || qLower.includes(tl))) s += 20;
  }
  const text = `${m.origin || ''} ${m.meaning || ''} ${m.usage || ''} ${m.imageTitle || ''}`.toLowerCase();
  if (text.includes(qLower)) s += 12;
  return s;
}

export async function lookupMeme(query, { allowLive = true, fetchImage = true, log = () => {} } = {}) {
  const q = String(query || '').trim();
  const kb = loadMemeKb();
  if (!q) {
    return {
      source: 'local',
      total: kb.memes.length,
      items: kb.memes.slice(-10).reverse().map(presentMeme)
    };
  }
  const qLower = q.toLowerCase();
  const scored = kb.memes
    .map((m) => ({ m, score: scoreMemeMatch(m, qLower) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length && scored[0].score >= 35) {
    const top = scored[0].m;
    if (fetchImage && (!top.imageFile || !fs.existsSync(top.imageFile))) {
      const img = await fetchAndSaveMemeImage(top.name, top.searchKeywords || [q]);
      if (img) {
        Object.assign(top, img);
        saveMemeKb(kb);
      }
    }
    return {
      source: 'local',
      total: kb.memes.length,
      items: scored.slice(0, 5).map((x) => presentMeme(x.m))
    };
  }

  if (!allowLive) {
    return { source: 'local', total: kb.memes.length, items: scored.slice(0, 5).map((x) => presentMeme(x.m)) };
  }

  // 第 2 层：实时查萌娘百科（严格校验词条相关性，防止风马牛不相及的误匹配入库）
  const titles = await searchMoegirlTitle(q);
  for (const bestTitle of titles.slice(0, 2)) {
    const wikitext = await fetchMoegirlWikitext(bestTitle);
    if (!wikitext || wikitext.length < 40) continue;
    const info = await distillMemeFromWikitext(bestTitle, wikitext, q);
    if (!info || info.relevant !== true) continue;
    const img = fetchImage ? await fetchAndSaveMemeImage(info.name || bestTitle, [q, ...(info.searchKeywords || [])]) : null;
    const entry = {
      id: makeMemeId(info.name || bestTitle),
      wikiTitle: bestTitle,
      name: info.name || bestTitle,
      aliases: Array.isArray(info.aliases) ? info.aliases : [],
      origin: info.origin || '',
      meaning: info.meaning || '',
      usage: info.usage || '',
      replies: Array.isArray(info.replies) ? info.replies.filter(Boolean).slice(0, 4) : [],
      mood: Array.isArray(info.mood) ? info.mood : ['玩梗'],
      searchKeywords: Array.isArray(info.searchKeywords) ? info.searchKeywords : [q],
      source: 'moegirl-live',
      imageFile: img?.imageFile || null,
      imageId: img?.imageId || null,
      imageTitle: img?.imageTitle || null,
      imageDesc: img?.imageDesc || null,
      imageTags: img?.imageTags || [],
      learnedAt: new Date().toISOString()
    };
    const idx = kb.memes.findIndex((m) => m.id === entry.id || (entry.wikiTitle && m.wikiTitle === entry.wikiTitle));
    if (idx >= 0) kb.memes[idx] = entry;
    else kb.memes.push(entry);
    saveMemeKb(kb);
    log(`[meme] 实时从萌娘百科查到并入库：「${entry.name}」${entry.imageFile ? '（已配梗图）' : ''}`);
    return { source: 'moegirl-live', total: kb.memes.length, items: [presentMeme(entry)] };
  }

  // 第 3 层（王牌）：B站搜「<query> 是什么梗」（含梗指南/梗科普视频详情+标签+热评）+ MemeCub 配图
  const biliInfo = await lookupMemeViaBilibili(q);
  if (biliInfo) {
    const img = fetchImage ? await fetchAndSaveMemeImage(biliInfo.name || q, [q, ...(biliInfo.searchKeywords || [])]) : null;
    const entry = {
      id: makeMemeId(biliInfo.name || q),
      wikiTitle: '',
      name: biliInfo.name || q,
      aliases: Array.from(new Set([q, ...(Array.isArray(biliInfo.aliases) ? biliInfo.aliases : [])])).slice(0, 5),
      origin: biliInfo.origin || '',
      meaning: biliInfo.meaning || '',
      usage: biliInfo.usage || '',
      replies: Array.isArray(biliInfo.replies) ? biliInfo.replies.filter(Boolean).slice(0, 4) : [],
      mood: Array.isArray(biliInfo.mood) ? biliInfo.mood : ['玩梗'],
      searchKeywords: Array.isArray(biliInfo.searchKeywords) ? biliInfo.searchKeywords : [q],
      source: 'bilibili-live',
      biliUrl: biliInfo.biliUrl || '',
      imageFile: img?.imageFile || null,
      imageId: img?.imageId || null,
      imageTitle: img?.imageTitle || null,
      imageDesc: img?.imageDesc || null,
      imageTags: img?.imageTags || [],
      learnedAt: new Date().toISOString()
    };
    const idx = kb.memes.findIndex((m) => m.id === entry.id);
    if (idx >= 0) kb.memes[idx] = entry;
    else kb.memes.push(entry);
    saveMemeKb(kb);
    log(`[meme] 实时从B站搜到新梗并入库：「${entry.name}」${entry.imageFile ? '（已配梗图）' : ''}`);
    return { source: 'bilibili-live', total: kb.memes.length, items: [presentMeme(entry)] };
  }

  // 第 4 层：百炼原生中文全网搜索兜底 + MemeCub 配图入库
  const webInfo = await lookupMemeViaWebSearch(q);
  if (webInfo) {
    const img = fetchImage ? await fetchAndSaveMemeImage(webInfo.name || q, [q, ...(webInfo.searchKeywords || [])]) : null;
    const entry = {
      id: makeMemeId(webInfo.name || q),
      wikiTitle: '',
      name: webInfo.name || q,
      aliases: Array.from(new Set([q, ...(Array.isArray(webInfo.aliases) ? webInfo.aliases : [])])).slice(0, 5),
      origin: webInfo.origin || '',
      meaning: webInfo.meaning || '',
      usage: webInfo.usage || '',
      replies: Array.isArray(webInfo.replies) ? webInfo.replies.filter(Boolean).slice(0, 4) : [],
      mood: Array.isArray(webInfo.mood) ? webInfo.mood : ['玩梗'],
      searchKeywords: Array.isArray(webInfo.searchKeywords) ? webInfo.searchKeywords : [q],
      source: 'web-live',
      imageFile: img?.imageFile || null,
      imageId: img?.imageId || null,
      imageTitle: img?.imageTitle || null,
      imageDesc: img?.imageDesc || null,
      imageTags: img?.imageTags || [],
      learnedAt: new Date().toISOString()
    };
    const idx = kb.memes.findIndex((m) => m.id === entry.id);
    if (idx >= 0) kb.memes[idx] = entry;
    else kb.memes.push(entry);
    saveMemeKb(kb);
    log(`[meme] 实时全网搜到新梗并入库：「${entry.name}」${entry.imageFile ? '（已配梗图）' : ''}`);
    return { source: 'web-live', total: kb.memes.length, items: [presentMeme(entry)] };
  }

  return { source: 'none', total: kb.memes.length, items: scored.slice(0, 3).map((x) => presentMeme(x.m)) };
}

export async function resolveMemeImage(ref, { log = () => {} } = {}) {
  const q = String(ref || '').trim();
  if (!q) return null;
  const kb = loadMemeKb();
  let found = kb.memes.find((m) => m.id === q);
  if (!found) {
    const qLower = q.toLowerCase();
    const scored = kb.memes
      .map((m) => ({ m, score: scoreMemeMatch(m, qLower) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scored.length && scored[0].score >= 20) found = scored[0].m;
  }
  if (found && found.imageFile && fs.existsSync(found.imageFile)) {
    return found;
  }
  if (found) {
    const img = await fetchAndSaveMemeImage(found.name, [q, ...(found.searchKeywords || [])]);
    if (img) {
      Object.assign(found, img);
      saveMemeKb(kb);
      return found;
    }
  }
  const res = await lookupMeme(q, { allowLive: true, fetchImage: true, log });
  if (res.items.length) {
    const kb2 = loadMemeKb();
    const hit = kb2.memes.find((m) => m.id === res.items[0].id);
    if (hit && hit.imageFile && fs.existsSync(hit.imageFile)) return hit;
  }
  return null;
}

function presentMeme(m) {
  return {
    id: m.id,
    name: m.name,
    aliases: m.aliases || [],
    origin: m.origin || '',
    meaning: m.meaning || '',
    usage: m.usage || '',
    replies: Array.isArray(m.replies) ? m.replies : [],
    mood: m.mood || [],
    source: m.source || '',
    biliUrl: m.biliUrl || null,
    hasImage: Boolean(m.imageFile && fs.existsSync(m.imageFile)),
    imageTitle: m.imageTitle || null,
    imageDesc: m.imageDesc || null,
    playTip: '若对方是直接抛梗/抛台词/说怪话（没主动问“啥意思”），请直接顺着 replies 接下句、吐槽捧哏或调 qq_send_meme 发对应梗图，千万不要像百科老师一样解释出处！只有对方明确问“这是什么梗/啥意思”才简短解释。'
  };
}

if (process.argv.includes('--run')) {
  const idx = process.argv.indexOf('--max-memes');
  const maxNewMemes = idx >= 0 ? Math.max(1, Number(process.argv[idx + 1]) || 5) : 5;
  runDailySurf({ maxNewMemes }).catch((err) => {
    console.error('[surf] fatal:', err);
    process.exit(1);
  });
}
