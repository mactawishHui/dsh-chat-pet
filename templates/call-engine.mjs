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
import { detectScreenModeCommand, detectScreenAudioCommand } from './screen-vision-engine.mjs';

const FRAME_SAMPLES_16K = 320; // 20ms @ 16kHz
const FRAME_BYTES_16K = FRAME_SAMPLES_16K * 2; // 640 bytes
const PCM24K_BYTES_PER_MS = 48; // 24000 * 2 / 1000
const PACER_TICK_MS = 20;
const PACER_CHUNK_BYTES = PCM24K_BYTES_PER_MS * PACER_TICK_MS; // 960 bytes = 20ms @ 24kHz
const PACER_PREFILL_BYTES = PCM24K_BYTES_PER_MS * 180; // 180ms 预充水库（严格大于 pacat 100ms 目标缓冲），攒够再开播彻底消灭卡顿

// 只匹配真正“话没说完”的连接词/思考停顿词（绝不包含「了/的/吧/呢/啊/呀」等句末完结词！）
const CONTINUATION_RE = /(然后|就是|但是|不过|因为|所以|那个|这个|而且|比如|其实|好像|可能|我觉得|就是说|另外|还有|或者|的话|嗯|呃|唉|都)[，,、。.\s]*$/;
// 严格匹配真正的挂断道别（避免把“晚安大小姐”“再见爱人”等梗/片名误判为道别挂断）
const GOODBYE_RE = /(先挂了|挂了吧|我挂了|不聊了|先这样吧|回头聊|下次聊|(?:^|[，,。！!\s])(?:拜拜|再见|晚安)(?:啦|呀|咯|哈|吧|哦|～|~|[。！!\s]|$))/;
const AI_GOODBYE_RE = /(?:挂啦|挂咯|拜拜|再见|晚安)(?:啦|呀|咯|哈|吧|哦|～|~|[。！!\s])*$/;

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
  s = s.replace(/\[(?:HANGUP|SILENT)\]/gi, '');
  // 剥离模型偶发幻觉吐出的裸 XML/JSON 工具调用标签，避免 TTS 把代码念出来
  s = s.replace(/<(?:tool_?call|search|function|invoke|call|thought|think)[\s\S]*$/i, '');
  s = s.replace(/\{[\s\S]*"(?:keyword|query|url|command)"[\s\S]*\}\s*$/i, '');
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

const KNOWN_CITIES_RE = /(北京|上海|广州|深圳|杭州|成都|重庆|武汉|西安|南京|天津|苏州|长沙|郑州|沈阳|大连|青岛|济南|厦门|福州|合肥|昆明|哈尔滨|长春|太原|大同|石家庄|南昌|贵阳|南宁|海口|兰州|银川|西宁|拉萨|乌鲁木齐|呼和浩特|无锡|宁波|佛山|东莞|珠海|温州|香港|澳门|台北)/;

/**
 * 极速（<0.2ms）通话异步旁路意图检测：在不拖慢主对话 0ms 的前提下识别是否需要后台查工具或记备忘。
 */
