/**
 * qq-call-adapter.mjs — QQ 原生语音通话接入适配器与守护服务（ESM）
 *
 * 职责边界（与 call-engine.mjs 彻底解耦）：
 *   1. 确保 snowluma 容器内 PulseAudio 虚拟声卡（qq_spk / ai_mic）在线
 *   2. 轮询 X11 检测好友语音来电窗口（360x640），通过双层白名单校验（仅好友、拒绝群通话与陌生人）
 *   3. 模拟真人延迟 1.5–2.8s 点击接听，桥接 parec(qq_spk.monitor) 与 pacat(ai_mic_sink)
 *   4. 打断时瞬杀重拉 pacat 立即清缓冲；通话结束或主动挂断时清理并将摘要写回 qq-bridge
 *   5. 提供本地状态接口 http://127.0.0.1:3300/health
 */

import fs from 'node:fs';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RealtimeCallEngine } from './call-engine.mjs';
import { fetchCityWeather } from './weather-solar.mjs';
import { lookupMeme } from './surf-kb.mjs';
import { serperGoogleSearch } from './reverse-image.mjs';
import { ScreenVisionEngine } from './screen-vision-engine.mjs';
import { attachScreenWebEndpoint } from './screen-web-endpoint.mjs';
import { QQScreenShareAdapter } from './qq-screen-adapter.mjs';

const execFileAsync = promisify(execFile);

const BRIDGE_CONFIG_PATH = process.env.QQ_BRIDGE_CONFIG || '/opt/qq-bridge/config.json';
const CONSOLE_TOKEN_PATH = '/opt/qq-bridge/state/console-token';
const DASHSCOPE_KEY_PATH = '/opt/qq-tts/apikey.txt';
const CONTAINER_NAME = process.env.SNOWLUMA_CONTAINER || 'snowluma';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_PATH, 'utf8'));
  const call = raw.call || {};
  return {
    raw,
    enabled: call.enabled !== false,
    whitelist: Array.isArray(call.whitelist) ? call.whitelist.map(String).filter(Boolean) : [],
    allowGroupCall: call.allowGroupCall === true,
    softReminderMin: Number(call.softReminderMin ?? 60),
    dailyLimitMin: Number(call.dailyLimitMin ?? 180),
    silenceAskSec: Number(call.silenceAskSec ?? 120),
    silenceHangupSec: Number(call.silenceHangupSec ?? 150),
    port: Number(call.port ?? 3300),
    bridgeBase: `http://127.0.0.1:${Number(raw.consolePort || raw.console?.port || 3100)}`,
    defaultCity: String(raw.life?.weatherCity || '').trim(),
    dshBaseUrl: raw.dsh?.baseUrl || 'http://127.0.0.1:3080',
    dshAuthToken: raw.dsh?.authToken || '',
    onebotHttp: `http://127.0.0.1:${Number(raw.snowluma?.httpPort || 3000)}`,
    onebotToken: raw.snowluma?.token || ''
  };
}

function readConsoleToken() {
  try { return fs.readFileSync(CONSOLE_TOKEN_PATH, 'utf8').trim(); } catch { return ''; }
}

function readDashscopeKey() {
  try { return fs.readFileSync(DASHSCOPE_KEY_PATH, 'utf8').trim(); } catch { return ''; }
}

async function dockerExec(cmd, timeoutMs = 8000) {
  const { stdout } = await execFileAsync('docker', ['exec', CONTAINER_NAME, 'sh', '-c', cmd], {
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024
  });
  return stdout;
}

async function ensurePulseAudio() {
  try {
    const out = await dockerExec('su -s /bin/sh node -c "export HOME=/app XDG_RUNTIME_DIR=/tmp/runtime-1000; pactl info 2>/dev/null | grep -E \'Default Sink|Default Source\'"');
    if (out.includes('qq_spk') && out.includes('ai_mic')) return true;
  } catch {}
  log('[call-adapter] 正在拉起容器内 PulseAudio 虚拟声卡...');
  await dockerExec('su -s /bin/sh node -c "export HOME=/app XDG_RUNTIME_DIR=/tmp/runtime-1000; pulseaudio --check 2>/dev/null || pulseaudio --daemonize=yes --exit-idle-time=-1 --disallow-exit -n -F /etc/pulse/qq-call.pa --log-target=file:/tmp/pulseaudio.log"');
  await sleep(800);
  return true;
}

