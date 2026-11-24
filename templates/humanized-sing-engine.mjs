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
  const useReplicateCurl = Boolean(CONFIG.replicateProxy && isReplicateUrl(url) && typeof opts.body !== 'object');
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      if (useReplicateCurl) {
        const proxyArgs = i < tries - 1 ? ['-x', CONFIG.replicateProxy] : ['--noproxy', '*'];
        const method = String(opts.method || 'GET').toUpperCase();
        const headerArgs = [];
        for (const [k, v] of Object.entries(opts.headers || {})) {
          if (v !== undefined && v !== null && String(v) !== '') headerArgs.push('-H', `${k}: ${v}`);
        }
        const args = [
          '-sS', '--max-time', String(Math.ceil((opts.timeoutMs || 60000) / 1000)),
          '--connect-timeout', '15',
          ...proxyArgs,
          '-X', method,
          ...headerArgs,
        ];
        if (typeof opts.body === 'string' && opts.body.length > 0) {
          args.push('--data-raw', opts.body);
        }
        args.push('-w', '\n__HTTP_CODE__:%{http_code}', String(url));
        const { stdout } = await execAsync('curl', args, { timeout: (opts.timeoutMs || 60000) + 10000 });
        const marker = '\n__HTTP_CODE__:';
        const idx = stdout.lastIndexOf(marker);
        const status = idx >= 0 ? Number(stdout.slice(idx + marker.length).trim()) : 200;
        const text = idx >= 0 ? stdout.slice(0, idx) : stdout;
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 240) }; }
        return { ok: status >= 200 && status < 300, status, body };
      }
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

  // 严防外放录屏音箱试听（满屏房间大混响）、AMV 混剪、翻唱、多人大合唱、DJ/琴谱/KTV
  const badRe = /翻唱|cover|男声版|女声版|伴奏|纯音乐|练唱|教程|吉他谱|琴谱|光遇|翻弹|串烧|合集|歌单|reaction|解析|教学|ai翻唱|dj版|dj\b|变速|升调|降调|0\.8x|1\.2x|群星|合唱|大合唱|男女对唱|对唱|多人|声乐团|钢琴版|唢呐|二胡|古筝版|录音棚大声听|专业录音棚听|百万豪装|百万级|录音棚试听|音响试听|音箱试听|耳机试听|车载音响|沉浸式试听|此时此刻|amv|mad|混剪|踩点|高燃|剪辑|鬼畜|日文版|日语版|韩文版|ktv|mtv|左耳.*右耳|毕业歌会/i;
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

