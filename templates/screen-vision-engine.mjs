/**
 * screen-vision-engine.mjs — 平台无关的「实时看屏」核心引擎（零外部依赖 ESM）
 *
 * 解耦设计：本模块完全不依赖 QQ / SnowLuma / 浏览器 / Discord / 游戏客户端。
 * 任何视频源 Endpoint 只需持续调用：
 *   screenEngine.pushFrame(jpegBuf, { source, changeScore, lumaGrid, width, height, label })
 *
 * 核心能力：
 *   1. 轻量帧差节流：画面静止时零推理消耗；支持前端传入 16x9 亮度网格或自动退回 JPEG 结构差分
 *   2. 纯内存 3 帧环形关键帧池：保留「此刻 / ~6s 前 / ~15s 前」用于动态对比，绝不落盘保护隐私
 *   3. 三模式实时切换：on_demand（随问随看）/ watch_along（主动陪看吐槽）/ off（暂停并清帧）
 *   4. 零重复发帧：同一静止画面若已送进对话历史，不重复耗费多模态 Token
 *   5. 独立问答与主动陪看回调：既可挂载进 RealtimeCallEngine 融合语音通话，也可完全脱离通话独立看屏聊天
 */

import crypto from 'node:crypto';

export const SCREEN_MODES = new Set(['on_demand', 'watch_along', 'off']);

const WATCH_ON_RE = /(?:(?:开启|打开|进入|切到|切换).{0,4}(?:陪看|看屏|主动吐槽))|(?:跟我一起看|陪我看(?:电影|视频|片|剧)?|看我打游戏|看我玩|主动吐槽|边看边聊)/;
const WATCH_QUIET_RE = /(?:安静看(?:片|电影|视频|剧)?|先别插嘴|先别说话|闭嘴看|我问你再说|关掉主动吐槽|关闭陪看|别主动说话)/;
const SCREEN_OFF_RE = /(?:别看屏幕了|关掉看屏|关闭看屏|停止看屏|别看我桌面|退出看屏)/;

const COMPARE_INTENT_RE = /(刚才|刚刚|刚才那|上一步|上一幕|刚过去|怎么死的|怎么输的|怎么回事|发生了什么|反转|变化|哪里变了)/;
const VISUAL_INTENT_RE = /(你看|看我|看看|屏幕|画面|桌面|电影|视频|台词|字幕|这人|这个人|角色|演员|主角|反派|这里|这个|这局|这把|这手|这张|牌|卡牌|血量|装备|打法|出什么|怎么打|啥意思|什么意思|谁演的|好不好看|帅不帅|笑死|你看这|帮我看|帮我瞅|瞄一眼)/;

function computeLumaDiff(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.abs(Number(a[i] || 0) - Number(b[i] || 0));
  }
  return Math.min(1, sum / (a.length * 255));
}

function computeJpegSignature(buf) {
  const len = buf.length;
  const bins = 48;
  const sig = new Uint8Array(bins);
  // 跳过 JPEG 头部前 512 字节，均匀采样主体压缩数据
  const start = Math.min(512, Math.floor(len * 0.1));
  const span = Math.max(1, len - start - 16);
  for (let i = 0; i < bins; i++) {
    const pos = start + Math.floor((span * i) / bins);
    sig[i] = buf[pos] || 0;
  }
  return { len, sig };
}

function computeJpegDelta(prev, cur) {
  if (!prev || !cur) return 1;
  const sizeRatio = Math.abs(cur.len - prev.len) / Math.max(1, prev.len);
  let byteDiff = 0;
  for (let i = 0; i < cur.sig.length; i++) {
    byteDiff += Math.abs(cur.sig[i] - prev.sig[i]);
  }
  const sigRatio = byteDiff / (cur.sig.length * 255);
  // 对 JPEG 来说，大小变化 >3% 通常意味着真实画面变化
  return Math.min(1, sizeRatio * 2.2 + sigRatio * 0.45);
}

