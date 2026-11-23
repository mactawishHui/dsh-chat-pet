#!/usr/bin/env node
/**
 * humanized-sing-engine.mjs — 活人感唱歌引擎（点歌翻唱 + 原创哼唱双模式）
 *
 * 核心链路：
 *   [翻唱模式] B站官方原唱检索(自动避坑翻唱/合集) -> Paraformer 歌词打点截取黄金 45s
 *   [原创模式] ACE-Step 生成完整旋律与人声
 *       ↓
 *   Demucs htdemucs_ft 零漏音分轨 (vocals.wav + other.wav)
 *       ↓
 *   Praat F0 基频测算 (女声原调 0 / 男声自动升八度 +12，伴奏零变调无损)
 *       ↓
 *   [Pre-RVC] vocal-humanizer.py 注入真人微瑕 (慢漂移/起音懒滑/尾音下坠/高音吃力/1~2处小跑调/微松弛)
 *       ↓
 *   Replicate RVC v2 (rmvpe) 用宠物专属声模换声 (自动检测并 curl 续传 24h 过期声模)
 *       ↓ (与同声纹 TTS 前后碎碎念并行合成)
 *   [Post-RVC] vocal-humanizer.py 注入防叠加柔换气/偷换气 + 手机近麦/房间外放/KTV声学 + 口白无缝拼接
 *       ↓
 *   24kHz 单声道 WAV (压在 58s 内单条 QQ 语音直发) + 自动销毁临时目录零磁盘残留
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ── 可通过环境变量覆写的路径配置（零硬编码敏感信息） ─────────────────────────
const CONFIG = {
  replicateTokenFile: process.env.REPLICATE_TOKEN_FILE || '/opt/qq-cover/replicate_token.txt',
  dashscopeKeyFile: process.env.DASHSCOPE_KEY_FILE || '/opt/qq-tts/apikey.txt',
  rvcModelJson: process.env.RVC_MODEL_JSON || '/opt/qq-cover/voice-model.json',
  rvcSlimZip: process.env.RVC_SLIM_ZIP || '/opt/qq-cover/slim.zip',
  workRoot: process.env.SING_WORK_ROOT || '/opt/qq-cover/work',
  songCacheDir: process.env.SING_CACHE_DIR || '/opt/qq-bridge/audio/song-cache',
  songCacheMax: Number(process.env.SING_CACHE_MAX || 60),
  curatedCatalogPath: process.env.SING_CURATED_CATALOG || '/opt/qq-cover/curated-songs-catalog.json',
  humanizerPy: process.env.HUMANIZER_PY || '/opt/qq-cover/venv/bin/python',
  humanizerScript: process.env.HUMANIZER_SCRIPT || '/opt/qq-cover/vocal-humanizer.py',
  ttsBaseUrl: (process.env.TTS_BASE_URL || 'http://127.0.0.1:3210').replace(/\/+$/, ''),
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
  replicateProxy: String(process.env.REPLICATE_PROXY || '').trim(),
};

function isReplicateUrl(url) {
  return /^https?:\/\/([^/]+\.)?replicate\.(com|delivery)\//i.test(String(url || ''));
}

const BILI_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function getReplicateToken() {
  if (process.env.REPLICATE_API_TOKEN) return process.env.REPLICATE_API_TOKEN.trim();
  return fs.readFileSync(CONFIG.replicateTokenFile, 'utf8').trim();
}

function getDashscopeKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY.trim();
  try { return fs.readFileSync(CONFIG.dashscopeKeyFile, 'utf8').trim(); } catch { return ''; }
}

function loadWsClass() {
  for (const cand of ['ws', '/opt/qq-tts/node_modules/ws', '/opt/qq-bridge/node_modules/ws']) {
    try { return require(cand); } catch {}
  }
  return globalThis.WebSocket || null;
}

function execAsync(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, timeout: 300000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        const detail = String(stderr || stdout || err.message).trim().slice(-400);
        reject(new Error(`${path.basename(bin)} failed: ${detail}`));
        return;
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function ff(args, timeout = 180000) {
  await execAsync(CONFIG.ffmpegBin, ['-y', '-loglevel', 'error', ...args], { timeout });
}

async function probeDuration(file) {
  try {
    const { stdout } = await execAsync(
      CONFIG.ffprobeBin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file],
      { timeout: 20000 }
    );
    const n = Number(stdout.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

async function jfetch(url, opts = {}, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 120000) });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 240) }; }
      return { ok: res.ok, status: res.status, body };
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`HTTP 请求失败: ${last?.message ?? last}`);
}

async function downloadFile(url, dest, headers = {}, tries = 4) {
  const headerArgs = [];
  for (const [k, v] of Object.entries(headers || {})) {
    if (v !== undefined && v !== null && String(v) !== '') {
      headerArgs.push('-H', `${k}: ${v}`);
    }
  }
  const useProxyFirst = Boolean(CONFIG.replicateProxy && isReplicateUrl(url));
  let last;
  for (let i = 0; i < tries; i++) {
    // 针对 Replicate 国际 CDN：前几次优先走可选 REPLICATE_PROXY 加速，最后一次兜底直连；国内源（B站等）强制直连
    const proxyArgs = (useProxyFirst && i < tries - 1)
      ? ['-x', CONFIG.replicateProxy]
      : ['--noproxy', '*'];
    try {
      await execAsync('curl', [
        '-fsSL', '--max-time', '180', '--connect-timeout', '20',
        ...proxyArgs,
        ...headerArgs,
        '-o', dest,
        String(url),
      ], { timeout: 195000 });
      if (!fs.existsSync(dest) || fs.statSync(dest).size < 16) {
        throw new Error('下载内容为空');
      }
      return dest;
    } catch (e) {
      last = e;
      try { fs.unlinkSync(dest); } catch {}
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`下载失败(${tries}次): ${last?.message ?? last}`);
}

// ── Replicate 声模自动续期 + 文件上传 + 模型预测 ──────────────────────────────
let _modelRefreshLock = null;

export async function ensureRvcModelUrl(log = console.error) {
  if (_modelRefreshLock) return _modelRefreshLock;
  _modelRefreshLock = (async () => {
    const tok = getReplicateToken();
    const H = { authorization: `Bearer ${tok}` };

    // 1. 先查缓存文件，距离过期 >30 分钟且 curl HEAD 存活（支持可选 REPLICATE_PROXY）直接复用，杜绝误判重传 51MB 声模！
    try {
      const cached = JSON.parse(fs.readFileSync(CONFIG.rvcModelJson, 'utf8'));
      const url = String(cached?.url || '').trim();
      const expMs = cached?.expires_at ? Date.parse(cached.expires_at) : 0;
      const notExpired = !expMs || expMs - Date.now() > 30 * 60 * 1000;
      if (url && notExpired) {
        const checkHead = async (useProxy) => {
          const pArgs = useProxy && CONFIG.replicateProxy ? ['-x', CONFIG.replicateProxy] : ['--noproxy', '*'];
          const { stdout } = await execAsync('curl', [
            '-sS', '-I', '-o', '/dev/null', '-w', '%{http_code}',
            '--max-time', '15', '--connect-timeout', '10',
            ...pArgs,
            '-H', `Authorization: Bearer ${tok}`,
            url,
          ], { timeout: 20000 });
          return Number(stdout.trim()) || 0;
        };
        let code = await checkHead(true).catch(() => 0);
        if (!code && CONFIG.replicateProxy) code = await checkHead(false).catch(() => 0);
        if (code >= 200 && code < 400) return url;
        // 若只是瞬时网络抖动(code=0)且离过期还有 >2 小时，沿用缓存链接避免白传 51MB
        if (!code && expMs && expMs - Date.now() > 2 * 3600 * 1000) return url;
      }
    } catch {}

    // 2. 过期或失效：用 curl 稳定上传 51MB slim.zip（避免小带宽下 Node fetch 超时）
    if (!fs.existsSync(CONFIG.rvcSlimZip)) {
      throw new Error(`找不到 RVC 声模包: ${CONFIG.rvcSlimZip}`);
    }
    log(`[sing-engine] RVC 声模链接已过期，正在通过 curl 重新上传 ${path.basename(CONFIG.rvcSlimZip)}…`);
    const proxyArgs = CONFIG.replicateProxy ? ['-x', CONFIG.replicateProxy] : [];
    const { stdout } = await execAsync('curl', [
      '-sS', '--max-time', '420',
      ...proxyArgs,
      '-X', 'POST', 'https://api.replicate.com/v1/files',
      '-H', `Authorization: Bearer ${tok}`,
      '-F', `content=@${CONFIG.rvcSlimZip};type=application/zip`,
    ], { timeout: 440000 });
    const parsed = JSON.parse(stdout);
    const newUrl = parsed?.urls?.get;
    if (!newUrl) throw new Error(`声模上传失败: ${stdout.slice(0, 200)}`);

    const record = {
      url: newUrl,
      id: parsed.id || '',
      expires_at: parsed.expires_at || new Date(Date.now() + 20 * 3600 * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    };
    fs.writeFileSync(CONFIG.rvcModelJson, JSON.stringify(record, null, 2));
    log(`[sing-engine] RVC 声模已续期，有效期至 ${record.expires_at}`);
    return newUrl;
  })().finally(() => {
    _modelRefreshLock = null;
  });
  return _modelRefreshLock;
}

async function uploadToReplicate(filePath, mime = 'audio/wav', tries = 3) {
  const tok = getReplicateToken();
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const proxyArgs = (CONFIG.replicateProxy && i < tries - 1)
      ? ['-x', CONFIG.replicateProxy]
      : ['--noproxy', '*'];
    try {
      // 使用 curl 稳定流式上传（支持可选 REPLICATE_PROXY 加速，避免低带宽云主机多 MB 断链）
      const { stdout } = await execAsync('curl', [
        '-sS', '--max-time', '180', '--connect-timeout', '20',
        ...proxyArgs,
        '-X', 'POST', 'https://api.replicate.com/v1/files',
        '-H', `Authorization: Bearer ${tok}`,
        '-F', `content=@${filePath};type=${mime}`,
      ], { timeout: 195000 });
      const parsed = JSON.parse(stdout || '{}');
      const url = parsed?.urls?.get;
      if (!url) throw new Error(`Replicate 上传返回异常: ${String(stdout || '').slice(0, 180)}`);
      return url;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw new Error(`Replicate 上传失败(${tries}次): ${lastErr?.message ?? lastErr}`);
}

async function runReplicateModel(model, input, label, maxPolls = 200) {
  const tok = getReplicateToken();
  const H = { authorization: `Bearer ${tok}` };
  const meta = (await jfetch(`https://api.replicate.com/v1/models/${model}`, { headers: H })).body || {};
  const version = meta.latest_version?.id;
  if (!version) throw new Error(`${label}: 无法获取模型版本`);
  let pred = (await jfetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/json' },
    body: JSON.stringify({ version, input }),
  })).body || {};
  if (!pred.id) throw new Error(`${label}: 创建任务失败 ${JSON.stringify(pred).slice(0, 180)}`);

  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    pred = (await jfetch(`https://api.replicate.com/v1/predictions/${pred.id}`, { headers: H })).body || pred;
    if (['succeeded', 'failed', 'canceled'].includes(pred.status)) break;
  }
  if (pred.status !== 'succeeded') {
    throw new Error(`${label} 失败(${pred.status}): ${JSON.stringify(pred.error || '').slice(0, 180)}`);
  }
  return pred.output;
}

// ── B 站原唱精准搜索与纯音频拉取 ──────────────────────────────────────────────
function parseBiliDuration(durStr) {
  if (typeof durStr === 'number') return durStr;
  const parts = String(durStr || '').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] || 0;
}

function lookupCuratedBvid(cleanSong, cleanArtist = '') {
  try {
    if (!CONFIG.curatedCatalogPath || !fs.existsSync(CONFIG.curatedCatalogPath)) return null;
    const raw = JSON.parse(fs.readFileSync(CONFIG.curatedCatalogPath, 'utf8'));
    const list = Array.isArray(raw?.songs) ? raw.songs : (Array.isArray(raw) ? raw : []);
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s《》【】"'.,!?，。！？\-—_]/g, '');
    const targetSong = norm(cleanSong);
    const targetArtist = norm(cleanArtist);
    if (!targetSong) return null;
    const matches = list.filter((it) => it && it.bvid && it.qaStatus !== 'rejected' && norm(it.song) === targetSong);
    if (!matches.length) return null;
    if (targetArtist) {
      const exactArtist = matches.find((it) => norm(it.artist).includes(targetArtist) || targetArtist.includes(norm(it.artist)));
      if (exactArtist) return exactArtist;
    }
    return matches[0];
  } catch {
    return null;
  }
}

export async function searchAndDownloadBilibiliSong({ song, artist = '', bvid: explicitBvid = '', destPath, log = console.error }) {
  const cleanSong = String(song || '').replace(/[《》"'【】]/g, '').trim();
  const cleanArtist = String(artist || '').trim();
  if (!cleanSong) throw new Error('歌名不能为空');

  // 1. 拉取新鲜 buvid3 会话 Cookie（彻底避开 HTTP 412）
  const home = await fetch('https://www.bilibili.com/', {
    headers: { 'user-agent': BILI_UA },
    signal: AbortSignal.timeout(15000),
  });
  const setCookies = home.headers.getSetCookie?.() || [home.headers.get('set-cookie') || ''];
  const cookie = setCookies.map((c) => c.split(';')[0]).filter(Boolean).join('; ');
  const H = { 'user-agent': BILI_UA, referer: 'https://www.bilibili.com/', cookie };

  // 1.5 优先命中显式 --bvid 或预筛纯净金曲目录（curated-songs-catalog.json），失败则自动回退实时检索
  const preferredBvid = String(explicitBvid || '').trim() || (lookupCuratedBvid(cleanSong, cleanArtist)?.bvid || '');
  const tryDownloadBvid = async (cand) => {
    const view = await jfetch(`https://api.bilibili.com/x/web-interface/view?bvid=${cand.bvid}`, { headers: H }, 2);
    const vData = view.body?.data;
    const cid = vData?.cid;
    if (!cid) return null;
    const play = await jfetch(
      `https://api.bilibili.com/x/player/playurl?bvid=${cand.bvid}&cid=${cid}&fnval=16`,
      { headers: H },
      2
    );
    const audios = (play.body?.data?.dash?.audio || []).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (!audios.length) return null;
    const streamUrl = audios[0].baseUrl || audios[0].base_url || audios[0].backupUrl?.[0];
    if (!streamUrl) return null;
    try {
      await downloadFile(streamUrl, destPath, H, 3);
      const st = fs.statSync(destPath);
      if (st.size > 50 * 1024) {
        return {
          bvid: cand.bvid,
          title: cand.title || String(vData?.title || cleanSong).trim(),
          author: cand.author || String(vData?.owner?.name || '').trim(),
          dur: cand.dur || Number(vData?.duration) || 0,
          play: cand.play || Number(vData?.stat?.view) || 0,
          score: cand.score ?? 99,
          bytes: st.size,
          bandwidth: audios[0].bandwidth || 0,
        };
      }
    } catch {}
    return null;
  };

  if (/^BV[0-9A-Za-z]{10}$/.test(preferredBvid)) {
    const direct = await tryDownloadBvid({ bvid: preferredBvid, title: '', author: '', dur: 0, play: 0, score: 100 });
    if (direct) {
      log(`[sing-engine] 命中精选直连原唱: ${direct.bvid} | ${direct.title} (UP: ${direct.author}, ${direct.dur}s, ${(direct.bytes / 1048576).toFixed(2)}MB)`);
      return direct;
    }
    log(`[sing-engine] 精选 BVID(${preferredBvid}) 拉取失败，自动回退 B 站实时检索…`);
  }

  // 2. 检索原唱（优先官方 MV / 无损，带干净兜底词防止多词过严漏掉歌曲）
  const queries = cleanArtist
    ? [`${cleanArtist} ${cleanSong} 官方MV 无损`, `${cleanArtist} ${cleanSong} 原唱`, `${cleanArtist} ${cleanSong}`]
    : [`${cleanSong} 官方MV 原唱 无损`, `${cleanSong} 原唱 完整版`, `${cleanSong} MV`];

  // 严防外放录屏音箱试听（满屏房间大混响）、AMV 混剪、翻唱、多人大合唱
  const badRe = /翻唱|cover|男声版|女声版|伴奏|纯音乐|练唱|教程|吉他谱|翻弹|串烧|合集|歌单|reaction|解析|教学|ai翻唱|dj版|变速|升调|降调|0\.8x|1\.2x|群星|合唱版|大合唱|男女对唱|对唱|多人|声乐团|钢琴版|唢呐|二胡|古筝版|录音棚大声听|百万豪装|音响试听|音箱试听|耳机试听|车载音响|沉浸式试听|此时此刻|amv|mad|混剪|踩点|高燃|剪辑|鬼畜|日文版|日语版|韩文版/i;
  const badAuthorsRe = /jlrs-?leofm/i;
  const goodRe = /官方mv|官方版|原唱|hi-?res|无损|flac|4k|唱片|太合|索尼|环球|华纳|杰威尔|滚石|福茂|英皇|相信音乐|放映员|完整版|单曲|歌词/i;
  const userWantedBad = badRe.test(`${cleanSong} ${cleanArtist}`);

  let candidates = [];
  for (const kw of queries) {
    const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}`;
    const r = await jfetch(url, { headers: H, timeoutMs: 20000 }, 2);
    const list = r.body?.data?.result || [];
    for (const item of list) {
      const bvid = item.bvid;
      if (!bvid || candidates.some((c) => c.bvid === bvid)) continue;
      const title = String(item.title || '').replace(/<[^>]+>/g, '').trim();
      const author = String(item.author || '').trim();
      const dur = parseBiliDuration(item.duration);
      if (dur < 80 || dur > 420) continue; // 过滤短视频与几小时合集

      const lowTitle = title.toLowerCase();
      const songTokens = cleanSong.toLowerCase().split(/[\s\-—_/]+/).filter((t) => t.length >= 1);
      if (!songTokens.every((tok) => lowTitle.includes(tok))) continue;

      let score = Math.log10(Math.max(10, Number(item.play) || 10)) * 2.0;
      if (cleanArtist && (title.includes(cleanArtist) || author.includes(cleanArtist))) score += 9;
      if (goodRe.test(title) || goodRe.test(author)) score += 6;
      if (/无损|hi-?res|flac|16\/44|完整版|单曲|歌词|中文字幕/i.test(title)) score += 4;
      if (/官方mv|官方版/i.test(title)) score += 4;
      // 影视片段 MV（如「【电影名】MV」）常在前奏/间奏穿插电影人物对白，权重略低于纯音频无损源
      if (/^【[^】]{2,12}】\s*mv|电影mv|剧情版|影视mv/i.test(title)) score -= 5;
      if (/[-—《》]/.test(title)) score += 2; // 规范歌曲标题格式（歌手-歌名 / 《歌名》）
      if (!userWantedBad && (badRe.test(title) || badAuthorsRe.test(author))) score -= 32;
      if (/live|现场|演唱会|音乐节/i.test(title) && !/live|现场/i.test(cleanSong)) score -= 6;

      candidates.push({ bvid, title, author, dur, play: Number(item.play) || 0, score });
    }
    if (candidates.some((c) => c.score >= 15)) break;
  }

  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) {
    throw new Error(`B 站未找到《${cleanSong}》合适的原唱音频`);
  }

  // 3. 按得分依次尝试拉取 DASH 高码率纯音频流
  let picked = null;
  for (const cand of candidates.slice(0, 4)) {
    const view = await jfetch(`https://api.bilibili.com/x/web-interface/view?bvid=${cand.bvid}`, { headers: H }, 2);
    const cid = view.body?.data?.cid;
    if (!cid) continue;
    const play = await jfetch(
      `https://api.bilibili.com/x/player/playurl?bvid=${cand.bvid}&cid=${cid}&fnval=16`,
      { headers: H },
      2
    );
    const audios = (play.body?.data?.dash?.audio || []).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
    if (!audios.length) continue;
    const streamUrl = audios[0].baseUrl || audios[0].base_url || audios[0].backupUrl?.[0];
    if (!streamUrl) continue;
    try {
      await downloadFile(streamUrl, destPath, H, 3);
      const st = fs.statSync(destPath);
      if (st.size > 50 * 1024) {
        picked = { ...cand, bytes: st.size, bandwidth: audios[0].bandwidth || 0 };
        break;
      }
    } catch {}
  }

  if (!picked) throw new Error(`《${cleanSong}》音频流下载失败`);
  log(`[sing-engine] 命中原唱: ${picked.bvid} | ${picked.title} (UP: ${picked.author}, ${picked.dur}s, ${(picked.bytes / 1048576).toFixed(2)}MB)`);
  return picked;
}

// ── Paraformer 歌词精确打点，自动切出“主歌+副歌”黄金 45s ────────────────────
async function transcribeTimestamps(audioPath, maxSec = 105) {
  const key = getDashscopeKey();
  const WS = loadWsClass();
  if (!key || !WS) return [];

  const pcmPath = `${audioPath}.asr16k.wav`;
  try {
    await ff(['-i', audioPath, '-t', String(maxSec), '-ac', '1', '-ar', '16000', pcmPath], 60000);
    const pcm = fs.readFileSync(pcmPath).subarray(44);
    const sentences = [];
    const taskId = `sing_asr_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;

    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const timerGuard = setTimeout(done, 45000);
      const ws = new WS('wss://dashscope.aliyuncs.com/api-ws/v1/inference/', {
        headers: { Authorization: `Bearer ${key}` },
      });
      let sendTimer = null;
      ws.on('open', () => {
        ws.send(JSON.stringify({
          header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
          payload: {
            task_group: 'audio', task: 'asr', function: 'recognition',
            model: 'paraformer-realtime-v2',
            parameters: { format: 'pcm', sample_rate: 16000 },
            input: {},
          },
        }));
      });
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        const ev = m.header?.event;
        if (ev === 'task-started') {
          let off = 0;
          sendTimer = setInterval(() => {
            if (off >= pcm.length) {
              clearInterval(sendTimer);
              sendTimer = null;
              try {
                ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
              } catch {}
              return;
            }
            try { ws.send(pcm.subarray(off, off + 6400)); } catch {}
            off += 6400;
          }, 15);
        } else if (ev === 'result-generated') {
          const s = m.payload?.output?.sentence;
          if (s?.sentence_end && s.text && String(s.text).trim().length >= 2) {
            sentences.push({
              begin: (Number(s.begin_time) || 0) / 1000,
              end: (Number(s.end_time) || 0) / 1000,
              text: String(s.text).trim(),
            });
          }
        } else if (ev === 'task-finished' || ev === 'task-failed') {
          if (sendTimer) clearInterval(sendTimer);
          clearTimeout(timerGuard);
          try { ws.close(); } catch {}
          done();
        }
      });
      ws.on('error', () => { if (sendTimer) clearInterval(sendTimer); clearTimeout(timerGuard); done(); });
      ws.on('close', () => { if (sendTimer) clearInterval(sendTimer); clearTimeout(timerGuard); done(); });
    });
    return sentences;
  } catch {
    return [];
  } finally {
    try { fs.unlinkSync(pcmPath); } catch {}
  }
}

async function locateSongWindow(audioPath, { start = null, seconds = 44, coarse = true, log = console.error } = {}) {
  const totalDur = await probeDuration(audioPath);
  const targetSec = Math.min(46, Math.max(20, Number(seconds) || 44));
  if (start !== null && start !== undefined && Number.isFinite(Number(start)) && Number(start) >= 0) {
    const s = Number(start);
    const dur = totalDur > 0 ? Math.min(targetSec, Math.max(10, totalDur - s)) : targetSec;
    return { start: s, duration: dur, reason: 'explicit', exactTrim: false };
  }
  if (totalDur > 0 && totalDur <= targetSec + 4) {
    return { start: 0, duration: totalDur, reason: 'short-source', exactTrim: false };
  }

  // 两阶段锁句裁剪·阶段 A：先切出宽裕 62s 粗窗口（首句前足足倒退 3.2s，绝不吞掉轻声民谣的开头 1~2 字！），
  // 待 Demucs 剥离纯净人声轨后，再由 vocal-humanizer.py --stage find_window 按真实静音缝做 10ms 级精确锁句！
  const coarseDur = coarse ? 62 : targetSec;
  const sentences = await transcribeTimestamps(audioPath, Math.min(120, Math.ceil(totalDur || 120)));
  if (sentences.length >= 1) {
    const first = sentences.find((s) => s.end - s.begin >= 0.7 && s.text.length >= 2) || sentences[0];
    const winStart = Math.max(0, first.begin - (coarse ? 3.2 : 1.2));
    const maxAvail = totalDur > 0 ? Math.max(20, totalDur - winStart) : coarseDur;
    const dur = Math.min(coarseDur, maxAvail);
    log(`[sing-engine] Paraformer 粗定位命中 ${sentences.length} 句 -> 粗切 ${winStart.toFixed(1)}s ~ ${(winStart + dur).toFixed(1)}s (${dur.toFixed(1)}s，后续按纯净人声轨精确锁句)`);
    return { start: winStart, duration: dur, reason: 'paraformer-coarse', exactTrim: coarse };
  }

  const fallbackStart = totalDur > 85 ? 14 : 0;
  const fallbackDur = totalDur > 0 ? Math.min(coarseDur, Math.max(20, totalDur - fallbackStart)) : coarseDur;
  log(`[sing-engine] 歌词打点未命中，粗切 ${fallbackStart}s ~ ${(fallbackStart + fallbackDur).toFixed(1)}s`);
  return { start: fallbackStart, duration: fallbackDur, reason: 'fallback-coarse', exactTrim: coarse };
}

// ── 同声纹口白生成（自然随机池，避免每次一模一样） ───────────────────────────
function pickFramingLines({ mode, songTitle, isOriginal, introText, outroText }) {
  const titleBit = songTitle ? `《${songTitle}》` : '这首歌';
  const acapIntros = [
    `行吧，那我给你清唱一段${titleBit}，跑调了不许笑啊。`,
    `清唱是吧，我先找找调哈，给你唱几句${titleBit}。`,
    `咳咳，清唱有点考验人啊，那我试着给你哼一段${titleBit}。`,
  ];
  const bgmIntros = [
    `来来来，我把伴奏外放出来跟着唱两句${titleBit}，高音可能有点悬哈。`,
    `行，我放着伴奏给你唱一段${titleBit}，唱得不好别嫌弃啊。`,
    `好嘞，伴奏开起来了，我跟着哼两句${titleBit}。`,
  ];
  const ktvIntros = [
    `麦我拿好了哈，给你来一段KTV感觉的${titleBit}。`,
    `行，那我当在KTV给你唱一段${titleBit}，高音凑合听啊。`,
  ];
  const origIntros = [
    '刚随手瞎哼出来几句小调，我唱给你听听看。',
    '好嘞，现编了一小段词和调，唱得有点随意别笑话我哈。',
  ];
  const outros = [
    '诶，最后那句气差点没接上，凑合听吧。',
    '呼，唱完了，是不是还挺像那么回事儿的。',
    '好啦就唱到这儿，后面高音我先撤了哈哈。',
    '唱完啦，有没有稍微跑一点调，不许打分啊。',
  ];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const intro = introText !== undefined
    ? String(introText || '').trim()
    : (isOriginal ? pick(origIntros) : pick(mode === 'acappella' ? acapIntros : mode === 'ktv' ? ktvIntros : bgmIntros));
  const outro = outroText !== undefined ? String(outroText || '').trim() : pick(outros);
  return { intro, outro };
}

async function synthesizeTtsClip(text, destWav) {
  if (!text) return '';
  try {
    const r = await jfetch(`${CONFIG.ttsBaseUrl}/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      timeoutMs: 30000,
    }, 2);
    const src = r.body?.absPath || r.body?.file;
    if (!r.ok || !src || !fs.existsSync(src)) return '';
    // 用 ffmpeg 规范化成干净 44.1kHz 单声道 WAV（消除 DashScope 流式 WAV 头占位长度）
    await ff(['-i', src, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', destWav], 30000);
    return destWav;
  } catch {
    return '';
  }
}

// ── 共享核心：Demucs htdemucs_ft -> F0 自动定调 -> Pre-RVC -> RVC -> Post-RVC ──
function mapLevels(level) {
  switch (String(level || 'natural')) {
    case 'subtle': return { pre: 'subtle', post: 'subtle' };
    case 'casual': return { pre: 'casual', post: 'casual' };
    case 'offkey': return { pre: 'offkey', post: 'casual' };
    case 'natural':
    default:
      // 经真·实耳与 QQ 实测验证的最自然黄金档：Pre-RVC casual + Post-RVC natural
      return { pre: 'casual', post: 'natural' };
  }
}

async function runHumanizedVocalPipeline({
  clipWav,
  workDir,
  outFile,
  mode = 'bedroom_bgm',
  level = 'natural',
  songTitle = '',
  isOriginal = false,
  framing = true,
  exactPhraseTrim = false,
  targetSongSec = 41,
  introText,
  outroText,
  pitchOverride = null,
  log = console.error,
}) {
  const safeMode = ['acappella', 'bedroom_bgm', 'ktv'].includes(mode) ? mode : 'bedroom_bgm';
  const levels = mapLevels(level);
  const seedBase = Math.floor(Date.now() % 100000);

  // 1. Demucs htdemucs_ft 零漏音分轨（全链路无损 FLAC 传输，省 3~6 倍带宽且 100% 保留立体声相位；清唱模式跳过伴奏轨下载）
  log(`[sing-engine] Demucs htdemucs_ft 分离人声与伴奏…`);
  let uploadClip = clipWav;
  let uploadMime = 'audio/wav';
  const clipFlac = path.join(workDir, 'clip.flac');
  try {
    await ff(['-i', clipWav, '-c:a', 'flac', '-compression_level', '5', clipFlac], 60000);
    if (fs.existsSync(clipFlac) && fs.statSync(clipFlac).size > 20 * 1024) {
      uploadClip = clipFlac;
      uploadMime = 'audio/flac';
    }
  } catch {}
  const clipUrl = await uploadToReplicate(uploadClip, uploadMime);
  const stems = await runReplicateModel('cjwbw/demucs', {
    audio: clipUrl,
    model_name: 'htdemucs_ft',
    stem: 'vocals',
    output_format: 'flac',
  }, 'Demucs(htdemucs_ft)');

  if (!stems?.vocals) throw new Error('Demucs 未产出人声轨');
  const vocalFlac = path.join(workDir, 'vocals.flac');
  const instFlac = path.join(workDir, 'other.flac');
  const needInst = safeMode !== 'acappella' && Boolean(stems.other);
  await Promise.all([
    downloadFile(stems.vocals, vocalFlac),
    needInst ? downloadFile(stems.other, instFlac) : Promise.resolve(),
  ]);
  let vocalRaw = path.join(workDir, 'vocals.wav');
  let instRaw = path.join(workDir, 'other.wav');
  await Promise.all([
    ff(['-i', vocalFlac, '-c:a', 'pcm_s16le', vocalRaw], 60000),
    needInst ? ff(['-i', instFlac, '-c:a', 'pcm_s16le', instRaw], 60000) : Promise.resolve(),
  ]);

  // 1.5 两阶段锁句裁剪·阶段 B：在 Demucs 纯净人声轨上做 10ms 级完整乐句起止锁定（绝不半句开唱或漏唱下句两字！）
  if (exactPhraseTrim) {
    try {
      const maxDur = Math.min(44.5, Math.max(32, Number(targetSongSec) + 3.5));
      const { stdout } = await execAsync(CONFIG.humanizerPy, [
        CONFIG.humanizerScript,
        '--stage', 'find_window',
        '--vocal', vocalRaw,
        '--min-dur', '20.5',
        '--target-dur', String(Math.min(41, Math.max(26, Number(targetSongSec) || 40))),
        '--max-dur', String(maxDur),
      ], { timeout: 60000 });
      const win = JSON.parse(stdout.trim().split('\n').at(-1) || '{}');
      if (Number.isFinite(win.start) && Number.isFinite(win.dur) && win.dur >= 14) {
        const vTrim = path.join(workDir, 'vocals-locked.wav');
        const iTrim = path.join(workDir, 'other-locked.wav');
        await ff(['-ss', String(win.start.toFixed(3)), '-i', vocalRaw, '-t', String(win.dur.toFixed(3)), '-c:a', 'pcm_s16le', vTrim]);
        if (fs.existsSync(instRaw)) {
          await ff(['-ss', String(win.start.toFixed(3)), '-i', instRaw, '-t', String(win.dur.toFixed(3)), '-c:a', 'pcm_s16le', iTrim]);
          instRaw = iTrim;
        }
        vocalRaw = vTrim;
        log(`[sing-engine] ✂️ 纯净人声精准锁句: ${win.start.toFixed(2)}s ~ ${win.end.toFixed(2)}s (${win.dur.toFixed(1)}s, ${win.phrases}/${win.total_phrases}句, HNR=${win.avg_hnr}dB)`);
      }
    } catch (e) {
      log(`[sing-engine] 精准锁句跳过(${e.message})，沿用粗切窗`);
    }
  }

  // 2. Praat F0 基频测算 + 自动八度对齐定调（常规 172~440Hz 原调 0 / 低沉男声 <172Hz 升 +12，伴奏零失真！）
  let pitchChange = 0;
  let f0Info = { median_hz: 0, suggested_pitch_shift: 0 };
  if (pitchOverride !== null && pitchOverride !== undefined && Number.isFinite(Number(pitchOverride))) {
    pitchChange = Number(pitchOverride);
  } else {
    try {
      const { stdout } = await execAsync(CONFIG.humanizerPy, [
        CONFIG.humanizerScript, '--stage', 'measure_f0', '--vocal', vocalRaw,
      ], { timeout: 60000 });
      f0Info = JSON.parse(stdout.trim().split('\n').at(-1) || '{}');
      pitchChange = Number(f0Info.suggested_pitch_shift) || 0;
    } catch {}
  }
  log(`[sing-engine] 原唱基频中位数=${f0Info.median_hz || '?'}Hz (p90=${f0Info.p90_hz || '?'}Hz) -> pitch_change=${pitchChange}`);

  // 3. Pre-RVC: 立体声 Mid/Side 居中主唱提纯(剥离宽混响/和声) + 去嗡鸣门限 + Praat TD-PSOLA 活人微瑕
  const vocalPreHum = path.join(workDir, 'vocal-prehum.wav');
  await execAsync(CONFIG.humanizerPy, [
    CONFIG.humanizerScript,
    '--stage', 'pre_rvc',
    '--vocal', vocalRaw,
    '--mode', 'bedroom_bgm',
    '--level', levels.pre,
    '--seed', String(seedBase),
    '--out', vocalPreHum,
  ], { timeout: 120000 });

  // 4. RVC 换声（protect=0.45 保咬字清晰、index_rate=0.28 去金属嗡声）+ 并行生成同声纹前后口白（0 额外延迟！）
  const lines = framing ? pickFramingLines({ mode: safeMode, songTitle, isOriginal, introText, outroText }) : { intro: '', outro: '' };
  const introWav = path.join(workDir, 'intro.wav');
  const outroWav = path.join(workDir, 'outro.wav');

  const [rvcOut, gotIntro, gotOutro] = await Promise.all([
    (async () => {
      const modelUrl = await ensureRvcModelUrl(log);
      const vUrl = await uploadToReplicate(vocalPreHum, 'audio/wav');
      const out = await runReplicateModel('pseudoram/rvc-v2', {
        input_audio: vUrl,
        rvc_model: 'CUSTOM',
        custom_rvc_model_download_url: modelUrl,
        pitch_change: pitchChange,
        f0_method: 'rmvpe',
        protect: 0.45,
        index_rate: 0.28,
        rms_mix_rate: 0.32,
        output_format: 'wav',
      }, 'RVC-v2');
      const url = Array.isArray(out) ? out.at(-1) : out;
      const dst = path.join(workDir, 'vocal-her.wav');
      await downloadFile(url, dst);
      return dst;
    })(),
    framing && lines.intro ? synthesizeTtsClip(lines.intro, introWav) : Promise.resolve(''),
    framing && lines.outro ? synthesizeTtsClip(lines.outro, outroWav) : Promise.resolve(''),
  ]);

  // 5. 确保 总时长(intro + song + outro) <= 58.5s（单条 QQ 语音完美装下不截断）
  const [songDur, introDur, outroDur] = await Promise.all([
    probeDuration(rvcOut),
    gotIntro ? probeDuration(gotIntro) : Promise.resolve(0),
    gotOutro ? probeDuration(gotOutro) : Promise.resolve(0),
  ]);
  let useIntro = gotIntro;
  let useOutro = gotOutro;
  if (songDur + introDur + outroDur > 58.8) {
    // 优先保主歌与开场白，超 58.8s 时省掉收尾口白避免触发 QQ 60s 分段
    useOutro = '';
    if (songDur + introDur > 58.8) useIntro = '';
  }

  // 6. Post-RVC: 智能防叠加换气 + 手机近麦/房间外放/KTV 声学 + 口白无缝封装 -> 24kHz 单声道 WAV
  const postArgs = [
    CONFIG.humanizerScript,
    '--stage', 'post_rvc',
    '--vocal', rvcOut,
    '--mode', safeMode,
    '--level', levels.post,
    '--seed', String(seedBase + 101),
    '--out-sr', '24000',
    '--out', outFile,
  ];
  if (safeMode !== 'acappella' && fs.existsSync(instRaw)) {
    postArgs.push('--inst', instRaw);
  }
  if (useIntro) postArgs.push('--intro', useIntro);
  if (useOutro) postArgs.push('--outro', useOutro);

  await execAsync(CONFIG.humanizerPy, postArgs, { timeout: 120000 });
  const finalDur = await probeDuration(outFile);
  log(`[sing-engine] 完成 ${path.basename(outFile)} | mode=${safeMode} level=${level} pitch=${pitchChange} dur=${finalDur.toFixed(1)}s`);
  return {
    file: outFile,
    mode: safeMode,
    level,
    pitchChange,
    medianHz: f0Info.median_hz || 0,
    durationSec: Number(finalDur.toFixed(1)),
  };
}

// ── 曲库 LRU 秒唱缓存（上限 60 首 ≈ 150MB，QQ 聊天与实时通话共享！） ───────────
function songCacheId(song, mode = 'bedroom_bgm') {
  const norm = String(song || '').toLowerCase().replace(/[\s《》【】"'.,!?，。！？\-—_]/g, '');
  if (!norm) return '';
  const safeMode = ['acappella', 'bedroom_bgm', 'ktv'].includes(mode) ? mode : 'bedroom_bgm';
  const hash = crypto.createHash('sha1').update(`${norm}|${safeMode}`).digest('hex').slice(0, 12);
  return `${safeMode}-${hash}`;
}

export function findCachedSong({ song = '', mode = 'bedroom_bgm' } = {}) {
  const cid = songCacheId(song, mode);
  if (!cid || !fs.existsSync(CONFIG.songCacheDir)) return null;
  const wavPath = path.join(CONFIG.songCacheDir, `${cid}.wav`);
  const metaPath = path.join(CONFIG.songCacheDir, `${cid}.json`);
  try {
    const st = fs.statSync(wavPath);
    if (!st.isFile() || st.size < 40 * 1024) return null;
    const now = new Date();
    try { fs.utimesSync(wavPath, now, now); } catch {}
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
    return {
      file: wavPath,
      song: meta.song || song,
      artist: meta.artist || '',
      mode: meta.mode || mode,
      durationSec: Number(meta.durationSec) || 0,
      pitchChange: Number(meta.pitchChange) || 0,
      cached: true,
    };
  } catch {
    return null;
  }
}

function saveSongToCache({ song, artist = '', mode = 'bedroom_bgm', wavFile, durationSec = 0, pitchChange = 0 }) {
  const cid = songCacheId(song, mode);
  if (!cid || !wavFile || !fs.existsSync(wavFile)) return;
  try {
    fs.mkdirSync(CONFIG.songCacheDir, { recursive: true });
    const dstWav = path.join(CONFIG.songCacheDir, `${cid}.wav`);
    const dstMeta = path.join(CONFIG.songCacheDir, `${cid}.json`);
    fs.copyFileSync(wavFile, dstWav);
    fs.writeFileSync(dstMeta, JSON.stringify({
      song,
      artist,
      mode,
      durationSec,
      pitchChange,
      savedAt: new Date().toISOString(),
    }, null, 2));

    // LRU 淘汰超出上限的最旧曲目，严格兜底磁盘占用
    const maxItems = Math.max(3, CONFIG.songCacheMax || 60);
    const entries = fs.readdirSync(CONFIG.songCacheDir)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => {
        const fp = path.join(CONFIG.songCacheDir, f);
        return { base: f.slice(0, -4), mtimeMs: fs.statSync(fp).mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const old of entries.slice(maxItems)) {
      try { fs.unlinkSync(path.join(CONFIG.songCacheDir, `${old.base}.wav`)); } catch {}
      try { fs.unlinkSync(path.join(CONFIG.songCacheDir, `${old.base}.json`)); } catch {}
    }
  } catch {}
}

// ── 进行中同曲并发合并（防止同一首歌被重复点歌时跑多份 Demucs + RVC 互相挤兑） ─
const INFLIGHT_COVERS = new Map();

// ── 公开入口 1：点歌翻唱已有歌曲（支持歌名检索 / 曲库秒唱缓存 / 外部链接 / 本地音频） ─
export async function coverSong({
  song = '',
  artist = '',
  bvid = '',
  file = '',
  url = '',
  mode = 'bedroom_bgm',
  level = 'natural',
  start = null,
  seconds = 45,
  framing = true,
  useCache = true,
  intro,
  outro,
  pitchChange = null,
  outDir = '/opt/qq-bridge/audio/tts',
  log = console.error,
} = {}) {
  fs.mkdirSync(CONFIG.workRoot, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const safeMode = ['acappella', 'bedroom_bgm', 'ktv'].includes(mode) ? mode : 'bedroom_bgm';
  const resolvedTitle = String(song || '').replace(/[《》]/g, '').trim();
  const canShareKey = Boolean(useCache && resolvedTitle && !file && !url && !bvid && start === null && !intro && !outro);
  const inflightKey = canShareKey ? songCacheId(resolvedTitle, safeMode) : '';

  // 0. 命中曲库秒唱缓存（仅按歌名翻唱且未指定自定义起止/口白时直接 0 秒返回！）
  if (canShareKey) {
    const hit = findCachedSong({ song: resolvedTitle, mode: safeMode });
    if (hit) {
      const outFile = path.join(outDir, `cover-cached-${Date.now()}.wav`);
      fs.copyFileSync(hit.file, outFile);
      log(`[sing-engine] ⚡ 命中曲库秒唱缓存: 《${resolvedTitle}》(${safeMode}, ${hit.durationSec}s)`);
      return {
        file: outFile,
        mode: safeMode,
        level,
        pitchChange: hit.pitchChange,
        durationSec: hit.durationSec,
        song: resolvedTitle,
        artist: artist || hit.artist,
        cached: true,
      };
    }
    // 0.5 并发去重：若完全相同的 (歌名, 模式) 正在渲染中，直接复用同一份 Promise 零重复开销！
    if (inflightKey && INFLIGHT_COVERS.has(inflightKey)) {
      log(`[sing-engine] 🔁 复用进行中的同曲渲染任务: 《${resolvedTitle}》(${safeMode})`);
      const shared = await INFLIGHT_COVERS.get(inflightKey);
      const dupOut = path.join(outDir, `cover-shared-${Date.now()}.wav`);
      if (shared?.file && fs.existsSync(shared.file)) {
        fs.copyFileSync(shared.file, dupOut);
        return { ...shared, file: dupOut };
      }
      const hitAfter = findCachedSong({ song: resolvedTitle, mode: safeMode });
      if (hitAfter) {
        fs.copyFileSync(hitAfter.file, dupOut);
        return { ...shared, file: dupOut };
      }
      return shared;
    }
  }

  const runJob = async () => {
    const workDir = fs.mkdtempSync(path.join(CONFIG.workRoot, 'cover-'));
    try {
      let sourcePath = '';
      let matchedInfo = null;

      if (file && fs.existsSync(file)) {
        sourcePath = file;
      } else if (url) {
        sourcePath = path.join(workDir, 'source-url.bin');
        await downloadFile(String(url), sourcePath);
      } else if (resolvedTitle) {
        sourcePath = path.join(workDir, 'source.m4a');
        matchedInfo = await searchAndDownloadBilibiliSong({ song: resolvedTitle, artist, bvid, destPath: sourcePath, log });
      } else {
        throw new Error('请提供歌名(song)、音频文件(file)或音频链接(url)');
      }

      // 阶段 A：宽裕粗切（约 62s），待 Demucs 分出纯净人声轨后再精准按完整乐句锁边裁剪
      const win = await locateSongWindow(sourcePath, { start, seconds: Math.min(45, Number(seconds) || 42), coarse: true, log });
      const clipWav = path.join(workDir, 'clip.wav');
      await ff([
        '-ss', String(win.start.toFixed(2)),
        '-i', sourcePath,
        '-t', String(win.duration.toFixed(2)),
        '-ar', '44100', '-ac', '2',
        clipWav,
      ]);

      const outFile = path.join(outDir, `cover-${Date.now()}.wav`);
      const res = await runHumanizedVocalPipeline({
        clipWav,
        workDir,
        outFile,
        mode: safeMode,
        level,
        songTitle: resolvedTitle,
        isOriginal: false,
        framing,
        exactPhraseTrim: Boolean(win.exactTrim),
        targetSongSec: Math.min(43, Number(seconds) || 41),
        introText: intro,
        outroText: outro,
        pitchOverride: pitchChange,
        log,
      });
      if (resolvedTitle && useCache && framing) {
        saveSongToCache({
          song: resolvedTitle,
          artist,
          mode: safeMode,
          wavFile: outFile,
          durationSec: res.durationSec,
          pitchChange: res.pitchChange,
        });
      }
      return { ...res, song: resolvedTitle, artist, matched: matchedInfo, cached: false };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
    }
  };

  if (!inflightKey) return runJob();
  const promise = runJob();
  INFLIGHT_COVERS.set(inflightKey, promise);
  try {
    return await promise;
  } finally {
    if (INFLIGHT_COVERS.get(inflightKey) === promise) {
      INFLIGHT_COVERS.delete(inflightKey);
    }
  }
}

// ── 公开入口 2：原创写词谱曲哼唱（ACE-Step + 同一套活人微瑕与声学引擎） ────────
export async function makeOriginalSong({
  lyrics,
  tags = 'chinese pop, cute sweet female vocal, light and fresh, acoustic guitar and ukulele, gentle, warm, 92bpm',
  duration = 42,
  mode = 'bedroom_bgm',
  level = 'natural',
  framing = true,
  intro,
  outro,
  outDir = '/opt/qq-bridge/audio/tts',
  log = console.error,
} = {}) {
  const cleanLyrics = String(lyrics || '').trim();
  if (!cleanLyrics) throw new Error('lyrics 不能为空');
  fs.mkdirSync(CONFIG.workRoot, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(CONFIG.workRoot, 'orig-'));
  try {
    // 压在 46s 以内，保证加上口白后单条 60s 内完美装下
    const genDur = Math.min(46, Math.max(22, Number(duration) || 42));
    log(`[sing-engine] ACE-Step 原创编曲生成 (${genDur}s)…`);
    const gen = await runReplicateModel('lucataco/ace-step', {
      lyrics: cleanLyrics,
      tags: String(tags),
      duration: genDur,
      number_of_steps: 32,
    }, 'ACE-Step');
    const genUrl = Array.isArray(gen) ? gen.at(-1) : gen;
    const rawMp3 = path.join(workDir, 'raw.mp3');
    await downloadFile(genUrl, rawMp3);

    const clipWav = path.join(workDir, 'clip.wav');
    await ff(['-i', rawMp3, '-ar', '44100', '-ac', '2', clipWav]);

    const outFile = path.join(outDir, `song-${Date.now()}.wav`);
    const res = await runHumanizedVocalPipeline({
      clipWav,
      workDir,
      outFile,
      mode,
      level,
      songTitle: '',
      isOriginal: true,
      framing,
      introText: intro,
      outroText: outro,
      pitchOverride: null,
      log,
    });
    return { ...res, tags, lyrics: cleanLyrics };
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

// ── CLI 调试入口（方便脱离服务直接单测） ──────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flags = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const k = args[i].slice(2);
      const v = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      flags[k] = v;
    }
  }
  try {
    if (cmd === 'cover') {
      const out = await coverSong({
        song: flags.song || '',
        artist: flags.artist || '',
        bvid: flags.bvid || '',
        file: flags.file || '',
        url: flags.url || '',
        mode: flags.mode || 'bedroom_bgm',
        level: flags.level || 'natural',
        start: flags.start !== undefined ? Number(flags.start) : null,
        seconds: flags.seconds !== undefined ? Number(flags.seconds) : 45,
        pitchChange: flags.pitch !== undefined ? Number(flags.pitch) : null,
        framing: flags.framing !== 'false',
        useCache: flags.noCache !== 'true',
        outDir: flags.outDir || os.tmpdir(),
      });
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'original') {
      const out = await makeOriginalSong({
        lyrics: flags.lyrics || '[verse]\n晚风轻轻吹过窗台\n星星落进奶茶杯里\n[chorus]\n今天也要开开心心\n明天继续一起发呆',
        tags: flags.tags,
        duration: flags.duration ? Number(flags.duration) : 38,
        mode: flags.mode || 'bedroom_bgm',
        level: flags.level || 'natural',
        framing: flags.framing !== 'false',
        outDir: flags.outDir || os.tmpdir(),
      });
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.error('用法: node humanized-sing-engine.mjs cover --song 红色高跟鞋 --artist 蔡健雅 [--mode acappella|bedroom_bgm|ktv] | original --lyrics "..."');
      process.exit(2);
    }
  } catch (e) {
    console.error('[sing-engine] ERROR:', e.message);
    process.exit(1);
  }
}