// ── Paraformer 歌词精确打点（支持任意起点与全曲扫描） ─────────────────────────
async function transcribeTimestamps(audioPath, { startSec = 0, maxSec = 120 } = {}) {
  const key = getDashscopeKey();
  const WS = loadWsClass();
  if (!key || !WS) return [];

  const pcmPath = `${audioPath}.asr16k.${Date.now()}.wav`;
  try {
    const ssArgs = startSec > 0.05 ? ['-ss', String(startSec.toFixed(2))] : [];
    await ff([...ssArgs, '-i', audioPath, '-t', String(maxSec), '-ac', '1', '-ar', '16000', pcmPath], 90000);
    const pcm = fs.readFileSync(pcmPath).subarray(44);
    if (pcm.length < 3200) return [];
    const sentences = [];
    const taskId = `sing_asr_${Date.now()}_${Math.floor(Math.random() * 1e5)}`;

    await new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      const timerGuard = setTimeout(done, Math.max(45000, Math.round(maxSec * 450)));
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
          }, 12);
        } else if (ev === 'result-generated') {
          const s = m.payload?.output?.sentence;
          if (s?.sentence_end && s.text && String(s.text).trim().length >= 1) {
            sentences.push({
              begin: startSec + (Number(s.begin_time) || 0) / 1000,
              end: startSec + (Number(s.end_time) || 0) / 1000,
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

function resolveLengthSpec(length = 'half', seconds = null) {
  const norm = String(length || '').toLowerCase().trim();
  if (norm === 'snippet' || norm === 'short' || norm === '浅唱') {
    return { length: 'snippet', coarseDur: 78, minDur: 22, targetDur: 45, maxDur: 55.5 };
  }
  if (norm === 'full' || norm === 'complete' || norm === '整首' || norm === '完整') {
    return { length: 'full', coarseDur: 260, minDur: 85, targetDur: 215, maxDur: 255 };
  }
  if (norm === 'continue' || norm === 'next' || norm === '继续') {
    return { length: 'continue', coarseDur: 155, minDur: 22, targetDur: 96, maxDur: 148 };
  }
  if (norm === 'half' || norm === '半首') {
    return { length: 'half', coarseDur: 138, minDur: 50, targetDur: 92, maxDur: 124 };
  }
  // 兼容旧调用仅传 seconds 时自动推断档位
  if (seconds !== null && seconds !== undefined && Number.isFinite(Number(seconds)) && Number(seconds) > 0) {
    const s = Number(seconds);
    if (s <= 56) return { length: 'snippet', coarseDur: 78, minDur: 22, targetDur: Math.min(52, Math.max(28, s)), maxDur: 55.5 };
    if (s >= 135) return { length: 'full', coarseDur: Math.min(260, s + 25), minDur: 85, targetDur: Math.min(225, s), maxDur: Math.min(255, s + 20) };
    return { length: 'half', coarseDur: 138, minDur: 50, targetDur: s, maxDur: Math.min(126, s + 24) };
  }
  return { length: 'half', coarseDur: 138, minDur: 50, targetDur: 92, maxDur: 124 };
}

async function locateSongWindow(audioPath, {
  start = null,
  continueFromSec = null,
  length = 'half',
  seconds = null,
  coarse = true,
  log = console.error,
} = {}) {
  const totalDur = await probeDuration(audioPath);
  const spec = resolveLengthSpec(length, seconds);

  if (start !== null && start !== undefined && Number.isFinite(Number(start)) && Number(start) >= 0) {
    const s = Number(start);
    const reqDur = Number(seconds) > 0 ? Number(seconds) : spec.targetDur;
    const dur = totalDur > 0 ? Math.min(reqDur, Math.max(10, totalDur - s)) : reqDur;
    return { start: s, duration: dur, totalDur, spec, reason: 'explicit', exactTrim: false };
  }

  // 续唱模式（“继续唱”）：从上一首结束处往后扫描，自动跳过 15~30s 纯音乐间奏直奔下一完整乐段！
  if (continueFromSec !== null && continueFromSec !== undefined && Number.isFinite(Number(continueFromSec)) && Number(continueFromSec) > 1) {
    const baseFrom = Number(continueFromSec);
    if (totalDur > 0 && baseFrom >= totalDur - 11) {
      throw new Error('这首歌刚才已经唱到最后一句啦，没有后面的段落了');
    }
    const scanMax = totalDur > 0 ? Math.min(120, Math.ceil(totalDur - baseFrom)) : 120;
    const sentences = await transcribeTimestamps(audioPath, { startSec: baseFrom, maxSec: scanMax });
    const first = sentences.find((s) => s.end - s.begin >= 0.6 && s.text.length >= 2) || sentences[0];
    const winStart = first ? Math.max(baseFrom, first.begin - 2.6) : baseFrom;
    const maxAvail = totalDur > 0 ? Math.max(12, totalDur - winStart) : spec.coarseDur;
    const dur = Math.min(spec.coarseDur, maxAvail);
    log(`[sing-engine] 续唱定位(from=${baseFrom.toFixed(1)}s) 命中 ${sentences.length} 句 -> 粗切 ${winStart.toFixed(1)}s ~ ${(winStart + dur).toFixed(1)}s (${dur.toFixed(1)}s)`);
    return { start: winStart, duration: dur, totalDur, spec, reason: 'continue-coarse', exactTrim: coarse };
  }

  if (totalDur > 0 && totalDur <= spec.minDur + 12) {
    return { start: 0, duration: totalDur, totalDur, spec, reason: 'short-source', exactTrim: coarse };
  }

  // 两阶段锁句/锁段裁剪·阶段 A：
  // 混音版 Paraformer 在轻声吉他前奏（如《晴天》“故事的小黄花”）常漏掉最前 10~15s 才识别到第一句！
  // 因此 half/full 直接从 0s 起切（把完整前奏+主歌1+副歌1 交给 Demucs，再在零伴奏纯净人声轨上精准锁第一句），
  // snippet 也向前足足倒退 12s，彻底根绝切丢歌曲真正第一句！
  if (coarse && (spec.length === 'half' || spec.length === 'full')) {
    const startSec = 0;
    const coarseDur = spec.length === 'full' ? Math.min(260, totalDur || 260) : Math.min(155, totalDur || 155);
    const dur = totalDur > 0 ? Math.min(coarseDur, totalDur) : coarseDur;
    log(`[sing-engine] 阶段 A 全开场粗切(${spec.length}): 0.0s ~ ${dur.toFixed(1)}s (${dur.toFixed(1)}s，防漏轻声首句，后续在纯净人声轨锁完整乐段)`);
    return { start: startSec, duration: dur, totalDur, spec, reason: 'full-head-coarse', exactTrim: true };
  }

  const coarseDur = coarse ? spec.coarseDur : spec.targetDur;
  const sentences = await transcribeTimestamps(audioPath, { startSec: 0, maxSec: Math.min(120, Math.ceil(totalDur || 120)) });
  if (sentences.length >= 1) {
    const first = sentences.find((s) => s.end - s.begin >= 0.7 && s.text.length >= 2) || sentences[0];
    const winStart = Math.max(0, first.begin - (coarse ? 12.0 : 1.2));
    const maxAvail = totalDur > 0 ? Math.max(20, totalDur - winStart) : coarseDur;
    const dur = Math.min(coarseDur, maxAvail);
    log(`[sing-engine] Paraformer 粗定位(${spec.length})命中 ${sentences.length} 句 -> 粗切 ${winStart.toFixed(1)}s ~ ${(winStart + dur).toFixed(1)}s (${dur.toFixed(1)}s，后续按纯净人声轨锁完整乐段)`);
    return { start: winStart, duration: dur, totalDur, spec, reason: 'paraformer-coarse', exactTrim: coarse };
  }

  const fallbackStart = totalDur > 85 ? 14 : 0;
  const fallbackDur = totalDur > 0 ? Math.min(coarseDur, Math.max(20, totalDur - fallbackStart)) : coarseDur;
  log(`[sing-engine] 歌词打点未命中(${spec.length})，粗切 ${fallbackStart}s ~ ${(fallbackStart + fallbackDur).toFixed(1)}s`);
  return { start: fallbackStart, duration: fallbackDur, totalDur, spec, reason: 'fallback-coarse', exactTrim: coarse };
}

/**
 * 阶段 B-2：在 Demucs 分离后的 100% 纯净人声轨上跑 Paraformer 歌词识别，
 * 再交由极速 LLM 按音乐段落（完整四句联 / 完整主歌+副歌 / 进间奏前收尾）选出最完整的起止句号与多段切分点！
 */
async function pickStanzaWindowWithLlm({
  vocalRaw,
  phrasesDetail,
  totalClipDur,
  songTitle = '',
  spec,
  log = console.error,
}) {
  const key = getDashscopeKey();
  if (!key || !Array.isArray(phrasesDetail) || phrasesDetail.length < 3) return null;

  const asrSents = await transcribeTimestamps(vocalRaw, { startSec: 0, maxSec: Math.min(265, Math.ceil(totalClipDur + 2)) });
  if (!asrSents || asrSents.length < 2) return null;

  // 将纯净人声 ASR 歌词按时间重叠对齐到精确声学乐句 phrasesDetail 上
  const annotated = phrasesDetail.map((p) => {
    const texts = [];
    for (const s of asrSents) {
      const ov = Math.min(p.end, s.end) - Math.max(p.start, s.begin);
      const sDur = Math.max(0.15, s.end - s.begin);
      const pDur = Math.max(0.15, p.end - p.start);
      if (ov >= Math.min(0.25, sDur * 0.35, pDur * 0.35)) {
        texts.push(s.text);
      }
    }
    return { ...p, text: texts.join(' ').trim() };
  });

  const nonEmptyCount = annotated.filter((x) => x.text.length >= 2).length;
  if (nonEmptyCount < 2) return null;

  const firstSingStart = annotated[0]?.start || 0;
  const linesText = annotated
    .map((p) => {
      const cumSec = Math.max(0, p.end - firstSingStart);
      return `[${p.idx}] ${p.start.toFixed(1)}s-${p.end.toFixed(1)}s (自首唱累计${cumSec.toFixed(0)}s, 后停${p.gap_after.toFixed(1)}s${p.chaotic ? ',多人合唱/混沌' : ''}) ${p.text || '(哼唱/长音)'}`;
    })
    .join('\n');

  const modeHint = spec.length === 'snippet'
    ? '【浅唱一段】选 1 个完整乐段（约 30~54 秒，如完整 4 句主歌或完整副歌），确保单条 58 秒语音装得下'
    : spec.length === 'full'
      ? '【唱完整一首】从全曲第 1 个完整唱段一直唱到全曲最后 1 句完整收尾（尽量覆盖全曲）'
      : spec.length === 'continue'
        ? '【续唱后半首】从紧接上文的下一个完整乐段第 1 句开始，唱完完整一大段或一直唱到全曲结尾'
        : '【唱半首（默认）】选完整的前半首——把「完整主歌 + 导歌 + 完整第一遍副歌」唱完，在进间奏/副歌彻底收束处干净结束（约 65~118 秒；若歌曲本身较短则唱完完整一大段）';

  const prompt = [
    `以下是歌曲${songTitle ? `《${songTitle}》` : ''}纯净人声轨的逐句时间戳、句后停顿时长与识别歌词：`,
    linesText,
    '',
    `演唱目标：${modeHint}。参考时长区间 ${spec.minDur.toFixed(0)}~${spec.maxDur.toFixed(0)} 秒（目标约 ${spec.targetDur.toFixed(0)} 秒）。`,
    '请严格遵守以下音乐段落铁律，选出起止句号 startIdx、endIdx：',
    '1. 起点 startIdx 必须是完整乐段的第 1 句（跳过开头 <0.2s 残句或电影念白对白）；',
    '2. 终点 endIdx **必须落在完整音乐段落/四句联/副歌最后一句的句尾**（语义完整、韵脚收束，优先选后停顿较长或进间奏前的自然段落尾），**严禁停在四句段落的第 2 或第 3 句、严禁停在问答/排比未完的上句！** 宁可比目标多唱 6~10 秒把最后一句唱完，也绝不腰斩段落；',
    '3. 若尾部出现标注「多人合唱/混沌」的杂乱段落，尽量在其之前一完整乐段收尾；',
    '4. 如果你选出的总时长超过 55 秒（需要自动拆成多条 ≤55 秒的 QQ 语音条），请同时给出切分句号数组 splitAfter（每个元素 s 表示在第 s 句结束后的停顿处切一刀，切分点也必须落在完整乐句/小段结尾，确保切出的每一段都 ≤55 秒且 ≥16 秒；不需要拆分则给空数组 []）。',
    '严格只输出一行 JSON，不要任何解释：{"startIdx": 0, "endIdx": 11, "splitAfter": [5], "reason": "简短说明起止段落"}',
  ].join('\n');

  try {
    const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen-plus-latest',
        temperature: 0.1,
        max_tokens: 260,
        enable_thinking: false,
        messages: [
          { role: 'system', content: '你是专业华语声乐制作人与音乐结构编辑，擅长按完整乐段（四句联/主歌/副歌）精准定剪歌曲。只输出严格 JSON。' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    let raw = String(data?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    const parsed = JSON.parse(raw.slice(s, e + 1));

    const startIdx = Number(parsed.startIdx);
    const endIdx = Number(parsed.endIdx);
    if (!Number.isInteger(startIdx) || !Number.isInteger(endIdx)) return null;
    if (startIdx < 0 || endIdx >= annotated.length || endIdx < startIdx) return null;

    // 映射回 10ms 精确声学边界（严守 trimEnd <= next_start - 0.16s，数学上绝不漏下句半个字！）
    const pFirst = annotated[startIdx];
    const prevEnd = startIdx > 0 ? annotated[startIdx - 1].end : 0.0;
    const gapBefore = Math.max(0, pFirst.start - prevEnd);
    let leadPad = startIdx === 0 ? Math.min(0.95, gapBefore) : Math.min(0.95, Math.max(0.20, gapBefore * 0.55));
    if (startIdx > 0 && pFirst.start - leadPad < prevEnd + 0.18) {
      leadPad = Math.max(0.05, pFirst.start - (prevEnd + 0.18));
    }
    const trimStart = Math.max(0, pFirst.start - leadPad);

    const pLast = annotated[endIdx];
    const nextStart = endIdx + 1 < annotated.length ? annotated[endIdx + 1].start : totalClipDur;
    const gapAfter = Math.max(0, nextStart - pLast.end);
    const tailPad = Math.min(1.15, Math.max(0.18, gapAfter * 0.55));
    const trimEnd = endIdx + 1 < annotated.length
      ? Math.min(pLast.end + tailPad, Math.max(pLast.end + 0.04, nextStart - 0.16))
      : Math.min(totalClipDur, pLast.end + 1.05);

    const dur = trimEnd - trimStart;
    const minAllowed = Math.max(14, Math.min(spec.minDur * 0.72, totalClipDur * 0.55));
    const maxAllowed = spec.length === 'snippet' ? 56.5 : spec.maxDur + 12.0;
    if (!Number.isFinite(dur) || dur < minAllowed || dur > maxAllowed) {
      log(`[sing-engine] LLM 乐段时长越界 (${dur.toFixed(1)}s, 允许 ${minAllowed.toFixed(0)}~${maxAllowed.toFixed(0)}s)，回退声学锁段`);
      return null;
    }

    const rawSplits = Array.isArray(parsed.splitAfter) ? parsed.splitAfter.map(Number).filter((x) => Number.isInteger(x) && x >= startIdx && x < endIdx) : [];
    const reason = String(parsed.reason || '').slice(0, 60);
    return {
      start: Number(trimStart.toFixed(3)),
      end: Number(trimEnd.toFixed(3)),
      dur: Number(dur.toFixed(3)),
      start_idx: startIdx,
      end_idx: endIdx,
      phrases: endIdx - startIdx + 1,
      total_phrases: annotated.length,
      splitAfter: [...new Set(rawSplits)].sort((a, b) => a - b),
      reason,
      annotated,
    };
  } catch (err) {
    log(`[sing-engine] LLM 乐段识别回退(${err?.message ?? err})`);
    return null;
  }
}

/**
 * 为超过单条 QQ 语音上限（>56.5s）的长音频计算精确的「乐句/乐段静音缝切分点」（相对修剪后 0..dur 的秒数），
 * 确保每条 QQ 语音都 <=55.5s 且绝不在歌词字中间硬切！
 */
function computeStanzaSplitPoints({ phrasesDetail = [], startIdx = 0, endIdx = -1, trimStart = 0, totalDur = 0, llmSplitAfter = [], maxPartSec = 55.0 }) {
  if (totalDur <= 56.8) return [];
  const slice = (phrasesDetail || []).slice(startIdx, endIdx >= startIdx ? endIdx + 1 : undefined);
  const candidates = [];
  for (let i = 0; i < slice.length - 1; i++) {
    const cur = slice[i];
    const nxt = slice[i + 1];
    const gap = Math.max(0, nxt.start - cur.end);
    const mid = cur.end + Math.min(gap * 0.5, Math.max(0.06, gap - 0.12)) - trimStart;
    if (mid > 8 && mid < totalDur - 8) {
      candidates.push({
        origIdx: cur.idx,
        sec: Number(mid.toFixed(3)),
        gap,
        isLlmPick: llmSplitAfter.includes(cur.idx),
      });
    }
  }

  // 先检验 LLM 建议的切分点是否本身已经满足每段 <= maxPartSec 且 >= 12s
  if (llmSplitAfter.length) {
    const llmSecs = candidates.filter((c) => c.isLlmPick).map((c) => c.sec).sort((a, b) => a - b);
    const bounds = [0, ...llmSecs, totalDur];
    const allOk = bounds.slice(1).every((b, idx) => (b - bounds[idx]) <= maxPartSec && (b - bounds[idx]) >= 10);
    if (llmSecs.length && allOk) return llmSecs;
  }

  // 否则按最优静音大缝贪心切分：尽量落在 34~54.5s 范围内停顿最长（优先乐段缝）的位置
  const splits = [];
  let cursor = 0;
  while (totalDur - cursor > 56.5) {
    const minCut = cursor + 22.0;
    const maxCut = cursor + maxPartSec;
    const inWin = candidates.filter((c) => c.sec >= minCut && c.sec <= maxCut && (totalDur - c.sec) >= 10.0);
    if (inWin.length) {
      // 优先 LLM 推荐点 + 大停顿（段落缝） + 不要切得太早导致后面多出一条
      const best = inWin.reduce((a, b) => {
        const sa = (a.isLlmPick ? 40 : 0) + Math.min(4.0, a.gap) * 18 + (a.sec - cursor) * 0.35;
        const sb = (b.isLlmPick ? 40 : 0) + Math.min(4.0, b.gap) * 18 + (b.sec - cursor) * 0.35;
        return sb > sa ? b : a;
      });
      splits.push(best.sec);
      cursor = best.sec;
    } else {
      const fallback = Number(Math.min(totalDur - 10, cursor + 53.0).toFixed(3));
      if (fallback <= cursor + 8) break;
      splits.push(fallback);
      cursor = fallback;
    }
  }
  return splits;
}

/**
 * 将长成品 WAV 按精确乐段切分点拆成多条 ≤56s 的无缝 QQ 语音分段（带 50ms 柔淡入淡出防爆音）
 */
async function sliceWavBySplitPoints(wavFile, splitPointsSec = [], outPrefix = '') {
  if (!Array.isArray(splitPointsSec) || !splitPointsSec.length) return [wavFile];
  const totalDur = await probeDuration(wavFile);
  if (totalDur <= 57.5) return [wavFile];
  const pts = splitPointsSec.filter((t) => Number.isFinite(t) && t > 5 && t < totalDur - 5).sort((a, b) => a - b);
  if (!pts.length) return [wavFile];
  const bounds = [0, ...pts, totalDur];
  const base = outPrefix || wavFile.replace(/\.wav$/i, '');
  const segFiles = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const s = bounds[i];
    const d = Math.max(1.0, bounds[i + 1] - s);
    const dst = `${base}-p${i + 1}.wav`;
    const fades = [];
    if (i > 0) fades.push('afade=t=in:st=0:d=0.05');
    if (i < bounds.length - 2) fades.push(`afade=t=out:st=${Math.max(0.1, d - 0.06).toFixed(3)}:d=0.06`);
    const afArgs = fades.length ? ['-af', fades.join(',')] : [];
    await ff(['-ss', s.toFixed(3), '-i', wavFile, '-t', d.toFixed(3), ...afArgs, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', dst], 60000);
    segFiles.push(dst);
  }
  return segFiles;
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
  framing = false,
  exactPhraseTrim = false,
  lengthSpec = null,
  clipOriginSec = 0,
  targetSongSec = 92,
  introText,
  outroText,
  pitchOverride = null,
  log = console.error,
}) {
  const safeMode = ['acappella', 'bedroom_bgm', 'ktv'].includes(mode) ? mode : 'bedroom_bgm';
  const levels = mapLevels(level);
  const seedBase = Math.floor(Date.now() % 100000);
  const spec = lengthSpec || resolveLengthSpec('half', targetSongSec);
  const hasExplicitIntro = introText !== undefined && String(introText || '').trim().length > 0;
  const hasExplicitOutro = outroText !== undefined && String(outroText || '').trim().length > 0;
  const useFraming = Boolean(framing === true || hasExplicitIntro || hasExplicitOutro);

  // 1. Demucs htdemucs_ft 零漏音分轨（上传用 256k AAC/M4A 省 5 倍上行带宽，下载用无损 FLAC 100% 保留立体声相位；清唱模式跳过伴奏轨下载）
  log(`[sing-engine] Demucs htdemucs_ft 分离人声与伴奏…`);
  let uploadClip = clipWav;
  let uploadMime = 'audio/wav';
  const clipM4a = path.join(workDir, 'clip.m4a');
  try {
    await ff(['-i', clipWav, '-c:a', 'aac', '-b:a', '256k', clipM4a], 90000);
    if (fs.existsSync(clipM4a) && fs.statSync(clipM4a).size > 20 * 1024) {
      uploadClip = clipM4a;
      uploadMime = 'audio/mp4';
    }
  } catch {}
  const clipUrl = await uploadToReplicate(uploadClip, uploadMime);
  const stems = await runReplicateModel('cjwbw/demucs', {
    audio: clipUrl,
    model_name: 'htdemucs_ft',
    stem: 'vocals',
    output_format: 'flac',
  }, 'Demucs(htdemucs_ft)', 260);

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
    ff(['-i', vocalFlac, '-c:a', 'pcm_s16le', vocalRaw], 90000),
    needInst ? ff(['-i', instFlac, '-c:a', 'pcm_s16le', instRaw], 90000) : Promise.resolve(),
  ]);

  // 1.5 两阶段锁段裁剪·阶段 B：先用声学乐句分析得到 10ms 精确边界与混沌段标记，
  // 再用纯净人声 Paraformer + LLM 锁定「完整四句/主副歌乐段」（绝不停在四句第 3 句，绝不漏唱下句半个字！）
  let trimRelStart = 0;
  let trimRelEnd = await probeDuration(vocalRaw);
  let splitPointsSec = [];
  let stanzaReason = '';
  if (exactPhraseTrim) {
    try {
      const { stdout } = await execAsync(CONFIG.humanizerPy, [
        CONFIG.humanizerScript,
        '--stage', 'find_window',
        '--vocal', vocalRaw,
        '--min-dur', String(spec.minDur),
        '--target-dur', String(spec.targetDur),
        '--max-dur', String(spec.maxDur),
      ], { timeout: 120000 });
      const pyWin = JSON.parse(stdout.trim().split('\n').at(-1) || '{}');
      let chosen = pyWin;
      let llmSplitAfter = [];

      // 阶段 B-2：在零伴奏纯净人声轨上识别歌词 + LLM 锁完整音乐段落（失败则无感回退声学乐段算法）
      if (Array.isArray(pyWin.phrases_detail) && pyWin.phrases_detail.length >= 3) {
        const llmWin = await pickStanzaWindowWithLlm({
          vocalRaw,
          phrasesDetail: pyWin.phrases_detail,
          totalClipDur: pyWin.total_dur || trimRelEnd,
          songTitle,
          spec,
          log,
        });
        if (llmWin && Number.isFinite(llmWin.dur) && llmWin.dur >= 14) {
          chosen = { ...pyWin, ...llmWin };
          llmSplitAfter = llmWin.splitAfter || [];
          stanzaReason = llmWin.reason || '';
          log(`[sing-engine] 🎼 LLM 乐段锁边(${spec.length}): [${llmWin.start_idx}..${llmWin.end_idx}] ${llmWin.start.toFixed(2)}s~${llmWin.end.toFixed(2)}s (${llmWin.dur.toFixed(1)}s, ${llmWin.phrases}/${llmWin.total_phrases}句)${stanzaReason ? ` | ${stanzaReason}` : ''}`);
        }
      }

      if (Number.isFinite(chosen.start) && Number.isFinite(chosen.dur) && chosen.dur >= 14) {
        const vTrim = path.join(workDir, 'vocals-locked.wav');
        const iTrim = path.join(workDir, 'other-locked.wav');
        await ff(['-ss', String(chosen.start.toFixed(3)), '-i', vocalRaw, '-t', String(chosen.dur.toFixed(3)), '-c:a', 'pcm_s16le', vTrim], 90000);
        if (fs.existsSync(instRaw)) {
          await ff(['-ss', String(chosen.start.toFixed(3)), '-i', instRaw, '-t', String(chosen.dur.toFixed(3)), '-c:a', 'pcm_s16le', iTrim], 90000);
          instRaw = iTrim;
        }
        vocalRaw = vTrim;
        trimRelStart = chosen.start;
        trimRelEnd = chosen.end;
        if (!stanzaReason) {
          log(`[sing-engine] ✂️ 纯净人声精准锁段(${spec.length}): ${chosen.start.toFixed(2)}s ~ ${chosen.end.toFixed(2)}s (${chosen.dur.toFixed(1)}s, ${chosen.phrases}/${chosen.total_phrases}句, HNR=${chosen.avg_hnr}dB)`);
        }
        // 为超单条 57s 的长曲计算精确的乐段/乐句静音缝切分点（供 QQ 聊天无缝分条发送，实时通话照常连续整段播）
        splitPointsSec = computeStanzaSplitPoints({
          phrasesDetail: pyWin.phrases_detail || [],
          startIdx: chosen.start_idx ?? 0,
          endIdx: chosen.end_idx ?? ((pyWin.phrases_detail?.length || 1) - 1),
          trimStart: chosen.start,
          totalDur: chosen.dur,
          llmSplitAfter,
        });
        if (splitPointsSec.length) {
          log(`[sing-engine] 📎 长曲乐段无痕切分点: [${splitPointsSec.map((x) => `${x.toFixed(1)}s`).join(', ')}] (共 ${splitPointsSec.length + 1} 段)`);
        }
      }
    } catch (e) {
      log(`[sing-engine] 精准锁段跳过(${e.message})，沿用粗切窗`);
    }
  }

  // 2. Praat F0 基频测算 + 贴合本人 268Hz 说话声线的智能定调（女声原调 0 / 流行男声 +3~+6 伴奏同步 rubberband 移调 / 低沉男声 +12 伴奏 0）
  let pitchChange = 0;
  let bgmPitchChange = 0;
  let f0Info = { median_hz: 0, suggested_pitch_shift: 0, bgm_pitch_shift: 0 };
  if (pitchOverride !== null && pitchOverride !== undefined && Number.isFinite(Number(pitchOverride))) {
    pitchChange = Number(pitchOverride);
    bgmPitchChange = (safeMode !== 'acappella' && Math.abs(pitchChange) > 0 && Math.abs(pitchChange) < 12) ? pitchChange : 0;
  } else {
    try {
      const { stdout } = await execAsync(CONFIG.humanizerPy, [
        CONFIG.humanizerScript, '--stage', 'measure_f0', '--vocal', vocalRaw, '--mode', safeMode,
      ], { timeout: 90000 });
      f0Info = JSON.parse(stdout.trim().split('\n').at(-1) || '{}');
      pitchChange = Number(f0Info.suggested_pitch_shift) || 0;
      bgmPitchChange = Number(f0Info.bgm_pitch_shift) || 0;
    } catch {}
  }
  log(`[sing-engine] 原唱基频中位数=${f0Info.median_hz || '?'}Hz (p90=${f0Info.p90_hz || '?'}Hz) -> vocal_shift=${pitchChange >= 0 ? '+' : ''}${pitchChange}, bgm_shift=${bgmPitchChange >= 0 ? '+' : ''}${bgmPitchChange}`);

  // 2.5 若流行男声启用了非八度女声升调（+3~+6 半音），用 studio 级 rubberband 同步移调伴奏（原速零变味、和声 100% 锁死！）
  if (bgmPitchChange !== 0 && safeMode !== 'acappella' && fs.existsSync(instRaw)) {
    const ratio = Math.pow(2, bgmPitchChange / 12).toFixed(6);
    const instShifted = path.join(workDir, 'other-shifted.wav');
    await ff([
      '-i', instRaw,
      '-af', `rubberband=pitch=${ratio}:formant=preserved:pitchq=quality:transients=crisp:detector=compound:channels=together`,
      '-c:a', 'pcm_s16le',
      instShifted,
    ], 180000);
    instRaw = instShifted;
    log(`[sing-engine] 🎹 伴奏同步移调 ${bgmPitchChange > 0 ? '+' : ''}${bgmPitchChange} 半音 (rubberband 保持原速零变味)`);
  }

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
  ], { timeout: 180000 });

  // 4. RVC 换声（protect=0.45 保咬字清晰、index_rate=0.28 去金属嗡声）+ 可选同声纹口白（默认关闭，不唱废话直接开唱！）
  const lines = useFraming
    ? {
        intro: hasExplicitIntro ? String(introText).trim() : (framing === true ? pickFramingLines({ mode: safeMode, songTitle, isOriginal }).intro : ''),
        outro: hasExplicitOutro ? String(outroText).trim() : (framing === true ? pickFramingLines({ mode: safeMode, songTitle, isOriginal }).outro : ''),
      }
    : { intro: '', outro: '' };
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
      }, 'RVC-v2', 260);
      const url = Array.isArray(out) ? out.at(-1) : out;
      const dst = path.join(workDir, 'vocal-her.wav');
      await downloadFile(url, dst);
      return dst;
    })(),
    lines.intro ? synthesizeTtsClip(lines.intro, introWav) : Promise.resolve(''),
    lines.outro ? synthesizeTtsClip(lines.outro, outroWav) : Promise.resolve(''),
  ]);

  // 5. 若显式带口白且为单条浅唱模式，压在 58.8s 内；半首/全曲则保留完整长度并按乐段切分
  const [songDur, introDur, outroDur] = await Promise.all([
    probeDuration(rvcOut),
    gotIntro ? probeDuration(gotIntro) : Promise.resolve(0),
    gotOutro ? probeDuration(gotOutro) : Promise.resolve(0),
  ]);
  let useIntro = gotIntro;
  let useOutro = gotOutro;
  if (spec.length === 'snippet' && songDur + introDur + outroDur > 58.8) {
    useOutro = '';
    if (songDur + introDur > 58.8) useIntro = '';
  }

  // 6. Post-RVC: 智能防叠加换气 + 手机近麦/房间外放/KTV 声学 + 封装 -> 24kHz 单声道 WAV
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

  await execAsync(CONFIG.humanizerPy, postArgs, { timeout: 180000 });
  const finalDur = await probeDuration(outFile);
  // 若有开场白或前导 0.10s 垫片，把切分点平移对齐到最终成品 WAV 时间轴
  const introShift = useIntro ? (introDur + (safeMode === 'acappella' ? 0.48 : 0.36)) : 0.10;
  const finalSplitPoints = splitPointsSec.map((t) => Number((t + introShift).toFixed(3)));
  const segments = finalDur > 57.5
    ? await sliceWavBySplitPoints(outFile, finalSplitPoints.length ? finalSplitPoints : [Math.min(finalDur - 10, 52)])
    : [outFile];

  log(`[sing-engine] 完成 ${path.basename(outFile)} | mode=${safeMode} len=${spec.length} vShift=${pitchChange} bShift=${bgmPitchChange} dur=${finalDur.toFixed(1)}s segs=${segments.length}`);
  return {
    file: outFile,
    segments,
    splitPointsSec: finalSplitPoints,
    mode: safeMode,
    length: spec.length,
    level,
    pitchChange,
    bgmPitchChange,
    medianHz: f0Info.median_hz || 0,
    durationSec: Number(finalDur.toFixed(1)),
    songStartSec: Number((clipOriginSec + trimRelStart).toFixed(2)),
    songEndSec: Number((clipOriginSec + trimRelEnd).toFixed(2)),
    stanzaReason,
  };
}

