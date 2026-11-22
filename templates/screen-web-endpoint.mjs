/**
 * screen-web-endpoint.mjs — Endpoint B：物理三通道超清浏览器推屏端（画面 + 独立屏幕音轨 + 独立陪看）
 *
 * 设计亮点：
 *   - 挂载在任意本机 Node http.Server 上（默认与 qq-call.service 共用 127.0.0.1:3300，零新增常驻进程）
 *   - 严格仅绑定 127.0.0.1 + Token 鉴权，绝不暴露公网，画面与屏幕台词纯内存流转、绝不落盘
 *   - 物理三通道分离：
 *       · 通道 1（听你说话）：普通 QQ 语音通话入站（纯净麦克风，不勾设备音频，零误打断）
 *       · 通道 2（看屏幕 + 听屏幕声音）：本端 getDisplayMedia({ video, audio }) 推送 1080p 画面 + 16kHz 独立屏幕音频（二进制 WS 帧），服务端后台静默听译最近 45 秒台词
 *       · 通道 3（小鲸鲸说话）：普通 QQ 语音通话出站（零回声、免 LinuxQQ 软渲染、彻底不卡顿）
 *   - 同时支持未打 QQ 电话时的独立桌面陪看模式，及 HTTP API（/api/screen/{status,mode,frame,audio-text,ask}）
 */

import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { detectScreenModeCommand, detectScreenAudioCommand } from './screen-vision-engine.mjs';
import { ScreenAudioListener } from './screen-audio-listener.mjs';

const ROOT = '/opt/qq-bridge';

function cleanReply(raw) {
  return String(raw || '')
    .replace(/\[(?:HANGUP|SILENT)\]/gi, '')
    .replace(/[*_~`#>]/g, '')
    .replace(/[（(][^）)]{0,16}[）)]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 独立桌面看屏对话大脑（不依赖 QQ 通话，复用零工具 qq-call 预设 + deepseek-flash 原生看图）
 */
class StandaloneScreenCompanion {
  constructor({ dshBaseUrl, dshAuthToken, ttsUrl = 'http://127.0.0.1:3210', log = console.log }) {
    this.dshBaseUrl = dshBaseUrl || 'http://127.0.0.1:3080';
    this.dshAuthToken = dshAuthToken || '';
    this.ttsUrl = String(ttsUrl || 'http://127.0.0.1:3210').replace(/\/+$/, '');
    this.log = log;
    this.api = null;
    this.sid = null;
    this.busy = false;
    this.lastActivityAt = Date.now();
    this._streamAc = null;
    this._pending = null;
  }

  async _ensureSession() {
    if (this.api && this.sid) return;
    const { NodeApiClient } = await import(path.join(ROOT, 'src', 'dsh-client.js'));
    this.api = new NodeApiClient(this.dshBaseUrl, undefined, {
      token: this.dshAuthToken,
      tokenExplicit: Boolean(this.dshAuthToken)
    });
    await this.api.ensureAuth();
    const created = await this.api.callUnary('session/create', {
      title: `screen-companion-${new Date().toISOString().slice(11, 16)}`,
      agentPreset: 'qq-call',
      model: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'off' }
    });
    this.sid = created?.result?.value?.sessionId;
    if (!this.sid) throw new Error('创建独立看屏会话失败');
    this._streamAc = new AbortController();
    this._pump(this._streamAc.signal);
    this.api.events.follow(this.sid);
    await new Promise((r) => setTimeout(r, 200));
    this.log(`[screen-web] 独立多模态看屏会话就绪: ${this.sid}`);
  }

  _pump(signal) {
    (async () => {
      try {
        for await (const env of this.api.events.mux(undefined, signal)) {
          const f = env?.payload;
          if (!f || f.sessionId !== this.sid || f.type !== 'session/event') continue;
          const ev = f.event;
          const p = this._pending;
          if (!p) continue;
          if (ev.type === 'assistant/message') {
            const t = (ev.data?.message?.content || []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
            if (t) p.text = t;
          } else if (ev.type === 'turn/end') {
            this._pending = null;
            p.resolve(p.text);
          }
        }
      } catch {
        if (this._pending) {
          const p = this._pending;
          this._pending = null;
          p.resolve(p.text || '');
        }
      }
    })();
  }

  async ask(promptText, { imageParts = [], silentIfToken = false } = {}) {
    if (this.busy) return { text: '', silent: true, busy: true };
    this.busy = true;
    try {
      await this._ensureSession();
      const content = imageParts.length
        ? [...imageParts, { type: 'text', text: promptText }]
        : [{ type: 'text', text: promptText }];
      const t0 = Date.now();
      const raw = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending = null;
          this.api?.stopSessionWork(this.sid).catch(() => {});
          reject(new Error('看屏回复超时'));
        }, 25000);
        this._pending = {
          text: '',
          resolve: (val) => { clearTimeout(timer); resolve(val); },
          reject: (err) => { clearTimeout(timer); reject(err); }
        };
        this.api.sessions.prompt({ sessionId: this.sid, mode: 'queue', content }).then((r) => {
          if (!r?.result?.ok) {
            clearTimeout(timer);
            this._pending = null;
            reject(new Error(r?.result?.error?.message || 'prompt rejected'));
          }
        }).catch((err) => {
          clearTimeout(timer);
          this._pending = null;
          reject(err);
        });
      });
      const ms = Date.now() - t0;
      if (silentIfToken && /\[SILENT\]/i.test(raw)) {
        return { text: '', silent: true, ms };
      }
      const text = cleanReply(raw);
      if (text) this.lastActivityAt = Date.now();
      return { text, silent: !text, ms };
    } finally {
      this.busy = false;
    }
  }

  async synthesizeVoice(text) {
    const clean = cleanReply(text);
    if (!clean) return null;
    try {
      const res = await fetch(`${this.ttsUrl}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: clean.slice(0, 140), format: 'wav' }),
        signal: AbortSignal.timeout(15000)
      });
      const j = await res.json().catch(() => null);
      const wavPath = [j?.absPath, j?.file, j?.file ? path.join(ROOT, 'audio', j.file) : ''].find((p) => p && fs.existsSync(p));
      if (res.ok && j?.ok && wavPath) {
        const buf = fs.readFileSync(wavPath);
        return { mime: 'audio/wav', data: buf.toString('base64') };
      }
    } catch {}
    return null;
  }
}

