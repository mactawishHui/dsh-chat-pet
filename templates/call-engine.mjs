/**
 * call-engine.mjs — 平台无关的实时全双工语音通话内核（ESM）
 *
 * 解耦设计：本模块不依赖 QQ / SnowLuma / Discord / 浏览器，只通过极简回调与宿主交互：
 *   - 输入：宿主持续喂入 16kHz / 16bit / 单声道 PCM 音频块 → engine.pushPcm16k(buf)
 *   - 输出：引擎回调 onAudioOut(pcm24kBuf) 推流 24kHz / 16bit / 单声道 PCM 音频
 *   - 打断：引擎回调 onClearOut() 立刻清空宿主音频播放缓冲
 *   - 挂断：引擎回调 onHangupRequest(reason) 通知宿主挂断
 *   - 记忆：通话前调 getContext() 拉取人设与记忆；挂断后调 onSummary(report) 写回摘要
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';

const FRAME_SAMPLES_16K = 320; // 20ms @ 16kHz
const FRAME_BYTES_16K = FRAME_SAMPLES_16K * 2; // 640 bytes
const PCM24K_BYTES_PER_MS = 48; // 24000 * 2 / 1000
const PACER_TICK_MS = 20;
const PACER_CHUNK_BYTES = PCM24K_BYTES_PER_MS * PACER_TICK_MS; // 960 bytes = 20ms @ 24kHz
const PACER_PREFILL_BYTES = PCM24K_BYTES_PER_MS * 80; // 80ms 预充缓冲，彻底杜绝 PulseAudio 欠载杂音

// 只匹配真正“话没说完”的连接词/思考停顿词（绝不包含「了/的/吧/呢/啊/呀」等句末完结词！）
const CONTINUATION_RE = /(然后|就是|但是|不过|因为|所以|那个|这个|而且|比如|其实|好像|可能|我觉得|就是说|另外|还有|或者|的话|嗯|呃|唉|都)[，,、。.\s]*$/;
const GOODBYE_RE = /(先挂了|挂了吧|我挂了|拜拜|再见|晚安|不聊了|先这样|回头聊|下次聊)/;

const DEFAULT_TTS_INSTRUCTION = '语速放慢一点，吐字松弛随意自然，像熟人私下打电话聊天一样带一点生活气、轻声气口和自然停顿，不要像播音员那样字正腔圆或赶着念完';

function applyFadeIn(pcmBuf, fadeSamples = 120) {
  const out = Buffer.from(pcmBuf);
  const total = out.length >> 1;
  const n = Math.min(fadeSamples, total);
  for (let i = 0; i < n; i++) {
    const s = out.readInt16LE(i * 2);
    out.writeInt16LE(Math.round((s * i) / n), i * 2);
  }
  return out;
}

function applyFadeOut(pcmBuf, fadeSamples = 120) {
  const out = Buffer.from(pcmBuf);
  const total = out.length >> 1;
  const n = Math.min(fadeSamples, total);
  for (let i = 0; i < n; i++) {
    const idx = total - 1 - i;
    const s = out.readInt16LE(idx * 2);
    out.writeInt16LE(Math.round((s * i) / n), idx * 2);
  }
  return out;
}

function formatBeijingNow() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const w = ['日', '一', '二', '三', '四', '五', '六'][d.getUTCDay()];
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日 星期${w} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function calcRms(buf) {
  const n = buf.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

function cleanSpokenText(raw) {
  let s = String(raw || '');
  s = s.replace(/\[HANGUP\]/gi, '');
  s = s.replace(/https?:\/\/\S+/g, '');
  s = s.replace(/```[\s\S]*?```/g, '');
  s = s.replace(/[*_~`#>]/g, '');
  s = s.replace(/[（(][^）)]{0,16}[）)]/g, ''); // 去掉（笑）（叹气）等舞台动作
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function splitSpokenClauses(text) {
  const cleaned = cleanSpokenText(text);
  if (!cleaned) return [];
  // 尽量按完整句子送 SSE 流式合成（不再在每个逗号处切碎），保持整句连贯自然语调
  const clauses = [];
  let buf = '';
  for (const ch of cleaned) {
    buf += ch;
    const isSentenceEnd = /[。！？!?；;\n]/.test(ch) && buf.length >= 16;
    const isVeryLongComma = /[，,]/.test(ch) && buf.length >= 38;
    if (isSentenceEnd || isVeryLongComma) {
      const part = buf.trim();
      if (part.replace(/[。！？!?；;，,、：:\s]/g, '').length > 0) clauses.push(part);
      buf = '';
    }
  }
  if (buf.trim().replace(/[。！？!?；;，,、：:\s]/g, '').length > 0) {
    if (clauses.length && buf.trim().length < 8) {
      clauses[clauses.length - 1] += buf.trim();
    } else {
      clauses.push(buf.trim());
    }
  }
  return clauses;
}

/**
 * 本地 0ms 梗库快速匹配：若通话中对方抛出已知热梗，直接给大脑注入接梗下句。
 */
function lookupLocalMemeSync(utterance, memeKbPath) {
  const q = String(utterance || '').replace(/[。！？!?，,、\s]/g, '').toLowerCase();
  if (!q || q.length < 2) return null;
  try {
    const kb = JSON.parse(fs.readFileSync(memeKbPath, 'utf8'));
    const memes = Array.isArray(kb?.memes) ? kb.memes : [];
    let best = null;
    let bestScore = 0;
    for (const m of memes) {
      const candidates = [m.name, ...(Array.isArray(m.aliases) ? m.aliases : [])]
        .map((x) => String(x || '').replace(/[。！？!?，,、\s]/g, '').toLowerCase())
        .filter((x) => x.length >= 2);
      for (const c of candidates) {
        let s = 0;
        if (q === c) s = 100;
        else if (q.includes(c) && c.length >= 3) s = 75;
        else if (c.includes(q) && q.length >= 3) s = 60;
        if (s > bestScore) {
          bestScore = s;
          best = m;
        }
      }
    }
    if (best && bestScore >= 60) {
      return {
        name: best.name,
        meaning: best.meaning || '',
        replies: Array.isArray(best.replies) ? best.replies.slice(0, 4) : []
      };
    }
  } catch {
    // ignore missing kb
  }
  return null;
}

