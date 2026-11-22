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
  songCacheMax: Number(process.env.SING_CACHE_MAX || 15),
  humanizerPy: process.env.HUMANIZER_PY || '/opt/qq-cover/venv/bin/python',
  humanizerScript: process.env.HUMANIZER_SCRIPT || '/opt/qq-cover/vocal-humanizer.py',
  ttsBaseUrl: (process.env.TTS_BASE_URL || 'http://127.0.0.1:3210').replace(/\/+$/, ''),
  ffmpegBin: process.env.FFMPEG_BIN || 'ffmpeg',
  ffprobeBin: process.env.FFPROBE_BIN || 'ffprobe',
};

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

async function downloadFile(url, dest, headers = {}, tries = 5) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(180000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) throw new Error('下载内容为空');
      fs.writeFileSync(dest, buf);
      return dest;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
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

    // 1. 先查缓存文件，距离过期 >30 分钟且 HEAD 200 直接复用
    try {
      const cached = JSON.parse(fs.readFileSync(CONFIG.rvcModelJson, 'utf8'));
      const url = String(cached?.url || '').trim();
      const expMs = cached?.expires_at ? Date.parse(cached.expires_at) : 0;
      const notExpired = !expMs || expMs - Date.now() > 30 * 60 * 1000;
      if (url && notExpired) {
        const head = await fetch(url, { method: 'HEAD', headers: H, signal: AbortSignal.timeout(12000) }).catch(() => null);
        if (head && head.ok) return url;
      }
    } catch {}

    // 2. 过期或失效：用 curl 稳定上传 51MB slim.zip（避免小带宽下 Node fetch 超时）
    if (!fs.existsSync(CONFIG.rvcSlimZip)) {
      throw new Error(`找不到 RVC 声模包: ${CONFIG.rvcSlimZip}`);
    }
    log(`[sing-engine] RVC 声模链接已过期，正在通过 curl 重新上传 ${path.basename(CONFIG.rvcSlimZip)}…`);
    const { stdout } = await execAsync('curl', [
      '-sS', '--max-time', '420',
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

async function uploadToReplicate(filePath, mime = 'audio/wav') {
  const tok = getReplicateToken();
  const fd = new FormData();
  fd.append('content', new Blob([fs.readFileSync(filePath)], { type: mime }), path.basename(filePath));
  const r = await jfetch('https://api.replicate.com/v1/files', {
    method: 'POST',
    headers: { authorization: `Bearer ${tok}` },
    body: fd,
    timeoutMs: 180000,
  });
  if (!r.ok || !r.body?.urls?.get) throw new Error(`Replicate 上传失败 HTTP ${r.status}`);
  return r.body.urls.get;
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

export async function searchAndDownloadBilibiliSong({ song, artist = '', destPath, log = console.error }) {
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

  // 2. 检索原唱（优先官方 MV / 无损）
  const queries = cleanArtist
    ? [`${cleanArtist} ${cleanSong} 官方MV 无损`, `${cleanArtist} ${cleanSong} 原唱`]
    : [`${cleanSong} 官方MV 原唱 无损`, `${cleanSong} 原唱`];

  const badRe = /翻唱|cover|男声版|女声版|伴奏|纯音乐|练唱|教程|吉他谱|翻弹|串烧|合集|歌单|reaction|解析|教学|ai翻唱|dj版|变速|升调|降调|0\.8x|1\.2x|群星|合唱版|钢琴版|唢呐|二胡|古筝版/i;
  const goodRe = /官方mv|官方版|原唱|hi-?res|无损|4k|唱片|太合|索尼|环球|华纳|杰威尔|滚石|滚石唱片|福茂|英皇|相信音乐/i;
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
      if (cleanArtist && (title.includes(cleanArtist) || author.includes(cleanArtist))) score += 8;
      if (goodRe.test(title) || goodRe.test(author)) score += 6;
      if (/官方mv|官方版/i.test(title)) score += 4;
      if (!userWantedBad && badRe.test(title)) score -= 25;
      if (/live|现场|演唱会/i.test(title) && !/live|现场/i.test(cleanSong)) score -= 5;

      candidates.push({ bvid, title, author, dur, play: Number(item.play) || 0, score });
    }
    if (candidates.some((c) => c.score >= 12)) break;
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

async function locateSongWindow(audioPath, { start = null, seconds = 45, log = console.error } = {}) {
  const totalDur = await probeDuration(audioPath);
  const targetSec = Math.min(48, Math.max(20, Number(seconds) || 45));
  if (start !== null && start !== undefined && Number.isFinite(Number(start)) && Number(start) >= 0) {
    const s = Number(start);
    const dur = totalDur > 0 ? Math.min(targetSec, Math.max(10, totalDur - s)) : targetSec;
    return { start: s, duration: dur, reason: 'explicit' };
  }
  if (totalDur > 0 && totalDur <= targetSec + 4) {
    return { start: 0, duration: totalDur, reason: 'short-source' };
  }

  const sentences = await transcribeTimestamps(audioPath, Math.min(110, Math.ceil(totalDur || 110)));
  if (sentences.length >= 2) {
    // 从第一句有效唱词前 0.9s 起刀，把结束点吸附到目标时长附近最干净的一句结尾后 +1.3s（绝不半句截断）
    const first = sentences.find((s) => s.end - s.begin >= 0.8 && s.text.length >= 3) || sentences[0];
    const winStart = Math.max(0, first.begin - 0.9);
    const idealEnd = winStart + targetSec;
    let bestEnd = idealEnd;
    let bestDiff = 999;
    for (const s of sentences) {
      if (s.end < winStart + 28 || s.end > winStart + 47.5) continue;
      const diff = Math.abs(s.end - (idealEnd - 1.2));
      if (diff < bestDiff) {
        bestDiff = diff;
        bestEnd = s.end + 1.25;
      }
    }
    const dur = Math.min(48.5, Math.max(25, bestEnd - winStart));
    log(`[sing-engine] Paraformer 歌词打点命中 ${sentences.length} 句 -> 截取 ${winStart.toFixed(1)}s ~ ${(winStart + dur).toFixed(1)}s (${dur.toFixed(1)}s)`);
    return { start: winStart, duration: dur, reason: 'paraformer' };
  }

  const fallbackStart = totalDur > 75 ? 16 : 0;
  const fallbackDur = totalDur > 0 ? Math.min(targetSec, Math.max(15, totalDur - fallbackStart)) : targetSec;
  log(`[sing-engine] 歌词打点未命中，回退截取 ${fallbackStart}s ~ ${(fallbackStart + fallbackDur).toFixed(1)}s`);
  return { start: fallbackStart, duration: fallbackDur, reason: 'fallback' };
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
  introText,
  outroText,
  pitchOverride = null,
  log = console.error,
}) {
  const safeMode = ['acappella', 'bedroom_bgm', 'ktv'].includes(mode) ? mode : 'bedroom_bgm';
  const levels = mapLevels(level);
  const seedBase = Math.floor(Date.now() % 100000);

  // 1. Demucs htdemucs_ft 零漏音分轨
  log(`[sing-engine] Demucs htdemucs_ft 分离人声与伴奏…`);
  const clipUrl = await uploadToReplicate(clipWav, 'audio/wav');
  const stems = await runReplicateModel('cjwbw/demucs', {
    audio: clipUrl,
    model_name: 'htdemucs_ft',
    stem: 'vocals',
    output_format: 'wav',
  }, 'Demucs(htdemucs_ft)');

  if (!stems?.vocals) throw new Error('Demucs 未产出人声轨');
  const vocalRaw = path.join(workDir, 'vocals.wav');
  const instRaw = path.join(workDir, 'other.wav');
  await Promise.all([
    downloadFile(stems.vocals, vocalRaw),
    stems.other ? downloadFile(stems.other, instRaw) : Promise.resolve(),
  ]);

  // 2. Praat F0 基频测算 + 自动八度对齐定调（女声 0 / 男声 +12，伴奏零失真！）
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
  log(`[sing-engine] 原唱基频中位数=${f0Info.median_hz || '?'}Hz -> pitch_change=${pitchChange}`);

  // 3. Pre-RVC: 对纯净原干声注入 Praat TD-PSOLA 活人微瑕（零 RVC 伪影，严格不脱拍）
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

  // 4. RVC 换声（自动检查/续期声模）+ 并行生成同声纹前后口白（0 额外延迟！）
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
        protect: 0.38,
        index_rate: 0.35,
        rms_mix_rate: 0.25,
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

// ── 曲库 LRU 秒唱缓存（上限 15 首 ≈ 38MB，QQ 聊天与实时通话共享！） ───────────
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
    const maxItems = Math.max(3, CONFIG.songCacheMax || 15);
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

// ── 公开入口 1：点歌翻唱已有歌曲（支持歌名检索 / 曲库秒唱缓存 / 外部链接 / 本地音频） ─
export async function coverSong({
  song = '',
  artist = '',
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

  // 0. 命中曲库秒唱缓存（仅按歌名翻唱且未指定自定义起止/口白时直接 0 秒返回！）
  if (useCache && resolvedTitle && !file && !url && start === null && !intro && !outro) {
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
  }

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
      matchedInfo = await searchAndDownloadBilibiliSong({ song: resolvedTitle, artist, destPath: sourcePath, log });
    } else {
      throw new Error('请提供歌名(song)、音频文件(file)或音频链接(url)');
    }

    // 定位最佳主歌+副歌窗口（默认 ~45s，加上口白正好 55~58s 单条语音）
    const win = await locateSongWindow(sourcePath, { start, seconds: Math.min(48, Number(seconds) || 45), log });
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
        file: flags.file || '',
        url: flags.url || '',
        mode: flags.mode || 'bedroom_bgm',
        level: flags.level || 'natural',
        start: flags.start !== undefined ? Number(flags.start) : null,
        seconds: flags.seconds !== undefined ? Number(flags.seconds) : 45,
        framing: flags.framing !== 'false',
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