function readBodyBuffer(req, maxBytes = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function renderWebConsoleHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>小鲸鲸 · 实时看屏陪聊台</title>
<style>
  :root { --bg:#0d1117; --card:#161b22; --line:#30363d; --text:#e6edf3; --muted:#8b949e; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --err:#f85149; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; padding:20px; }
  .wrap { max-width:980px; margin:0 auto; display:grid; grid-template-columns:1.15fr 1fr; gap:16px; }
  @media (max-width:820px){ .wrap{ grid-template-columns:1fr; } }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; }
  h1 { font-size:18px; margin:0 0 6px; display:flex; align-items:center; gap:8px; }
  .sub { font-size:12px; color:var(--muted); margin-bottom:14px; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:12px; }
  input[type=text], input[type=password], select { background:#0d1117; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 10px; font-size:13px; }
  button { background:#21262d; color:var(--text); border:1px solid var(--line); border-radius:8px; padding:8px 13px; font-size:13px; cursor:pointer; transition:.15s; }
  button:hover { border-color:var(--accent); }
  button.primary { background:#1f6feb; border-color:#388bfd; color:#fff; font-weight:600; }
  button.danger { background:#b62324; border-color:#f85149; color:#fff; }
  button.active { background:#1f6feb33; border-color:var(--accent); color:#79c0ff; }
  .pill { font-size:12px; padding:4px 9px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .pill.ok { color:var(--ok); border-color:#3fb95066; background:#3fb95015; }
  .pill.warn { color:var(--warn); border-color:#d2992266; background:#d2992215; }
  .previewBox { position:relative; background:#010409; border:1px solid var(--line); border-radius:10px; overflow:hidden; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center; }
  video { width:100%; height:100%; object-fit:contain; display:none; }
  .placeholder { color:var(--muted); font-size:13px; text-align:center; padding:16px; }
  .meter { height:6px; background:#21262d; border-radius:999px; overflow:hidden; margin-top:8px; }
  .meter > div { height:100%; width:0%; background:linear-gradient(90deg,#3fb950,#58a6ff,#f0883e); transition:width .18s; }
  .meter.audio > div { background:linear-gradient(90deg,#a371f7,#58a6ff,#3fb950); }
  .stats { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin-top:6px; }
  .subTicker { margin-top:10px; padding:8px 10px; background:#0d1117; border:1px solid var(--line); border-radius:8px; font-size:12px; color:#c9d1d9; line-height:1.45; min-height:38px; }
  .subTicker .tag { color:#a371f7; font-weight:600; margin-right:6px; }
  .chatBox { height:380px; overflow-y:auto; background:#0d1117; border:1px solid var(--line); border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px; }
  .msg { font-size:13px; line-height:1.55; padding:8px 11px; border-radius:10px; max-width:92%; }
  .msg.ai { background:#1f6feb22; border:1px solid #388bfd44; align-self:flex-start; }
  .msg.me { background:#21262d; border:1px solid var(--line); align-self:flex-end; }
  .msg.sys { font-size:12px; color:var(--muted); align-self:center; padding:3px 8px; border:none; background:transparent; }
  .askRow { display:flex; gap:8px; margin-top:10px; }
  .askRow input { flex:1; }
  label.chk { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:5px; cursor:pointer; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>🐳 小鲸鲸 · 物理三通道推屏端</h1>
    <div class="sub">通道 1 走普通 QQ 语音只听你说话 · 通道 2 本页独立传 1080p 画面与视频音频 · 零落盘</div>
    <div class="row">
      <input id="token" type="password" placeholder="粘贴 console-token" style="flex:1;min-width:150px" />
      <button id="btnConn" class="primary">连接</button>
      <span id="connPill" class="pill">未连接</span>
      <span id="callPill" class="pill">独立陪看模式</span>
    </div>
    <div class="row">
      <button id="btnShare" class="primary" disabled>选择屏幕 / 标签页</button>
      <button id="btnStop" class="danger" disabled>停止共享</button>
      <select id="resSel">
        <option value="960" selected>720p 极速零滞后（推荐）</option>
        <option value="1280">1080p 超清看卡牌小字</option>
      </select>
      <input id="labelInput" type="text" placeholder="标签(如 电影/游戏)" style="width:130px" />
    </div>
    <div class="row" style="justify-content:space-between">
      <label class="chk"><input id="wantAudioChk" type="checkbox" checked /> 同时采集屏幕/标签页独立音频（三通道）</label>
      <button id="btnToggleAudio" style="padding:4px 10px;font-size:12px" disabled>🔊 屏幕音轨：开</button>
    </div>
    <div class="row">
      <span style="font-size:12px;color:var(--muted)">模式：</span>
      <button class="modeBtn active" data-mode="on_demand">随问随看</button>
      <button class="modeBtn" data-mode="watch_along">主动陪看吐槽</button>
      <button class="modeBtn" data-mode="off">暂停看屏</button>
      <span id="audioPill" class="pill">音轨待机</span>
    </div>
    <div class="previewBox">
      <video id="vid" autoplay muted playsinline></video>
      <div id="ph" class="placeholder">点「选择屏幕 / 标签页」并在弹窗底部勾选「分享音频」即可开启物理三通道<br/>（画面与台词纯内存流转；建议戴耳机打普通 QQ 语音，彻底互不干扰）</div>
    </div>
    <div class="meter" title="画面帧变化幅度"><div id="diffBar"></div></div>
    <div class="meter audio" title="通道 2 屏幕独立音轨电平"><div id="audioBar"></div></div>
    <div class="stats">
      <span id="statLeft">待机</span>
      <span id="statRight">已推送 0 帧</span>
    </div>
    <div id="subTicker" class="subTicker"><span class="tag">🎬 通道 2 屏幕台词</span><span id="subText">等待屏幕音频输入（仅作背景记忆，绝不打断你或小鲸鲸）</span></div>
  </div>

  <div class="card">
    <h1>💬 陪看互动与吐槽流</h1>
    <div class="sub">QQ 语音通话中直接开口聊即可；没打电话也能在这儿问她，勾上语音可直接发声</div>
    <div id="chat" class="chatBox"></div>
    <div class="askRow">
      <input id="askInput" type="text" placeholder="问点啥：比如「刚才他说啥来着」「这手牌怎么打」…" />
      <button id="btnAsk" class="primary">发送</button>
    </div>
    <div class="row" style="margin-top:8px;margin-bottom:0;justify-content:space-between">
      <label class="chk"><input id="ttsChk" type="checkbox" checked /> 独立模式下同步播报小鲸鲸语音</label>
      <button id="btnClearLog" style="padding:4px 9px;font-size:12px">清屏</button>
    </div>
  </div>
</div>
<canvas id="capCanvas" style="display:none"></canvas>
<canvas id="diffCanvas" width="16" height="9" style="display:none"></canvas>
<script>
const $ = (id) => document.getElementById(id);
const qsToken = new URLSearchParams(location.search).get('token') || '';
if (qsToken) sessionStorage.setItem('screen_token', qsToken);
$('token').value = sessionStorage.getItem('screen_token') || '';

let ws = null, stream = null, bgTimer = null, imgCap = null, capBusy = false, prevGrid = null, sentCount = 0, lastPushAt = 0;
let curMode = 'on_demand', audioEnabled = true, hasAudioTrack = false;
let audioCtx = null, audioSrc = null, audioProc = null, zeroGain = null;
let resamplePos = 0, pcmPending = [], pcmPendingLen = 0;
const capC = $('capCanvas'), capCtx = capC.getContext('2d');
const diffC = $('diffCanvas'), diffCtx = diffC.getContext('2d');

function addMsg(role, text) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  $('chat').appendChild(d);
  $('chat').scrollTop = $('chat').scrollHeight;
}
function playWavBase64(b64) {
  try {
    const a = new Audio('data:audio/wav;base64,' + b64);
    a.play().catch(() => {});
  } catch {}
}
function setModeUi(m) {
  curMode = m;
  document.querySelectorAll('.modeBtn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
}
function setAudioUi(enabled) {
  audioEnabled = Boolean(enabled);
  $('btnToggleAudio').textContent = audioEnabled ? '🔊 屏幕音轨：开' : '🔇 屏幕音轨：关';
  if (!hasAudioTrack) {
    $('audioPill').textContent = '音轨待机';
    $('audioPill').className = 'pill';
  } else if (audioEnabled) {
    $('audioPill').textContent = '🎬 通道 2 听译中';
    $('audioPill').className = 'pill ok';
  } else {
    $('audioPill').textContent = '🔇 通道 2 已静音';
    $('audioPill').className = 'pill warn';
  }
}
function teardownAudioPipeline() {
  hasAudioTrack = false;
  pcmPending = []; pcmPendingLen = 0; resamplePos = 0;
  if (audioProc) { try { audioProc.disconnect(); } catch {} audioProc = null; }
  if (audioSrc) { try { audioSrc.disconnect(); } catch {} audioSrc = null; }
  if (zeroGain) { try { zeroGain.disconnect(); } catch {} zeroGain = null; }
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
  $('audioBar').style.width = '0%';
  $('btnToggleAudio').disabled = true;
  setAudioUi(audioEnabled);
}
function startAudioPipeline(mediaStream, surface) {
  teardownAudioPipeline();
  const tracks = mediaStream.getAudioTracks();
  if (!tracks.length) return false;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return false;
  hasAudioTrack = true;
  audioCtx = new AudioCtor();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  const audioOnlyStream = new MediaStream(tracks);
  audioSrc = audioCtx.createMediaStreamSource(audioOnlyStream);
  audioProc = audioCtx.createScriptProcessor(4096, 1, 1);
  zeroGain = audioCtx.createGain();
  zeroGain.gain.value = 0;
  const ratio = audioCtx.sampleRate / 16000;
  const TARGET_SAMPLES = 1600; // 100ms @ 16kHz

  audioProc.onaudioprocess = (ev) => {
    if (!ws || ws.readyState !== 1 || !audioEnabled || curMode === 'off') {
      $('audioBar').style.width = '0%';
      return;
    }
    const input = ev.inputBuffer.getChannelData(0);
    // 计算实时电平显示
    let sq = 0;
    for (let i = 0; i < input.length; i += 4) sq += input[i] * input[i];
    const rmsNorm = Math.sqrt(sq / Math.max(1, input.length / 4));
    $('audioBar').style.width = Math.min(100, Math.round(rmsNorm * 380)) + '%';

    // 线性重采样至 16kHz Int16LE
    const out = [];
    let pos = resamplePos;
    while (pos < input.length) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = input[idx] || 0;
      const s1 = input[Math.min(idx + 1, input.length - 1)] || s0;
      const v = Math.max(-1, Math.min(1, s0 + (s1 - s0) * frac));
      out.push(v < 0 ? Math.round(v * 32768) : Math.round(v * 32767));
      pos += ratio;
    }
    resamplePos = pos - input.length;
    if (!out.length) return;
    pcmPending.push(out);
    pcmPendingLen += out.length;

    if (pcmPendingLen >= TARGET_SAMPLES) {
      const merged = new Int16Array(pcmPendingLen);
      let off = 0;
      for (const arr of pcmPending) { merged.set(arr, off); off += arr.length; }
      pcmPending = []; pcmPendingLen = 0;
      if (ws.bufferedAmount < 64000) {
        try { ws.send(merged.buffer); } catch {}
      }
    }
  };

  audioSrc.connect(audioProc);
  audioProc.connect(zeroGain);
  zeroGain.connect(audioCtx.destination);
  tracks[0].onended = () => {
    teardownAudioPipeline();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'audio_meta', active: false }));
  };
  $('btnToggleAudio').disabled = false;
  setAudioUi(audioEnabled);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'audio_meta', active: true, surface }));
  }
  return true;
}

function connectWs() {
  const tok = $('token').value.trim();
  if (!tok) { alert('请先输入 console-token'); return; }
  sessionStorage.setItem('screen_token', tok);
  if (ws) try { ws.close(); } catch {}
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws/screen?token=' + encodeURIComponent(tok));
  ws.onopen = () => {
    $('connPill').textContent = '已连接'; $('connPill').className = 'pill ok';
    $('btnShare').disabled = false;
    addMsg('sys', '已连接到物理三通道实时看屏核心引擎');
  };
  ws.onclose = (ev) => {
    $('connPill').textContent = ev.code === 4401 ? 'Token 错误' : '已断开';
    $('connPill').className = 'pill warn';
    $('btnShare').disabled = true;
    stopShare();
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'status') {
      if (msg.mode) setModeUi(msg.mode);
      if (msg.screen && msg.screen.audio && typeof msg.screen.audio.enabled === 'boolean') {
        setAudioUi(msg.screen.audio.enabled);
      }
      if (msg.callState === 'in_call') {
        $('callPill').textContent = '🎙️ 已融合 QQ 语音（三通道）'; $('callPill').className = 'pill ok';
      } else {
        $('callPill').textContent = '💬 独立桌面陪看模式'; $('callPill').className = 'pill';
      }
    } else if (msg.type === 'snap_now') {
      captureAndPush(true);
    } else if (msg.type === 'screen_audio') {
      const prefix = msg.isFinal ? '' : '… ';
      $('subText').textContent = prefix + (msg.text || '');
    } else if (msg.type === 'reply') {
      addMsg('ai', '🐳 ' + msg.text + (msg.ms ? '  (' + msg.ms + 'ms)' : ''));
      if (msg.audio && msg.audio.data) playWavBase64(msg.audio.data);
    } else if (msg.type === 'event' && msg.event) {
      if (msg.event.kind === 'watch_along') addMsg('ai', '🐳 [主动吐槽] ' + msg.event.text);
      else if (msg.event.kind === 'screen_reply') addMsg('ai', '🐳 [通话看屏] ' + msg.event.text);
      else addMsg('sys', msg.event.text);
    }
  };
}

async function startShare() {
  try {
    const wantAudio = $('wantAudioChk').checked;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 2 },
        audio: wantAudio ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false
      });
    } catch (firstErr) {
      if (wantAudio && (firstErr?.name === 'TypeError' || firstErr?.name === 'OverconstrainedError')) {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: true });
      } else {
        throw firstErr;
      }
    }
    $('vid').srcObject = stream; $('vid').style.display = 'block'; $('ph').style.display = 'none';
    $('btnStop').disabled = false; $('btnShare').disabled = true;
    prevGrid = null; sentCount = 0; lastPushAt = 0;
    const vTrack = stream.getVideoTracks()[0];
    const surface = vTrack?.getSettings?.()?.displaySurface || 'unknown';
    vTrack.onended = () => stopShare();
    imgCap = (typeof ImageCapture !== 'undefined') ? new ImageCapture(vTrack) : null;
    bgTimer = createBgTimer(() => captureAndPush(false), 1400);
    setTimeout(() => captureAndPush(true), 250);

    const gotAudio = wantAudio && startAudioPipeline(stream, surface);
    if (gotAudio) {
      const surfLabel = surface === 'browser' ? '标签页独立音频（完全隔离）' : '系统音频（AI 说话时自动静音防回声）';
      addMsg('sys', '已开启物理三通道：实时低延迟画面 + 通道 2 ' + surfLabel);
      $('subText').textContent = '通道 2 已接通，正在静默等待视频/游戏台词…';
    } else if (wantAudio) {
      addMsg('sys', '已开始共享画面（未捕获到音频轨；若要让小鲸鲸听视频台词，重新共享时记得勾选浏览器弹窗底部的「分享音频」）');
    } else {
      addMsg('sys', '已开始共享纯画面（未开启屏幕音频）');
    }
  } catch (e) {
    addMsg('sys', '取消或无法捕获屏幕：' + e.message);
  }
}

function createBgTimer(fn, ms) {
  try {
    const blob = new Blob(['let t=setInterval(()=>postMessage(1),' + ms + ');onmessage=()=>clearInterval(t);'], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    w.onmessage = () => fn();
    return { stop() { try { w.postMessage(0); w.terminate(); } catch {} URL.revokeObjectURL(url); } };
  } catch {
    const id = setInterval(fn, ms);
    return { stop() { clearInterval(id); } };
  }
}

async function grabLiveFrame() {
  const track = stream && stream.getVideoTracks ? stream.getVideoTracks()[0] : null;
  if (track && track.readyState === 'live' && typeof ImageCapture !== 'undefined') {
    try {
      if (!imgCap || imgCap.track !== track) imgCap = new ImageCapture(track);
      const bmp = await imgCap.grabFrame();
      return { src: bmp, w: bmp.width, h: bmp.height, close: () => { try { bmp.close(); } catch {} } };
    } catch {}
  }
  const v = $('vid');
  if (!v.videoWidth || !v.videoHeight) return null;
  return { src: v, w: v.videoWidth, h: v.videoHeight, close: () => {} };
}

function stopShare() {
  if (bgTimer) { bgTimer.stop(); bgTimer = null; }
  imgCap = null; capBusy = false;
  teardownAudioPipeline();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  $('vid').srcObject = null; $('vid').style.display = 'none'; $('ph').style.display = 'block';
  $('btnStop').disabled = true;
  if (ws && ws.readyState === 1) {
    $('btnShare').disabled = false;
    ws.send(JSON.stringify({ type: 'stop_share' }));
  }
  $('statLeft').textContent = '已停止共享';
  $('subText').textContent = '已停止共享并清空内存台词缓存';
}

async function captureAndPush(forceSnap = false) {
  if (capBusy || !stream || !ws || ws.readyState !== 1 || curMode === 'off') return;
  // 严格防积压背压保护：若上一帧还没发完，直接跳过中间帧，绝不让旧画面在 WS 缓冲里越积越滞后！
  if (!forceSnap && ws.bufferedAmount > 32768) {
    $('statLeft').textContent = '网络发包中，跳过中间帧防滞后 (' + Math.round(ws.bufferedAmount / 1024) + 'KB)';
    return;
  }
  if (forceSnap && ws.bufferedAmount > 131072) return;
  capBusy = true;
  let grabbed = null;
  try {
    grabbed = await grabLiveFrame();
    if (!grabbed) return;
    // 1. 计算 16x9 灰度网格与精确帧差
    diffCtx.drawImage(grabbed.src, 0, 0, 16, 9);
    const px = diffCtx.getImageData(0, 0, 16, 9).data;
    const grid = [];
    for (let i = 0; i < px.length; i += 4) grid.push(Math.round(px[i]*0.299 + px[i+1]*0.587 + px[i+2]*0.114));
    let diff = 1;
    if (prevGrid) {
      let s = 0;
      for (let i = 0; i < grid.length; i++) s += Math.abs(grid[i] - prevGrid[i]);
      diff = Math.min(1, s / (grid.length * 255));
    }
    $('diffBar').style.width = Math.min(100, Math.round(diff * 320)) + '%';
    const now = Date.now();
    // 画面几乎静止时每 8 秒才推 1 帧保活；若是服务端 snap_now 立即强制抓取
    if (!forceSnap && prevGrid && diff < 0.025 && now - lastPushAt < 8000) {
      $('statLeft').textContent = '画面静止，省流待机 (Δ=' + diff.toFixed(3) + ')';
      return;
    }
    prevGrid = grid; lastPushAt = now;
    const maxW = Number($('resSel').value) || 960;
    const scale = Math.min(1, maxW / grabbed.w);
    const w = Math.round(grabbed.w * scale), h = Math.round(grabbed.h * scale);
    capC.width = w; capC.height = h;
    capCtx.drawImage(grabbed.src, 0, 0, w, h);
    const q = maxW <= 960 ? 0.62 : 0.68;
    const dataUrl = capC.toDataURL('image/jpeg', q);
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const kb = Math.round((b64.length * 3) / 4096);
    ws.send(JSON.stringify({
      type: 'frame', data: b64, changeScore: Number(diff.toFixed(3)), lumaGrid: grid,
      width: w, height: h, capturedAt: now, force: Boolean(forceSnap),
      label: $('labelInput').value.trim() || '桌面窗口'
    }));
    sentCount++;
    $('statLeft').textContent = (forceSnap ? '⚡即时抓取 ' : '推送中 ') + w + 'x' + h + ' · ' + kb + 'KB (Δ=' + diff.toFixed(3) + ')';
    $('statRight').textContent = '已推送 ' + sentCount + ' 帧';
  } finally {
    if (grabbed) grabbed.close();
    capBusy = false;
  }
}

function sendAsk() {
  const txt = $('askInput').value.trim();
  if (!txt || !ws || ws.readyState !== 1) return;
  $('askInput').value = '';
  addMsg('me', txt);
  ws.send(JSON.stringify({ type: 'ask', text: txt, tts: $('ttsChk').checked }));
}

$('btnConn').onclick = connectWs;
$('btnShare').onclick = startShare;
$('btnStop').onclick = stopShare;
$('btnAsk').onclick = sendAsk;
$('btnClearLog').onclick = () => { $('chat').innerHTML = ''; };
$('btnToggleAudio').onclick = () => {
  const next = !audioEnabled;
  setAudioUi(next);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set_audio', enabled: next }));
};
$('askInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAsk(); });
document.querySelectorAll('.modeBtn').forEach(b => b.onclick = () => {
  const m = b.dataset.mode;
  setModeUi(m);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set_mode', mode: m }));
});
if ($('token').value.trim()) connectWs();
</script>
</body>
</html>`;
}

/**
 * 将 Endpoint B（独立浏览器推屏端 + HTTP/WS API）挂载到本机 http.Server
 */
export function attachScreenWebEndpoint(httpServer, {
  screenEngine,
  getCallEngine = () => null,
  getCallState = () => 'idle',
  getToken = () => '',
  dashscopeKeyFile = '/opt/qq-tts/apikey.txt',
  dshBaseUrl = 'http://127.0.0.1:3080',
  dshAuthToken = '',
  ttsUrl = 'http://127.0.0.1:3210',
  log = console.log
}) {
  const companion = new StandaloneScreenCompanion({ dshBaseUrl, dshAuthToken, ttsUrl, log });
  const audioListener = new ScreenAudioListener({
    screenEngine,
    dashscopeKeyFile,
    isAiSpeaking: () => Boolean(getCallEngine()?._isActuallySpeakingNow()),
    log
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });
  const clients = new Set();

  const authOk = (req, urlObj) => {
    const expected = String(getToken() || '').trim();
    if (!expected) return true;
    const provided = String(
      urlObj.searchParams.get('token') ||
      req.headers['x-screen-token'] ||
      req.headers['x-console-token'] ||
      ''
    ).trim();
    return provided === expected;
  };

  const broadcast = (payload) => {
    const raw = JSON.stringify(payload);
    for (const c of clients) {
      if (c.readyState === 1) {
        try { c.send(raw); } catch {}
      }
    }
  };

  // 当网页控制台在线时，监测 QQ 通话状态变化（如接通/挂断）并实时同步给前端状态徽章
  let lastBroadcastCallState = getCallState();
  const statusSyncTimer = setInterval(() => {
    if (!clients.size) return;
    const cur = getCallState();
    if (cur !== lastBroadcastCallState) {
      lastBroadcastCallState = cur;
      broadcast({ type: 'status', mode: screenEngine.mode, callState: cur, screen: screenEngine.getStatus() });
    }
  }, 2000);
  statusSyncTimer.unref?.();

  // 将引擎活动、模式与通道 2 屏幕台词变化实时广播给所有已连接控制台
  const prevOnMode = screenEngine.onModeChange;
  screenEngine.onModeChange = (mode, reason) => {
    prevOnMode?.(mode, reason);
    if (mode === 'off') audioListener.stop('mode_off');
    broadcast({ type: 'status', mode, callState: getCallState(), screen: screenEngine.getStatus() });
  };
  const prevOnAudio = screenEngine.onAudioChange;
  screenEngine.onAudioChange = (enabled, reason) => {
    prevOnAudio?.(enabled, reason);
    if (!enabled) audioListener.stop('audio_off');
    broadcast({ type: 'status', mode: screenEngine.mode, callState: getCallState(), screen: screenEngine.getStatus() });
  };
  const prevOnAudioTx = screenEngine.onAudioTranscript;
  screenEngine.onAudioTranscript = (ev) => {
    prevOnAudioTx?.(ev);
    broadcast({ type: 'screen_audio', text: ev.text, isFinal: ev.isFinal, ts: ev.ts });
  };
  const prevOnAct = screenEngine.onActivity;
  screenEngine.onActivity = (ev) => {
    prevOnAct?.(ev);
    broadcast({ type: 'event', event: ev });
  };
  const prevOnSnapReq = screenEngine.onRequestFreshFrame;
  screenEngine.onRequestFreshFrame = (reason) => {
    prevOnSnapReq?.(reason);
    if (clients.size) broadcast({ type: 'snap_now', reason });
  };

  // 独立模式下的主动陪看吐槽处理（通话中交给 callEngine，未通话时由独立大脑接管）
  screenEngine.onWatchCandidate = async (cand) => {
    const callEng = getCallEngine();
    if (callEng && callEng.active) {
      await callEng.handleWatchAlongCandidate(cand);
      return;
    }
    if (!clients.size) return;
    if (Date.now() - companion.lastActivityAt < 14000) return;
    const imageParts = screenEngine.buildWatchAlongParts(cand.frames);
    if (!imageParts.length) return;
    const audioCtx = screenEngine.getRecentAudioContext();
    const promptLines = [
      `[独立主动陪看模式${cand.label ? ` · ${cand.label}` : ''}：对方正在共享屏幕，画面刚发生明显变化。]`
    ];
    if (audioCtx.note) promptLines.push(audioCtx.note);
    promptLines.push('如果画面或刚才的屏幕台词里有真值得吐槽、夸一句或惊叹的细节（搞笑字幕、剧情反转、游戏翻车或神操作），用一句极短自然口语冒出来（≤24字）；画面平淡没啥好说的严格只输出 [SILENT]。');
    const res = await companion.ask(promptLines.join('\n'), { imageParts, silentIfToken: true }).catch(() => null);
    if (res && !res.silent && res.text) {
      screenEngine.recordAiComment(res.text, 'watch_along');
      const audio = await companion.synthesizeVoice(res.text);
      broadcast({ type: 'reply', text: res.text, ms: res.ms, audio, proactive: true });
    }
  };

  // 1. WebSocket Upgrade 处理
  httpServer.on('upgrade', (req, socket, head) => {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    if (urlObj.pathname !== '/ws/screen') return;
    if (!authOk(req, urlObj)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    lastBroadcastCallState = getCallState();
    ws.send(JSON.stringify({ type: 'status', mode: screenEngine.mode, callState: lastBroadcastCallState, screen: screenEngine.getStatus() }));

    ws.on('message', async (raw, isBinary) => {
      // 二进制帧：通道 2 屏幕独立音轨（16kHz Int16LE 单声道 PCM），零 JSON/Base64 开销
      if (isBinary) {
        const pcmBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        audioListener.pushPcm16k(pcmBuf);
        return;
      }

      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'frame' && msg.data) {
        const buf = Buffer.from(String(msg.data), 'base64');
        screenEngine.pushFrame(buf, {
          source: 'web-direct',
          changeScore: msg.changeScore,
          lumaGrid: msg.lumaGrid,
          width: msg.width,
          height: msg.height,
          capturedAt: msg.capturedAt,
          force: Boolean(msg.force),
          label: msg.label || '桌面窗口'
        });
      } else if (msg.type === 'audio_meta') {
        if (msg.surface) audioListener.setSurface(msg.surface);
        if (msg.active === false) audioListener.stop('client_audio_off');
      } else if (msg.type === 'set_audio') {
        screenEngine.setAudioEnabled(msg.enabled, 'web_ui');
      } else if (msg.type === 'set_mode') {
        screenEngine.setMode(msg.mode, 'web_ui');
      } else if (msg.type === 'stop_share') {
        audioListener.stop('web_stop');
        if (screenEngine.getLatestFrame()?.source === 'web-direct') screenEngine.clear('web_stop');
        else screenEngine.clearAudio('web_stop');
      } else if (msg.type === 'ask' && msg.text) {
        const q = String(msg.text).trim();
        const modeCmd = detectScreenModeCommand(q);
        if (modeCmd) screenEngine.setMode(modeCmd.mode, 'text_command');
        const audioCmd = detectScreenAudioCommand(q);
        if (audioCmd) screenEngine.setAudioEnabled(audioCmd.enabled, 'text_command');

        const callEng = getCallEngine();
        if (callEng && callEng.active) {
          const reply = await callEng.askFromScreenText(q).catch(() => '');
          if (reply) ws.send(JSON.stringify({ type: 'reply', text: reply, fusedWithCall: true }));
          return;
        }
        const picked = screenEngine.pickFramesForTurn(q, { force: true });
        const audioCtx = screenEngine.getRecentAudioContext();
        const promptParts = [];
        if (picked.note) promptParts.push(picked.note);
        if (audioCtx.note) promptParts.push(audioCtx.note);
        promptParts.push(`对方问：${q}`);
        const res = await companion.ask(promptParts.join('\n'), { imageParts: picked.imageParts }).catch((err) => ({ text: `看屏出错了：${err.message}`, ms: 0 }));
        if (res?.text) {
          screenEngine.recordAiComment(res.text, 'reply');
          const audio = msg.tts ? await companion.synthesizeVoice(res.text) : null;
          ws.send(JSON.stringify({ type: 'reply', text: res.text, ms: res.ms, audio }));
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      if (!clients.size) {
        audioListener.stop('web_disconnect');
        if (screenEngine.getLatestFrame()?.source === 'web-direct') {
          screenEngine.clear('web_disconnect');
        } else {
          screenEngine.clearAudio('web_disconnect');
        }
      }
    });
  });

  // 2. 返回 HTTP 路由处理函数供主 server 挂载
  return async function handleScreenHttp(req, res) {
    const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && urlObj.pathname === '/screen') {
      const html = renderWebConsoleHtml();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return true;
    }
    if (urlObj.pathname.startsWith('/api/screen/')) {
      if (!authOk(req, urlObj)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return true;
      }
      if (req.method === 'GET' && urlObj.pathname === '/api/screen/status') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, callState: getCallState(), webClients: clients.size, screen: screenEngine.getStatus() }));
        return true;
      }
      if (req.method === 'POST' && urlObj.pathname === '/api/screen/mode') {
        const body = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}');
        const mode = body.mode ? screenEngine.setMode(body.mode, 'http_api') : screenEngine.mode;
        if (typeof body.audioEnabled === 'boolean') screenEngine.setAudioEnabled(body.audioEnabled, 'http_api');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, mode, audioEnabled: screenEngine.audioEnabled }));
        return true;
      }
      if (req.method === 'POST' && urlObj.pathname === '/api/screen/audio-text') {
        const body = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}');
        const accepted = screenEngine.pushAudioTranscript(body.text, {
          isFinal: body.isFinal !== false,
          source: String(body.source || 'http-audio-text')
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, accepted, audio: screenEngine.getStatus().audio }));
        return true;
      }
      if (req.method === 'POST' && urlObj.pathname === '/api/screen/frame') {
        const rawBuf = await readBodyBuffer(req);
        const ct = String(req.headers['content-type'] || '');
        let jpegBuf = rawBuf;
        let rawLabel = String(req.headers['x-screen-label'] || '桌面');
        try { rawLabel = decodeURIComponent(rawLabel); } catch {}
        let meta = { source: String(req.headers['x-screen-source'] || 'http-push'), label: rawLabel };
        if (ct.includes('application/json')) {
          const j = JSON.parse(rawBuf.toString('utf8') || '{}');
          jpegBuf = Buffer.from(String(j.data || ''), 'base64');
          meta = { ...meta, ...j };
        }
        const r = screenEngine.pushFrame(jpegBuf, meta);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ...r }));
        return true;
      }
      if (req.method === 'POST' && urlObj.pathname === '/api/screen/ask') {
        const body = JSON.parse((await readBodyBuffer(req)).toString('utf8') || '{}');
        const q = String(body.text || '').trim();
        if (!q) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'missing text' })); return true; }
        const callEng = getCallEngine();
        if (callEng && callEng.active) {
          const reply = await callEng.askFromScreenText(q);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, fusedWithCall: true, text: reply }));
          return true;
        }
        const picked = screenEngine.pickFramesForTurn(q, { force: true });
        const audioCtx = screenEngine.getRecentAudioContext();
        const promptParts = [];
        if (picked.note) promptParts.push(picked.note);
        if (audioCtx.note) promptParts.push(audioCtx.note);
        promptParts.push(`对方问：${q}`);
        const ans = await companion.ask(promptParts.join('\n'), { imageParts: picked.imageParts });
        if (ans.text) screenEngine.recordAiComment(ans.text, 'reply');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, frameCount: picked.frameCount, audioChars: audioCtx.text.length, ...ans }));
        return true;
      }
    }
    return false;
  };
}