/**
 * DashScope Paraformer 实时流式语音识别会话（仅在用户开口说话期间建连，静音期 0 费用）
 */
class ParaformerStream {
  constructor({ apiKey, wsUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', model = 'paraformer-realtime-v2', log = console.log }) {
    this.apiKey = apiKey;
    this.wsUrl = wsUrl;
    this.model = model;
    this.log = log;
    this.taskId = crypto.randomUUID().replace(/-/g, '');
    this.ws = null;
    this.ready = false;
    this.closed = false;
    this.pendingAudio = [];
    this.committedSegments = [];
    this.currentPartial = '';
    this._finishResolve = null;
    this._open();
  }

  _open() {
    this.ws = new WebSocket(this.wsUrl, {
      headers: { authorization: `Bearer ${this.apiKey}` }
    });
    this.ws.on('open', () => {
      if (this.closed) return;
      this.ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio',
          task: 'asr',
          function: 'recognition',
          model: this.model,
          parameters: {
            format: 'pcm',
            sample_rate: 16000,
            language_hints: ['zh', 'en']
          },
          input: {}
        }
      }));
    });
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      const ev = msg?.header?.event;
      if (ev === 'task-started') {
        this.ready = true;
        for (const buf of this.pendingAudio) {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buf);
        }
        this.pendingAudio = [];
      } else if (ev === 'result-generated') {
        const sent = msg?.payload?.output?.sentence;
        if (sent && typeof sent.text === 'string') {
          const t = sent.text.trim();
          if (sent.sentence_end) {
            if (t) this.committedSegments.push(t);
            this.currentPartial = '';
          } else {
            this.currentPartial = t;
          }
        }
      } else if (ev === 'task-finished' || ev === 'task-failed') {
        this._resolveFinal();
      }
    });
    this.ws.on('error', (err) => {
      this.log(`[call-asr] ws error: ${err?.message ?? err}`);
      this._resolveFinal();
    });
    this.ws.on('close', () => {
      this._resolveFinal();
    });
  }

  getPartialText() {
    return [...this.committedSegments, this.currentPartial].filter(Boolean).join('');
  }

  sendAudio(pcm16kBuf) {
    if (this.closed || !pcm16kBuf?.length) return;
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcm16kBuf);
    } else if (this.pendingAudio.length < 250) {
      this.pendingAudio.push(Buffer.from(pcm16kBuf));
    }
  }

  finish(timeoutMs = 2500) {
    return new Promise((resolve) => {
      if (this.closed) return resolve(this.getPartialText());
      this._finishResolve = resolve;
      const timer = setTimeout(() => this._resolveFinal(), timeoutMs);
      timer.unref?.();
      this._finishTimer = timer;
      try {
        if (this.ws?.readyState === WebSocket.OPEN) {
          if (this.ready) {
            this.ws.send(JSON.stringify({
              header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
              payload: { input: {} }
            }));
          } else {
            // 若还没 task-started，等最多 600ms
            setTimeout(() => {
              if (!this.closed && this.ws?.readyState === WebSocket.OPEN) {
                for (const buf of this.pendingAudio) this.ws.send(buf);
                this.pendingAudio = [];
                this.ws.send(JSON.stringify({
                  header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
                  payload: { input: {} }
                }));
              }
            }, 600);
          }
        } else {
          this._resolveFinal();
        }
      } catch {
        this._resolveFinal();
      }
    });
  }

  abort() {
    this.closed = true;
    if (this._finishTimer) clearTimeout(this._finishTimer);
    try { this.ws?.close(); } catch {}
    if (this._finishResolve) {
      const fn = this._finishResolve;
      this._finishResolve = null;
      fn('');
    }
  }

  _resolveFinal() {
    if (this.closed && !this._finishResolve) return;
    this.closed = true;
    if (this._finishTimer) clearTimeout(this._finishTimer);
    const finalText = this.getPartialText().trim();
    try { this.ws?.close(); } catch {}
    if (this._finishResolve) {
      const fn = this._finishResolve;
      this._finishResolve = null;
      fn(finalText);
    }
  }
}

/**
 * DashScope Qwen-Audio-TTS SSE 流式合成：返回 PCM16 24kHz 音频块（首包 ~280ms）
 */
async function streamDashscopeTts({ text, apiKey, model = 'qwen-audio-3.1-tts-flash', voice = 'qiaoxiaojiao_v3.1', instruction = DEFAULT_TTS_INSTRUCTION, endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer', signal, onChunk }) {
  const input = { text, voice, format: 'pcm', sample_rate: 24000 };
  if (instruction) input.instruction = instruction;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
      'X-DashScope-SSE': 'enable'
    },
    body: JSON.stringify({ model, input }),
    signal
  });
  if (!res.ok || !res.body) {
    throw new Error(`DashScope TTS SSE HTTP ${res.status}`);
  }
  const decoder = new TextDecoder();
  let carry = '';
  let totalBytes = 0;
  for await (const rawChunk of res.body) {
    if (signal?.aborted) break;
    carry += decoder.decode(rawChunk, { stream: true });
    let idx;
    while ((idx = carry.indexOf('\n\n')) >= 0) {
      const block = carry.slice(0, idx);
      carry = carry.slice(idx + 2);
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      let j;
      try { j = JSON.parse(dataLine.slice(5)); } catch { continue; }
      const b64 = j?.output?.audio?.data;
      if (b64) {
        const pcm = Buffer.from(b64, 'base64');
        if (pcm.length) {
          totalBytes += pcm.length;
          onChunk(pcm);
        }
      }
    }
  }
  return totalBytes;
}