/**
 * 解析语音/文字口令，判断用户是否要切换看屏模式
 */
export function detectScreenModeCommand(utterance) {
  const t = String(utterance || '').trim();
  if (!t || t.length < 3) return null;
  if (SCREEN_OFF_RE.test(t)) return { mode: 'off', label: '暂停看屏' };
  if (WATCH_QUIET_RE.test(t)) return { mode: 'on_demand', label: '随问随看（安静陪看）' };
  if (WATCH_ON_RE.test(t)) return { mode: 'watch_along', label: '主动陪看吐槽' };
  return null;
}

export class ScreenVisionEngine {
  constructor(opts = {}) {
    this.mode = SCREEN_MODES.has(opts.mode) ? opts.mode : 'on_demand';
    this.maxFrameAgeMs = Number(opts.maxFrameAgeMs ?? 45000);
    this.keyframeMinGapMs = Number(opts.keyframeMinGapMs ?? 4500);
    this.staticChangeThresh = Number(opts.staticChangeThresh ?? 0.035);
    this.watchChangeThresh = Number(opts.watchChangeThresh ?? 0.11);
    this.watchCooldownMs = Number(opts.watchCooldownMs ?? 24000);
    this.maxHistory = Number(opts.maxHistory ?? 3);
    this.log = opts.log || console.log;

    // 事件回调
    this.onModeChange = opts.onModeChange || (() => {});
    this.onFrameAccepted = opts.onFrameAccepted || (() => {});
    this.onWatchCandidate = opts.onWatchCandidate || null;
    this.onActivity = opts.onActivity || (() => {});

    // 纯内存环形关键帧池（严禁落盘！）
    this._latest = null; // { id, buf, ts, source, label, width, height, changeScore, lumaGrid, jpegSig }
    this._keyframes = []; // 最旧 → 最新，最多 maxHistory 帧
    this._frameSeq = 0;
    this._lastSentFrameId = 0;
    this._lastWatchEmitAt = 0;
    this._totalFramesIn = 0;
    this._totalKeyframes = 0;
    this._recentEvents = []; // [{ ts, kind, text }]
  }

  setMode(nextMode, reason = 'manual') {
    if (!SCREEN_MODES.has(nextMode)) return this.mode;
    const prev = this.mode;
    this.mode = nextMode;
    if (nextMode === 'off') {
      this.clear('mode_off');
    }
    if (prev !== nextMode) {
      this.log(`[screen-vision] 模式切换: ${prev} → ${nextMode} (${reason})`);
      this._recordEvent('mode', `看屏模式已切换为「${this.modeLabel()}」`);
      this.onModeChange(nextMode, reason);
    }
    return this.mode;
  }

  modeLabel(m = this.mode) {
    if (m === 'watch_along') return '主动陪看吐槽';
    if (m === 'off') return '已暂停';
    return '随问随看';
  }

  clear(reason = 'manual') {
    const had = Boolean(this._latest || this._keyframes.length);
    this._latest = null;
    this._keyframes = [];
    this._lastSentFrameId = 0;
    if (had) {
      this.log(`[screen-vision] 已清空内存帧缓存 (${reason})`);
      this._recordEvent('clear', '已停止共享并清空内存画面');
    }
  }

  _recordEvent(kind, text) {
    const ev = { ts: Date.now(), kind, text: String(text || '').slice(0, 240) };
    this._recentEvents.push(ev);
    if (this._recentEvents.length > 40) this._recentEvents = this._recentEvents.slice(-40);
    this.onActivity(ev);
    return ev;
  }

  recordAiComment(text, kind = 'reply') {
    return this._recordEvent(kind, text);
  }

