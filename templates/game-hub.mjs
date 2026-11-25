/**
 * game-hub.mjs — 平台无关统一游戏伴侣内核 & 标准 Neuro-API v1 网关（ESM）
 *
 * 架构职责（解耦设计，一份内核同时服务 Minecraft 具身联机 + Steam Neuro-SDK 开源 Mod + 自定义游戏）：
 *   1. 100% 兼容 VedalAI/neuro-sdk WebSocket 协议：
 *      - 上行（游戏 -> 大脑）：startup / context / actions/register / actions/unregister / actions/force / action/result
 *      - 下行（大脑 -> 游戏）：action（data.data 严格 JSON 字符串化）/ actions/reregister_all
 *      - 可选扩展（不破坏标准客户端）：pet/telemetry / pet/chat_in / pet/highlight
 *   2. 轻量结构化决策大脑（DashScope qwen-plus-latest 非思考模式，~0.6-1.3s），严格按注册的 JSON Schema 校验动作
 *   3. 与 QQ 实时语音通话（call-engine）双向打通：
 *      - 游戏高光事件（被偷袭/苦力怕/挖到钻石/残血/翻盘）按冷却推送到 qq-call 主动原声反应
 *      - 通话中用户口头指挥（/api/game/command）实时映射为游戏动作并返回自然口语答复
 *   4. 与 qq-bridge / qq-life 打通：对局结束后自动将精彩瞬间写回长期记忆与晚间手账日记素材
 *   5. 可选托管 mc-server-manager（自休眠 PaperMC 1.21.1 私服 + IP 敲门墙 + Mineflayer 队友）
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const BRIDGE_CONFIG_PATH = process.env.QQ_BRIDGE_CONFIG || '/opt/qq-bridge/config.json';
const STATE_DIR = process.env.QQ_BRIDGE_STATE_DIR || '/opt/qq-bridge/state';
const CONSOLE_TOKEN_PATH = path.join(STATE_DIR, 'console-token');
const DASHSCOPE_KEY_PATH = process.env.DASHSCOPE_KEY_PATH || '/opt/qq-tts/apikey.txt';
const GAME_TOKEN_PATH = path.join(STATE_DIR, 'game-link-token');
const GAME_STATE_PATH = path.join(STATE_DIR, 'game-hub-state.json');

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), '[game-hub]', ...args);

function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

function loadBridgeConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_PATH, 'utf8'));
    return {
      raw,
      port: Number(process.env.GAME_HUB_PORT || raw.game?.port || 3350),
      bridgeBase: `http://127.0.0.1:${Number(raw.consolePort || raw.console?.port || 3100)}`,
      callBase: `http://127.0.0.1:${Number(raw.call?.port || 3300)}`,
      ownerQQ: String(raw.ownerQQ || raw.whitelist?.ownerQQ || '').trim(),
      petName: String(raw.game?.petName || '小鲸鲸').trim(),
      mcBotName: String(raw.game?.mcBotName || 'xiaojingjing').trim(),
      model: String(process.env.GAME_BRAIN_MODEL || raw.game?.model || 'qwen-plus-latest').trim(),
      fallbackModel: String(raw.game?.fallbackModel || 'qwen-turbo').trim(),
      enableMcManager: raw.game?.enableMcManager !== false,
    };
  } catch {
    return {
      raw: {},
      port: Number(process.env.GAME_HUB_PORT || 3350),
      bridgeBase: 'http://127.0.0.1:3100',
      callBase: 'http://127.0.0.1:3300',
      ownerQQ: '',
      petName: '小鲸鲸',
      mcBotName: 'xiaojingjing',
      model: String(process.env.GAME_BRAIN_MODEL || 'qwen-plus-latest'),
      fallbackModel: 'qwen-turbo',
      enableMcManager: true,
    };
  }
}

export function ensureGameLinkToken(forceRotate = false) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!forceRotate && fs.existsSync(GAME_TOKEN_PATH)) {
    const existing = readTextSafe(GAME_TOKEN_PATH);
    if (existing.length >= 20) return existing;
  }
  const tok = 'petg_' + crypto.randomBytes(20).toString('hex');
  const tmp = `${GAME_TOKEN_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, tok + '\n', { mode: 0o600 });
  fs.renameSync(tmp, GAME_TOKEN_PATH);
  try { fs.chmodSync(GAME_TOKEN_PATH, 0o600); } catch {}
  return tok;
}

function readConsoleToken() {
  return readTextSafe(CONSOLE_TOKEN_PATH);
}

function readDashscopeKey() {
  return process.env.DASHSCOPE_API_KEY || readTextSafe(DASHSCOPE_KEY_PATH);
}

function safeJsonParse(str, fallback = null) {
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * 按 Neuro-API 注册的简单 JSON Schema 做参数清洗与基础校验，尽量修正类型偏差而非直接报错
 */
function sanitizeActionArgs(schema, rawArgs) {
  if (!schema || typeof schema !== 'object') return { ok: true, args: null };
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  const src = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)) ? rawArgs : {};
  const out = {};

  for (const [k, def] of Object.entries(props)) {
    if (src[k] === undefined || src[k] === null) continue;
    let v = src[k];
    const t = def?.type;
    if (t === 'string') {
      v = String(v).trim();
    } else if (t === 'integer') {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n)) continue;
      v = n;
      if (Number.isFinite(def.minimum)) v = Math.max(def.minimum, v);
      if (Number.isFinite(def.maximum)) v = Math.min(def.maximum, v);
    } else if (t === 'number') {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      v = n;
      if (Number.isFinite(def.minimum)) v = Math.max(def.minimum, v);
      if (Number.isFinite(def.maximum)) v = Math.min(def.maximum, v);
    } else if (t === 'boolean') {
      v = typeof v === 'boolean' ? v : /^(true|1|yes|是)$/i.test(String(v));
    } else if (t === 'array') {
      if (!Array.isArray(v)) v = [v];
    }
    if (Array.isArray(def?.enum) && def.enum.length && !def.enum.includes(v)) {
      const ci = def.enum.find((e) => String(e).toLowerCase() === String(v).toLowerCase());
      if (ci !== undefined) v = ci;
      else continue;
    }
    out[k] = v;
  }

  for (const reqKey of required) {
    if (out[reqKey] === undefined || out[reqKey] === '') {
      const def = props[reqKey];
      if (Array.isArray(def?.enum) && def.enum.length) {
        out[reqKey] = def.enum[0];
      } else {
        return { ok: false, error: `缺少必填参数 ${reqKey}` };
      }
    }
  }
  return { ok: true, args: out };
}