/**
 * 实时通话引擎主类
 */
export class RealtimeCallEngine {
  constructor(opts = {}) {
    this.callerId = String(opts.callerId || 'unknown');
    this.callerName = String(opts.callerName || '朋友');
    this.dashscopeKeyFile = opts.dashscopeKeyFile || '/opt/qq-tts/apikey.txt';
    this.ttsModel = opts.ttsModel || 'qwen-audio-3.1-tts-flash';
    this.ttsVoice = opts.ttsVoice || 'qiaoxiaojiao_v3.1';
    this.asrModel = opts.asrModel || 'paraformer-realtime-v2';
    this.memeKbPath = opts.memeKbPath || '/opt/qq-bridge/state/meme-kb.json';
    this.fillersDir = opts.fillersDir || '/opt/qq-bridge/audio/call-fillers';
    this.statsPath = opts.statsPath || '/opt/qq-bridge/state/call-stats.json';
    this.dshBaseUrl = opts.dshBaseUrl || 'http://127.0.0.1:3080';
    this.dshAuthToken = opts.dshAuthToken || '';
    this.dshPreset = opts.dshPreset || 'qq-call';
    this.dshModel = opts.dshModel || { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off' };
    this.dshClientPath = opts.dshClientPath || '/opt/qq-bridge/src/dsh-client.js';

    // 时长与护栏配置
    this.softReminderMin = Number(opts.softReminderMin ?? 60);
    this.dailyLimitMin = Number(opts.dailyLimitMin ?? 180);
    this.silenceAskSec = Number(opts.silenceAskSec ?? 120);
    this.silenceHangupSec = Number(opts.silenceHangupSec ?? 150);
    this.enableFillers = opts.enableFillers === true; // 默认关闭独立预录语气词，避免拼接突兀
    this.ttsInstruction = opts.ttsInstruction ?? DEFAULT_TTS_INSTRUCTION;
    this.baseSilenceFrames = Number(opts.baseSilenceFrames ?? 32); // 640ms（说完利落接话，不卡顿）
    this.longSilenceFrames = Number(opts.longSilenceFrames ?? 62); // 1240ms（真正停在思考词/短字时耐心等待）

    // 宿主回调
    this.onAudioOut = opts.onAudioOut || (() => {});
    this.onClearOut = opts.onClearOut || (() => {});
    this.onHangupRequest = opts.onHangupRequest || (() => {});
    this.getContext = opts.getContext || (async () => ({}));
    this.onSummary = opts.onSummary || (async () => {});
    this.log = opts.log || console.log;

    // 内部状态
    this.active = false;
    this.startedAt = 0;
    this.dshApi = null;
    this.dshSessionId = null;
    this.dshStreamAc = null;
    this.dshPendingTurn = null; // { resolve, reject, onTextDelta }

    // 音频帧拼接与 VAD
    this._pcmRem = Buffer.alloc(0);
    this._preRoll = []; // 最近 15 帧 (300ms)
    this._noiseFloor = 120;
    this._inSpeech = false;
    this._speechFrames = 0;
    this._silenceFrames = 0;
    this._utteranceFrames = 0;
    this._activeAsr = null;

    // 1x 实时播放队列与精确打断状态（彻底消灭音频重叠！）
    this._playQueue = []; // Buffer[] of PCM24K
    this._playQueueBytes = 0;
    this._pacerTimer = null;
    this._aiThinking = false;
    this._aiHasSpokenThisTurn = false;
    this._pendingUserUtterance = ''; // 若 AI 还在思考就被补话，合并后再回答
    this._playedBytesThisTurn = 0;
    this._totalQueuedBytesThisTurn = 0;
    this._currentReplyText = '';
    this._turnAc = null;
    this._turnSeq = 0;
    this._lastInterruptedContext = '';
    this._lastFillerId = '';
    this._fillers = this.enableFillers ? this._loadFillers() : [];

    // 对话记录、统计与定时器
    this.transcript = []; // [{ role, text, ts }]
    this.latencies = []; // [{ asrMs, llmMs, ttsFirstMs, totalMs }]
    this._lastActivityAt = 0;
    this._askedStillThere = false;
    this._hangupTriggered = false;
    this._softReminderSent = false;
    this._dailyLimitTriggered = false;
    this._watchdogTimer = null;
    this._ending = false;
  }

  _apiKey() {
    return fs.readFileSync(this.dashscopeKeyFile, 'utf8').trim();
  }

  _loadFillers() {
    const out = [];
    try {
      for (const f of fs.readdirSync(this.fillersDir)) {
        if (!f.endsWith('.pcm')) continue;
        const buf = fs.readFileSync(path.join(this.fillersDir, f));
        if (buf.length > 1000) out.push({ id: f.replace(/\.pcm$/, ''), pcm: buf });
      }
    } catch {
      // optional fillers
    }
    return out;
  }

  _pickFiller(userText) {
    if (!this._fillers.length) return null;
    const isQ = /[吗嘛啥呢怎么为什么哪里几谁？?]/.test(userText);
    const isFun = /(哈哈|笑死|离谱|卧槽|牛逼|验牌|鸡你太美|压力马斯内)/.test(userText);
    let preferred = ['en1', 'enen', 'oo', 'ei'];
    if (isQ) preferred = ['en1', 'xiang', 'ah', 'ei'];
    else if (isFun) preferred = ['haha', 'ei', 'dui', 'queshi'];
    const pool = this._fillers.filter((f) => preferred.includes(f.id) && f.id !== this._lastFillerId);
    const list = pool.length ? pool : this._fillers.filter((f) => f.id !== this._lastFillerId);
    const chosen = list[Math.floor(Math.random() * list.length)] || this._fillers[0];
    this._lastFillerId = chosen.id;
    return chosen;
  }

  _readDailyUsedSec() {
    const today = new Date().toISOString().slice(0, 10);
    try {
      const data = JSON.parse(fs.readFileSync(this.statsPath, 'utf8'));
      if (data?.day === today) return Number(data.usedSec) || 0;
    } catch {}
    return 0;
  }

  _addDailyUsedSec(deltaSec) {
    const today = new Date().toISOString().slice(0, 10);
    let data = { day: today, usedSec: 0, calls: [] };
    try {
      const prev = JSON.parse(fs.readFileSync(this.statsPath, 'utf8'));
      if (prev?.day === today) data = prev;
      else if (Array.isArray(prev?.calls)) data.calls = prev.calls.slice(-30);
    } catch {}
    data.usedSec = Math.round((Number(data.usedSec) || 0) + deltaSec);
    fs.mkdirSync(path.dirname(this.statsPath), { recursive: true });
    fs.writeFileSync(this.statsPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return data;
  }

  async start() {
    if (this.active) return;
    this.active = true;
    this.startedAt = Date.now();
    this._lastActivityAt = this.startedAt;

    // 检查每日时长额度
    const usedMin = this._readDailyUsedSec() / 60;
    if (usedMin >= this.dailyLimitMin) {
      this.log(`[call-engine] 今日通话时长已达上限 (${usedMin.toFixed(1)}/${this.dailyLimitMin}min)`);
      await this._speakTextDirect('今天电话额度聊满啦，咱们去 QQ 打字接着聊，拜拜');
      setTimeout(() => this.onHangupRequest('daily_limit'), 2500);
      return;
    }

    // 1. 初始化 DSH 会话（无工具轻量 qq-call 预设 + deepseek-flash off）
    const { NodeApiClient } = await import(this.dshClientPath);
    this.dshApi = new NodeApiClient(this.dshBaseUrl, undefined, {
      token: this.dshAuthToken,
      tokenExplicit: Boolean(this.dshAuthToken)
    });
    await this.dshApi.ensureAuth();
    const created = await this.dshApi.callUnary('session/create', {
      title: `qq-call-${this.callerId}-${new Date().toISOString().slice(11, 16)}`,
      agentPreset: this.dshPreset,
      model: this.dshModel
    });
    this.dshSessionId = created?.result?.value?.sessionId;
    if (!this.dshSessionId) {
      throw new Error(`创建 DSH qq-call 会话失败: ${JSON.stringify(created).slice(0, 200)}`);
    }
    this.log(`[call-engine] DSH 通话会话就绪: ${this.dshSessionId} (${this.dshModel.model}/${this.dshModel.reasoningEffort})`);

    // 启动 DSH 事件流监听
    this.dshStreamAc = new AbortController();
    this._pumpDshEvents(this.dshStreamAc.signal);
    this.dshApi.events.follow(this.dshSessionId);
    await new Promise((r) => setTimeout(r, 250));

    // 2. 启动 1x 实时播放节拍器 + 拉取 QQ 长期记忆与近期聊天快照
    this._startPacer();
    const ctx = await this.getContext(this.callerId).catch(() => ({}));
    const contextPrimer = this._formatContextPrimer(ctx);
    this._startWatchdog();

    // 立即用她的声音先打声招呼，同时悄悄把上下文喂进会话
    const greetPrompt = [
      contextPrimer,
      `现在电话刚刚接通，打电话来的是「${this.callerName}」。请直接自然地开口打个招呼（简短一句，如“喂？听得见吗？”），不要主动提旧事，也不要复述上面的背景资料。`
    ].filter(Boolean).join('\n\n');

    await this._runAiTurn(greetPrompt, { isGreeting: true, userUtterance: '' });
  }

  _startPacer() {
    if (this._pacerTimer) return;
    this._pacerActive = false;
    this._pacerOriginMs = 0;
    this._pacerSentBytes = 0;
    this._pacerTimer = setInterval(() => {
      if (!this.active || this._ending) return;
      if (this._playQueueBytes <= 0) {
        this._pacerActive = false;
        return;
      }
      const now = performance.now();
      let need = 0;
      if (!this._pacerActive) {
        // 新一句开播前预充 80ms 缓冲给 PulseAudio，彻底消灭低延迟欠载噼啪杂音
        this._pacerActive = true;
        this._pacerOriginMs = now;
        this._pacerSentBytes = 0;
        need = Math.min(this._playQueueBytes, PACER_PREFILL_BYTES);
      } else {
        // 高精度时钟漂移补偿：保证下游始终保持 80ms 稳定水库，绝不欠载也不堆积
        const targetBytes = Math.floor((now - this._pacerOriginMs) * PCM24K_BYTES_PER_MS) + PACER_PREFILL_BYTES;
        need = Math.min(this._playQueueBytes, Math.max(0, targetBytes - this._pacerSentBytes));
        // 对齐 2 字节（int16 样本边界），避免奇数字节切错声道产生爆音！
        need -= need % 2;
      }
      if (need < 2) return;

      const parts = [];
      let rem = need;
      while (rem > 0 && this._playQueue.length) {
        const head = this._playQueue[0];
        if (head.length <= rem) {
          parts.push(this._playQueue.shift());
          rem -= head.length;
        } else {
          parts.push(head.subarray(0, rem));
          this._playQueue[0] = head.subarray(rem);
          rem = 0;
        }
      }
      if (parts.length) {
        let out = parts.length === 1 ? parts[0] : Buffer.concat(parts);
        if (this._pacerSentBytes === 0) out = applyFadeIn(out, 120);
        if (this._playQueueBytes - out.length <= 0) out = applyFadeOut(out, 120);
        this._playQueueBytes = Math.max(0, this._playQueueBytes - out.length);
        this._pacerSentBytes += out.length;
        this._playedBytesThisTurn += out.length;
        this.onAudioOut(out);
      }
    }, 10);
    this._pacerTimer.unref?.();
  }

  _enqueueAudioOut(pcmBuf) {
    if (!pcmBuf?.length) return;
    // 确保严格偶数字节，绝不破坏 int16 采样边界
    const aligned = pcmBuf.length % 2 === 0 ? pcmBuf : pcmBuf.subarray(0, pcmBuf.length - 1);
    if (!aligned.length) return;
    this._playQueue.push(aligned);
    this._playQueueBytes += aligned.length;
    this._totalQueuedBytesThisTurn += aligned.length;
  }

  _clearPlaybackQueue() {
    this._playQueue.length = 0;
    this._playQueueBytes = 0;
    this._pacerActive = false;
    this._pacerSentBytes = 0;
    this.onClearOut();
  }

  _formatContextPrimer(ctx) {
    const parts = [
      `【当前准确时间】${formatBeijingNow()}（北京时间）\n⚠️ 时间校准铁律：下面「长期印象」里记录的多为历史信息，遇到任何日期（如生日、哪周去哪）务必先对照上面的当前日期——已经过去的事绝对不要当成“今天”或“快到了”来提！优先关注下面「最近 QQ 聊天」里的最新近况。`
    ];
    if (ctx?.impression) {
      parts.push(`【你对「${this.callerName}」的长期印象（历史累积，注意核对日期）】\n${ctx.impression}`);
    }
    if (Array.isArray(ctx?.recentMessages) && ctx.recentMessages.length) {
      parts.push(`【你们最近在 QQ 上聊过的内容（自然有印象即可，别刻意背诵）】\n${ctx.recentMessages.slice(-12).join('\n')}`);
    }
    if (ctx?.dailyFeedText) {
      parts.push(ctx.dailyFeedText);
    }
    return parts.join('\n\n');
  }

  _pumpDshEvents(signal) {
    (async () => {
      try {
        for await (const env of this.dshApi.events.mux(undefined, signal)) {
          const frame = env?.payload;
          if (!frame || frame.sessionId !== this.dshSessionId || frame.type !== 'session/event') continue;
          const ev = frame.event;
          const pending = this.dshPendingTurn;
          if (!pending) continue;

          if (ev.type === 'assistant/chunk') {
            const ch = ev.data?.chunk;
            const isText = ch?.type === 'text' || ch?.type === 'text-delta' || ch?.kind === 'text';
            const delta = isText ? (ch.text || ch.delta || ch.content || '') : '';
            if (delta) {
              pending.gotChunks = true;
              pending.fullText += delta;
              pending.onTextDelta?.(delta);
            }
          } else if (ev.type === 'assistant/message') {
            const content = ev.data?.message?.content || [];
            const txt = content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
            if (txt && !pending.gotChunks) {
              pending.fullText = txt;
              pending.onTextDelta?.(txt);
            }
          } else if (ev.type === 'turn/end') {
            const res = pending.fullText;
            this.dshPendingTurn = null;
            pending.resolve(res);
          }
        }
      } catch (err) {
        if (!signal.aborted) {
          this.log(`[call-engine] DSH 事件流异常: ${err?.message ?? err}`);
        }
      }
    })();
  }

  _startWatchdog() {
    this._watchdogTimer = setInterval(() => {
      if (!this.active || this._ending) return;
      const now = Date.now();
      const elapsedSec = (now - this.startedAt) / 1000;
      const idleSec = (now - this._lastActivityAt) / 1000;

      // 每日总时长兜底
      const totalTodayMin = (this._readDailyUsedSec() + elapsedSec) / 60;
      if (!this._dailyLimitTriggered && totalTodayMin >= this.dailyLimitMin) {
        this._dailyLimitTriggered = true;
        this.log(`[call-engine] 触达每日通话额度上限 (${this.dailyLimitMin}min)`);
        this._speakTextDirect('今天电话额度聊满啦，咱们去 QQ 打字接着聊，拜拜').then(() => {
          setTimeout(() => this.onHangupRequest('daily_limit'), 2500);
        });
        return;
      }

      // 沉默防忘挂提醒（严格单次触发，避免重复喊挂断）
      if (!this._isActuallySpeakingNow() && !this._inSpeech && !this._hangupTriggered) {
        if (!this._askedStillThere && idleSec >= this.silenceAskSec) {
          this._askedStillThere = true;
          this.log(`[call-engine] 沉默 ${Math.round(idleSec)}s，主动询问还在吗`);
          this._speakTextDirect('喂，你还在吗？');
        } else if (this._askedStillThere && idleSec >= this.silenceHangupSec) {
          this._hangupTriggered = true;
          this.log(`[call-engine] 沉默超 ${this.silenceHangupSec}s，自动道别挂断`);
          this._speakTextDirect('好像没声音啦，那我先挂咯，有事 QQ 喊我，拜拜').then(() => {
            const waitLeft = Math.max(1200, Math.round(this._playQueueBytes / PCM24K_BYTES_PER_MS) + 500);
            setTimeout(() => this.onHangupRequest('silence_timeout'), waitLeft);
          });
        }
      }
    }, 3000);
    this._watchdogTimer.unref?.();
  }

  /**
   * 宿主喂入 16kHz PCM16 单声道音频流
   */
  pushPcm16k(chunk) {
    if (!this.active || this._ending || !chunk?.length) return;
    let buf = this._pcmRem.length ? Buffer.concat([this._pcmRem, chunk]) : chunk;
    let offset = 0;
    while (offset + FRAME_BYTES_16K <= buf.length) {
      const frame = buf.subarray(offset, offset + FRAME_BYTES_16K);
      offset += FRAME_BYTES_16K;
      this._processFrame20ms(frame);
    }
    this._pcmRem = offset < buf.length ? Buffer.from(buf.subarray(offset)) : Buffer.alloc(0);
  }

  _isActuallySpeakingNow() {
    return this._playQueueBytes > 0 || (this._aiThinking && this._aiHasSpokenThisTurn);
  }

  _processFrame20ms(frame) {
    const rms = calcRms(frame);
    const aiSpeaking = this._isActuallySpeakingNow();

    // 维护 300ms 预录环形缓冲
    this._preRoll.push(Buffer.from(frame));
    if (this._preRoll.length > 15) this._preRoll.shift();

    // 非说话期平滑更新动态底噪
    if (!this._inSpeech && rms < 600) {
      this._noiseFloor = Math.max(40, Math.min(500, this._noiseFloor * 0.96 + rms * 0.04));
    }

    const startThresh = aiSpeaking
      ? Math.max(500, this._noiseFloor * 3.6)
      : Math.max(320, this._noiseFloor * 2.8);
    const keepThresh = Math.max(220, this._noiseFloor * 2.1);

    if (!this._inSpeech) {
      if (rms >= startThresh) {
        this._speechFrames++;
        // AI 正在说话时，连续 260ms (13帧) 确认为真人打断；空闲时 100ms (5帧) 即开始收音
        const needFrames = aiSpeaking ? 13 : 5;
        if (this._speechFrames >= needFrames) {
          if (aiSpeaking || this._aiThinking) {
            this._triggerBargeIn(aiSpeaking);
          }
          this._startUserUtterance();
        }
      } else {
        this._speechFrames = 0;
      }
      return;
    }

    // 正在听用户说话
    this._utteranceFrames++;
    this._lastActivityAt = Date.now();
    this._askedStillThere = false;
    this._activeAsr?.sendAudio(frame);

    if (rms >= keepThresh) {
      this._silenceFrames = 0;
    } else {
      this._silenceFrames++;
    }

    // 智能耐心断句：默认 640ms (32帧)；若刚说 1~3 个字或停在真正未完词（然后/但是/那个/嗯等）延长到 1240ms (62帧)
    const partial = (this._activeAsr?.getPartialText() || '').trim();
    const looksIncomplete = partial.length <= 3 || CONTINUATION_RE.test(partial);
    const needSilence = looksIncomplete ? this.longSilenceFrames : this.baseSilenceFrames;

    if (this._silenceFrames >= needSilence || this._utteranceFrames >= 1250) {
      this._endUserUtterance();
    }
  }

  _startUserUtterance() {
    this._inSpeech = true;
    this._silenceFrames = 0;
    this._utteranceFrames = 0;
    this._lastActivityAt = Date.now();
    this._askedStillThere = false;

    const asr = new ParaformerStream({
      apiKey: this._apiKey(),
      model: this.asrModel,
      log: this.log
    });
    // 冲入 300ms 预录缓冲，不丢第一个音节
    for (const f of this._preRoll) asr.sendAudio(f);
    this._activeAsr = asr;
  }

  _triggerBargeIn(wasAudiblySpeaking) {
    if (wasAudiblySpeaking) {
      this.log('[call-engine] 检测到对方打断，0ms 清空播放队列并取消在途生成');
      const full = cleanSpokenText(this._currentReplyText);
      if (full && this._totalQueuedBytesThisTurn > 0) {
        const ratio = Math.min(1, Math.max(0.1, this._playedBytesThisTurn / this._totalQueuedBytesThisTurn));
        const cutLen = Math.max(2, Math.floor(full.length * ratio));
        const spokenPart = full.slice(0, cutLen);
        this._lastInterruptedContext = `[提示：你刚才说到“${spokenPart}……”时被对方打断了，直接顺着对方新说的话自然接下去]`;
      }
    } else {
      this.log('[call-engine] 对方在回复开口前继续补充，取消在途回合准备合并');
    }
    this._turnSeq++;
    this._turnAc?.abort();
    this._turnAc = null;
    this._aiThinking = false;
    this._aiHasSpokenThisTurn = false;
    this._clearPlaybackQueue();
    if (this.dshPendingTurn) {
      const p = this.dshPendingTurn;
      this.dshPendingTurn = null;
      p.resolve('');
    }
    this.dshApi?.stopSessionWork(this.dshSessionId).catch(() => {});
  }

  async _endUserUtterance() {
    this._inSpeech = false;
    this._speechFrames = 0;
    this._silenceFrames = 0;
    const vadEndAt = Date.now();
    const asr = this._activeAsr;
    this._activeAsr = null;
    if (!asr) return;

    const rawText = (await asr.finish(2500)).trim();
    const asrMs = Date.now() - vadEndAt;
    if (!rawText) {
      this.log(`[call-engine] VAD 触发但 ASR 为空 (${asrMs}ms)，忽略杂音`);
      return;
    }

    // 如果上一句还在等大模型思考就被用户补话了，合并成一句完整话再回答
    const text = this._pendingUserUtterance ? `${this._pendingUserUtterance} ${rawText}` : rawText;
    this._pendingUserUtterance = '';

    // 如果 ASR 刚结束的瞬间用户又开口了，先暂存合并，别抢着回
    if (this._inSpeech) {
      this._pendingUserUtterance = text;
      this.log(`[call-engine] 👤 ${this.callerName} (暂存合并): "${text}"`);
      return;
    }

    this.log(`[call-engine] 👤 ${this.callerName}: "${text}" (asr=${asrMs}ms)`);
    this.transcript.push({ role: 'user', text, ts: Date.now() });
    this._lastActivityAt = Date.now();

    // 构造发给大脑的本轮输入（含打断感知、本地 0ms 梗库命中、60分钟软提醒）
    const notes = [];
    if (this._lastInterruptedContext) {
      notes.push(this._lastInterruptedContext);
      this._lastInterruptedContext = '';
    }
    const memeHit = lookupLocalMemeSync(text, this.memeKbPath);
    if (memeHit) {
      const reps = memeHit.replies.length ? memeHit.replies.join(' / ') : memeHit.meaning;
      notes.push(`[本地梗库命中「${memeHit.name}」：接梗下句参考=${reps}（对方是直接抛梗，请直接入戏接梗别科普）]`);
    }
    const elapsedMin = (Date.now() - this.startedAt) / 60000;
    if (!this._softReminderSent && elapsedMin >= this.softReminderMin) {
      this._softReminderSent = true;
      notes.push(`[提示：你们已经连续聊了约 ${Math.round(elapsedMin)} 分钟，可以在回复末尾自然随口提一句“不知不觉都聊了一个小时了诶”，但不要主动挂断]`);
    }

    const promptText = notes.length ? `${notes.join('\n')}\n对方说：${text}` : text;
    this._pendingUserUtterance = text; // 在正式出声前保留，万一思考中被补话可合并
    await this._runAiTurn(promptText, { vadEndAt, asrMs, userUtterance: text });
  }

  async _runAiTurn(promptText, { isGreeting = false, vadEndAt = Date.now(), asrMs = 0, userUtterance = '' } = {}) {
    // 严格串行：启动新回合前先取消任何残留的旧回合与播放队列，杜绝双声音重叠
    if (this._turnAc) {
      this._turnAc.abort();
      this._clearPlaybackQueue();
    }
    const mySeq = ++this._turnSeq;
    const ac = new AbortController();
    this._turnAc = ac;
    this._aiThinking = true;
    this._aiHasSpokenThisTurn = false;
    const tLlmStart = Date.now();

    let fillerPlayed = false;
    let firstAudioMs = 0;
    let fillerTimer = null;

    // 仅当显式开启 enableFillers 且等待超过 700ms 才垫声（默认关闭，保持纯自然语调）
    if (this.enableFillers && !isGreeting && userUtterance.length >= 4) {
      const filler = this._pickFiller(userUtterance);
      if (filler) {
        fillerTimer = setTimeout(() => {
          if (mySeq !== this._turnSeq || ac.signal.aborted || firstAudioMs > 0) return;
          fillerPlayed = true;
          this._aiHasSpokenThisTurn = true;
          this._enqueueAudioOut(filler.pcm);
        }, 700);
        fillerTimer.unref?.();
      }
    }

    try {
      const fullReply = await new Promise((resolve, reject) => {
        if (ac.signal.aborted) return resolve('');
        this.dshPendingTurn = {
          gotChunks: false,
          fullText: '',
          resolve,
          reject
        };
        this.dshApi.sessions.prompt({
          sessionId: this.dshSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: promptText }]
        }).then((resp) => {
          if (!resp?.result?.ok) {
            this.dshPendingTurn = null;
            reject(new Error(resp?.result?.error?.message || 'prompt rejected'));
          }
        }).catch((err) => {
          this.dshPendingTurn = null;
          reject(err);
        });
      });

      const llmMs = Date.now() - tLlmStart;
      if (mySeq !== this._turnSeq || ac.signal.aborted || this._inSpeech) {
        if (fillerTimer) clearTimeout(fillerTimer);
        if (mySeq === this._turnSeq) this._aiThinking = false;
        return;
      }

      const wantHangup = /\[HANGUP\]/i.test(fullReply) || (GOODBYE_RE.test(userUtterance) && /(拜拜|挂啦|挂咯|晚安|再见)/.test(fullReply));
      const spoken = cleanSpokenText(fullReply);
      if (!spoken) {
        if (fillerTimer) clearTimeout(fillerTimer);
        if (mySeq === this._turnSeq) this._aiThinking = false;
        return;
      }

      this._pendingUserUtterance = ''; // 正式开口，清空待合并缓存
      this.transcript.push({ role: 'assistant', text: spoken, ts: Date.now() });
      const clauses = splitSpokenClauses(spoken);
      this._currentReplyText = spoken;
      this._playedBytesThisTurn = 0;
      this._totalQueuedBytesThisTurn = 0;

      // 整句 SSE 流式合成推入 1x 节拍队列，句间加 220ms 自然换气停顿
      const breathGap = Buffer.alloc(PCM24K_BYTES_PER_MS * 220);
      for (let ci = 0; ci < clauses.length; ci++) {
        if (mySeq !== this._turnSeq || ac.signal.aborted) break;
        const clause = clauses[ci];
        const tTtsStart = Date.now();
        await streamDashscopeTts({
          text: clause,
          apiKey: this._apiKey(),
          model: this.ttsModel,
          voice: this.ttsVoice,
          instruction: this.ttsInstruction,
          signal: ac.signal,
          onChunk: (pcm) => {
            if (mySeq !== this._turnSeq || ac.signal.aborted) return;
            if (fillerTimer) { clearTimeout(fillerTimer); fillerTimer = null; }
            if (!firstAudioMs) {
              firstAudioMs = Date.now() - vadEndAt;
              this._aiHasSpokenThisTurn = true;
              const ttsFirstMs = Date.now() - tTtsStart;
              if (!isGreeting) {
                this.latencies.push({ asrMs, llmMs, ttsFirstMs, totalMs: firstAudioMs, fillerPlayed });
                this.log(`[call-engine] 🐳 小鲸鲸: "${spoken}" | asr=${asrMs}ms llm=${llmMs}ms tts1st=${ttsFirstMs}ms total=${firstAudioMs}ms`);
              } else {
                this.log(`[call-engine] 🐳 开场打招呼: "${spoken}" (llm=${llmMs}ms tts1st=${ttsFirstMs}ms)`);
              }
            }
            this._enqueueAudioOut(pcm);
          }
        });
        if (ci < clauses.length - 1 && mySeq === this._turnSeq && !ac.signal.aborted) {
          this._enqueueAudioOut(breathGap);
        }
      }

      if (mySeq === this._turnSeq) {
        this._aiThinking = false;
        this._lastActivityAt = Date.now();
        if (wantHangup && !this._hangupTriggered) {
          this._hangupTriggered = true;
          const waitLeft = Math.max(800, Math.round(this._playQueueBytes / PCM24K_BYTES_PER_MS) + 600);
          this.log(`[call-engine] 对方道别，${waitLeft}ms 后自动挂断`);
          setTimeout(() => {
            if (this.active && !this._ending) this.onHangupRequest('farewell');
          }, waitLeft);
        }
      }
    } catch (err) {
      if (fillerTimer) clearTimeout(fillerTimer);
      if (!ac.signal.aborted) {
        this.log(`[call-engine] 本轮对话异常: ${err?.message ?? err}`);
      }
      if (mySeq === this._turnSeq) this._aiThinking = false;
    }
  }