  /**
   * 任意 Endpoint 推入一帧 JPEG（纯内存处理，绝不写磁盘）
   */
  pushFrame(jpegBuf, meta = {}) {
    if (this.mode === 'off') return { accepted: false, reason: 'mode_off' };
    if (!Buffer.isBuffer(jpegBuf) || jpegBuf.length < 800 || jpegBuf.length > 2 * 1024 * 1024) {
      return { accepted: false, reason: 'invalid_jpeg' };
    }
    const now = Number(meta.ts) || Date.now();
    const source = String(meta.source || 'unknown');

    // 优先级保护：若高清晰直连源（web/local）近 5 秒刚推过帧，自动让低清晰源（qq-screen）静默避让
    if (source === 'qq-screen' && this._latest && this._latest.source !== 'qq-screen' && now - this._latest.ts < 5000) {
      return { accepted: false, reason: 'higher_priority_source_active' };
    }

    this._totalFramesIn += 1;
    const lumaGrid = Array.isArray(meta.lumaGrid) ? meta.lumaGrid : null;
    const jpegSig = computeJpegSignature(jpegBuf);

    let changeScore = typeof meta.changeScore === 'number' && Number.isFinite(meta.changeScore)
      ? Math.max(0, Math.min(1, meta.changeScore))
      : null;
    if (changeScore === null) {
      if (lumaGrid && this._latest?.lumaGrid) {
        changeScore = computeLumaDiff(this._latest.lumaGrid, lumaGrid);
      } else if (this._latest?.jpegSig) {
        changeScore = computeJpegDelta(this._latest.jpegSig, jpegSig);
      } else {
        changeScore = 1;
      }
    }

    const isFirst = !this._latest || (now - this._latest.ts > this.maxFrameAgeMs);
    const significant = isFirst || changeScore >= this.staticChangeThresh;

    // 淘汰过期关键帧
    this._keyframes = this._keyframes.filter((f) => now - f.ts <= this.maxFrameAgeMs);

    if (!significant) {
      // 画面静止：仅刷新时间戳，不分配新帧 ID，避免重复多模态推理
      this._latest.ts = now;
      return { accepted: true, keyframe: false, changeScore };
    }

    const frame = {
      id: ++this._frameSeq,
      hash: crypto.createHash('md5').update(jpegBuf.subarray(0, Math.min(4096, jpegBuf.length))).digest('hex').slice(0, 8),
      buf: Buffer.from(jpegBuf),
      ts: now,
      source,
      label: String(meta.label || '').slice(0, 60),
      width: Number(meta.width || 0),
      height: Number(meta.height || 0),
      changeScore: Number(changeScore.toFixed(3)),
      lumaGrid,
      jpegSig
    };

    this._latest = frame;
    const lastKf = this._keyframes[this._keyframes.length - 1];
    if (!lastKf || now - lastKf.ts >= this.keyframeMinGapMs || changeScore >= this.watchChangeThresh) {
      this._keyframes.push(frame);
      if (this._keyframes.length > this.maxHistory) this._keyframes.shift();
      this._totalKeyframes += 1;
    }

    this.onFrameAccepted(frame);

    // 主动陪看吐槽候选触发（真正是否开口由宿主检查安静状态与冷却后决定）
    if (
      this.mode === 'watch_along' &&
      this.onWatchCandidate &&
      !isFirst &&
      changeScore >= this.watchChangeThresh &&
      now - this._lastWatchEmitAt >= this.watchCooldownMs
    ) {
      this._lastWatchEmitAt = now;
      const candidateFrames = this._keyframes.slice(-2);
      Promise.resolve(this.onWatchCandidate({
        frames: candidateFrames,
        changeScore,
        source: frame.source,
        label: frame.label
      })).catch(() => {});
    }

    return { accepted: true, keyframe: true, id: frame.id, changeScore: frame.changeScore };
  }

  hasFreshFrame(now = Date.now()) {
    return Boolean(this.mode !== 'off' && this._latest && now - this._latest.ts <= this.maxFrameAgeMs);
  }

  getLatestFrame(now = Date.now()) {
    return this.hasFreshFrame(now) ? this._latest : null;
  }