async function fetchFriendWhitelistMap(cfg) {
  const map = new Map(); // uin -> { uin, names: Set<string> }
  for (const uin of cfg.whitelist) {
    map.set(uin, { uin, names: new Set([uin]) });
  }
  // 1) 从 SnowLuma OneBot 获取好友列表（昵称 + 备注）
  try {
    const headers = { 'content-type': 'application/json' };
    if (cfg.onebotToken) headers.authorization = `Bearer ${cfg.onebotToken}`;
    const res = await fetch(`${cfg.onebotHttp}/get_friend_list`, {
      method: 'POST',
      headers,
      body: '{}',
      signal: AbortSignal.timeout(5000)
    });
    const j = await res.json().catch(() => null);
    const list = Array.isArray(j?.data) ? j.data : [];
    for (const f of list) {
      const u = String(f.user_id || f.uin || '');
      if (!map.has(u)) continue;
      if (f.remark) map.get(u).names.add(String(f.remark).trim());
      if (f.nickname) map.get(u).names.add(String(f.nickname).trim());
    }
  } catch {}
  // 2) 从 qq-bridge state/social-v2.json 补充真实昵称（过滤通用占位词）
  const IGNORE_NAMES = new Set(['管理员', '私聊', '群聊', '我', '对方', '用户', '自己', 'unknown']);
  try {
    const st = JSON.parse(fs.readFileSync('/opt/qq-bridge/state/social-v2.json', 'utf8'));
    for (const u of cfg.whitelist) {
      const conv = st?.conversations?.[`private:${u}`];
      if (!conv) continue;
      for (const m of (conv.recentMessages || conv.messages || []).slice(-10)) {
        const s = String(m.sender || '').trim();
        if (String(m.userId || '') === u && s && !IGNORE_NAMES.has(s)) map.get(u).names.add(s);
      }
      for (const k of Object.keys(conv.memberImpressions || {})) {
        const s = String(k || '').trim();
        if (s && !IGNORE_NAMES.has(s)) map.get(u).names.add(s);
      }
    }
  } catch {}
  return map;
}

/**
 * 扫描 X11 是否存在 360x640 的 QQ 语音通话窗口
 */
async function findCallWindow() {
  try {
    const out = await dockerExec('DISPLAY=:1 xwininfo -root -tree 2>/dev/null | grep -E "360x640\\+0\\+0" | grep \'"QQ"\' | head -n 1');
    const line = out.trim();
    if (!line) return null;
    const wid = line.split(/\s+/)[0];
    const m = line.match(/\+(\d+)\+(\d+)$/);
    return {
      wid,
      x: m ? Number(m[1]) : 780,
      y: m ? Number(m[2]) : 210
    };
  } catch {
    return null;
  }
}

/**
 * 扫描 X11 是否存在 350x160 的 QQ 屏幕共享邀请弹窗（「XX正邀请你加入屏幕共享」）
 */
async function findScreenInviteWindow() {
  try {
    const out = await dockerExec('DISPLAY=:1 xwininfo -root -tree 2>/dev/null | grep -E "350x160\\+0\\+0" | grep \'"QQ"\' | head -n 1');
    const line = out.trim();
    if (!line) return null;
    const wid = line.split(/\s+/)[0];
    const m = line.match(/\+(\d+)\+(\d+)$/);
    return {
      wid,
      x: m ? Number(m[1]) : 785,
      y: m ? Number(m[2]) : 450
    };
  } catch {
    return null;
  }
}

/**
 * 截取 350x160 屏幕共享邀请弹窗并用快速多模态模型校验：是否单聊屏幕共享邀请 + 邀请人昵称
 */
