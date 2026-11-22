/**
 * disk-hygiene.mjs — 零常驻内存的磁盘垃圾自动代谢模块（引用计数 GC，平台解耦）
 *
 * 解决长期使用实时看屏与语音后容易被忽视的隐形磁盘膨胀：
 *   1. 清理过期的临时通话/看屏/自测 DSH 会话（仅作用于 --root-- 与 --tmp-* 临时命名空间，绝不碰 QQ 日常长会话！）
 *   2. 对 DSH 底层附件库（~/.dsh/attachments/v1/objects/）做严格的「标记-清除」引用计数 GC：
 *      扫描所有现存会话引用的 sha256 哈希，仅删除 0 引用且超过宽限期的无主看屏截图，绝不误删聊天重要图片
 *   3. 清理超过 7 天的临时 TTS 语音条缓存（仅限 audio/tts/，绝不碰 call-fillers/memes/images），并保留最新 20 条
 *   4. 清理 /tmp 中超过 1 小时的残留临时截屏/测试文件
 *
 * 用法：
 *   node disk-hygiene.mjs [--dry-run] [--ephemeral-hours=12] [--attach-grace-hours=2] [--tts-days=7]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = process.env.QQ_BRIDGE_ROOT || '/opt/qq-bridge';
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const SESSIONS_ROOT = path.join(DSH_HOME, 'sessions');
const PROJCACHE_DIR = path.join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
const ATTACH_OBJECTS_DIR = path.join(DSH_HOME, 'attachments', 'v1', 'objects');
const TTS_DIR = path.join(ROOT, 'audio', 'tts');
const STATE_PATH = path.join(ROOT, 'state', 'state.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function argNum(prefix, fallback) {
  const hit = args.find((a) => a.startsWith(prefix));
  if (!hit) return fallback;
  const n = Number(hit.slice(prefix.length));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const EPHEMERAL_MAX_AGE_MS = argNum('--ephemeral-hours=', 12) * 3600 * 1000;
const ATTACH_GRACE_MS = argNum('--attach-grace-hours=', 2) * 3600 * 1000;
const TTS_MAX_AGE_MS = argNum('--tts-days=', 7) * 24 * 3600 * 1000;
const TTS_KEEP_RECENT = 20;

const log = (...a) => console.log(new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 19), '[disk-hygiene]', ...a);

function fmtMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function dirSize(dirPath) {
  let total = 0;
  try {
    for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, ent.name);
      if (ent.isDirectory()) total += dirSize(full);
      else if (ent.isFile()) total += fs.statSync(full).size;
    }
  } catch {}
  return total;
}

function loadProtectedSessionIds() {
  const set = new Set();
  try {
    const st = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (st?.sessions && typeof st.sessions === 'object') {
      for (const sid of Object.values(st.sessions)) {
        if (typeof sid === 'string' && sid) set.add(sid);
      }
    }
  } catch {}
  return set;
}

async function isCallCurrentlyActive() {
  try {
    const res = await fetch('http://127.0.0.1:3300/health', { signal: AbortSignal.timeout(2000) });
    const j = await res.json().catch(() => null);
    return j?.state === 'in_call';
  } catch {
    return false;
  }
}

/**
 * 1. 清理过期临时会话目录（仅限 --root-- 与 --tmp-* 命名空间，绝不碰日常聊天会话目录）
 */
function pruneEphemeralSessions(protectedIds, callActive) {
  const result = { removedSessions: 0, freedBytes: 0, prunedIds: new Set() };
  if (!fs.existsSync(SESSIONS_ROOT)) return result;

  const now = Date.now();
  // 通话进行中时放宽保护期至少 4 小时，避免碰触刚轮换或进行中的临时会话
  const effectiveAgeMs = callActive ? Math.max(EPHEMERAL_MAX_AGE_MS, 4 * 3600 * 1000) : EPHEMERAL_MAX_AGE_MS;

  for (const ns of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!ns.isDirectory()) continue;
    const isEphemeralNs = ns.name === '--root--' || ns.name.startsWith('--tmp-');
    if (!isEphemeralNs) continue;

    const nsPath = path.join(SESSIONS_ROOT, ns.name);
    for (const ent of fs.readdirSync(nsPath, { withFileTypes: true })) {
      if (!ent.isDirectory() || !ent.name.startsWith('session-')) continue;
      const sid = ent.name;
      if (protectedIds.has(sid)) continue;

      const sPath = path.join(nsPath, sid);
      // 取目录内最新文件时间判断是否过期
      let latestMtime = 0;
      try {
        latestMtime = fs.statSync(sPath).mtimeMs;
        for (const f of fs.readdirSync(sPath)) {
          const mt = fs.statSync(path.join(sPath, f)).mtimeMs;
          if (mt > latestMtime) latestMtime = mt;
        }
      } catch {
        continue;
      }
      if (now - latestMtime < effectiveAgeMs) continue;

      const bytes = dirSize(sPath);
      const cacheFile = path.join(PROJCACHE_DIR, `${sid}.json`);
      const cacheBytes = fs.existsSync(cacheFile) ? (fs.statSync(cacheFile).size || 0) : 0;

      if (!DRY_RUN) {
        fs.rmSync(sPath, { recursive: true, force: true });
        if (fs.existsSync(cacheFile)) fs.rmSync(cacheFile, { force: true });
      }
      result.removedSessions += 1;
      result.freedBytes += bytes + cacheBytes;
      result.prunedIds.add(sid);
    }
  }
  return result;
}