  /**
   * 为一轮语音/文字对话挑选最合适的 0~2 张关键帧（转成 DSH 原生 image 内容块）
   * 规则：
   *   - 未开启或无新鲜帧 → 0 帧
   *   - 明确问「刚才发生了什么 / 对比变化」→ 最多 2 帧（历史帧 + 最新帧）
   *   - 明确提到画面/电影/游戏 → 必发最新 1 帧（即使刚才发过同一帧）
   *   - 普通聊天但画面刚更新（id != _lastSentFrameId）→ 自动顺带发 1 帧让 AI 始终有画面感
   *   - 画面完全没变且用户没提屏幕 → 0 帧（零冗余开销）
   */
  pickFramesForTurn(utterance = '', { force = false } = {}) {
    const now = Date.now();
    if (!this.hasFreshFrame(now)) return { imageParts: [], note: '', frameCount: 0 };

    const t = String(utterance || '').trim();
    const wantsCompare = COMPARE_INTENT_RE.test(t);
    const wantsVisual = force || VISUAL_INTENT_RE.test(t);
    const hasNewSinceLast = this._latest.id !== this._lastSentFrameId;

    let selected = [];
    if (wantsCompare && this._keyframes.length >= 2) {
      selected = [this._keyframes[this._keyframes.length - 2], this._latest];
    } else if (wantsVisual || hasNewSinceLast) {
      selected = [this._latest];
    } else {
      return { imageParts: [], note: '', frameCount: 0 };
    }

    // 去重同一帧
    const uniq = [];
    const seen = new Set();
    for (const f of selected) {
      if (!seen.has(f.id)) { seen.add(f.id); uniq.push(f); }
    }
    this._lastSentFrameId = this._latest.id;

    const imageParts = uniq.map((f, idx) => ({
      type: 'image',
      mediaType: 'image/jpeg',
      data: f.buf.toString('base64'),
      name: uniq.length > 1 ? `screen-${idx === 0 ? 'prev' : 'now'}.jpg` : 'screen-now.jpg'
    }));

    const ageSec = Math.max(0, Math.round((now - this._latest.ts) / 1000));
    const srcLabel = this._latest.source === 'qq-screen' ? 'QQ屏幕共享' : (this._latest.label || '桌面实时画面');
    const note = uniq.length > 1
      ? `[实时看屏（${srcLabel}）：附带了刚才与现在（${ageSec}秒前）的 2 帧画面对比，结合画面细节自然用口语回答，别说“根据图片”]`
      : `[实时看屏（${srcLabel}，${ageSec}秒前）：这是对方当前屏幕画面，结合看到的内容自然聊天，别说“根据你发的截图”]`;

    return { imageParts, note, frameCount: imageParts.length };
  }

  /**
   * 打包给主动陪看吐槽回合的 1~2 帧
   */
  buildWatchAlongParts(frames) {
    const list = (Array.isArray(frames) && frames.length ? frames : (this._latest ? [this._latest] : [])).slice(-2);
    if (!list.length) return [];
    this._lastSentFrameId = list[list.length - 1].id;
    return list.map((f, idx) => ({
      type: 'image',
      mediaType: 'image/jpeg',
      data: f.buf.toString('base64'),
      name: list.length > 1 ? `watch-${idx === 0 ? 'before' : 'now'}.jpg` : 'watch-now.jpg'
    }));
  }

  getStatus() {
    const now = Date.now();
    const fresh = this.hasFreshFrame(now);
    return {
      mode: this.mode,
      modeLabel: this.modeLabel(),
      active: fresh,
      source: fresh ? this._latest.source : null,
      label: fresh ? this._latest.label : '',
      width: fresh ? this._latest.width : 0,
      height: fresh ? this._latest.height : 0,
      lastFrameAgeSec: this._latest ? Math.round((now - this._latest.ts) / 1000) : null,
      lastChangeScore: this._latest ? this._latest.changeScore : 0,
      keyframesBuffered: this._keyframes.length,
      totalFramesIn: this._totalFramesIn,
      totalKeyframes: this._totalKeyframes,
      recentEvents: this._recentEvents.slice(-15)
    };
  }
}