async function inspectScreenInviteCard(win) {
  const key = readDashscopeKey();
  if (!key) return null;
  const imgPath = '/tmp/share_verify.png';
  await dockerExec(`ffmpeg -y -loglevel error -f x11grab -video_size 350x160 -i :1+${win.x},${win.y} -vframes 1 ${imgPath}`);
  const b64 = (await dockerExec(`base64 -w 0 ${imgPath}; rm -f ${imgPath}`)).trim();
  if (!b64) return null;

  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3-omni-flash',
      temperature: 0,
      max_tokens: 180,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            {
              type: 'text',
              text: '这是 QQ 弹窗截图。请严格只输出 JSON 对象：{"isScreenInvite": 布尔值(是否显示“正邀请你加入屏幕共享”且有“拒绝”和蓝色“加入”按钮), "isGroupCall": 布尔值(是否为多人/群屏幕共享), "callerName": "左侧头像旁显示的邀请人昵称文字（原样照抄，看不到留空）"}。只输出 JSON。'
            }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) return null;
  const data = await res.json();
  let raw = String(data?.choices?.[0]?.message?.content || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * 截取 360x640 来电窗口并用快速多模态模型校验：是否好友单聊来电 + 来电人名称
 */
async function inspectIncomingCallCard(win) {
  const key = readDashscopeKey();
  if (!key) return null;
  const imgPath = '/tmp/call_verify.png';
  await dockerExec(`ffmpeg -y -loglevel error -f x11grab -video_size 360x640 -i :1+${win.x},${win.y} -vframes 1 ${imgPath}`);
  const b64 = (await dockerExec(`base64 -w 0 ${imgPath}`)).trim();
  if (!b64) return null;

  const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'qwen3-omni-flash',
      temperature: 0,
      max_tokens: 180,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } },
            {
              type: 'text',
              text: '这是 QQ 来电界面截图。请严格只输出 JSON 对象：{"isIncoming": 布尔值(底部是否有绿色接听按钮), "isGroupCall": 布尔值(是否为多人/群通话邀请), "callerName": "头像下方显示的来电人昵称文字（原样照抄，看不到留空）", "hasErrorModal": 布尔值(是否有“异常提示/我知道了”白框弹窗)}。只输出 JSON。'
            }
          ]
        }
      ]
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) return null;
  const data = await res.json();
  let raw = String(data?.choices?.[0]?.message?.content || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const s = raw.indexOf('{');
  const e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

function matchCallerWhitelist(callerName, wlMap) {
  const clean = String(callerName || '').trim();
  if (!clean) return null;
  for (const [uin, info] of wlMap.entries()) {
    for (const candidate of info.names) {
      if (!candidate) continue;
      if (clean === candidate || clean.includes(candidate) || candidate.includes(clean)) {
        return { uin, matchedName: candidate };
      }
    }
  }
  return null;
}

/**
 * Layer-2 接听后硬核 UIN 复核：读 snowluma 近 12 秒日志里的 msgType=529/11 from=<UIN>
 */
async function checkPostAcceptUin(whitelist) {
  try {
    const { stdout } = await execFileAsync('docker', ['logs', '--since', '12s', CONTAINER_NAME], { timeout: 5000 });
    const matches = [...stdout.matchAll(/from=(\d+)\s+msgType=529\/11/g)];
    if (!matches.length) return { verified: false, uin: null };
    const uin = matches[matches.length - 1][1];
    return { verified: true, uin, allowed: whitelist.includes(uin) };
  } catch {
    return { verified: false, uin: null };
  }
}

class NativeQQCallDaemon {
  constructor() {
    this.state = 'idle'; // idle | ringing | in_call | cooldown
    this.currentCall = null;
    this.recentCalls = [];
    this.engine = null;
    this.parecProc = null;
    this.pacatProc = null;
    this.activeWin = null;
    this.ignoredWids = new Set();
    this.wlMap = new Map();
    this.lastWlRefresh = 0;
    this.screenEngine = new ScreenVisionEngine({ log });
    this.qqScreenAdapter = new QQScreenShareAdapter({
      screenEngine: this.screenEngine,
      containerName: CONTAINER_NAME,
      isPaused: () => Boolean(this.engine?._isActuallySpeakingNow()),
      log
    });
  }

  async start() {
    const cfg = loadConfig();
    await ensurePulseAudio();
    // 清理上次服务重启可能残留的孤儿 pacat/parec，并在宿主机侧提权 PulseAudio 调度优先级
    await dockerExec('pkill -9 -f "pacat.*ai_mic_sink|parec.*qq_spk" 2>/dev/null || true').catch(() => {});
    await execFileAsync('sh', ['-c', 'renice -n -10 $(pgrep -f "pulseaudio.*qq-call") 2>/dev/null || true']).catch(() => {});
    this.wlMap = await fetchFriendWhitelistMap(cfg);
    this.lastWlRefresh = Date.now();
    const wlDesc = [...this.wlMap.entries()].map(([u, v]) => `${u}(${[...v.names].join('/')})`).join(', ');
    log(`[call-adapter] 已启动 QQ 原生通话守护 | 白名单: ${wlDesc} | 群通话: ${cfg.allowGroupCall ? '开' : '关'} | 每日限额: ${cfg.dailyLimitMin}min`);

    this._startHttpServer(cfg.port, cfg);
    this._pollLoop();
  }

  _startHttpServer(port, cfg) {
    let handleScreenHttp = null;
    const srv = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
        if (urlObj.pathname === '/health' || urlObj.pathname === '/status') {
          let dailyUsedSec = 0;
          try {
            const st = JSON.parse(fs.readFileSync('/opt/qq-bridge/state/call-stats.json', 'utf8'));
            if (st?.day === new Date().toISOString().slice(0, 10)) dailyUsedSec = Number(st.usedSec) || 0;
          } catch {}
          const curCfg = loadConfig();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            ok: true,
            state: this.state,
            whitelist: curCfg.whitelist,
            allowGroupCall: curCfg.allowGroupCall,
            dailyUsedSec,
            dailyLimitMin: curCfg.dailyLimitMin,
            currentCall: this.currentCall,
            recentCalls: this.recentCalls.slice(-10),
            screen: this.screenEngine.getStatus()
          }, null, 2));
          return;
        }
        if (req.method === 'GET' && urlObj.pathname === '/api/screen/qq-probe') {
          const expected = readConsoleToken();
          const provided = String(urlObj.searchParams.get('token') || req.headers['x-screen-token'] || req.headers['x-console-token'] || '').trim();
          if (expected && provided !== expected) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
            return;
          }
          const info = await this.qqScreenAdapter.probe();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, callState: this.state, activeWin: this.activeWin, ...info }, null, 2));
          return;
        }
        if (handleScreenHttp && await handleScreenHttp(req, res)) return;
        res.writeHead(404);
        res.end('not found');
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err?.message ?? err) }));
      }
    });
    handleScreenHttp = attachScreenWebEndpoint(srv, {
      screenEngine: this.screenEngine,
      getCallEngine: () => this.engine,
      getCallState: () => this.state,
      getToken: () => readConsoleToken(),
      dashscopeKeyFile: DASHSCOPE_KEY_PATH,
      dshBaseUrl: cfg.dshBaseUrl,
      dshAuthToken: cfg.dshAuthToken,
      ttsUrl: String(cfg.raw.draw?.serviceUrl || 'http://127.0.0.1:3210'),
      log
    });
    srv.listen(port, '127.0.0.1', () => {
      log(`[call-adapter] 状态与看屏控制台监听 http://127.0.0.1:${port}/health | /screen`);
    });
  }

  async _isCallWindowAlive() {
    if (this.activeWin?.wid) {
      try {
        const out = await dockerExec(`DISPLAY=:1 xwininfo -id ${this.activeWin.wid} 2>/dev/null | grep -E "Map State: IsViewable|Width:" || true`);
        if (out.includes('IsViewable')) return true;
      } catch {}
    }
    const win = await findCallWindow();
    if (win) {
      this.activeWin = win;
      return true;
    }
    return false;
  }

  async _pollLoop() {
    while (true) {
      try {
        const cfg = loadConfig();
        if (!cfg.enabled) {
          await sleep(3000);
          continue;
        }
        if (Date.now() - this.lastWlRefresh > 5 * 60 * 1000) {
          this.wlMap = await fetchFriendWhitelistMap(cfg);
          this.lastWlRefresh = Date.now();
        }

        if (this.state === 'idle') {
          const win = await findCallWindow();
          if (win && !this.ignoredWids.has(win.wid)) {
            await this._handleIncomingCall(win, cfg);
          } else {
            const shareWin = await findScreenInviteWindow();
            if (shareWin && !this.ignoredWids.has(shareWin.wid)) {
              await this._handleScreenShareInvite(shareWin, cfg, { duringCall: false });
            } else if (!win && !shareWin && this.ignoredWids.size) {
              this.ignoredWids.clear();
            }
          }
          await sleep(450);
        } else if (this.state === 'in_call') {
          // 若通话中途对方发起了屏幕共享邀请（350x160 弹窗），通过白名单校验后自动点「加入」
          const shareInv = await findScreenInviteWindow();
          if (shareInv && !this.ignoredWids.has(shareInv.wid)) {
            await this._handleScreenShareInvite(shareInv, cfg, { duringCall: true });
          }
          const alive = await this._isCallWindowAlive();
          if (!alive) {
            log('[call-adapter] 检测到通话/共享窗口关闭（对方已挂断）');
            await this._teardownCall('remote_hangup');
          }
          await sleep(1000);
        } else {
          await sleep(500);
        }
      } catch (err) {
        log(`[call-adapter] 轮询异常: ${err?.message ?? err}`);
        await sleep(1500);
      }
    }
  }

  async _handleIncomingCall(win, cfg) {
    this.state = 'ringing';
    this.activeWin = win;
    log(`[call-adapter] 检测到 QQ 来电窗口 WID=${win.wid} pos=+${win.x}+${win.y}`);

    // 等弹窗稳定，点掉“异常提示/我知道了”（不接听电话）以露出来电人名字
    await sleep(1200);
    const okX = win.x + 288;
    const okY = win.y + 374;
    await dockerExec(`DISPLAY=:1 xdotool windowactivate --sync ${win.wid} 2>/dev/null || true; sleep 0.15; DISPLAY=:1 xdotool mousemove ${okX} ${okY} click 1; sleep 0.25; DISPLAY=:1 xdotool mousemove ${okX} ${okY} click 1`);
    await sleep(300);

    // 确认窗口还在（防止响一声就挂了）
    const stillThere = await findCallWindow();
    if (!stillThere) {
      log('[call-adapter] 来电已提前取消');
      this.state = 'idle';
      return;
    }

    // Layer-1 接听前白名单与单聊校验
    let card = await inspectIncomingCallCard(stillThere);
    if (card?.hasErrorModal) {
      await dockerExec(`DISPLAY=:1 xdotool mousemove ${okX} ${okY} click 1`);
      await sleep(250);
      card = await inspectIncomingCallCard(stillThere);
    }
    log(`[call-adapter] 来电卡片识别: ${JSON.stringify(card)}`);

    if (!card || !card.isIncoming) {
      log(`[call-adapter] 非来电响铃界面，忽略 WID=${win.wid} 直到窗口关闭`);
      this.ignoredWids.add(win.wid);
      this.state = 'idle';
      return;
    }
    if (card.isGroupCall && !cfg.allowGroupCall) {
      log(`[call-adapter] 拒绝群通话邀请（caller=${card.callerName}）`);
      await this._clickReject(stillThere);
      this.state = 'cooldown';
      await sleep(3000);
      this.state = 'idle';
      return;
    }

    const matched = matchCallerWhitelist(card.callerName, this.wlMap);
    if (!matched) {
      log(`[call-adapter] ⛔ 来电人「${card.callerName || '未知'}」不在白名单中，已拒接`);
      await this._clickReject(stillThere);
      this.state = 'cooldown';
      await sleep(3000);
      this.state = 'idle';
      return;
    }

    // 模拟真人接听节奏（额外随机延迟 400–1100ms）
    const extraDelay = 400 + Math.floor(Math.random() * 700);
    await sleep(extraDelay);

    const accX = stillThere.x + 114;
    const accY = stillThere.y + 508;
    log(`[call-adapter] ✅ 白名单命中 ${matched.uin} (${matched.matchedName})，点击接听 (${accX}, ${accY})`);
    await dockerExec(`DISPLAY=:1 xdotool windowactivate --sync ${stillThere.wid} 2>/dev/null || true; sleep 0.1; DISPLAY=:1 xdotool mousemove ${accX} ${accY} click 1`);
    await sleep(1600);

    // 确认接通（窗口仍存在）
    const activeWin = await findCallWindow();
    if (!activeWin) {
      log('[call-adapter] 点击接听后窗口消失，可能已超时');
      this.state = 'idle';
      return;
    }

    // 启动全双工音频管道与通话引擎
    this.state = 'in_call';
    this.activeWin = activeWin;
    this.currentCall = {
      uin: matched.uin,
      callerName: matched.matchedName,
      startedAt: new Date().toISOString()
    };

    // Layer-2 接听后 3 秒做 UIN 二次防伪复核
    setTimeout(async () => {
      if (this.state !== 'in_call') return;
      const check = await checkPostAcceptUin(cfg.whitelist);
      if (check.verified && !check.allowed) {
        log(`[call-adapter] ⛔ 二次 UIN 复核不通过 (from=${check.uin})，立即挂断！`);
        await this._clickHangupActive();
        await this._teardownCall('whitelist_post_reject');
      } else if (check.verified) {
        log(`[call-adapter] 🔒 二次 UIN 复核通过: from=${check.uin}`);
      }
    }, 3000).unref?.();

    await this._startEngineAndAudio(matched.uin, matched.matchedName, cfg);
  }

  /**
   * 处理 QQ 屏幕共享邀请弹窗（350x160：拒绝 +209,+124 / 蓝色加入 +295,+124）
   * 支持两种场景：1) 空闲直接点屏幕共享（同步拉起语音通话+实时看屏）；2) 语音通话中途升级屏幕共享
   */
  async _handleScreenShareInvite(win, cfg, { duringCall = false } = {}) {
    if (!duringCall) this.state = 'ringing';
    log(`[call-adapter] 检测到 QQ 屏幕共享邀请弹窗 WID=${win.wid} pos=+${win.x}+${win.y} (duringCall=${duringCall})`);
    await sleep(600);

    const card = await inspectScreenInviteCard(win);
    log(`[call-adapter] 屏幕共享邀请识别: ${JSON.stringify(card)}`);
    if (!card || !card.isScreenInvite) {
      this.ignoredWids.add(win.wid);
      if (!duringCall) this.state = 'idle';
      return;
    }

    const matched = matchCallerWhitelist(card.callerName, this.wlMap);
    const rejX = win.x + 209;
    const rejY = win.y + 124;
    const joinX = win.x + 295;
    const joinY = win.y + 124;

    if (card.isGroupCall && !cfg.allowGroupCall) {
      log(`[call-adapter] ⛔ 拒绝群屏幕共享邀请 (${card.callerName})`);
      await dockerExec(`DISPLAY=:1 xdotool windowactivate --sync ${win.wid} 2>/dev/null || true; sleep 0.1; DISPLAY=:1 xdotool mousemove ${rejX} ${rejY} click 1`).catch(() => {});
      this.ignoredWids.add(win.wid);
      if (!duringCall) { await sleep(1500); this.state = 'idle'; }
      return;
    }
    if (!matched) {
      log(`[call-adapter] ⛔ 拒绝非白名单屏幕共享邀请: callerName="${card.callerName}"`);
      await dockerExec(`DISPLAY=:1 xdotool windowactivate --sync ${win.wid} 2>/dev/null || true; sleep 0.1; DISPLAY=:1 xdotool mousemove ${rejX} ${rejY} click 1`).catch(() => {});
      this.ignoredWids.add(win.wid);
      if (!duringCall) { await sleep(1500); this.state = 'idle'; }
      return;
    }

    // 记录点击「加入」前的 QQ 窗口快照，用于精准锁定新弹出的共享画面窗口
    const beforeProbe = await this.qqScreenAdapter.probe();
    const beforeWids = new Set((beforeProbe.windows || []).map((w) => w.wid));

    const delayMs = duringCall ? 600 : (1100 + Math.floor(Math.random() * 700));
    log(`[call-adapter] ✅ 白名单屏幕共享验证通过: ${matched.matchedName} (${matched.uin})，${delayMs}ms 后点击「加入」`);
    await sleep(delayMs);

    await dockerExec(`DISPLAY=:1 xdotool windowactivate --sync ${win.wid} 2>/dev/null || true; sleep 0.12; DISPLAY=:1 xdotool mousemove ${joinX} ${joinY} click 1`);
    this.ignoredWids.add(win.wid);

    // 等「屏幕共享」查看器窗口变为真实可见 IsViewable（最多等 5 秒；注意 LinuxQQ 可能在点「加入」前就预创建了该 WID）
    let viewerWin = null;
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      viewerWin = await this.qqScreenAdapter.findVisibleShareWindow();
      if (viewerWin) break;
      const afterProbe = await this.qqScreenAdapter.probe();
      const newly = (afterProbe.windows || [])
        .filter((w) => !beforeWids.has(w.wid) && w.wid !== win.wid && w.w >= 420 && w.h >= 300)
        .sort((a, b) => (b.w * b.h) - (a.w * a.h));
      if (newly.length && await this.qqScreenAdapter._isViewable(newly[0].wid)) {
        viewerWin = newly[0];
        break;
      }
    }
    log(`[call-adapter] 屏幕共享加入后锁定窗口: ${viewerWin ? `${viewerWin.wid} "${viewerWin.title}" ${viewerWin.w}x${viewerWin.h}+${viewerWin.x}+${viewerWin.y}` : '未检测到可见共享窗'}`);

    if (duringCall) {
      if (viewerWin) {
        this.activeWin = viewerWin;
        await this.qqScreenAdapter.start(viewerWin.wid, { forceShareWin: viewerWin }).catch(() => {});
      }
      return;
    }

    // 独立屏幕共享：直接进入全双工通话 + 实时看屏模式！
    this.state = 'in_call';
    this.activeWin = viewerWin || await findCallWindow();
    this.currentCall = {
      uin: matched.uin,
      callerName: matched.matchedName,
      startedAt: new Date().toISOString(),
      mode: 'screen_share'
    };
    await this._startEngineAndAudio(matched.uin, matched.matchedName, cfg, { forceShareWin: viewerWin });
  }

  async _clickReject(win) {
    const rejX = win.x + 246;
    const rejY = win.y + 508;
    await dockerExec(`DISPLAY=:1 xdotool windowactivate --sync ${win.wid} 2>/dev/null || true; sleep 0.1; DISPLAY=:1 xdotool mousemove ${rejX} ${rejY} click 1`).catch(() => {});
  }

  async _clickHangupActive() {
    const win = this.activeWin || await findCallWindow();
    if (!win) return;
    if (this.currentCall?.mode === 'screen_share' || (win.w && win.w > 450)) {
      await dockerExec(`DISPLAY=:1 xdotool windowclose ${win.wid} 2>/dev/null || true`).catch(() => {});
      return;
    }
    // 通话中底部 4 按钮：关闭麦克风 / 开启视频 / 屏幕共享 / 退出通话(+286, +508)
    const hangX = win.x + 286;
    const hangY = win.y + 508;
    await dockerExec(`DISPLAY=:1 xdotool windowactivate --sync ${win.wid} 2>/dev/null || true; sleep 0.1; DISPLAY=:1 xdotool mousemove ${hangX} ${hangY} click 1`).catch(() => {});
  }

  _spawnPacat() {
    if (this.pacatProc) {
      try { this.pacatProc.kill('SIGKILL'); } catch {}
      this.pacatProc = null;
    }
    const p = spawn('docker', [
      'exec', '-i', CONTAINER_NAME, 'su', '-s', '/bin/sh', 'node', '-c',
      'export HOME=/app XDG_RUNTIME_DIR=/tmp/runtime-1000; exec pacat -p -d ai_mic_sink --raw --format=s16le --rate=24000 --channels=1 --latency-msec=100 --process-time-msec=20 --volume=58000'
    ], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('exit', () => {
      if (this.pacatProc === p) this.pacatProc = null;
    });
    this.pacatProc = p;
    return p;
  }

  _spawnParec() {
    if (this.parecProc) {
      try { this.parecProc.kill('SIGKILL'); } catch {}
      this.parecProc = null;
    }
    const p = spawn('docker', [
      'exec', CONTAINER_NAME, 'su', '-s', '/bin/sh', 'node', '-c',
      'export HOME=/app XDG_RUNTIME_DIR=/tmp/runtime-1000; exec parec -d qq_spk.monitor --format=s16le --rate=16000 --channels=1 --latency-msec=20'
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', (chunk) => {
      this.engine?.pushPcm16k(chunk);
    });
    p.on('exit', () => {
      if (this.parecProc === p) this.parecProc = null;
    });
    this.parecProc = p;
    return p;
  }

  async _startEngineAndAudio(uin, callerName, cfg, { forceShareWin = null } = {}) {
    this._spawnPacat();

    this.engine = new RealtimeCallEngine({
      callerId: uin,
      callerName,
      dashscopeKeyFile: DASHSCOPE_KEY_PATH,
      dshBaseUrl: cfg.dshBaseUrl,
      dshAuthToken: cfg.dshAuthToken,
      softReminderMin: cfg.softReminderMin,
      dailyLimitMin: cfg.dailyLimitMin,
      silenceAskSec: cfg.silenceAskSec,
      silenceHangupSec: cfg.silenceHangupSec,
      defaultCity: cfg.defaultCity,
      screenEngine: this.screenEngine,
      log,
      onSidecarTask: async (task) => {
        if (task.kind === 'remember') {
          const token = readConsoleToken();
          const res = await fetch(`${cfg.bridgeBase}/api/call/note`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(token ? { 'X-Console-Token': token } : {})
            },
            body: JSON.stringify({ callerId: uin, callerName, text: task.query }),
            signal: AbortSignal.timeout(4000)
          });
          if (res.ok) return `已把「${task.query}」记进长期提醒事项，之后聊 QQ 也能记得`;
          return '';
        }
        if (task.kind === 'weather') {
          const w = await fetchCityWeather(task.city);
          return w?.summary || `暂时没查到${task.city}的实时天气`;
        }
        if (task.kind === 'meme') {
          const r = await lookupMeme(task.query, { allowLive: true, fetchImage: false, log });
          const top = r?.items?.[0];
          if (!top) return `没查到「${task.query}」的确切出处`;
          const rep = Array.isArray(top.replies) && top.replies.length ? `；常用接梗：${top.replies[0]}` : '';
          return `「${top.name}」：${top.meaning || top.origin || ''}${rep}`.slice(0, 180);
        }
        if (task.kind === 'web_search') {
          const hits = await serperGoogleSearch(task.query, { num: 3 });
          if (!Array.isArray(hits) || !hits.length) return `网上暂时没搜到「${task.query}」的明确结果`;
          return hits.slice(0, 2).map((h) => `${h.title}（${String(h.snippet || '').slice(0, 70)}）`).join('；');
        }
        return '';
      },
      onAudioOut: (pcm24kBuf) => {
        if (this.state !== 'in_call' || !pcm24kBuf?.length) return;
        const p = this.pacatProc || this._spawnPacat();
        if (p?.stdin?.writable) {
          try { p.stdin.write(pcm24kBuf); } catch {}
        }
      },
      onClearOut: () => {
        // 1x 节拍器保证了下游 pacat 缓冲永远 ≤ 40ms，不再重拉第二个 pacat（彻底根除双声轨重叠），
        // 直接往唯一 pacat 写入 40ms 静音平滑收尾即可！
        if (this.state === 'in_call' && this.pacatProc?.stdin?.writable) {
          try { this.pacatProc.stdin.write(Buffer.alloc(48 * 40)); } catch {}
        }
      },
      onHangupRequest: async (reason) => {
        log(`[call-adapter] 收到引擎主动挂断指令 (${reason})`);
        await this._clickHangupActive();
        await this._teardownCall(reason);
      },
      getContext: async (qq) => {
        try {
          const token = readConsoleToken();
          const res = await fetch(`${cfg.bridgeBase}/api/call/context?qq=${encodeURIComponent(qq)}`, {
            headers: token ? { 'X-Console-Token': token } : {},
            signal: AbortSignal.timeout(5000)
          });
          if (res.ok) return await res.json();
        } catch (err) {
          log(`[call-adapter] 拉取 qq-bridge 上下文失败: ${err?.message ?? err}`);
        }
        return {};
      },
      onSummary: async (report) => {
        this.recentCalls.push({
          callerId: report.callerId,
          callerName: report.callerName,
          startedAt: report.startedAt,
          durationSec: report.durationSec,
          turns: report.turns,
          avgLatencyMs: report.avgLatencyMs,
          summary: report.summary
        });
        if (this.recentCalls.length > 20) this.recentCalls = this.recentCalls.slice(-20);
        try {
          const token = readConsoleToken();
          await fetch(`${cfg.bridgeBase}/api/call/summary`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(token ? { 'X-Console-Token': token } : {})
            },
            body: JSON.stringify(report),
            signal: AbortSignal.timeout(8000)
          });
        } catch (err) {
          log(`[call-adapter] 写回通话摘要到 qq-bridge 失败: ${err?.message ?? err}`);
        }
      }
    });

    this._spawnParec();
    // 在宿主机 root 下把 QQ 软渲进程降权 (+15) 并把 PulseAudio / AudioService 提权 (-10)，确保视频软渲绝不抢占语音播放
    execFileAsync('sh', ['-c', 'renice -n -10 $(pgrep -f "pulseaudio.*qq-call|audio\\.mojom\\.AudioService") 2>/dev/null || true; renice -n 15 $(pgrep -f "/opt/QQ/qq --type=zygote --no-zygote-sandbox") 2>/dev/null || true']).catch(() => {});
    await this.qqScreenAdapter.start(this.activeWin?.wid || '', { forceShareWin }).catch(() => {});
    try {
      await this.engine.start();
    } catch (err) {
      log(`[call-adapter] 启动通话引擎失败: ${err?.message ?? err}`);
      await this._clickHangupActive();
      await this._teardownCall('engine_start_error');
    }
  }

  async _teardownCall(reason) {
    if (this.state !== 'in_call') return;
    this.state = 'cooldown';
    this.qqScreenAdapter.stop();
    if (this.parecProc) { try { this.parecProc.kill('SIGKILL'); } catch {} this.parecProc = null; }
    if (this.pacatProc) {
      try { this.pacatProc.stdin?.end(); } catch {}
      try { this.pacatProc.kill('SIGTERM'); } catch {}
      this.pacatProc = null;
    }
    await dockerExec('pkill -9 -f "pacat.*ai_mic_sink|parec.*qq_spk" 2>/dev/null || true').catch(() => {});
    const eng = this.engine;
    this.engine = null;
    this.currentCall = null;
    this.activeWin = null;
    if (eng) {
      await eng.stop(reason).catch(() => {});
    }
    await sleep(2500);
    this.state = 'idle';
  }
}

const daemon = new NativeQQCallDaemon();
daemon.start().catch((err) => {
  console.error('[call-adapter] fatal:', err);
  process.exit(1);
});