// ── 曲库 LRU 秒唱缓存（上限 60 首，按 mode + length 分档隔离，v5 纯唱无固定废话口白） ─
function normalizeLengthKey(length = 'half') {
  const s = String(length || 'half').toLowerCase().trim();
  if (s === 'snippet' || s === 'short' || s === '浅唱') return 'snippet';
  if (s === 'full' || s === 'complete' || s === '整首' || s === '完整') return 'full';
  return 'half';
}

function songCacheId(song, mode = 'bedroom_bgm', length = 'half') {
  const norm = String(song || '').toLowerCase().replace(/[\s《》【】"'.,!?，。！？\-—_]/g, '');
  if (!norm) return '';
  const safeMode = ['acappella', 'bedroom_bgm', 'ktv'].includes(mode) ? mode : 'bedroom_bgm';
  const safeLen = normalizeLengthKey(length);
  const hash = crypto.createHash('sha1').update(`${norm}|${safeMode}|${safeLen}|v5`).digest('hex').slice(0, 12);
  return `${safeMode}-${safeLen}-v5-${hash}`;
}

export function findCachedSong({ song = '', mode = 'bedroom_bgm', length = 'half' } = {}) {
  const cid = songCacheId(song, mode, length);
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
      bvid: meta.bvid || '',
      mode: meta.mode || mode,
      length: meta.length || normalizeLengthKey(length),
      durationSec: Number(meta.durationSec) || 0,
      pitchChange: Number(meta.pitchChange) || 0,
      bgmPitchChange: Number(meta.bgmPitchChange) || 0,
      songStartSec: Number(meta.songStartSec) || 0,
      songEndSec: Number(meta.songEndSec) || 0,
      totalDurSec: Number(meta.totalDurSec) || 0,
      hasMoreAfter: Boolean(meta.hasMoreAfter),
      splitPointsSec: Array.isArray(meta.splitPointsSec) ? meta.splitPointsSec : [],
      stanzaReason: meta.stanzaReason || '',
      cached: true,
    };
  } catch {
    return null;
  }
}