export function detectSidecarTask(utterance, { defaultCity = '', localMemeHit = false } = {}) {
  const t = String(utterance || '').trim();
  if (!t || t.length < 4) return null;

  // 1. 记备忘 / 提醒事项（优先级最高，本地毫秒级写回）
  if (/(帮我记一下|帮我记个|给我记一下|记一下|记个备忘|别忘了提醒我|下次提醒我|明天提醒我|后天提醒我|提醒我一下)/.test(t)) {
    const clean = t
      .replace(/^(?:诶|哎|那个|对了|麻烦|你)?(?:帮我|给我)?(?:记一下|记个备忘|记个|别忘了)?[，,：:\s]*/g, '')
      .trim() || t;
    return { kind: 'remember', query: clean, label: '记下提醒事项', rawText: t };
  }

  // 2. 查天气（识别提到的城市或回退默认城市）
  if (/(天气|下雨|下雪|降温|升温|多少度|几度|冷不冷|热不热|刮风)/.test(t) &&
      /(查|看|明天|今天|后天|现在|外面|怎么样|几度|多少度|冷|热|带伞|穿)/.test(t)) {
    const known = t.match(KNOWN_CITIES_RE);
    const dynamic = !known ? t.match(/([\u4e00-\u9fa5]{2,3})(?:市|省)?(?:今天|明天|后天|现在)?的?天气/) : null;
    const city = (known?.[1] || dynamic?.[1] || defaultCity || '').replace(/^(明天|今天|后天|现在|外面|这边|那边)$/, '');
    if (city) {
      return { kind: 'weather', city, query: city, label: `查${city}天气`, rawText: t };
    }
    return { kind: 'web_search', query: t, label: '查天气', rawText: t };
  }

  // 3. 查梗（仅当本地 0ms 梗库未命中时才走后台实时查梗）
  if (!localMemeHit && /(什么梗|啥梗|啥意思|什么意思|查一下.*梗|搜一下.*梗)/.test(t)) {
    const q = t
      .replace(/^(?:诶|哎|那个|这个|刚才说的|你说的|帮我|你)+/g, '')
      .replace(/(?:帮我|你)?(?:查一下|搜一下|问一下|知道)?/g, '')
      .replace(/(?:到底)?(?:是)?(?:什么梗|啥梗|什么意思|啥意思)[呀啊吗呢？?。！!]*/g, '')
      .trim();
    if (q.length >= 2 && q.length <= 24) {
      return { kind: 'meme', query: q, label: `查梗「${q}」`, rawText: t };
    }
  }

  // 4. 显式联网查资料 / 事实检索
  if (/(帮我查一下|帮我搜一下|查一下|搜一下|网上查|网上搜|帮我看看网上|最新消息|什么时候上映|票房多少|是谁演的|哪年上映|多少钱)/.test(t)) {
    const q = t
      .replace(/^(?:诶|哎|那个|对了|你)?(?:帮我|去)?(?:网上)?(?:查一下|搜一下|看看)?[，,：:\s]*/g, '')
      .replace(/[呀啊吗呢？?。！!]+$/g, '')
      .trim();
    if (q.length >= 2) {
      return { kind: 'web_search', query: q, label: `查「${q.slice(0, 14)}」`, rawText: t };
    }
  }

  return null;
}

/**
 * DashScope Paraformer 实时流式语音识别会话（仅在有声音期间建连，静音期 0 费用）
 */