/**
 * 2. 引用计数标记-清除：扫描所有剩余 DSH 会话，仅回收 0 引用且超过宽限期的孤儿附件
 */
function gcUnreferencedAttachments(prunedIds = new Set()) {
  const result = { scannedSessions: 0, liveHashes: 0, removedObjects: 0, freedBytes: 0, skipped: false };
  if (!fs.existsSync(ATTACH_OBJECTS_DIR) || !fs.existsSync(SESSIONS_ROOT)) return result;

  const liveHashes = new Set();
  const HASH_RE = /sha256:([0-9a-f]{64})/gi;

  // Fail-closed：任何现存会话解压失败时中止回收，绝不误删任何仍在使用的聊天图片！
  try {
    for (const ns of fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
      if (!ns.isDirectory()) continue;
      const nsPath = path.join(SESSIONS_ROOT, ns.name);
      for (const sDir of fs.readdirSync(nsPath, { withFileTypes: true })) {
        if (!sDir.isDirectory() || !sDir.name.startsWith('session-')) continue;
        if (prunedIds.has(sDir.name)) continue;
        const fullDir = path.join(nsPath, sDir.name);
        for (const f of fs.readdirSync(fullDir)) {
          const fp = path.join(fullDir, f);
          let text = '';
          if (f.endsWith('.zstd')) {
            text = execFileSync('zstdcat', [fp], { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
          } else if (f.endsWith('.jsonl') || f.endsWith('.json')) {
            text = fs.readFileSync(fp, 'utf8');
          } else {
            continue;
          }
          result.scannedSessions += 1;
          let m;
          while ((m = HASH_RE.exec(text)) !== null) {
            liveHashes.add(m[1].toLowerCase());
          }
        }
      }
    }
  } catch (err) {
    log(`⚠️ 扫描现存会话引用失败，为保护聊天图片已跳过附件回收：${err?.message ?? err}`);
    result.skipped = true;
    return result;
  }

  result.liveHashes = liveHashes.size;
  const now = Date.now();

  for (const sub of fs.readdirSync(ATTACH_OBJECTS_DIR, { withFileTypes: true })) {
    if (!sub.isDirectory()) continue;
    const subPath = path.join(ATTACH_OBJECTS_DIR, sub.name);
    let remaining = 0;
    for (const f of fs.readdirSync(subPath, { withFileTypes: true })) {
      if (!f.isFile()) { remaining += 1; continue; }
      const hash = f.name.toLowerCase();
      const fp = path.join(subPath, f.name);
      const st = fs.statSync(fp);
      const isReferenced = liveHashes.has(hash);
      const inGrace = now - st.mtimeMs < ATTACH_GRACE_MS;
      if (isReferenced || inGrace) {
        remaining += 1;
        continue;
      }
      if (!DRY_RUN) {
        fs.rmSync(fp, { force: true });
      }
      result.removedObjects += 1;
      result.freedBytes += st.size;
    }
    if (!DRY_RUN && remaining === 0) {
      try { fs.rmdirSync(subPath); } catch {}
    }
  }
  return result;
}

/**
 * 3. 清理 audio/tts/ 中超过 7 天的临时语音缓存（保留最新 20 条，绝不碰 memes/images/call-fillers）
 */
function pruneOldTtsCache() {
  const result = { removedFiles: 0, freedBytes: 0 };
  const AUDIO_EXT_RE = /\.(?:wav|silk|amr|mp3|ogg|pcm)$/i;
  const targets = [TTS_DIR, path.join(TTS_DIR, 'inbound')];
  const now = Date.now();

  for (const dir of targets) {
    if (!fs.existsSync(dir)) continue;
    const files = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !AUDIO_EXT_RE.test(ent.name)) continue;
      const fp = path.join(dir, ent.name);
      try {
        const st = fs.statSync(fp);
        files.push({ fp, mtimeMs: st.mtimeMs, size: st.size });
      } catch {}
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const candidates = files.slice(TTS_KEEP_RECENT);
    for (const item of candidates) {
      if (now - item.mtimeMs < TTS_MAX_AGE_MS) continue;
      if (!DRY_RUN) {
        try { fs.rmSync(item.fp, { force: true }); } catch {}
      }
      result.removedFiles += 1;
      result.freedBytes += item.size;
    }
  }
  return result;
}

/**
 * 4. 清理 /tmp 中超过 1 小时的残留临时截图/测试文件
 */
function pruneTmpArtifacts() {
  const result = { removedFiles: 0, freedBytes: 0 };
  const TMP_RE = /^(?:share_verify|call_verify|qq_screen_|e2e_ch2_).*\.(?:png|jpg|jpeg|pcm|wav)$/i;
  const now = Date.now();
  try {
    for (const ent of fs.readdirSync('/tmp', { withFileTypes: true })) {
      if (!ent.isFile() || !TMP_RE.test(ent.name)) continue;
      const fp = path.join('/tmp', ent.name);
      const st = fs.statSync(fp);
      if (now - st.mtimeMs < 3600 * 1000) continue;
      if (!DRY_RUN) {
        try { fs.rmSync(fp, { force: true }); } catch {}
      }
      result.removedFiles += 1;
      result.freedBytes += st.size;
    }
  } catch {}
  return result;
}

/**
 * 5. 清理唱歌引擎异常中断后可能残留的临时目录（/opt/qq-cover/work/{cover-,orig-,song-}*，超过 6 小时）
 */
function pruneStaleSingWork() {
  const result = { removedDirs: 0, freedBytes: 0 };
  const workRoot = process.env.SING_WORK_ROOT || '/opt/qq-cover/work';
  if (!fs.existsSync(workRoot)) return result;
  const now = Date.now();
  try {
    for (const ent of fs.readdirSync(workRoot, { withFileTypes: true })) {
      if (!ent.isDirectory() || !/^(?:cover|orig|song)-/.test(ent.name)) continue;
      const full = path.join(workRoot, ent.name);
      const st = fs.statSync(full);
      if (now - st.mtimeMs < 6 * 3600 * 1000) continue;
      const bytes = dirSize(full);
      if (!DRY_RUN) {
        try { fs.rmSync(full, { recursive: true, force: true }); } catch {}
      }
      result.removedDirs += 1;
      result.freedBytes += bytes;
    }
  } catch {}
  return result;
}

async function main() {
  const protectedIds = loadProtectedSessionIds();
  const callActive = await isCallCurrentlyActive();

  const rSess = pruneEphemeralSessions(protectedIds, callActive);
  const rAtt = gcUnreferencedAttachments(rSess.prunedIds);
  const rTts = pruneOldTtsCache();
  const rTmp = pruneTmpArtifacts();
  const rSing = pruneStaleSingWork();

  const totalFreed = rSess.freedBytes + rAtt.freedBytes + rTts.freedBytes + rTmp.freedBytes + rSing.freedBytes;
  const tag = DRY_RUN ? 'DRY-RUN 预演' : '清理完成';
  log(
    `${tag} | 临时会话=${rSess.removedSessions}个(${fmtMb(rSess.freedBytes)})` +
    ` | 无主附件=${rAtt.removedObjects}个(${fmtMb(rAtt.freedBytes)}, 保护现存引用=${rAtt.liveHashes})` +
    ` | 旧TTS缓存=${rTts.removedFiles}个(${fmtMb(rTts.freedBytes)})` +
    ` | 唱歌残留=${rSing.removedDirs}个(${fmtMb(rSing.freedBytes)})` +
    ` | /tmp残留=${rTmp.removedFiles}个` +
    ` | 合计释放 ${fmtMb(totalFreed)}`
  );
}

main().catch((err) => {
  console.error('[disk-hygiene] fatal:', err);
  process.exit(1);
});