function summarizeActionList(actionsMap, filterNames = null) {
  const list = [];
  for (const [name, def] of actionsMap.entries()) {
    if (Array.isArray(filterNames) && filterNames.length && !filterNames.includes(name)) continue;
    const props = def.schema?.properties || {};
    const reqSet = new Set(Array.isArray(def.schema?.required) ? def.schema.required : []);
    const pDesc = Object.entries(props).map(([k, p]) => {
      const enumStr = Array.isArray(p?.enum) ? ` 可选[${p.enum.join('|')}]` : '';
      return `${k}${reqSet.has(k) ? '*' : ''}(${p?.type || 'any'}${enumStr}${p?.description ? ': ' + p.description : ''})`;
    }).join(', ');
    list.push(`- ${name}: ${def.description || ''}${pDesc ? ` | 参数: ${pDesc}` : ' | 无参数'}`);
  }
  return list.join('\n');
}

/**
 * 单个已连接游戏会话（支持同时连接多个游戏或按最近活跃路由）
 */
class GameSession {
  constructor(id, ws, { game = 'Unknown Game', remote = 'local' } = {}) {
    this.id = id;
    this.ws = ws;
    this.game = game;
    this.remote = remote;
    this.connectedAt = Date.now();
    this.lastActivityAt = Date.now();
    this.actions = new Map(); // name -> { name, description, schema }
    this.contexts = []; // [{ ts, message, silent }]
    this.highlights = []; // [{ ts, level, text }]
    this.actionLog = []; // [{ ts, id, name, args, success, message, say }]
    this.telemetry = {};
    this.pendingActions = new Map(); // actionId -> { resolve, reject, timer, name, args }
    this.busy = false;
    this.usesForce = false; // 检测到游戏发过 actions/force 后，自动识别为回合制/游戏驱动型（如小丑牌/杀戮尖塔）
    this.lastHumanCmdAt = 0;
    this.lastAutoTickAt = 0;
    this.lastVoicePushAt = 0;
    this.lastUrgentVoiceAt = 0;
    this.closed = false;
  }

  addContext(message, silent = true) {
    const txt = String(message || '').trim();
    if (!txt) return;
    this.lastActivityAt = Date.now();
    const last = this.contexts[this.contexts.length - 1];
    if (last && last.message === txt && Date.now() - last.ts < 8000) return;
    this.contexts.push({ ts: Date.now(), message: txt.slice(0, 600), silent: Boolean(silent) });
    if (this.contexts.length > 28) this.contexts.shift();
  }

  addHighlight(level, text) {
    const txt = String(text || '').trim();
    if (!txt) return;
    this.highlights.push({ ts: Date.now(), level: level || 'info', text: txt.slice(0, 240) });
    if (this.highlights.length > 30) this.highlights.shift();
  }

  addActionLog(entry) {
    this.actionLog.push({ ts: Date.now(), ...entry });
    if (this.actionLog.length > 40) this.actionLog.shift();
  }

  sendRaw(obj) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 严格按 Neuro-API 协议下发 action 并等待 action/result（默认 20s 超时）
   */
  dispatchAction(name, args, timeoutMs = 20000) {
    return new Promise((resolve) => {
      if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
        return resolve({ success: false, message: '游戏连接已断开' });
      }
      const id = 'act_' + crypto.randomBytes(6).toString('hex');
      const dataField = (args && typeof args === 'object' && Object.keys(args).length > 0)
        ? JSON.stringify(args)
        : undefined;
      const payload = {
        command: 'action',
        data: dataField !== undefined ? { id, name, data: dataField } : { id, name },
      };
      const timer = setTimeout(() => {
        this.pendingActions.delete(id);
        resolve({ success: false, message: `动作 ${name} 超过 ${Math.round(timeoutMs / 1000)}s 未返回结果` });
      }, timeoutMs);
      timer.unref?.();
      this.pendingActions.set(id, { resolve, timer, name, args, startedAt: Date.now() });
      const sent = this.sendRaw(payload);
      if (!sent) {
        clearTimeout(timer);
        this.pendingActions.delete(id);
        resolve({ success: false, message: 'WebSocket 发送失败' });
      }
    });
  }

  resolveActionResult(id, success, message) {
    const p = this.pendingActions.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pendingActions.delete(id);
    p.resolve({ success: Boolean(success), message: String(message || '') });
    return true;
  }

  cleanup() {
    this.closed = true;
    for (const [, p] of this.pendingActions.entries()) {
      clearTimeout(p.timer);
      p.resolve({ success: false, message: '游戏已断开连接' });
    }
    this.pendingActions.clear();
  }

  toPublicSummary() {
    return {
      id: this.id,
      game: this.game,
      remote: this.remote,
      connectedAt: this.connectedAt,
      uptimeSec: Math.round((Date.now() - this.connectedAt) / 1000),
      usesForce: this.usesForce,
      busy: this.busy,
      actionCount: this.actions.size,
      actions: [...this.actions.values()].map((a) => ({ name: a.name, description: a.description })),
      telemetry: this.telemetry,
      recentContexts: this.contexts.slice(-10),
      recentActions: this.actionLog.slice(-12),
      recentHighlights: this.highlights.slice(-8),
    };
  }
}

export class GameHub {
  constructor(opts = {}) {
    this.cfg = loadBridgeConfig();
    this.port = Number(opts.port || this.cfg.port || 3350);
    this.mcManager = opts.mcManager || null;
    this.sessions = new Map(); // sessionId -> GameSession
    this.activeSessionId = null;
    this.settings = {
      autonomous: true,        // 沙盒/开放世界是否允许自主决策（回合制游戏由 actions/force 驱动，不受此限制）
      voiceCommentary: true,   // 在 QQ 语音通话中是否把游戏高光事件主动推给通话引擎
      inGameChat: true,        // 在 MC 等游戏里是否允许在游戏聊天框说话
      autonomousIntervalSec: 22,
    };
    this._loadPersistedSettings();
    this.server = null;
    this.wss = null;
    this.autoTimer = null;
    this.gameToken = ensureGameLinkToken(false);
  }