export class ParaformerStream {
  constructor({
    apiKey,
    wsUrl = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference',
    model = 'paraformer-realtime-v2',
    onSentence = null,
    onPartial = null,
    onClose = null,
    log = console.log
  }) {
    this.apiKey = apiKey;
    this.wsUrl = wsUrl;
    this.model = model;
    this.onSentence = onSentence;
    this.onPartial = onPartial;
    this.onClose = onClose;
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
            if (t) {
              this.committedSegments.push(t);
              try { this.onSentence?.(t); } catch {}
            }
            this.currentPartial = '';
          } else {
            this.currentPartial = t;
            if (t) {
              try { this.onPartial?.(t); } catch {}
            }
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
      try { this.onClose?.(); } catch {}
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
    this.onSidecarTask = typeof opts.onSidecarTask === 'function' ? opts.onSidecarTask : null;
    this.defaultCity = String(opts.defaultCity || '').trim();
    this.screenEngine = opts.screenEngine || null;
    this.log = opts.log || console.log;

    // 异步旁路工具状态（绝不阻塞主通话延迟）
    this._pendingSidecarNotes = [];
    this._sidecarSeq = 0;

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
    this._utteranceStartAt = 0;
    this._lastAsrPartial = '';
    this._lastAsrTextChangeAt = 0;
    this._activeAsr = null;

    // 1x 实时播放队列与精确打断状态（彻底消灭音频重叠！）
    this._playQueue = []; // Buffer[] of PCM24K
    this._playQueueBytes = 0;
    this._pacerTimer = null;
    this._aiThinking = false;
    this._ttsStreaming = false;
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
        // 关键：若 SSE TTS 正在推流但还没攒够 180ms 水库，先等几十毫秒攒满再开播，绝不把 30ms 碎包直接喂给 pacat 导致反复欠载卡顿！
        if (this._ttsStreaming && this._playQueueBytes < PACER_PREFILL_BYTES) return;
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

    const latestFrame = this.screenEngine?.getLatestFrame();
    const screenActive = Boolean(latestFrame);
    // 物理三通道（web-direct 等独立推屏源）时，通道 1 是纯净真人麦，保持 100% 原始高灵敏度；
    // 仅在 QQ 单轨共享（qq-screen）可能混入设备 BGM 时才启用额外的抗背景音抬升
    const qqScreenMixed = Boolean(screenActive && latestFrame.source === 'qq-screen');
    const isWatchMode = Boolean(qqScreenMixed && this.screenEngine.mode === 'watch_along');

    // 非说话期平滑更新动态底噪（严格限顶 ≤600，绝不因视频/游戏 BGM 抬高阈值导致听不见真人说话）
    const floorCap = qqScreenMixed ? 600 : 500;
    const floorSampleMax = qqScreenMixed ? 800 : 600;
    if (!this._inSpeech && rms < Math.max(floorSampleMax, this._noiseFloor)) {
      this._noiseFloor = Math.max(40, Math.min(floorCap, this._noiseFloor * 0.94 + rms * 0.06));
    }

    const watchBoost = isWatchMode ? 1.2 : (qqScreenMixed ? 1.08 : 1.0);
    const guardBusy = aiSpeaking || (qqScreenMixed && this._aiThinking);
    const startThresh = Math.round((guardBusy
      ? Math.max(540, this._noiseFloor * 3.6)
      : Math.max(320, this._noiseFloor * 2.8)) * watchBoost);
    const keepThresh = Math.max(220, this._noiseFloor * 2.1);

    if (!this._inSpeech) {
      if (rms >= startThresh) {
        this._speechFrames++;
        // AI 正在说话时需 300ms 持续人声才打断；物理三通道空闲态保持 100ms (5帧) 极致灵敏度
        const needFrames = aiSpeaking ? 15 : (guardBusy ? 11 : (qqScreenMixed ? 7 : 5));
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

    // ASR 辅助智能断句（彻底治好游戏/电影 BGM 一直响导致 VAD 卡满 25 秒才收尾的问题！）
    const partial = (this._activeAsr?.getPartialText() || '').trim();
    const nowMs = Date.now();
    if (partial !== this._lastAsrPartial) {
      this._lastAsrPartial = partial;
      this._lastAsrTextChangeAt = nowMs;
    }
    const uttElapsedMs = nowMs - this._utteranceStartAt;
    if (screenActive && !partial && uttElapsedMs >= 2400) {
      this._abortNoiseUtterance(rms);
      return;
    }

    const looksIncomplete = partial.length <= 3 || CONTINUATION_RE.test(partial);
    const needSilence = looksIncomplete ? this.longSilenceFrames : this.baseSilenceFrames;
    const asrStaleMs = this._lastAsrTextChangeAt ? (nowMs - this._lastAsrTextChangeAt) : 0;
    const asrFinished = partial.length >= 2 && asrStaleMs >= (looksIncomplete ? 1650 : 1150);

    if (this._silenceFrames >= needSilence || asrFinished || this._utteranceFrames >= 1250) {
      this._endUserUtterance();
    }
  }

  _abortNoiseUtterance(currentRms) {
    this._inSpeech = false;
    this._speechFrames = 0;
    this._silenceFrames = 0;
    const asr = this._activeAsr;
    this._activeAsr = null;
    asr?.abort();
    // 把当前游戏/电影 BGM 能量轻度吸收进底噪，严格限顶 ≤650，绝不把门槛抬高到听不见真人说话
    this._noiseFloor = Math.min(650, Math.max(this._noiseFloor * 1.15, Math.min(currentRms * 0.85, 650)));
    this.log(`[call-engine] 检测到纯背景音/游戏BGM（2.4s 无语音识别），静默忽略并自适应底噪→${Math.round(this._noiseFloor)}`);
  }

  _startUserUtterance() {
    this._inSpeech = true;
    this._silenceFrames = 0;
    this._utteranceFrames = 0;
    this._utteranceStartAt = Date.now();
    this._lastAsrPartial = '';
    this._lastAsrTextChangeAt = 0;
    this._lastActivityAt = this._utteranceStartAt;
    this._askedStillThere = false;
    // 若刚才误触发了道别挂断倒计时但对方又开口继续聊了，立即取消挂断！
    if (this._hangupTimer) {
      clearTimeout(this._hangupTimer);
      this._hangupTimer = null;
      this._hangupTriggered = false;
      this.log('[call-engine] 对方继续开口说话，已取消自动挂断倒计时');
    }
    // 用户刚开口的瞬间，主动通知看屏端立刻抓一帧此刻最新画面，彻底消灭画面滞后
    this.screenEngine?.requestFreshFrame('voice_start');

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
    this._ttsStreaming = false;
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

    // 构造发给大脑的本轮输入（含打断感知、本地 0ms 梗库命中、异步旁路工具、60分钟软提醒）
    const notes = [];
    if (this._lastInterruptedContext) {
      notes.push(this._lastInterruptedContext);
      this._lastInterruptedContext = '';
    }
    if (this._pendingSidecarNotes.length) {
      notes.push(...this._pendingSidecarNotes.splice(0));
    }
    const memeHit = lookupLocalMemeSync(text, this.memeKbPath);
    if (memeHit) {
      const reps = memeHit.replies.length ? memeHit.replies.join(' / ') : memeHit.meaning;
      notes.push(`[本地梗库命中「${memeHit.name}」：接梗下句参考=${reps}（对方是直接抛梗，请直接入戏接梗别科普）]`);
    }

    // 异步旁路工具：180ms 内完成的直接进本轮回答；超过 180ms 先零延迟过渡，查完后自动静默播报
    const sidecarTask = this.onSidecarTask
      ? detectSidecarTask(text, { defaultCity: this.defaultCity, localMemeHit: Boolean(memeHit) })
      : null;
    if (sidecarTask) {
      const scSeq = ++this._sidecarSeq;
      const scStart = Date.now();
      this.log(`[call-sidecar] 触发异步旁路(${sidecarTask.kind}): ${sidecarTask.query}`);
      const scPromise = Promise.resolve()
        .then(() => this.onSidecarTask(sidecarTask))
        .then((res) => String(res || '').trim())
        .catch((err) => {
          this.log(`[call-sidecar] 执行失败(${sidecarTask.kind}): ${err?.message ?? err}`);
          return '';
        });

      const fastRes = await Promise.race([
        scPromise,
        new Promise((r) => setTimeout(() => r(null), 180))
      ]);
      if (fastRes) {
        this.log(`[call-sidecar] 即时命中 (${Date.now() - scStart}ms): ${fastRes.slice(0, 80)}`);
        notes.push(`[后台工具已即时完成（${sidecarTask.label}）：${fastRes}（请自然简短地用口语回复结果）]`);
      } else if (fastRes === null) {
        notes.push(`[系统提示：后台正在查「${sidecarTask.label}」，1~2 秒就会回来；现在请先极简自然地过渡一句（如「等等啊我瞄一眼手机」），绝对不要自己瞎编结果]`);
        scPromise.then((lateRes) => {
          if (!lateRes) return;
          this.log(`[call-sidecar] 后台返回 (${Date.now() - scStart}ms): ${lateRes.slice(0, 100)}`);
          this._deliverSidecarResult(sidecarTask, lateRes, scSeq);
        });
      }
    }

    let screenImageParts = [];
    if (this.screenEngine) {
      const modeCmd = detectScreenModeCommand(text);
      if (modeCmd) {
        this.screenEngine.setMode(modeCmd.mode, 'voice_command');
        notes.push(`[系统提示：已按对方要求将看屏模式切换为「${modeCmd.label}」，请自然简短地答应一句]`);
      }
      const audioCmd = detectScreenAudioCommand(text);
      if (audioCmd) {
        this.screenEngine.setAudioEnabled(audioCmd.enabled, 'voice_command');
        notes.push(`[系统提示：已按对方要求${audioCmd.label}，请自然简短地答应一句]`);
      }
      // 若最新帧超过 0.9s，最多等 360ms 让刚触发的即时快照落地，确保看到此刻最新画面
      await this.screenEngine.waitForFreshFrame(360);
      const picked = this.screenEngine.pickFramesForTurn(text);
      if (picked.frameCount > 0) {
        screenImageParts = picked.imageParts;
        notes.push(picked.note);
        this.log(`[call-screen] 随轮附带 ${picked.frameCount} 帧实时画面 (${this.screenEngine.mode})`);
      }
      const audioCtx = this.screenEngine.getRecentAudioContext();
      if (audioCtx.note) {
        notes.push(audioCtx.note);
        this.log(`[call-screen] 随轮注入通道 2 屏幕台词 (${audioCtx.text.length}字)`);
      }
    }

    const elapsedMin = (Date.now() - this.startedAt) / 60000;
    if (!this._softReminderSent && elapsedMin >= this.softReminderMin) {
      this._softReminderSent = true;
      notes.push(`[提示：你们已经连续聊了约 ${Math.round(elapsedMin)} 分钟，可以在回复末尾自然随口提一句“不知不觉都聊了一个小时了诶”，但不要主动挂断]`);
    }

    const promptText = notes.length ? `${notes.join('\n')}\n对方说：${text}` : text;
    this._pendingUserUtterance = text;
    await this._runAiTurn(promptText, { vadEndAt, asrMs, userUtterance: text, imageParts: screenImageParts });
  }

  async handleWatchAlongCandidate({ frames, changeScore = 0, label = '' } = {}) {
    if (!this.active || this._ending || !this.screenEngine) return false;
    if (this.screenEngine.mode !== 'watch_along') return false;
    if (this._inSpeech || this._aiThinking || this._playQueueBytes > 0) return false;
    const idleMs = Date.now() - this._lastActivityAt;
    if (idleMs < 14000) return false;
    const imageParts = this.screenEngine.buildWatchAlongParts(frames);
    if (!imageParts.length) return false;
    const audioCtx = this.screenEngine.getRecentAudioContext();
    this.log(`[call-screen] 主动陪看检查 (Δ=${changeScore.toFixed(2)}, 静默=${Math.round(idleMs / 1000)}s, ${imageParts.length}帧${audioCtx.text ? `, 台词${audioCtx.text.length}字` : ''})…`);
    const promptLines = [
      `[主动陪看模式${label ? ` · ${label}` : ''}：你们正在一起看屏幕，画面刚发生了明显变化，且过去 ${Math.round(idleMs / 1000)} 秒没人说话。]`
    ];
    if (audioCtx.note) promptLines.push(audioCtx.note);
    promptLines.push('请先看清画面细节、字幕与刚才的屏幕台词：真有值得吐槽/夸一句/接茬的点就自然冒一句短话（≤22字）；如果画面平淡没啥好说的，严格只输出 [SILENT] 绝不硬凑话！');
    const spoken = await this._runAiTurn(promptLines.join('\n'), { vadEndAt: Date.now(), asrMs: 0, userUtterance: '', imageParts, silentIfToken: true, isWatchAlong: true });
    return Boolean(spoken);
  }

  async askFromScreenText(text) {
    if (!this.active || this._ending || !String(text || '').trim()) return '';
    const q = String(text).trim();
    const notes = [];
    let imageParts = [];
    if (this.screenEngine) {
      const audioCmd = detectScreenAudioCommand(q);
      if (audioCmd) this.screenEngine.setAudioEnabled(audioCmd.enabled, 'text_command');
      const picked = this.screenEngine.pickFramesForTurn(q, { force: true });
      if (picked.frameCount > 0) { imageParts = picked.imageParts; notes.push(picked.note); }
      const audioCtx = this.screenEngine.getRecentAudioContext();
      if (audioCtx.note) notes.push(audioCtx.note);
    }
    this.transcript.push({ role: 'user', text: q, ts: Date.now() });
    this._lastActivityAt = Date.now();
    const promptText = notes.length ? `${notes.join('\n')}\n对方在看屏窗口问：${q}` : q;
    return await this._runAiTurn(promptText, { vadEndAt: Date.now(), asrMs: 0, userUtterance: q, imageParts });
  }

  async _deliverSidecarResult(task, resultText, scSeq) {
    if (!this.active || this._ending || !resultText) return;
    const note = `[后台刚查到的真实结果（${task.label}）：${resultText}]`;
    this._pendingSidecarNotes.push(note);

    // 等待当前过渡句讲完且用户没有在开口说话（最多等 6 秒），若空闲则主动顺嘴播报
    const deadline = Date.now() + 6000;
    while (this.active && !this._ending && Date.now() < deadline) {
      if (this._inSpeech || scSeq !== this._sidecarSeq) return; // 用户在说话或已开启新任务，留给下一轮自然带出
      const idle = !this._aiThinking && this._playQueueBytes <= PCM24K_BYTES_PER_MS * 220;
      if (idle) break;
      await new Promise((r) => setTimeout(r, 120));
    }
    if (!this.active || this._ending || this._inSpeech || this._aiThinking || !this._pendingSidecarNotes.length) return;
    const batch = this._pendingSidecarNotes.splice(0).join('\n');
    await this._runAiTurn(
      `${batch}\n[提示：后台结果刚出来，现在自然简短地用一两句大白话把查到的内容告诉对方，不要复读“后台查到”]`,
      { vadEndAt: Date.now(), asrMs: 0, userUtterance: '' }
    );
  }

  async _runAiTurn(promptText, { isGreeting = false, vadEndAt = Date.now(), asrMs = 0, userUtterance = '', imageParts = [], silentIfToken = false, isWatchAlong = false } = {}) {
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

    if (this.enableFillers && !isGreeting && !isWatchAlong && userUtterance.length >= 4) {
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
      const contentBlocks = Array.isArray(imageParts) && imageParts.length
        ? [...imageParts, { type: 'text', text: promptText }]
        : [{ type: 'text', text: promptText }];
      const fullReply = await new Promise((resolve, reject) => {
        if (ac.signal.aborted) return resolve('');
        this.dshPendingTurn = { gotChunks: false, fullText: '', resolve, reject };
        this.dshApi.sessions.prompt({
          sessionId: this.dshSessionId,
          mode: 'queue',
          content: contentBlocks
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
        return '';
      }

      if (silentIfToken && /\[SILENT\]/i.test(fullReply)) {
        if (fillerTimer) clearTimeout(fillerTimer);
        if (mySeq === this._turnSeq) this._aiThinking = false;
        this.log(`[call-screen] 画面平淡，保持静默 (${llmMs}ms)`);
        return '';
      }

      const wantHangup = !isWatchAlong && (/\[HANGUP\]/i.test(fullReply) || (GOODBYE_RE.test(userUtterance) && AI_GOODBYE_RE.test(cleanSpokenText(fullReply))));
      const spoken = cleanSpokenText(fullReply);
      if (!spoken) {
        if (fillerTimer) clearTimeout(fillerTimer);
        if (mySeq === this._turnSeq) this._aiThinking = false;
        return '';
      }

      this._pendingUserUtterance = '';
      this.transcript.push({ role: 'assistant', text: spoken, ts: Date.now() });
      if (this.screenEngine && (imageParts.length || isWatchAlong)) {
        this.screenEngine.recordAiComment(spoken, isWatchAlong ? 'watch_along' : 'screen_reply');
      }
      const clauses = splitSpokenClauses(spoken);
      this._currentReplyText = spoken;
      this._playedBytesThisTurn = 0;
      this._totalQueuedBytesThisTurn = 0;

      // 整句 SSE 流式合成推入 1x 节拍队列，句间加 220ms 自然换气停顿
      this._ttsStreaming = true;
      const breathGap = Buffer.alloc(PCM24K_BYTES_PER_MS * 220);
      try {
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
      } finally {
        if (mySeq === this._turnSeq) this._ttsStreaming = false;
      }

      if (mySeq === this._turnSeq) {
        this._aiThinking = false;
        this._lastActivityAt = Date.now();
        if (wantHangup && !this._hangupTriggered) {
          this._hangupTriggered = true;
          const waitLeft = Math.max(800, Math.round(this._playQueueBytes / PCM24K_BYTES_PER_MS) + 600);
          this.log(`[call-engine] 对方道别，${waitLeft}ms 后自动挂断`);
          this._hangupTimer = setTimeout(() => {
            this._hangupTimer = null;
            if (this.active && !this._ending) this.onHangupRequest('farewell');
          }, waitLeft);
        }
      }
      return spoken;
    } catch (err) {
      if (fillerTimer) clearTimeout(fillerTimer);
      if (!ac.signal.aborted) {
        this.log(`[call-engine] 本轮对话异常: ${err?.message ?? err}`);
      }
      if (mySeq === this._turnSeq) this._aiThinking = false;
      return '';
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
    if (this._hangupTimer) { clearTimeout(this._hangupTimer); this._hangupTimer = null; }
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