function saveSongToCache({
  song,
  artist = '',
  bvid = '',
  mode = 'bedroom_bgm',
  length = 'half',
  wavFile,
  durationSec = 0,
  pitchChange = 0,
  bgmPitchChange = 0,
  songStartSec = 0,
  songEndSec = 0,
  totalDurSec = 0,
  hasMoreAfter = false,
  splitPointsSec = [],
  stanzaReason = '',
}) {
  const cid = songCacheId(song, mode, length);
  if (!cid || !wavFile || !fs.existsSync(wavFile)) return;
  try {
    fs.mkdirSync(CONFIG.songCacheDir, { recursive: true });
    const dstWav = path.join(CONFIG.songCacheDir, `${cid}.wav`);
    const dstMeta = path.join(CONFIG.songCacheDir, `${cid}.json`);
    fs.copyFileSync(wavFile, dstWav);
    fs.writeFileSync(dstMeta, JSON.stringify({
      version: 5,
      song,
      artist,
      bvid,
      mode,
      length: normalizeLengthKey(length),
      durationSec,
      pitchChange,
      bgmPitchChange,
      songStartSec,
      songEndSec,
      totalDurSec,
      hasMoreAfter,
      splitPointsSec,
      stanzaReason,
      framing: false,
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

// ── 公开入口 1：点歌翻唱已有歌曲（支持歌名检索 / 曲库秒唱缓存 / 半首·整首·浅唱·续唱 / 外部链接 / 本地音频） ─
export async function coverSong({
  song = '',
  artist = '',
  bvid = '',
  file = '',
  url = '',
  mode = 'bedroom_bgm',
  length = 'half',
  continueFromSec = null,
  level = 'natural',
  start = null,
  seconds = null,
  framing = false,
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
  const isContinue = String(length || '').toLowerCase() === 'continue' || (continueFromSec !== null && continueFromSec !== undefined && Number(continueFromSec) > 1);
  const spec = resolveLengthSpec(isContinue ? 'continue' : length, seconds);
  const wantsFraming = Boolean(framing === true || (intro && String(intro).trim()) || (outro && String(outro).trim()));
  const canShareKey = Boolean(useCache && resolvedTitle && !file && !url && !bvid && !isContinue && start === null && !wantsFraming);
  const inflightKey = canShareKey ? songCacheId(resolvedTitle, safeMode, spec.length) : '';

  // 0. 命中曲库秒唱缓存（仅按歌名翻唱且未指定自定义起止/口白/续唱时直接 0 秒返回！）
  if (canShareKey) {
    const hit = findCachedSong({ song: resolvedTitle, mode: safeMode, length: spec.length });
    if (hit) {
      const outFile = path.join(outDir, `cover-cached-${Date.now()}.wav`);
      fs.copyFileSync(hit.file, outFile);
      const segments = hit.durationSec > 57.5 && hit.splitPointsSec?.length
        ? await sliceWavBySplitPoints(outFile, hit.splitPointsSec)
        : [outFile];
      log(`[sing-engine] ⚡ 命中曲库秒唱缓存(v5): 《${resolvedTitle}》(${safeMode}/${spec.length}, ${hit.durationSec}s, ${segments.length}段)`);
      return {
        file: outFile,
        segments,
        splitPointsSec: hit.splitPointsSec || [],
        mode: safeMode,
        length: spec.length,
        level,
        pitchChange: hit.pitchChange,
        bgmPitchChange: hit.bgmPitchChange || 0,
        durationSec: hit.durationSec,
        songStartSec: hit.songStartSec || 0,
        songEndSec: hit.songEndSec || 0,
        totalDurSec: hit.totalDurSec || 0,
        hasMoreAfter: Boolean(hit.hasMoreAfter),
        bvid: hit.bvid || '',
        stanzaReason: hit.stanzaReason || '',
        song: resolvedTitle,
        artist: artist || hit.artist,
        cached: true,
      };
    }
    // 0.5 并发去重：若完全相同的 (歌名, 模式, 档位) 正在渲染中，直接复用同一份 Promise 零重复开销！
    if (inflightKey && INFLIGHT_COVERS.has(inflightKey)) {
      log(`[sing-engine] 🔁 复用进行中的同曲渲染任务: 《${resolvedTitle}》(${safeMode}/${spec.length})`);
      const shared = await INFLIGHT_COVERS.get(inflightKey);
      const dupOut = path.join(outDir, `cover-shared-${Date.now()}.wav`);
      if (shared?.file && fs.existsSync(shared.file)) {
        fs.copyFileSync(shared.file, dupOut);
        const dupSegs = shared.durationSec > 57.5 && shared.splitPointsSec?.length
          ? await sliceWavBySplitPoints(dupOut, shared.splitPointsSec)
          : [dupOut];
        return { ...shared, file: dupOut, segments: dupSegs };
      }
      const hitAfter = findCachedSong({ song: resolvedTitle, mode: safeMode, length: spec.length });
      if (hitAfter) {
        fs.copyFileSync(hitAfter.file, dupOut);
        const dupSegs = hitAfter.durationSec > 57.5 && hitAfter.splitPointsSec?.length
          ? await sliceWavBySplitPoints(dupOut, hitAfter.splitPointsSec)
          : [dupOut];
        return { ...shared, file: dupOut, segments: dupSegs };
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

      // 阶段 A：按档位宽裕粗切（浅唱 78s / 半首 138s / 整首 260s / 续唱 155s），待 Demucs 分出纯净人声轨后再按完整乐段锁边裁剪
      const win = await locateSongWindow(sourcePath, {
        start,
        continueFromSec: isContinue ? Number(continueFromSec) : null,
        length: spec.length,
        seconds,
        coarse: true,
        log,
      });
      const clipWav = path.join(workDir, 'clip.wav');
      await ff([
        '-ss', String(win.start.toFixed(2)),
        '-i', sourcePath,
        '-t', String(win.duration.toFixed(2)),
        '-ar', '44100', '-ac', '2',
        clipWav,
      ], 120000);

      const outFile = path.join(outDir, `cover-${Date.now()}.wav`);
      const res = await runHumanizedVocalPipeline({
        clipWav,
        workDir,
        outFile,
        mode: safeMode,
        level,
        songTitle: resolvedTitle,
        isOriginal: false,
        framing: wantsFraming,
        exactPhraseTrim: Boolean(win.exactTrim),
        lengthSpec: win.spec || spec,
        clipOriginSec: win.start,
        targetSongSec: (win.spec || spec).targetDur,
        introText: intro,
        outroText: outro,
        pitchOverride: pitchChange,
        log,
      });
      const totalDurSec = Number((win.totalDur || 0).toFixed(1));
      const hasMoreAfter = totalDurSec > 0 && (totalDurSec - res.songEndSec) >= 16;
      const resolvedBvid = matchedInfo?.bvid || bvid || '';
      if (resolvedTitle && useCache && !isContinue && !wantsFraming) {
        saveSongToCache({
          song: resolvedTitle,
          artist,
          bvid: resolvedBvid,
          mode: safeMode,
          length: spec.length,
          wavFile: outFile,
          durationSec: res.durationSec,
          pitchChange: res.pitchChange,
          bgmPitchChange: res.bgmPitchChange,
          songStartSec: res.songStartSec,
          songEndSec: res.songEndSec,
          totalDurSec,
          hasMoreAfter,
          splitPointsSec: res.splitPointsSec,
          stanzaReason: res.stanzaReason,
        });
      }
      return {
        ...res,
        song: resolvedTitle,
        artist,
        bvid: resolvedBvid,
        totalDurSec,
        hasMoreAfter,
        matched: matchedInfo,
        cached: false,
      };
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
  duration = 46,
  mode = 'bedroom_bgm',
  level = 'natural',
  framing = false,
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
    // 无固定口白时可放宽至 54s，单条 QQ 语音完美装下
    const genDur = Math.min(54, Math.max(22, Number(duration) || 46));
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
        length: flags.length || 'half',
        continueFromSec: flags['continue-from'] !== undefined ? Number(flags['continue-from']) : null,
        level: flags.level || 'natural',
        start: flags.start !== undefined ? Number(flags.start) : null,
        seconds: flags.seconds !== undefined ? Number(flags.seconds) : null,
        pitchChange: flags.pitch !== undefined ? Number(flags.pitch) : null,
        framing: flags.framing === 'true',
        useCache: flags.noCache !== 'true',
        outDir: flags.outDir || os.tmpdir(),
      });
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'original') {
      const out = await makeOriginalSong({
        lyrics: flags.lyrics || '[verse]\n晚风轻轻吹过窗台\n星星落进奶茶杯里\n[chorus]\n今天也要开开心心\n明天继续一起发呆',
        tags: flags.tags,
        duration: flags.duration ? Number(flags.duration) : 46,
        mode: flags.mode || 'bedroom_bgm',
        level: flags.level || 'natural',
        framing: flags.framing === 'true',
        outDir: flags.outDir || os.tmpdir(),
      });
      console.log(JSON.stringify(out, null, 2));
    } else {
      console.error('用法: node humanized-sing-engine.mjs cover --song 红色高跟鞋 --artist 蔡健雅 [--mode acappella|bedroom_bgm|ktv] [--length snippet|half|full|continue] | original --lyrics "..."');
      process.exit(2);
    }
  } catch (e) {
    console.error('[sing-engine] ERROR:', e.message);
    process.exit(1);
  }
}