  _loadPersistedSettings() {
    try {
      const d = JSON.parse(fs.readFileSync(GAME_STATE_PATH, 'utf8'));
      if (d?.settings && typeof d.settings === 'object') {
        Object.assign(this.settings, d.settings);
      }
    } catch {}
  }

  _savePersistedSettings() {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = `${GAME_STATE_PATH}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ settings: this.settings, updatedAt: new Date().toISOString() }, null, 2) + '\n');
      fs.renameSync(tmp, GAME_STATE_PATH);
    } catch {}
  }

  getActiveSession(gameHint = '') {
    if (gameHint) {
      const hintLow = String(gameHint).toLowerCase();
      for (const s of this.sessions.values()) {
        if (s.game.toLowerCase().includes(hintLow)) return s;
      }
    }
    if (this.activeSessionId && this.sessions.has(this.activeSessionId)) {
      return this.sessions.get(this.activeSessionId);
    }
    const all = [...this.sessions.values()];
    return all.length ? all[all.length - 1] : null;
  }

  /**
   * 调用 DashScope 结构化决策大脑（快、稳、贴合小鲸鲸人设、零客服腔）
   */
  async decideAction(session, { trigger = 'auto', userFrom = '', userText = '', forceState = '', forceQuery = '', allowedActions = null, retryHint = '' } = {}) {
    const apiKey = readDashscopeKey();
    if (!apiKey) throw new Error('缺少 DashScope API Key');
    const actionNames = Array.isArray(allowedActions) && allowedActions.length
      ? allowedActions.filter((n) => session.actions.has(n))
      : [...session.actions.keys()];
    if (!actionNames.length) {
      return { action: null, args: null, say: '我现在游戏里还没啥能做的操作呢', inGameChat: '' };
    }

    const actionsText = summarizeActionList(session.actions, actionNames);
    const ctxLines = session.contexts.slice(-12).map((c) => {
      const ago = Math.max(0, Math.round((Date.now() - c.ts) / 1000));
      return `[${ago}s前] ${c.message}`;
    }).join('\n');

    const recentActs = session.actionLog.slice(-6).map((a) =>
      `- ${a.name}(${a.args ? JSON.stringify(a.args) : ''}) => ${a.success ? '成功' : '失败'}: ${a.message || ''}`
    ).join('\n');

    const isForced = trigger === 'force';
    const sysPrompt = [
      `你是${this.cfg.petName}，正在陪好朋友一起玩《${session.game}》。`,
      `性格：活泼机灵、有点小傲娇和吐槽欲、真诚仗义的活人游戏搭子，说话简短自然口语化（绝不官腔、不用敬语、不用 Markdown、不写括号动作）。`,
      `你必须严格只输出一个合法 JSON 对象，字段如下：`,
      `{`,
      `  "action": ${isForced ? '"必须从允许动作列表里选一个动作名"' : '"从允许动作列表里选一个动作名；如果此刻确实只需说话或继续当前任务可填 null"'},`,
      `  "args": { "按所选动作的参数表填写，无参数填 {}" },`,
      `  "say": "给朋友听的一句简短口语反应（<=24字，没有就留空字符串）",`,
      `  "inGameChat": "如果游戏里没有开语音通话、且需要在游戏聊天框回复一句时填（<=28字，普通自主行动留空字符串）"`,
      `}`,
      `铁律：`,
      `1. action 必须严格等于允许列表中的英文动作名，绝不自造动作名。`,
      `2. 参数值必须符合类型与枚举限制；在 Minecraft 里方块/物品名尽量用常见英文或中文关键词（适配器会自动映射标准 ID）。`,
      `3. 当朋友直接命令你干某件事时，优先立刻执行对应动作！`,
      `4. 玩卡牌/策略游戏（如 Balatro / 小丑牌 / 杀戮尖塔等）时，认真看清手牌、牌型、筹码/倍率、剩余出牌与弃牌次数，做出真正聪明的策略选择，不要乱选。`,
    ].join('\n');

    const userBlocks = [
      `【当前游戏】${session.game}`,
      `【允许动作列表】\n${actionsText}`,
    ];
    if (forceState) userBlocks.push(`【当前即时盘面/状态】\n${forceState}`);
    if (ctxLines) userBlocks.push(`【近期游戏动态】\n${ctxLines}`);
    if (recentActs) userBlocks.push(`【最近执行记录】\n${recentActs}`);
    if (trigger === 'force') {
      userBlocks.push(`【游戏强制要求你现在做出选择】${forceQuery || '请立刻选择一个合法动作！'}`);
    } else if (trigger === 'human_command') {
      userBlocks.push(`【朋友 ${userFrom || '主人'} 刚对你说】「${userText}」\n请优先响应他的要求（执行最贴切的动作，并用自然简短口语回复他）。`);
    } else if (trigger === 'in_game_chat') {
      userBlocks.push(`【玩家 ${userFrom} 在游戏聊天框说】「${userText}」\n请在 inGameChat 里自然短句回复他；如果他在让你做某事，同时选对应 action 执行！`);
    } else {
      userBlocks.push(`【自主巡检】目前没有新的玩家指令且你处于空闲状态。如果玩家在附近，优先 guard_player 或 follow_player 陪着他，或顺手砍少量木头/合成基础工具；严禁主动去打苦力怕（creeper）！如果没有必要打扰，action 填 null。`);
    }
    if (retryHint) {
      userBlocks.push(`【上一次尝试失败，请立刻修正】${retryHint}`);
    }

    const tryModel = async (modelName) => {
      const res = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: modelName,
          temperature: isForced ? 0.3 : 0.45,
          max_tokens: 320,
          enable_thinking: false,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: userBlocks.join('\n\n') },
          ],
        }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) {
        const errTxt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${errTxt.slice(0, 120)}`);
      }
      const data = await res.json();
      let raw = String(data?.choices?.[0]?.message?.content || '').trim();
      raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
      const s = raw.indexOf('{');
      const e = raw.lastIndexOf('}');
      if (s >= 0 && e > s) raw = raw.slice(s, e + 1);
      const parsed = JSON.parse(raw);
      return {
        action: parsed.action && parsed.action !== 'null' ? String(parsed.action).trim() : null,
        args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {},
        say: String(parsed.say || '').replace(/[（(][^）)]{0,16}[）)]/g, '').trim().slice(0, 60),
        inGameChat: String(parsed.inGameChat || '').replace(/[（(][^）)]{0,16}[）)]/g, '').trim().slice(0, 60),
      };
    };

    try {
      return await tryModel(this.cfg.model);
    } catch (err) {
      log(`主模型 ${this.cfg.model} 失败，回退 ${this.cfg.fallbackModel}: ${err?.message ?? err}`);
      return await tryModel(this.cfg.fallbackModel);
    }
  }

  /**
   * 处理 Neuro-API actions/force（含失败最多 3 次自动纠错重试）
   */
  async handleForceAction(session, data) {
    session.usesForce = true;
    const allowed = Array.isArray(data?.actions) ? data.actions.filter((n) => session.actions.has(n)) : [...session.actions.keys()];
    if (!allowed.length) {
      log(`[${session.game}] actions/force 无有效可用动作，忽略`);
      return;
    }
    const forceState = String(data?.state || '').trim();
    const forceQuery = String(data?.query || '').trim();
    const priority = String(data?.priority || 'medium');

    // 等待前一个动作结束（最多 5 秒）
    const waitEnd = Date.now() + 5000;
    while (session.busy && !session.closed && Date.now() < waitEnd) {
      await new Promise((r) => setTimeout(r, 120));
    }
    if (session.closed) return;

    session.busy = true;
    let retryHint = '';
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (session.closed) return;
        const plan = await this.decideAction(session, {
          trigger: 'force',
          forceState,
          forceQuery,
          allowedActions: allowed,
          retryHint,
        });
        let chosenName = plan.action;
        if (!chosenName || !allowed.includes(chosenName)) {
          chosenName = allowed[0];
        }
        const actionDef = session.actions.get(chosenName);
        const check = sanitizeActionArgs(actionDef?.schema, plan.args);
        if (!check.ok) {
          retryHint = `你选的 ${chosenName} 参数不合法：${check.error}，请重新选择或补齐参数`;
          continue;
        }
        log(`[${session.game}] ⚡ force(${priority}) #${attempt}: ${chosenName}(${check.args ? JSON.stringify(check.args) : ''})${plan.say ? ` | "${plan.say}"` : ''}`);
        if (plan.say && attempt === 1) {
          this.pushVoiceHighlight(session, priority === 'critical' || priority === 'high' ? 'urgent' : 'fun', plan.say).catch(() => {});
        }
        const res = await session.dispatchAction(chosenName, check.args, 20000);
        session.addActionLog({ name: chosenName, args: check.args, success: res.success, message: res.message, say: plan.say });
        if (res.message) session.addContext(`动作 ${chosenName} ${res.success ? '成功' : '失败'}: ${res.message}`, true);
        if (res.success) return;
        retryHint = `上一次执行 ${chosenName} 被游戏拒绝，原因：${res.message || '未知错误'}，请换合法操作！`;
      }
    } catch (err) {
      log(`[${session.game}] force 决策异常: ${err?.message ?? err}`);
    } finally {
      session.busy = false;
    }
  }

  /**
   * <1ms 零大模型极速指令快路由（彻底砍掉二次 LLM 延迟：3800ms -> ~15ms！）
   * 仅在 Minecraft 会话且意图明确时直出标准 Neuro-API 动作；复杂组合指令自动回退给大模型。
   */
  matchFastMcAction(text, session) {
    if (!session || !/minecraft/i.test(session.game)) return null;
    const t = String(text || '').trim();
    if (!t) return null;
    const has = (name) => session.actions.has(name);
    const numM = t.match(/([1-9]\d?|[一二两三四五六七八九十])(?:个|根|块|只|把)?/);
    const cnMap = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const parsedCount = numM ? (cnMap[numM[1]] || Math.min(16, Math.max(1, Number(numM[1]) || 4))) : null;

    // 1. 停止 / 别动 / 待命
    if (has('stop_action') && /(停手|停下|别动|别乱跑|先别干|暂停|原地待命|别打了|不玩了)/.test(t)) {
      return { action: 'stop_action', args: {} };
    }
    // 2. 设家 / 回家
    if (has('set_home') && /(设家|记.*家|这里当.*家|定为家)/.test(t)) {
      return { action: 'set_home', args: {} };
    }
    if (has('go_home') && /(回家|回基地|滚回家)/.test(t) && !/(堵|建|搭)/.test(t)) {
      return { action: 'go_home', args: {} };
    }
    // 3. 睡觉
    if (has('sleep_in_bed') && /(去睡觉|快睡觉|上床|睡个觉)/.test(t)) {
      return { action: 'sleep_in_bed', args: {} };
    }
    // 4. 吃东西
    if (has('eat_food') && /(吃东西|吃点东西|吃口饭|快吃|补血|吃面包|吃肉)/.test(t)) {
      return { action: 'eat_food', args: {} };
    }
    // 5. 插火把
    if (has('place_torch') && /(插.*火把|放.*火把|点.*火把)/.test(t) && !/(围墙|搭|建)/.test(t)) {
      return { action: 'place_torch', args: {} };
    }
    // 6. 建房子 / 搭小屋 / 围墙
    if (has('build_shelter') && /(建.*房|搭.*房|盖.*房|搭.*小屋|建.*小屋|围.*墙|搭.*避难)/.test(t) && !/(砍|收集|挖)/.test(t)) {
      return { action: 'build_shelter', args: {} };
    }
    // 7. 贴身保镖 / 保护我
    if (has('guard_player') && /(保护我|护着我|当保镖|贴身保护|帮我清怪|守着我)/.test(t)) {
      return { action: 'guard_player', args: {} };
    }
    // 8. 击杀指定生物/动物/怪物
    if (has('combat_mob') && /(打死|砍死|干掉|杀掉|击杀|收拾|打那个|砍那个|打这只|砍僵尸|打僵尸|打羊|杀羊|砍羊|打骷髅|打蜘蛛|打猪|打牛|救我|救援)/.test(t)) {
      const mobMap = [
        [/(羊|绵羊)/, '羊'], [/(僵尸|尸壳)/, '僵尸'], [/(骷髅|小白)/, '骷髅'],
        [/(蜘蛛)/, '蜘蛛'], [/(苦力怕|爬行者)/, '苦力怕'], [/(猪)/, '猪'],
        [/(牛)/, '牛'], [/(鸡)/, '鸡'], [/(末影人)/, '末影人'],
      ];
      let mob = '';
      for (const [re, name] of mobMap) { if (re.test(t)) { mob = name; break; } }
      return { action: 'combat_mob', args: mob ? { mob } : {} };
    }
    // 9. 采集资源（砍木头/挖石头/挖煤/挖铁/挖钻石/挖土）
    if (has('gather_resource') && /(砍|挖|采|弄点|搞点|收集|捡点)/.test(t)) {
      const resMap = [
        [/(木头|原木|树|橡木|云杉)/, '木头'], [/(钻石)/, '钻石'], [/(铁矿|铁)/, '铁矿'],
        [/(煤|煤炭|煤矿)/, '煤炭'], [/(石头|圆石)/, '石头'], [/(泥土|土)/, '泥土'], [/(沙子|沙)/, '沙子'],
      ];
      for (const [re, resName] of resMap) {
        if (re.test(t)) return { action: 'gather_resource', args: { resource: resName, count: parsedCount || 4 } };
      }
    }
    // 10. 给物品
    if (has('give_item') && /(给我|扔给我|丢给我|分我)/.test(t)) {
      const itemMap = [
        [/(木头|原木)/, '木头'], [/(木板)/, '木板'], [/(铁矿|铁锭|粗铁)/, '铁矿'],
        [/(煤|煤炭)/, '煤炭'], [/(火把)/, '火把'], [/(石头|圆石)/, '圆石'],
        [/(工作台)/, '工作台'], [/(面包|肉|食物|苹果)/, '面包'], [/(剑)/, '石剑'], [/(镐)/, '石镐'],
      ];
      for (const [re, itemName] of itemMap) {
        if (re.test(t)) return { action: 'give_item', args: parsedCount ? { item: itemName, count: parsedCount } : { item: itemName } };
      }
    }
    // 11. 合成常用物品
    if (has('craft_item') && /(合成|做一把|做个|造个|做一个|做点)/.test(t)) {
      const craftMap = [
        [/(工作台)/, '工作台'], [/(木板)/, '木板'], [/(木棍)/, '木棍'], [/(火把)/, '火把'],
        [/(石剑)/, '石剑'], [/(木剑)/, '木剑'], [/(铁剑)/, '铁剑'],
        [/(石镐)/, '石镐'], [/(木镐)/, '木镐'], [/(铁镐)/, '铁镐'],
        [/(熔炉)/, '熔炉'], [/(箱子)/, '箱子'], [/(盾牌)/, '盾牌'],
      ];
      for (const [re, itemName] of craftMap) {
        if (re.test(t)) return { action: 'craft_item', args: { item: itemName, count: parsedCount || 1 } };
      }
    }
    // 12. 跟随 / 过来
    if (has('follow_player') && /(跟我走|跟着我|跟紧我|别掉队|跟我来)/.test(t)) {
      return { action: 'follow_player', args: { distance: 3 } };
    }
    if (has('go_to_player') && /(过来|来我这|到我身边|来找我|快上来|上来看)/.test(t)) {
      return { action: 'go_to_player', args: {} };
    }
    return null;
  }

  /**
   * 外部人类指令入口（QQ 语音通话 / QQ 聊天 / pet-portal / MC 游戏内聊天）
   */
  async handleHumanCommand({ from = '主人', text = '', via = 'voice', gameHint = '' } = {}) {
    const clean = String(text || '').trim();
    if (!clean) return { ok: false, error: '空指令' };
    const session = this.getActiveSession(gameHint);
    if (!session) {
      if (this.mcManager && /(开服|启动|唤醒|打开|进服|来玩).*(mc|我的世界|minecraft)|(mc|我的世界|minecraft).*(开服|启动|唤醒|走起)/i.test(clean)) {
        const wakeRes = await this.mcManager.wake({ reason: `human_${via}`, spawnBot: true });
        return {
          ok: true,
          wakedMc: true,
          needsVoiceReport: true,
          reply: wakeRes.alreadyRunning
            ? 'MC 服务器本来就开着呢，我已经在世界里等你啦！'
            : '好嘞，我正在把咱们的 MC 私服唤醒，大概十几秒就能进去啦！',
        };
      }
      return { ok: false, error: '当前没有已连接的游戏会话', needsVoiceReport: false, reply: '我现在还没连上任何游戏呢，先在管理台或让我把 MC 服开起来吧' };
    }

    session.lastHumanCmdAt = Date.now();
    const fastHit = (via !== 'in_game_chat') ? this.matchFastMcAction(clean, session) : null;
    const plan = fastHit
      ? { action: fastHit.action, args: fastHit.args, say: '', inGameChat: '', fastPath: true }
      : await this.decideAction(session, {
          trigger: via === 'in_game_chat' ? 'in_game_chat' : 'human_command',
          userFrom: from,
          userText: clean,
        });

    let actionResult = null;
    if (plan.action && session.actions.has(plan.action)) {
      const def = session.actions.get(plan.action);
      const check = sanitizeActionArgs(def?.schema, plan.args);
      if (check.ok) {
        log(`[${session.game}] 🎮 ${via}${plan.fastPath ? '(⚡0ms快路由)' : ''}指令(${from}): "${clean}" -> ${plan.action}(${check.args ? JSON.stringify(check.args) : ''})`);
        const startedAt = Date.now();
        const p = session.dispatchAction(plan.action, check.args, 20000).then((res) => {
          session.addActionLog({ name: plan.action, args: check.args, success: res.success, message: res.message, say: '' });
          if (res.message) session.addContext(`执行 ${plan.action} ${res.success ? '成功' : '失败'}: ${res.message}`, true);
          // 长任务延迟结束后的真实反馈：只有真正失败或有实质战果时才推送高光，绝不虚构
          if (Date.now() - startedAt > 1400 && via.startsWith('voice')) {
            if (!res.success && res.message) {
              this.pushVoiceHighlight(session, 'fun', `小鲸鲸刚才执行「${clean}」失败了，真实原因：${res.message}`).catch(() => {});
            } else if (res.success && (plan.action === 'combat_mob' || plan.action === 'build_shelter') && res.message) {
              this.pushVoiceHighlight(session, 'fun', `小鲸鲸刚完成任务：${res.message}`).catch(() => {});
            }
          }
          return res;
        });
        actionResult = await Promise.race([
          p,
          new Promise((r) => setTimeout(() => r({ pending: true, success: true, message: '正在执行中' }), 1300)),
        ]);
      }
    }

    // 游戏内聊天自动回话（如果本次指令来自游戏聊天框且配置允许）
    if (via === 'in_game_chat' && this.settings.inGameChat && session.actions.has('chat_in_game')) {
      const chatReply = plan.inGameChat || plan.say;
      if (chatReply && plan.action !== 'chat_in_game') {
        session.dispatchAction('chat_in_game', { message: chatReply }, 6000).catch(() => {});
      }
    }

    // 关键修复：绝不把执行前盲目乐观的 plan.say 当成成功结果报给语音！
    // 只有动作立即失败（例如背包没火把、方块不够、附近没羊）才需要语音补播真实失败原因；正常开始执行时静默不重复插话！
    const failedNow = Boolean(actionResult && !actionResult.pending && !actionResult.success);
    const needsVoiceReport = failedNow;
    const honestReply = failedNow
      ? `小鲸鲸刚才尝试执行「${plan.action}」没做成，真实原因：${actionResult.message || '条件不满足'}`
      : (actionResult?.message && actionResult.message !== '正在执行中' ? actionResult.message : (plan.action ? `已开始执行 ${plan.action}` : '收到'));

    return {
      ok: true,
      game: session.game,
      fastPath: Boolean(plan.fastPath),
      action: plan.action,
      args: plan.args,
      actionResult,
      needsVoiceReport,
      reply: honestReply,
    };
  }

  /**
   * 沙盒开放世界自主行动心跳（严格让路人类指令与活跃任务，绝不瞎打断、绝不主动找苦力怕送死、绝不发假语音）
   */
  async _autonomousTick() {
    if (!this.settings.autonomous) return;
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.closed || session.busy || session.usesForce || session.actions.size === 0) continue;
      // 人类刚下过指令 45 秒内、或机器人正在执行跟随/保镖/采集等任务时，绝不抢占打断！
      if (now - session.lastHumanCmdAt < 45000) continue;
      const curMode = session.telemetry?.activeMode;
      if (curMode === 'task' || curMode === 'follow' || curMode === 'guard') continue;
      if (now - session.lastAutoTickAt < this.settings.autonomousIntervalSec * 1000) continue;
      const humanCount = Number(session.telemetry?.humanPlayerCount);
      if (Number.isFinite(humanCount) && humanCount === 0 && now - session.connectedAt > 60000) continue;

      session.lastAutoTickAt = now;
      session.busy = true;
      try {
        const plan = await this.decideAction(session, { trigger: 'auto' });
        // 严禁自主决策主动去砍苦力怕送死！
        if (plan.action === 'combat_mob' && /creeper|苦力怕/i.test(String(plan.args?.mob || ''))) {
          continue;
        }
        if (plan.action && session.actions.has(plan.action)) {
          const def = session.actions.get(plan.action);
          const check = sanitizeActionArgs(def?.schema, plan.args);
          if (check.ok) {
            log(`[${session.game}] 🤖 自主行动: ${plan.action}(${check.args ? JSON.stringify(check.args) : ''})`);
            const res = await session.dispatchAction(plan.action, check.args, 20000);
            session.addActionLog({ name: plan.action, args: check.args, success: res.success, message: res.message, say: '' });
            if (res.message) session.addContext(`自主执行 ${plan.action} ${res.success ? '成功' : '失败'}: ${res.message}`, true);
          }
        }
        // 注意：自主行动绝不再推送 plan.say 给语音，避免“语音抢话/身份错乱/实际没做成却吹牛”
      } catch (err) {
        log(`[${session.game}] 自主行动异常: ${err?.message ?? err}`);
      } finally {
        session.busy = false;
      }
    }
  }

  /**
   * 将游戏高光/紧急事件推送到正在进行的 QQ 实时语音通话（critical 阵亡事件零冷却必达！）
   */
  async pushVoiceHighlight(session, level = 'fun', text = '') {
    const clean = String(text || '').trim();
    if (!clean || !this.settings.voiceCommentary) return false;
    const now = Date.now();
    if (level === 'critical') {
      session.lastUrgentVoiceAt = now;
    } else if (level === 'urgent') {
      if (now - session.lastUrgentVoiceAt < 6500) return false;
      session.lastUrgentVoiceAt = now;
    } else {
      if (now - session.lastVoicePushAt < 18000) return false;
    }
    session.lastVoicePushAt = now;
    session.addHighlight(level, clean);

    try {
      const tok = readConsoleToken();
      const res = await fetch(`${this.cfg.callBase}/api/call/game-event`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(tok ? { 'X-Console-Token': tok } : {}),
        },
        body: JSON.stringify({
          game: session.game,
          level,
          text: clean,
          ts: now,
          telemetry: session.telemetry || {},
        }),
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 游戏会话结束后自动提炼战绩/名场面写回 qq-bridge 长期记忆与日记素材
   */
  async _writeSessionMemory(session) {
    const durMin = Math.round((Date.now() - session.connectedAt) / 60000);
    if (durMin < 2 && session.highlights.length < 2 && session.actionLog.length < 3) return;
    if (!this.cfg.ownerQQ) return;
    const hiText = session.highlights.slice(-5).map((h) => h.text).join('；');
    const actCount = session.actionLog.length;
    const summaryText = `和朋友一起玩了约 ${Math.max(1, durMin)} 分钟《${session.game}》（共配合行动 ${actCount} 次）${hiText ? `，名场面：${hiText}` : ''}`.slice(0, 220);
    try {
      const tok = readConsoleToken();
      await fetch(`${this.cfg.bridgeBase}/api/call/note`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(tok ? { 'X-Console-Token': tok } : {}),
        },
        body: JSON.stringify({
          callerId: this.cfg.ownerQQ,
          callerName: '游戏联机记录',
          text: summaryText,
        }),
        signal: AbortSignal.timeout(4000),
      });
      log(`[${session.game}] 📝 已将联机记忆写回 qq-bridge: ${summaryText}`);
    } catch (err) {
      log(`[${session.game}] 写回记忆失败: ${err?.message ?? err}`);
    }
  }

  _handleWsConnection(ws, req) {
    const sid = 'gs_' + crypto.randomBytes(4).toString('hex');
    const remote = String(req.socket?.remoteAddress || 'local').replace(/^::ffff:/, '');
    const session = new GameSession(sid, ws, { game: 'Connecting...', remote });
    this.sessions.set(sid, session);
    this.activeSessionId = sid;
    log(`🎮 新游戏客户端已连入 id=${sid} remote=${remote}`);

    ws.on('message', async (raw) => {
      const msg = safeJsonParse(String(raw || ''));
      if (!msg || typeof msg !== 'object') return;
      const cmd = String(msg.command || '').trim();
      const gameName = String(msg.game || '').trim();
      if (gameName) session.game = gameName;
      const data = msg.data || {};

      try {
        if (cmd === 'startup') {
          session.actions.clear();
          session.contexts = [];
          session.addContext(`已启动并连接游戏《${session.game}》`, true);
          log(`[${session.game}] startup 注册完成 (id=${sid})`);
          this.pushVoiceHighlight(session, 'info', `我已经连进《${session.game}》啦，随时可以开玩！`).catch(() => {});
          return;
        }
        if (cmd === 'context') {
          const text = String(data.message || '').trim();
          const silent = data.silent !== false;
          session.addContext(text, silent);
          if (!silent && text) {
            this.pushVoiceHighlight(session, 'fun', text).catch(() => {});
          }
          return;
        }
        if (cmd === 'actions/register') {
          const arr = Array.isArray(data.actions) ? data.actions : [];
          for (const a of arr) {
            if (!a?.name) continue;
            session.actions.set(String(a.name), {
              name: String(a.name),
              description: String(a.description || ''),
              schema: a.schema && typeof a.schema === 'object' ? a.schema : null,
            });
          }
          log(`[${session.game}] 注册了 ${arr.length} 个动作（当前共 ${session.actions.size} 个）`);
          return;
        }
        if (cmd === 'actions/unregister') {
          const names = Array.isArray(data.action_names) ? data.action_names : [];
          for (const n of names) session.actions.delete(String(n));
          return;
        }
        if (cmd === 'actions/force') {
          this.handleForceAction(session, data).catch((e) => log(`force err: ${e?.message ?? e}`));
          return;
        }
        if (cmd === 'action/result') {
          session.resolveActionResult(String(data.id || ''), Boolean(data.success), String(data.message || ''));
          return;
        }
        // ── 扩展协议（兼容标准 Neuro-API，标准 Mod 不会发送也不会受影响）──
        if (cmd === 'pet/telemetry') {
          session.telemetry = { ...session.telemetry, ...data, updatedAt: Date.now() };
          session.lastActivityAt = Date.now();
          return;
        }
        if (cmd === 'pet/highlight') {
          const lvl = String(data.level || 'fun');
          const txt = String(data.text || '').trim();
          if (txt) {
            session.addContext(`[高光] ${txt}`, false);
            this.pushVoiceHighlight(session, lvl, txt).catch(() => {});
          }
          return;
        }
        if (cmd === 'pet/chat_in') {
          const sender = String(data.sender || '玩家').trim();
          const text = String(data.message || '').trim();
          if (text) {
            session.addContext(`${sender} 在游戏里说: ${text}`, false);
            this.handleHumanCommand({ from: sender, text, via: 'in_game_chat', gameHint: session.game }).catch(() => {});
          }
          return;
        }
      } catch (err) {
        log(`[${session.game}] 处理消息 ${cmd} 异常: ${err?.message ?? err}`);
      }
    });

    const onClose = () => {
      if (session.closed) return;
      log(`🎮 游戏连接断开: ${session.game} (id=${sid})`);
      this._writeSessionMemory(session).catch(() => {});
      session.cleanup();
      this.sessions.delete(sid);
      if (this.activeSessionId === sid) {
        const rest = [...this.sessions.keys()];
        this.activeSessionId = rest.length ? rest[rest.length - 1] : null;
      }
    };
    ws.on('close', onClose);
    ws.on('error', onClose);
  }

  _checkHttpAuth(req, urlObj) {
    const expected = readConsoleToken();
    if (!expected) return true;
    const provided = String(
      urlObj.searchParams.get('token') ||
      req.headers['x-console-token'] ||
      req.headers['x-game-token'] ||
      ''
    ).trim();
    return provided === expected || provided === this.gameToken;
  }

  _checkWsAuth(req, urlObj) {
    const remote = String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
    const tok = String(
      urlObj.searchParams.get('token') ||
      req.headers['x-game-token'] ||
      req.headers['x-console-token'] ||
      ''
    ).trim();
    const consoleTok = readConsoleToken();
    // 本机回环连接（如本地 mc-companion 或本机测试）允许免 token 或带任一有效 token
    if (remote === '127.0.0.1' || remote === '::1') {
      if (!tok || tok === this.gameToken || (consoleTok && tok === consoleTok)) return true;
    }
    return Boolean(tok && (tok === this.gameToken || (consoleTok && tok === consoleTok)));
  }

  getStatusSnapshot() {
    const active = this.getActiveSession();
    return {
      ok: true,
      port: this.port,
      settings: this.settings,
      activeGame: active ? active.game : null,
      activeSessionId: active ? active.id : null,
      sessions: [...this.sessions.values()].map((s) => s.toPublicSummary()),
      mc: this.mcManager ? this.mcManager.getStatus() : null,
    };
  }

  async start() {
    const sendJson = (res, obj, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const readBody = async (req) => {
      const chunks = [];
      let n = 0;
      for await (const c of req) {
        n += c.length;
        if (n > 256 * 1024) throw new Error('body too large');
        chunks.push(c);
      }
      const s = Buffer.concat(chunks).toString('utf8').trim();
      return s ? JSON.parse(s) : {};
    };

    this.server = http.createServer(async (req, res) => {
      try {
        const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
        const p = urlObj.pathname;

        if (req.method === 'GET' && p === '/health') {
          return sendJson(res, {
            ok: true,
            activeGame: this.getActiveSession()?.game || null,
            sessionCount: this.sessions.size,
            mcState: this.mcManager?.state || 'disabled',
          });
        }

        if (!this._checkHttpAuth(req, urlObj)) {
          return sendJson(res, { ok: false, error: 'unauthorized' }, 401);
        }

        if (req.method === 'GET' && p === '/api/game/status') {
          return sendJson(res, this.getStatusSnapshot());
        }

        if (req.method === 'GET' && p === '/api/game/token') {
          return sendJson(res, { ok: true, token: this.gameToken });
        }

        if (req.method === 'POST' && p === '/api/game/token/rotate') {
          this.gameToken = ensureGameLinkToken(true);
          log('🔑 已轮换 Neuro-API Game Link Token');
          return sendJson(res, { ok: true, token: this.gameToken });
        }

        if (req.method === 'POST' && p === '/api/game/config') {
          const body = await readBody(req);
          if (typeof body.autonomous === 'boolean') this.settings.autonomous = body.autonomous;
          if (typeof body.voiceCommentary === 'boolean') this.settings.voiceCommentary = body.voiceCommentary;
          if (typeof body.inGameChat === 'boolean') this.settings.inGameChat = body.inGameChat;
          if (Number.isFinite(Number(body.autonomousIntervalSec))) {
            this.settings.autonomousIntervalSec = Math.max(10, Math.min(120, Math.round(Number(body.autonomousIntervalSec))));
          }
          this._savePersistedSettings();
          return sendJson(res, { ok: true, settings: this.settings });
        }

        if (req.method === 'POST' && p === '/api/game/command') {
          const body = await readBody(req);
          const out = await this.handleHumanCommand({
            from: body.from || '主人',
            text: body.text || '',
            via: body.via || 'voice',
            gameHint: body.game || '',
          });
          return sendJson(res, out, out.ok ? 200 : 400);
        }

        if (req.method === 'POST' && p === '/api/game/action') {
          const body = await readBody(req);
          const session = this.getActiveSession(body.game || '');
          if (!session) return sendJson(res, { ok: false, error: '没有已连接的游戏' }, 404);
          const actName = String(body.name || '').trim();
          if (!session.actions.has(actName)) return sendJson(res, { ok: false, error: `动作 ${actName} 未注册` }, 400);
          const check = sanitizeActionArgs(session.actions.get(actName)?.schema, body.args || {});
          if (!check.ok) return sendJson(res, { ok: false, error: check.error }, 400);
          const r = await session.dispatchAction(actName, check.args, 20000);
          session.addActionLog({ name: actName, args: check.args, success: r.success, message: r.message, say: '[手动触发]' });
          return sendJson(res, { ok: r.success, ...r });
        }

        // ── MC 自休眠私服管理路由 ──
        if (this.mcManager && p.startsWith('/api/mc/')) {
          const body = req.method === 'POST' ? await readBody(req) : {};
          if (req.method === 'GET' && p === '/api/mc/status') {
            return sendJson(res, { ok: true, mc: this.mcManager.getStatus() });
          }
          if (req.method === 'POST' && p === '/api/mc/wake') {
            if (body.knockIp) this.mcManager.allowIp(body.knockIp, Number(body.hours || 24), body.note || 'portal');
            const r = await this.mcManager.wake({ reason: body.reason || 'portal', spawnBot: body.spawnBot !== false });
            return sendJson(res, { ok: true, ...r, mc: this.mcManager.getStatus() });
          }
          if (req.method === 'POST' && p === '/api/mc/stop') {
            const r = await this.mcManager.stopServer(body.reason || 'manual_stop');
            return sendJson(res, { ok: true, ...r, mc: this.mcManager.getStatus() });
          }
          if (req.method === 'POST' && p === '/api/mc/access') {
            const r = this.mcManager.updateAccess(body);
            return sendJson(res, { ok: true, ...r, mc: this.mcManager.getStatus() });
          }
          if (req.method === 'POST' && p === '/api/mc/bot') {
            const act = String(body.action || 'spawn');
            const r = act === 'stop'
              ? await this.mcManager.stopBot('manual')
              : await this.mcManager.startBot();
            return sendJson(res, { ok: true, ...r, mc: this.mcManager.getStatus() });
          }
        }

        sendJson(res, { ok: false, error: 'not found' }, 404);
      } catch (err) {
        sendJson(res, { ok: false, error: String(err?.message ?? err) }, 500);
      }
    });

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    this.server.on('upgrade', (req, socket, head) => {
      const urlObj = new URL(req.url || '/', 'http://127.0.0.1');
      if (urlObj.pathname !== '/ws/neuro' && urlObj.pathname !== '/ws/game' && urlObj.pathname !== '/') {
        socket.destroy();
        return;
      }
      if (!this._checkWsAuth(req, urlObj)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this._handleWsConnection(ws, req);
      });
    });

    await new Promise((resolve) => this.server.listen(this.port, '127.0.0.1', resolve));
    log(`🚀 统一游戏伴侣内核 & Neuro-API 网关已监听 http://127.0.0.1:${this.port} | ws://127.0.0.1:${this.port}/ws/neuro`);

    this.autoTimer = setInterval(() => {
      this._autonomousTick().catch(() => {});
    }, 5000);
    this.autoTimer.unref?.();

    if (this.mcManager) {
      await this.mcManager.startProxy();
    }
  }

  async stop() {
    if (this.autoTimer) clearInterval(this.autoTimer);
    if (this.mcManager) await this.mcManager.shutdownAll().catch(() => {});
    for (const s of this.sessions.values()) {
      try { s.ws.close(); } catch {}
      s.cleanup();
    }
    this.sessions.clear();
    if (this.server) await new Promise((r) => this.server.close(r));
  }
}

// ── 独立启动入口（支持自动挂载 MC 自休眠管理器） ──
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const cfg = loadBridgeConfig();
  let mcManager = null;
  if (cfg.enableMcManager) {
    try {
      const { McServerManager } = await import('./mc-server-manager.mjs');
      mcManager = new McServerManager({
        hubPort: cfg.port,
        botName: cfg.mcBotName,
        log: (...a) => console.log(new Date().toISOString().slice(11, 19), '[mc-mgr]', ...a),
      });
    } catch (err) {
      log(`加载 mc-server-manager 失败（将以纯 Neuro-API 模式运行）: ${err?.message ?? err}`);
    }
  }
  const hub = new GameHub({ port: cfg.port, mcManager });
  await hub.start();
  const shutdown = async (sig) => {
    log(`收到 ${sig}，正在优雅关闭游戏网关与 MC 托管...`);
    await hub.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