  async _speakTextDirect(text) {
    const clean = cleanSpokenText(text);
    if (!clean) return;
    try {
      await streamDashscopeTts({
        text: clean,
        apiKey: this._apiKey(),
        model: this.ttsModel,
        voice: this.ttsVoice,
        instruction: this.ttsInstruction,
        onChunk: (pcm) => this._enqueueAudioOut(pcm)
      });
    } catch (err) {
      this.log(`[call-engine] 直出语音失败: ${err?.message ?? err}`);
    }
  }

  async stop(reason = 'ended') {
    if (!this.active || this._ending) return null;
    this._ending = true;
    this.active = false;
    if (this._watchdogTimer) clearInterval(this._watchdogTimer);
    if (this._pacerTimer) clearInterval(this._pacerTimer);
    this._clearPlaybackQueue();
    this._turnAc?.abort();
    this._activeAsr?.abort();
    this.dshStreamAc?.abort();
    if (this.dshSessionId) {
      this.dshApi?.events.forget(this.dshSessionId);
      this.dshApi?.stopSessionWork(this.dshSessionId).catch(() => {});
    }

    const durationSec = Math.max(1, Math.round((Date.now() - this.startedAt) / 1000));
    this._addDailyUsedSec(durationSec);

    const avgLatencyMs = this.latencies.length
      ? Math.round(this.latencies.reduce((s, x) => s + x.totalMs, 0) / this.latencies.length)
      : 0;

    // 提炼通话摘要与新事实写回 QQ 长期记忆
    let summary = '';
    let facts = [];
    if (this.transcript.length >= 2) {
      const res = await this._summarizeTranscript().catch((e) => {
        this.log(`[call-engine] 生成通话摘要失败: ${e?.message ?? e}`);
        return null;
      });
      if (res) {
        summary = res.summary || '';
        facts = Array.isArray(res.facts) ? res.facts : [];
      }
    }

    const report = {
      callerId: this.callerId,
      callerName: this.callerName,
      startedAt: new Date(this.startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationSec,
      reason,
      turns: this.transcript.filter((x) => x.role === 'user').length,
      avgLatencyMs,
      summary,
      facts,
      transcript: this.transcript.slice(-30)
    };
    this.log(`[call-engine] 通话结束 (${reason})：时长 ${durationSec}s，${report.turns} 轮，平均延迟 ${avgLatencyMs}ms${summary ? `，摘要：${summary}` : ''}`);
    await this.onSummary(report).catch((e) => this.log(`[call-engine] 写回摘要失败: ${e?.message ?? e}`));
    return report;
  }

  async _summarizeTranscript() {
    const key = this._apiKey();
    const lines = this.transcript.map((m) => `${m.role === 'user' ? this.callerName : '小鲸鲸'}：${m.text}`).join('\n');
    const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen-plus-latest',
        temperature: 0.2,
        max_tokens: 350,
        enable_thinking: false,
        messages: [
          {
            role: 'system',
            content: '你是通话记忆整理器。将下面一段实时语音通话记录压缩成严格 JSON：{"summary": "一句话概括聊了什么（≤70字，第一人称‘刚才和对方通了电话，聊了…’）", "facts": ["新得知的具体个人近况/偏好/约定，最多3条，没有就空数组"]}。只输出 JSON。'
          },
          { role: 'user', content: lines }
        ]
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    let raw = String(data?.choices?.[0]?.message?.content || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
    return JSON.parse(raw);
  }
}
