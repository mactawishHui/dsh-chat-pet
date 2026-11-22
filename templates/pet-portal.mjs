/**
 * pet-portal.mjs — 小鲸鲸统一远程 HTTPS 管理台与物理三通道看屏网关（ESM）
 *
 * 安全架构（可安全部署至公网 IP:8443 或后续绑定域名）：
 *   1. 全站强制 HTTPS（支持自带正式证书或自动生成带 IP SAN 的自签 TLS 证书）
 *   2. 账号密码登录（scrypt 加盐哈希存于 state/portal-auth.json，0600 权限，永不进仓库）
 *   3. 防爆破限流（单 IP 10 分钟内失败 5 次锁定 10 分钟）+ HttpOnly/Secure/SameSite=Strict Cookie + Origin 校验
 *   4. 最小权限网关：底层 qq-bridge(127.0.0.1:3100) 与 qq-call(127.0.0.1:3300) 仍死守本机回环，
 *      内部 console-token 绝不下发给浏览器，仅暴露白名单管理、状态总览与受鉴权看屏/三通道 WebSocket 代理
 *   5. 手机 + 电脑自适应单页：出门用手机秒加好友白名单，在家用电脑 Chrome/Edge 直开 1080p 物理三通道看屏
 */

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { WebSocket, WebSocketServer } from 'ws';

const BRIDGE_CONFIG_PATH = process.env.QQ_BRIDGE_CONFIG || '/opt/qq-bridge/config.json';
const STATE_DIR = process.env.QQ_BRIDGE_STATE_DIR || '/opt/qq-bridge/state';
const CONSOLE_TOKEN_PATH = path.join(STATE_DIR, 'console-token');
const AUTH_FILE_PATH = path.join(STATE_DIR, 'portal-auth.json');
const TLS_DIR = path.join(STATE_DIR, 'portal-tls');
const DEFAULT_CERT_PATH = path.join(TLS_DIR, 'cert.pem');
const DEFAULT_KEY_PATH = path.join(TLS_DIR, 'key.pem');

const SESSION_COOKIE = 'pet_portal_sid';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), '[pet-portal]', ...args);

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(BRIDGE_CONFIG_PATH, 'utf8'));
  const portal = raw.portal || {};
  return {
    raw,
    port: Number(process.env.PORTAL_PORT || portal.port || 8443),
    host: String(process.env.PORTAL_HOST || portal.host || '0.0.0.0'),
    publicHost: String(process.env.PORTAL_PUBLIC_HOST || portal.publicHost || '').trim(),
    certPath: String(process.env.PORTAL_CERT || portal.certPath || DEFAULT_CERT_PATH),
    keyPath: String(process.env.PORTAL_KEY || portal.keyPath || DEFAULT_KEY_PATH),
    bridgeBase: `http://127.0.0.1:${Number(raw.consolePort || raw.console?.port || 3100)}`,
    callPort: Number(raw.call?.port || 3300),
    callBase: `http://127.0.0.1:${Number(raw.call?.port || 3300)}`,
    onebotHttp: String(raw.snowluma?.httpUrl || `http://127.0.0.1:${Number(raw.snowluma?.httpPort || 3000)}`).replace(/\/+$/, ''),
    onebotToken: String(raw.snowluma?.accessToken || raw.snowluma?.token || '')
  };
}

function readConsoleToken() {
  try { return fs.readFileSync(CONSOLE_TOKEN_PATH, 'utf8').trim(); } catch { return ''; }
}

function hashPassword(password, saltHex = crypto.randomBytes(16).toString('hex')) {
  const derived = crypto.scryptSync(String(password), saltHex, 64).toString('hex');
  return { salt: saltHex, hash: derived };
}

function verifyPassword(password, authRecord) {
  if (!authRecord?.salt || !authRecord?.hash) return false;
  const candidate = Buffer.from(crypto.scryptSync(String(password), authRecord.salt, 64).toString('hex'), 'hex');
  const expected = Buffer.from(String(authRecord.hash), 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function saveAuthRecord(username, password) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const { salt, hash } = hashPassword(password);
  const data = { username: String(username || 'admin').trim() || 'admin', salt, hash, updatedAt: new Date().toISOString() };
  const tmp = `${AUTH_FILE_PATH}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, AUTH_FILE_PATH);
  try { fs.chmodSync(AUTH_FILE_PATH, 0o600); } catch {}
  return data;
}

function loadOrInitAuth() {
  if (fs.existsSync(AUTH_FILE_PATH)) {
    return JSON.parse(fs.readFileSync(AUTH_FILE_PATH, 'utf8'));
  }
  // 首次启动自动生成高强度随机初始密码（不含易混淆字符）
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let pwd = '';
  const bytes = crypto.randomBytes(14);
  for (let i = 0; i < 14; i++) pwd += chars[bytes[i] % chars.length];
  const rec = saveAuthRecord('admin', pwd);
  const initHintPath = path.join(STATE_DIR, 'portal-initial-password.txt');
  fs.writeFileSync(initHintPath, `username: ${rec.username}\npassword: ${pwd}\n`, { mode: 0o600 });
  log(`首次初始化登录账号：${rec.username}，随机初始密码已写入 ${initHintPath}（权限 0600，登录后建议修改并删除该文件）`);
  return rec;
}

function ensureTlsCert(cfg) {
  if (fs.existsSync(cfg.certPath) && fs.existsSync(cfg.keyPath)) {
    return {
      cert: fs.readFileSync(cfg.certPath),
      key: fs.readFileSync(cfg.keyPath),
      certPath: cfg.certPath
    };
  }
  fs.mkdirSync(path.dirname(cfg.certPath), { recursive: true });
  const sanItems = ['DNS:localhost', 'IP:127.0.0.1'];
  if (cfg.publicHost) {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(cfg.publicHost)) sanItems.push(`IP:${cfg.publicHost}`);
    else sanItems.push(`DNS:${cfg.publicHost}`);
  }
  const cn = cfg.publicHost || 'localhost';
  const extCfg = path.join(TLS_DIR, 'openssl.cnf');
  fs.writeFileSync(extCfg, [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = v3_req',
    'prompt = no',
    '[dn]',
    `CN = ${cn}`,
    'O = DSH Pet Portal',
    '[v3_req]',
    'basicConstraints = critical, CA:FALSE',
    'keyUsage = critical, digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    `subjectAltName = ${sanItems.join(', ')}`
  ].join('\n') + '\n', { mode: 0o600 });

  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
    '-nodes', '-days', '3650',
    '-keyout', cfg.keyPath,
    '-out', cfg.certPath,
    '-config', extCfg
  ], { stdio: 'ignore' });
  try { fs.chmodSync(cfg.keyPath, 0o600); } catch {}
  log(`已生成 TLS 证书 (CN=${cn}, SAN=${sanItems.join(', ')})`);
  return {
    cert: fs.readFileSync(cfg.certPath),
    key: fs.readFileSync(cfg.keyPath),
    certPath: cfg.certPath
  };
}

// 支持 CLI 修改密码：node pet-portal.mjs --set-password <newPassword> [username]
if (process.argv.includes('--set-password')) {
  const idx = process.argv.indexOf('--set-password');
  const nextPwd = String(process.argv[idx + 1] || '').trim();
  const nextUser = String(process.argv[idx + 2] || 'admin').trim() || 'admin';
  if (nextPwd.length < 8) {
    console.error('密码长度至少 8 位');
    process.exit(1);
  }
  saveAuthRecord(nextUser, nextPwd);
  try { fs.rmSync(path.join(STATE_DIR, 'portal-initial-password.txt'), { force: true }); } catch {}
  console.log(`已更新账号「${nextUser}」的登录密码。`);
  process.exit(0);
}

function parseCookies(req) {
  const out = {};
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function getClientIp(req) {
  return String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function setSecurityHeaders(res, isHtml = false) {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!isHtml) res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res, data, status = 200, extraHeaders = {}) {
  setSecurityHeaders(res, false);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req, maxBytes = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > maxBytes) throw new Error('请求体过大');
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

function checkSameOrigin(req) {
  const origin = String(req.headers.origin || '').trim();
  if (!origin) return true;
  const host = String(req.headers.host || '').trim();
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

async function fetchJsonSafe(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(opts.timeoutMs || 6000), ...opts });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, json, text };
}

function renderPortalHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<title>小鲸鲸 · 远程管理台</title>
<style>
  :root {
    --bg:#0b0f17; --card:#131a26; --card2:#192233; --line:#273247;
    --text:#eef3fb; --muted:#8e9db8; --accent:#4e9eff; --accent2:#7c5cff;
    --ok:#36c76c; --warn:#e6a23c; --err:#f56565;
  }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; background:radial-gradient(circle at top,#141d2e 0%,var(--bg) 55%); color:var(--text); font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,"PingFang SC",sans-serif; min-height:100vh; }
  .hidden { display:none !important; }
  .toast { position:fixed; top:16px; left:50%; transform:translateX(-50%); background:#1c273b; border:1px solid var(--accent); color:#fff; padding:10px 16px; border-radius:12px; font-size:13px; box-shadow:0 12px 32px rgba(0,0,0,.45); z-index:999; opacity:0; pointer-events:none; transition:.22s; max-width:92vw; text-align:center; }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(2px); }
  .toast.err { border-color:var(--err); background:#2e161b; }
  .toast.ok { border-color:var(--ok); background:#132b20; }

  /* 登录页 */
  .loginWrap { min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px; }
  .loginCard { width:100%; max-width:380px; background:var(--card); border:1px solid var(--line); border-radius:20px; padding:28px 24px; box-shadow:0 20px 60px rgba(0,0,0,.45); }
  .loginCard h1 { margin:0 0 6px; font-size:22px; display:flex; align-items:center; gap:8px; }
  .loginCard .sub { font-size:13px; color:var(--muted); margin-bottom:22px; line-height:1.5; }
  .field { margin-bottom:14px; }
  .field label { display:block; font-size:12px; color:var(--muted); margin-bottom:6px; }
  input[type=text], input[type=password], input[type=search], select {
    width:100%; background:#0b1019; color:var(--text); border:1px solid var(--line);
    border-radius:11px; padding:11px 13px; font-size:15px; outline:none; transition:.15s;
  }
  input:focus, select:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(78,158,255,.15); }
  button {
    background:#212c40; color:var(--text); border:1px solid var(--line); border-radius:11px;
    padding:9px 14px; font-size:14px; cursor:pointer; transition:.15s; font-weight:500;
  }
  button:hover:not(:disabled) { border-color:var(--accent); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  button.primary { background:linear-gradient(135deg,#2d7ef7,#5a67f2); border-color:#4e9eff; color:#fff; font-weight:600; }
  button.okBtn { background:#183a28; border-color:#2e8555; color:#7cf0a7; }
  button.danger { background:#3b181d; border-color:#8a2c35; color:#ff9ea6; }
  button.sm { padding:6px 10px; font-size:12px; border-radius:8px; }
  button.active { background:#1f6feb33; border-color:var(--accent); color:#8bc2ff; }
  .fullBtn { width:100%; padding:12px; font-size:15px; }

  /* 主界面 */
  .shell { max-width:1100px; margin:0 auto; padding:14px 14px 36px; }
  .topbar { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
  .brand { display:flex; align-items:center; gap:10px; }
  .brand h1 { margin:0; font-size:19px; }
  .pills { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .pill { font-size:12px; padding:4px 10px; border-radius:999px; border:1px solid var(--line); color:var(--muted); background:var(--card); white-space:nowrap; }
  .pill.ok { color:var(--ok); border-color:#36c76c55; background:#36c76c14; }
  .pill.warn { color:var(--warn); border-color:#e6a23c55; background:#e6a23c14; }
  .pill.accent { color:#8bc2ff; border-color:#4e9eff55; background:#4e9eff14; }

  .tabs { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; background:var(--card); border:1px solid var(--line); padding:6px; border-radius:14px; margin-bottom:16px; position:sticky; top:8px; z-index:20; backdrop-filter:blur(10px); }
  .tabBtn { background:transparent; border:1px solid transparent; padding:10px 8px; border-radius:10px; color:var(--muted); font-size:14px; font-weight:600; }
  .tabBtn.active { background:linear-gradient(135deg,#214175,#2d2b66); border-color:#4e9eff66; color:#fff; }

  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:14px; }
  .card h2 { margin:0 0 6px; font-size:16px; display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }
  .card .hint { font-size:12px; color:var(--muted); margin-bottom:12px; line-height:1.5; }
  .row { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .grid2 { display:grid; grid-template-columns:1.15fr 1fr; gap:14px; }
  @media (max-width:840px) { .grid2 { grid-template-columns:1fr; } }

  /* 白名单标签与好友列表 */
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px; }
  .chip { display:inline-flex; align-items:center; gap:7px; padding:7px 11px; border-radius:999px; background:var(--card2); border:1px solid var(--line); font-size:13px; }
  .chip .qq { color:var(--muted); font-size:12px; }
  .chip button { padding:2px 7px; font-size:12px; border-radius:999px; background:#2b1b22; border-color:#69303b; color:#ff9ea6; }
  .empty { font-size:13px; color:var(--muted); padding:8px 0; }

  .pickerList { max-height:280px; overflow-y:auto; margin-top:10px; display:flex; flex-direction:column; gap:6px; }
  .pickerItem { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:9px 11px; background:#0d131f; border:1px solid var(--line); border-radius:11px; }
  .pickerInfo { min-width:0; }
  .pickerName { font-size:14px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pickerSub { font-size:12px; color:var(--muted); }
  .pickerActs { display:flex; gap:6px; flex-shrink:0; }

  .switchRow { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; background:#0d131f; border:1px solid var(--line); border-radius:12px; margin-top:10px; }
  .switchRow span { font-size:13px; }
  .switchRow small { display:block; font-size:11px; color:var(--muted); margin-top:2px; }
  input[type=checkbox].toggle { width:44px; height:24px; appearance:none; background:#2b364d; border-radius:999px; position:relative; cursor:pointer; outline:none; transition:.2s; flex-shrink:0; }
  input[type=checkbox].toggle:checked { background:var(--ok); }
  input[type=checkbox].toggle::after { content:''; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition:.2s; }
  input[type=checkbox].toggle:checked::after { transform:translateX(20px); }

  /* 看屏区 */
  .previewBox { position:relative; background:#05080f; border:1px solid var(--line); border-radius:12px; overflow:hidden; aspect-ratio:16/9; display:flex; align-items:center; justify-content:center; margin-top:10px; }
  video { width:100%; height:100%; object-fit:contain; display:none; }
  .placeholder { color:var(--muted); font-size:13px; text-align:center; padding:16px; line-height:1.6; }
  .meter { height:6px; background:#212c40; border-radius:999px; overflow:hidden; margin-top:8px; }
  .meter > div { height:100%; width:0%; background:linear-gradient(90deg,#36c76c,#4e9eff,#f0883e); transition:width .18s; }
  .meter.audio > div { background:linear-gradient(90deg,#a371f7,#4e9eff,#36c76c); }
  .stats { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin-top:6px; }
  .subTicker { margin-top:10px; padding:9px 11px; background:#0b1019; border:1px solid var(--line); border-radius:10px; font-size:12px; color:#d5e0f2; line-height:1.5; min-height:40px; }
  .subTicker .tag { color:#b388ff; font-weight:600; margin-right:6px; }
  .chatBox { height:340px; overflow-y:auto; background:#0b1019; border:1px solid var(--line); border-radius:12px; padding:12px; display:flex; flex-direction:column; gap:9px; }
  .msg { font-size:13px; line-height:1.55; padding:8px 11px; border-radius:11px; max-width:92%; word-break:break-word; }
  .msg.ai { background:#1d3b66; border:1px solid #4e9eff44; align-self:flex-start; }
  .msg.me { background:#212c40; border:1px solid var(--line); align-self:flex-end; }
  .msg.sys { font-size:12px; color:var(--muted); align-self:center; padding:2px 6px; }
  .askRow { display:flex; gap:8px; margin-top:10px; }
  .askRow input { flex:1; }
  label.chk { font-size:12px; color:var(--muted); display:flex; align-items:center; gap:6px; cursor:pointer; }
  .cmdBox { background:#0b1019; border:1px solid var(--line); border-radius:12px; padding:12px; font-size:13px; line-height:1.8; color:#d5e0f2; }
  .cmdBox code { background:#1e293d; padding:2px 6px; border-radius:6px; color:#8bc2ff; font-size:12px; }
  .callItem { padding:10px 12px; background:#0b1019; border:1px solid var(--line); border-radius:11px; margin-top:8px; font-size:13px; line-height:1.5; }
  .callItem .meta { font-size:11px; color:var(--muted); margin-bottom:4px; }
</style>
</head>
<body>
<div id="toast" class="toast"></div>

<!-- 登录界面 -->
<div id="loginView" class="loginWrap">
  <div class="loginCard">
    <h1>🐳 小鲸鲸 · 远程管理台</h1>
    <div class="sub">HTTPS 加密通道 · 手机随时加减白名单，电脑直开 1080p 物理三通道看屏</div>
    <form id="loginForm">
      <div class="field">
        <label>管理员账号</label>
        <input id="loginUser" type="text" value="admin" autocomplete="username" required />
      </div>
      <div class="field">
        <label>登录密码</label>
        <input id="loginPass" type="password" placeholder="输入管理密码" autocomplete="current-password" required />
      </div>
      <button id="btnLogin" type="submit" class="primary fullBtn">登录管理台</button>
    </form>
  </div>
</div>

<!-- 已登录主界面 -->
<div id="appView" class="shell hidden">
  <div class="topbar">
    <div class="brand">
      <h1>🐳 小鲸鲸控制台</h1>
    </div>
    <div class="pills">
      <span id="topBridgePill" class="pill">检测中…</span>
      <span id="topCallPill" class="pill">通话待机</span>
      <span id="topQuotaPill" class="pill">今日 0min</span>
    </div>
  </div>

  <div class="tabs">
    <button class="tabBtn active" data-tab="wl">👥 白名单</button>
    <button class="tabBtn" data-tab="screen">🖥️ 看屏三通道</button>
    <button class="tabBtn" data-tab="status">⚙️ 状态与安全</button>
  </div>

  <!-- TAB 1: 白名单管理 -->
  <section id="tab-wl">
    <div class="card">
      <h2>
        <span>🔍 快捷添加朋友（搜昵称 / 输 QQ 号）</span>
        <button id="btnRefreshWl" class="sm">刷新好友列表</button>
      </h2>
      <div class="hint">点一下即时热生效，不用重启服务；出门在外朋友想试聊或试打电话，1 秒就能放行。</div>
      <div class="row">
        <input id="manualQqInput" type="text" inputmode="numeric" placeholder="输入 QQ 号或搜索下方好友昵称/备注…" style="flex:1;min-width:200px" />
        <button id="btnAddChatManual" class="sm primary">+ 聊天白名单</button>
        <button id="btnAddCallManual" class="sm okBtn">+ 语音白名单</button>
        <button id="btnAddBothManual" class="sm">+ 聊天+语音全加</button>
      </div>
      <div id="friendPicker" class="pickerList"></div>
    </div>

    <div class="grid2">
      <div class="card">
        <h2><span>💬 QQ 私聊白名单</span><span id="chatCountPill" class="pill accent">0 人</span></h2>
        <div class="hint">在列表里的好友可以私聊小鲸鲸（管理员始终放行）。</div>
        <div id="privateChips" class="chips"></div>
      </div>

      <div class="card">
        <h2><span>📞 语音通话白名单</span><span id="callCountPill" class="pill ok">0 人</span></h2>
        <div class="hint">只有名单内的好友打来 QQ 语音或屏幕共享邀请时才会自动接听。</div>
        <div id="callChips" class="chips"></div>
        <div class="switchRow">
          <div><span>自动接听好友语音来电</span><small>关闭后任何人来电都会静默不接</small></div>
          <input id="chkCallEnabled" type="checkbox" class="toggle" />
        </div>
        <div class="switchRow">
          <div><span>允许群语音通话</span><small>强烈建议保持关闭，防止多人混音刷额度</small></div>
          <input id="chkAllowGroupCall" type="checkbox" class="toggle" />
        </div>
      </div>
    </div>

    <div class="card">
      <h2><span>👨‍👩‍👧‍👦 QQ 群聊白名单</span><span id="groupCountPill" class="pill accent">0 个群</span></h2>
      <div class="hint">输入群号或从下方已加入的 QQ 群里一键放行 / 移出。</div>
      <div class="row">
        <input id="manualGroupInput" type="text" inputmode="numeric" placeholder="输入 QQ 群号或搜索群名…" style="flex:1;min-width:180px" />
        <button id="btnAddGroupManual" class="sm primary">+ 添加群白名单</button>
      </div>
      <div id="groupChips" class="chips"></div>
      <div id="groupPicker" class="pickerList" style="max-height:200px"></div>
    </div>
  </section>

  <!-- TAB 2: 看屏与物理三通道 -->
  <section id="tab-screen" class="hidden">
    <div class="grid2">
      <div class="card">
        <h2>
          <span>🖥️ 物理三通道推屏端</span>
          <span id="wsPill" class="pill">连接中…</span>
        </h2>
        <div class="hint">通道 1 走普通 QQ 语音只听你说话 · 通道 2 本页独立推 1080p 画面与视频音频（零 SSH、零落盘）</div>
        <div id="mobileScreenTip" class="subTicker hidden" style="margin-top:0;margin-bottom:10px;border-color:#e6a23c66">
          📱 当前设备浏览器不支持系统录屏；你可以在这里直接切换陪看模式、开关屏幕音轨、文字互动或看实时吐槽流。电脑 Chrome/Edge 打开同一网址即可一键开启 1080p 物理三通道。
        </div>
        <div id="desktopShareBar" class="row" style="margin-bottom:10px">
          <button id="btnShare" class="primary" disabled>选择屏幕 / 标签页</button>
          <button id="btnStop" class="danger" disabled>停止共享</button>
          <select id="resSel" style="width:auto">
            <option value="960">720p 省流</option>
            <option value="1280" selected>1080p 超清</option>
          </select>
          <input id="labelInput" type="text" placeholder="标签(如 电影/游戏)" style="width:125px" />
        </div>
        <div id="desktopAudioBar" class="row" style="justify-content:space-between;margin-bottom:10px">
          <label class="chk"><input id="wantAudioChk" type="checkbox" checked /> 同时采集屏幕/标签页独立音频（三通道）</label>
          <button id="btnToggleAudio" class="sm">🔊 屏幕音轨：开</button>
        </div>
        <div class="row" style="margin-bottom:8px">
          <span style="font-size:12px;color:var(--muted)">模式：</span>
          <button class="sm modeBtn active" data-mode="on_demand">随问随看</button>
          <button class="sm modeBtn" data-mode="watch_along">主动陪看吐槽</button>
          <button class="sm modeBtn" data-mode="off">暂停看屏</button>
          <span id="callFusePill" class="pill">独立陪看模式</span>
          <span id="audioPill" class="pill">音轨待机</span>
        </div>
        <div class="previewBox">
          <video id="vid" autoplay muted playsinline></video>
          <div id="ph" class="placeholder">点「选择屏幕 / 标签页」并在弹窗底部勾选「分享音频」即可开启物理三通道<br/>建议戴耳机打普通 QQ 语音，人声与视频声彻底互不干扰</div>
        </div>
        <div class="meter" title="画面帧变化幅度"><div id="diffBar"></div></div>
        <div class="meter audio" title="通道 2 屏幕独立音轨电平"><div id="audioBar"></div></div>
        <div class="stats">
          <span id="statLeft">待机</span>
          <span id="statRight">已推送 0 帧</span>
        </div>
        <div class="subTicker"><span class="tag">🎬 通道 2 屏幕台词</span><span id="subText">等待屏幕音频输入（仅作背景记忆，绝不打断你或小鲸鲸）</span></div>
      </div>

      <div class="card">
        <h2><span>💬 陪看互动与吐槽流</span><button id="btnClearLog" class="sm">清屏</button></h2>
        <div class="hint">QQ 语音通话中直接开口聊即可；没打电话也能在这儿问她，勾上语音可直接发声。</div>
        <div id="chat" class="chatBox"></div>
        <div class="askRow">
          <input id="askInput" type="text" placeholder="问点啥：比如「刚才他说啥」「这手牌怎么打」…" />
          <button id="btnAsk" class="primary">发送</button>
        </div>
        <div class="row" style="margin-top:9px">
          <label class="chk"><input id="ttsChk" type="checkbox" checked /> 独立模式下同步播报小鲸鲸语音</label>
        </div>
      </div>
    </div>
  </section>

  <!-- TAB 3: 状态与安全 -->
  <section id="tab-status" class="hidden">
    <div class="grid2">
      <div class="card">
        <h2><span>⚡ 外出 QQ 私聊快捷口令</span></h2>
        <div class="hint">只对管理员 QQ 生效，别人发无效；出门在外不想开网页时，直接给小鲸鲸发私聊即可：</div>
        <div class="cmdBox">
          <code>/全白名单 加 QQ号</code> — 同时加入私聊 + 语音通话白名单<br/>
          <code>/全白名单 删 QQ号</code> — 同时移出私聊 + 语音通话白名单<br/>
          <code>/白名单 加 QQ号</code> / <code>/白名单 删 QQ号</code> — 仅增删私聊白名单<br/>
          <code>/通话白名单 加 QQ号</code> / <code>/通话白名单 删 QQ号</code> — 仅增删语音白名单<br/>
          <code>/群白名单 加 群号</code> / <code>/群白名单 删 群号</code> — 增删群聊白名单<br/>
          <code>/白名单</code> — 查看当前全部白名单列表
        </div>
      </div>

      <div class="card">
        <h2><span>🔐 账号与安全</span><button id="btnLogout" class="sm danger">退出登录</button></h2>
        <div class="hint">修改远程管理台登录密码（至少 8 位）；修改后其他设备会话自动失效。</div>
        <form id="pwdForm">
          <div class="field"><input id="oldPwd" type="password" placeholder="当前密码" required /></div>
          <div class="field"><input id="newPwd" type="password" placeholder="新密码（至少 8 位）" minlength="8" required /></div>
          <div class="row">
            <button type="submit" class="primary">更新密码</button>
            <a href="/auth/cert.crt" download="dsh-pet-portal.crt"><button type="button">下载自签证书 (.crt)</button></a>
          </div>
        </form>
        <div class="hint" style="margin-top:10px;margin-bottom:0">
          提示：在 Mac 上双击下载的 <code>.crt</code> 加入「系统钥匙串」并设为「始终信任」，Chrome 打开本地址就会变永久绿锁。以后绑定正式域名后可无缝切换免费 Let's Encrypt 证书。
        </div>
      </div>
    </div>

    <div class="card">
      <h2><span>📞 最近通话记录与摘要</span><button id="btnRefreshOverview" class="sm">刷新</button></h2>
      <div id="recentCallsList"></div>
    </div>
  </section>
</div>

<canvas id="capCanvas" style="display:none"></canvas>
<canvas id="diffCanvas" width="16" height="9" style="display:none"></canvas>
<script>
const $ = (id) => document.getElementById(id);
let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    credentials: 'same-origin',
    ...opts
  });
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (res.status === 401) {
    showLogin();
    throw new Error('登录已失效，请重新登录');
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

// ── 状态数据 ──
let wlState = { chatPrivate: [], chatGroups: [], callWhitelist: [], callEnabled: true, allowGroupCall: false, ownerQQ: null, friends: [], groups: [] };
let friendMap = new Map();
let groupMap = new Map();

function showLogin() {
  $('appView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  if (ws) { try { ws.close(); } catch {} ws = null; }
}
function showApp() {
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  const canCapture = Boolean(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  $('mobileScreenTip').classList.toggle('hidden', canCapture);
  $('desktopShareBar').classList.toggle('hidden', !canCapture);
  $('desktopAudioBar').classList.toggle('hidden', !canCapture);
  loadOverview();
  loadWhitelists();
  connectScreenWs();
}

// Tab 切换
document.querySelectorAll('.tabBtn').forEach(btn => {
  btn.onclick = () => {
    const t = btn.dataset.tab;
    document.querySelectorAll('.tabBtn').forEach(b => b.classList.toggle('active', b === btn));
    ['wl', 'screen', 'status'].forEach(id => $('tab-' + id).classList.toggle('hidden', id !== t));
    if (t === 'status') loadOverview();
    if (t === 'wl') loadWhitelists();
  };
});

// 登录与退出
$('loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('btnLogin').disabled = true;
  try {
    await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('loginUser').value.trim(), password: $('loginPass').value })
    });
    $('loginPass').value = '';
    toast('登录成功');
    showApp();
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    $('btnLogin').disabled = false;
  }
};
$('btnLogout').onclick = async () => {
  try { await api('/auth/logout', { method: 'POST', body: '{}' }); } catch {}
  stopShare();
  showLogin();
  toast('已退出登录');
};
$('pwdForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ oldPassword: $('oldPwd').value, newPassword: $('newPwd').value })
    });
    $('oldPwd').value = ''; $('newPwd').value = '';
    toast('密码已更新');
  } catch (err) {
    toast(err.message, 'err');
  }
};

// ── 总览状态 ──
async function loadOverview() {
  try {
    const d = await api('/api/overview');
    $('topBridgePill').textContent = d.bridgeOnline ? '🟢 QQ 在线' : '🔴 桥接离线';
    $('topBridgePill').className = 'pill ' + (d.bridgeOnline ? 'ok' : 'warn');
    const inCall = d.call?.state === 'in_call';
    $('topCallPill').textContent = inCall ? ('🎙️ 通话中 · ' + (d.call.currentCall?.callerName || '')) : '📞 通话待机';
    $('topCallPill').className = 'pill ' + (inCall ? 'ok' : '');
    const usedMin = Math.round((d.call?.dailyUsedSec || 0) / 60);
    const limMin = d.call?.dailyLimitMin || 180;
    $('topQuotaPill').textContent = '今日通话 ' + usedMin + '/' + limMin + 'min';

    const list = Array.isArray(d.call?.recentCalls) ? d.call.recentCalls.slice().reverse() : [];
    const box = $('recentCallsList');
    if (!list.length) {
      box.innerHTML = '<div class="empty">暂无最近通话记录</div>';
    } else {
      box.innerHTML = list.map(c => {
        const dt = c.startedAt ? new Date(c.startedAt).toLocaleString('zh-CN', { hour12: false }) : '';
        const dur = Math.max(1, Math.round((c.durationSec || 0) / 60)) + ' 分钟';
        return '<div class="callItem"><div class="meta">' + esc(c.callerName || c.callerId) + ' · ' + esc(dt) + ' · ' + dur + ' · ' + (c.turns || 0) + ' 轮 · 平均 ' + (c.avgLatencyMs || 0) + 'ms</div><div>' + esc(c.summary || '（无摘要）') + '</div></div>';
      }).join('');
    }
  } catch {}
}
$('btnRefreshOverview').onclick = loadOverview;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function friendLabel(uin) {
  const f = friendMap.get(String(uin));
  if (!f) return '';
  return f.remark || f.nickname || '';
}
function groupLabel(gid) {
  const g = groupMap.get(String(gid));
  return g ? g.groupName : '';
}

// ── 白名单渲染与热更新 ──
async function loadWhitelists(forceRefresh = false) {
  try {
    const d = await api('/api/whitelists' + (forceRefresh ? '?refresh=1' : ''));
    wlState = {
      chatPrivate: (d.chat?.allow?.private || []).map(String),
      chatGroups: (d.chat?.allow?.groups || []).map(String),
      callWhitelist: (d.call?.whitelist || []).map(String),
      callEnabled: d.call?.enabled !== false,
      allowGroupCall: d.call?.allowGroupCall === true,
      ownerQQ: d.chat?.ownerQQ ? String(d.chat.ownerQQ) : null,
      friends: Array.isArray(d.friends) ? d.friends : [],
      groups: Array.isArray(d.groups) ? d.groups : []
    };
    friendMap = new Map(wlState.friends.map(f => [String(f.uin), f]));
    groupMap = new Map(wlState.groups.map(g => [String(g.groupId), g]));
    renderWhitelists();
  } catch (err) {
    toast('读取白名单失败：' + err.message, 'err');
  }
}

function renderWhitelists() {
  $('chatCountPill').textContent = wlState.chatPrivate.length + ' 人';
  $('callCountPill').textContent = wlState.callWhitelist.length + ' 人';
  $('groupCountPill').textContent = wlState.chatGroups.length + ' 个群';
  $('chkCallEnabled').checked = wlState.callEnabled;
  $('chkAllowGroupCall').checked = wlState.allowGroupCall;

  // 私聊白名单卡片
  $('privateChips').innerHTML = wlState.chatPrivate.length
    ? wlState.chatPrivate.map(q => {
        const name = friendLabel(q);
        return '<span class="chip"><span>' + esc(name || q) + '</span>' + (name ? '<span class="qq">' + esc(q) + '</span>' : '') + '<button data-rm-chat="' + esc(q) + '" title="移出私聊白名单">×</button></span>';
      }).join('')
    : '<div class="empty">暂无私聊白名单</div>';

  // 通话白名单卡片
  $('callChips').innerHTML = wlState.callWhitelist.length
    ? wlState.callWhitelist.map(q => {
        const name = friendLabel(q);
        return '<span class="chip"><span>' + esc(name || q) + '</span>' + (name ? '<span class="qq">' + esc(q) + '</span>' : '') + '<button data-rm-call="' + esc(q) + '" title="移出通话白名单">×</button></span>';
      }).join('')
    : '<div class="empty">暂无通话白名单</div>';

  // 群聊白名单卡片
  $('groupChips').innerHTML = wlState.chatGroups.length
    ? wlState.chatGroups.map(g => {
        const name = groupLabel(g);
        return '<span class="chip"><span>' + esc(name || g) + '</span>' + (name ? '<span class="qq">' + esc(g) + '</span>' : '') + '<button data-rm-group="' + esc(g) + '" title="移出群白名单">×</button></span>';
      }).join('')
    : '<div class="empty">暂无群白名单</div>';

  renderFriendPicker();
  renderGroupPicker();
}

function renderFriendPicker() {
  const kw = $('manualQqInput').value.trim().toLowerCase();
  const chatSet = new Set(wlState.chatPrivate);
  const callSet = new Set(wlState.callWhitelist);
  let list = wlState.friends;
  if (kw) {
    list = list.filter(f => String(f.uin).includes(kw) || String(f.nickname || '').toLowerCase().includes(kw) || String(f.remark || '').toLowerCase().includes(kw));
  }
  const show = list.slice(0, kw ? 30 : 12);
  if (!show.length) {
    $('friendPicker').innerHTML = kw ? '<div class="empty">好友列表未搜到匹配项，可直接点上方按钮按 QQ 号添加</div>' : '<div class="empty">暂未获取到 QQ 好友列表，可直接在上方输入 QQ 号添加</div>';
    return;
  }
  $('friendPicker').innerHTML = show.map(f => {
    const q = String(f.uin);
    const title = f.remark ? (f.remark + ' (' + f.nickname + ')') : (f.nickname || q);
    const inChat = chatSet.has(q);
    const inCall = callSet.has(q);
    return '<div class="pickerItem">'
      + '<div class="pickerInfo"><div class="pickerName">' + esc(title) + '</div><div class="pickerSub">QQ: ' + esc(q) + '</div></div>'
      + '<div class="pickerActs">'
      + '<button class="sm ' + (inChat ? 'active' : '') + '" data-tog-chat="' + esc(q) + '">' + (inChat ? '✓ 聊天' : '+ 聊天') + '</button>'
      + '<button class="sm ' + (inCall ? 'okBtn' : '') + '" data-tog-call="' + esc(q) + '">' + (inCall ? '✓ 通话' : '+ 通话') + '</button>'
      + '</div></div>';
  }).join('');
}

function renderGroupPicker() {
  const kw = $('manualGroupInput').value.trim().toLowerCase();
  const gSet = new Set(wlState.chatGroups);
  let list = wlState.groups;
  if (kw) {
    list = list.filter(g => String(g.groupId).includes(kw) || String(g.groupName || '').toLowerCase().includes(kw));
  }
  const show = list.slice(0, kw ? 20 : 8);
  if (!show.length) {
    $('groupPicker').innerHTML = '';
    return;
  }
  $('groupPicker').innerHTML = show.map(g => {
    const id = String(g.groupId);
    const inG = gSet.has(id);
    return '<div class="pickerItem">'
      + '<div class="pickerInfo"><div class="pickerName">' + esc(g.groupName || id) + '</div><div class="pickerSub">群号: ' + esc(id) + (g.memberCount ? ' · ' + g.memberCount + '人' : '') + '</div></div>'
      + '<div class="pickerActs"><button class="sm ' + (inG ? 'active' : '') + '" data-tog-group="' + esc(id) + '">' + (inG ? '✓ 已放行' : '+ 放行群') + '</button></div></div>';
  }).join('');
}

async function saveChatWhitelist(nextPrivate, nextGroups, msg) {
  await api('/api/whitelists/chat', {
    method: 'POST',
    body: JSON.stringify({ private: nextPrivate, groups: nextGroups })
  });
  wlState.chatPrivate = nextPrivate;
  wlState.chatGroups = nextGroups;
  renderWhitelists();
  toast(msg || '聊天白名单已生效');
}

async function saveCallWhitelist(patch, msg) {
  const res = await api('/api/whitelists/call', {
    method: 'POST',
    body: JSON.stringify(patch)
  });
  wlState.callWhitelist = (res.whitelist || []).map(String);
  wlState.callEnabled = res.enabled !== false;
  wlState.allowGroupCall = res.allowGroupCall === true;
  renderWhitelists();
  toast(msg || '通话白名单已生效');
}

function validQq(s) { return /^\d{5,15}$/.test(String(s || '').trim()); }

$('btnRefreshWl').onclick = () => loadWhitelists(true).then(() => toast('已刷新好友与白名单'));
$('manualQqInput').oninput = renderFriendPicker;
$('manualGroupInput').oninput = renderGroupPicker;

$('btnAddChatManual').onclick = async () => {
  const q = $('manualQqInput').value.trim();
  if (!validQq(q)) return toast('请输入正确的 QQ 号（5~15 位数字）', 'err');
  const next = [...new Set([...wlState.chatPrivate, q])];
  await saveChatWhitelist(next, wlState.chatGroups, '已将 ' + q + ' 加入私聊白名单').catch(e => toast(e.message, 'err'));
  $('manualQqInput').value = '';
};
$('btnAddCallManual').onclick = async () => {
  const q = $('manualQqInput').value.trim();
  if (!validQq(q)) return toast('请输入正确的 QQ 号（5~15 位数字）', 'err');
  const next = [...new Set([...wlState.callWhitelist, q])];
  await saveCallWhitelist({ whitelist: next }, '已将 ' + q + ' 加入语音白名单').catch(e => toast(e.message, 'err'));
  $('manualQqInput').value = '';
};
$('btnAddBothManual').onclick = async () => {
  const q = $('manualQqInput').value.trim();
  if (!validQq(q)) return toast('请输入正确的 QQ 号（5~15 位数字）', 'err');
  try {
    await saveChatWhitelist([...new Set([...wlState.chatPrivate, q])], wlState.chatGroups, '已同步加入聊天+语音白名单');
    await saveCallWhitelist({ whitelist: [...new Set([...wlState.callWhitelist, q])] }, '已将 ' + q + ' 加入聊天 + 语音通话白名单');
    $('manualQqInput').value = '';
  } catch (e) { toast(e.message, 'err'); }
};
$('btnAddGroupManual').onclick = async () => {
  const g = $('manualGroupInput').value.trim();
  if (!validQq(g)) return toast('请输入正确的 QQ 群号', 'err');
  const next = [...new Set([...wlState.chatGroups, g])];
  await saveChatWhitelist(wlState.chatPrivate, next, '已将群 ' + g + ' 加入白名单').catch(e => toast(e.message, 'err'));
  $('manualGroupInput').value = '';
};
$('chkCallEnabled').onchange = () => saveCallWhitelist({ enabled: $('chkCallEnabled').checked }, $('chkCallEnabled').checked ? '已开启自动接听语音来电' : '已暂停自动接听语音来电').catch(e => toast(e.message, 'err'));
$('chkAllowGroupCall').onchange = () => saveCallWhitelist({ allowGroupCall: $('chkAllowGroupCall').checked }, '已更新群通话开关').catch(e => toast(e.message, 'err'));

// 事件委托处理所有一键加减按钮
document.body.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.rmChat) {
      const q = btn.dataset.rmChat;
      await saveChatWhitelist(wlState.chatPrivate.filter(x => x !== q), wlState.chatGroups, '已移出私聊白名单：' + q);
    } else if (btn.dataset.rmCall) {
      const q = btn.dataset.rmCall;
      await saveCallWhitelist({ whitelist: wlState.callWhitelist.filter(x => x !== q) }, '已移出语音白名单：' + q);
    } else if (btn.dataset.rmGroup) {
      const g = btn.dataset.rmGroup;
      await saveChatWhitelist(wlState.chatPrivate, wlState.chatGroups.filter(x => x !== g), '已移出群白名单：' + g);
    } else if (btn.dataset.togChat) {
      const q = btn.dataset.togChat;
      const has = wlState.chatPrivate.includes(q);
      const next = has ? wlState.chatPrivate.filter(x => x !== q) : [...wlState.chatPrivate, q];
      await saveChatWhitelist(next, wlState.chatGroups, (has ? '已移出' : '已加入') + '私聊白名单：' + (friendLabel(q) || q));
    } else if (btn.dataset.togCall) {
      const q = btn.dataset.togCall;
      const has = wlState.callWhitelist.includes(q);
      const next = has ? wlState.callWhitelist.filter(x => x !== q) : [...wlState.callWhitelist, q];
      await saveCallWhitelist({ whitelist: next }, (has ? '已移出' : '已加入') + '语音白名单：' + (friendLabel(q) || q));
    } else if (btn.dataset.togGroup) {
      const g = btn.dataset.togGroup;
      const has = wlState.chatGroups.includes(g);
      const next = has ? wlState.chatGroups.filter(x => x !== g) : [...wlState.chatGroups, g];
      await saveChatWhitelist(wlState.chatPrivate, next, (has ? '已移出' : '已加入') + '群白名单：' + (groupLabel(g) || g));
    }
  } catch (e) {
    toast(e.message, 'err');
  }
});

// ── 看屏 & 物理三通道（直接走同源 wss:// + Cookie 鉴权，免 Token） ──
let ws = null, wsReconnectTimer = null, stream = null, timer = null, prevGrid = null, sentCount = 0, lastPushAt = 0;
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
  try { new Audio('data:audio/wav;base64,' + b64).play().catch(() => {}); } catch {}
}
function setModeUi(m) {
  curMode = m;
  document.querySelectorAll('.modeBtn').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
}
function setAudioUi(enabled) {
  audioEnabled = Boolean(enabled);
  $('btnToggleAudio').textContent = audioEnabled ? '🔊 屏幕音轨：开' : '🔇 屏幕音轨：关';
  if (!hasAudioTrack) {
    $('audioPill').textContent = audioEnabled ? '音轨待机' : '🔇 音轨已关';
    $('audioPill').className = 'pill' + (audioEnabled ? '' : ' warn');
  } else if (audioEnabled) {
    $('audioPill').textContent = '🎬 通道 2 听译中';
    $('audioPill').className = 'pill ok';
  } else {
    $('audioPill').textContent = '🔇 通道 2 已静音';
    $('audioPill').className = 'pill warn';
  }
}
function teardownAudioPipeline() {
  hasAudioTrack = false; pcmPending = []; pcmPendingLen = 0; resamplePos = 0;
  if (audioProc) { try { audioProc.disconnect(); } catch {} audioProc = null; }
  if (audioSrc) { try { audioSrc.disconnect(); } catch {} audioSrc = null; }
  if (zeroGain) { try { zeroGain.disconnect(); } catch {} zeroGain = null; }
  if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
  $('audioBar').style.width = '0%';
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
  audioSrc = audioCtx.createMediaStreamSource(new MediaStream(tracks));
  audioProc = audioCtx.createScriptProcessor(4096, 1, 1);
  zeroGain = audioCtx.createGain();
  zeroGain.gain.value = 0;
  const ratio = audioCtx.sampleRate / 16000;
  const TARGET_SAMPLES = 1600;

  audioProc.onaudioprocess = (ev) => {
    if (!ws || ws.readyState !== 1 || !audioEnabled || curMode === 'off') {
      $('audioBar').style.width = '0%';
      return;
    }
    const input = ev.inputBuffer.getChannelData(0);
    let sq = 0;
    for (let i = 0; i < input.length; i += 4) sq += input[i] * input[i];
    $('audioBar').style.width = Math.min(100, Math.round(Math.sqrt(sq / Math.max(1, input.length / 4)) * 380)) + '%';

    const out = [];
    let pos = resamplePos;
    while (pos < input.length) {
      const idx = Math.floor(pos), frac = pos - idx;
      const s0 = input[idx] || 0, s1 = input[Math.min(idx + 1, input.length - 1)] || s0;
      const v = Math.max(-1, Math.min(1, s0 + (s1 - s0) * frac));
      out.push(v < 0 ? Math.round(v * 32768) : Math.round(v * 32767));
      pos += ratio;
    }
    resamplePos = pos - input.length;
    if (!out.length) return;
    pcmPending.push(out); pcmPendingLen += out.length;
    if (pcmPendingLen >= TARGET_SAMPLES) {
      const merged = new Int16Array(pcmPendingLen);
      let off = 0;
      for (const arr of pcmPending) { merged.set(arr, off); off += arr.length; }
      pcmPending = []; pcmPendingLen = 0;
      if (ws.bufferedAmount < 64000) { try { ws.send(merged.buffer); } catch {} }
    }
  };
  audioSrc.connect(audioProc);
  audioProc.connect(zeroGain);
  zeroGain.connect(audioCtx.destination);
  tracks[0].onended = () => {
    teardownAudioPipeline();
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'audio_meta', active: false }));
  };
  setAudioUi(audioEnabled);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'audio_meta', active: true, surface }));
  return true;
}

function connectScreenWs() {
  if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(proto + location.host + '/ws/screen');
  ws.onopen = () => {
    $('wsPill').textContent = '已连接'; $('wsPill').className = 'pill ok';
    $('btnShare').disabled = false;
  };
  ws.onclose = (ev) => {
    $('wsPill').textContent = '已断开'; $('wsPill').className = 'pill warn';
    $('btnShare').disabled = true;
    if (stream) stopShare();
    if (!$('appView').classList.contains('hidden') && ev.code !== 4401) {
      wsReconnectTimer = setTimeout(connectScreenWs, 3500);
    }
  };
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'status') {
      if (msg.mode) setModeUi(msg.mode);
      if (msg.screen?.audio && typeof msg.screen.audio.enabled === 'boolean') setAudioUi(msg.screen.audio.enabled);
      if (msg.callState === 'in_call') {
        $('callFusePill').textContent = '🎙️ 已融合 QQ 语音（三通道）'; $('callFusePill').className = 'pill ok';
        $('topCallPill').textContent = '🎙️ 通话中'; $('topCallPill').className = 'pill ok';
      } else {
        $('callFusePill').textContent = '💬 独立陪看模式'; $('callFusePill').className = 'pill';
      }
    } else if (msg.type === 'screen_audio') {
      $('subText').textContent = (msg.isFinal ? '' : '… ') + (msg.text || '');
    } else if (msg.type === 'reply') {
      addMsg('ai', '🐳 ' + msg.text + (msg.ms ? '  (' + msg.ms + 'ms)' : ''));
      if (msg.audio?.data) playWavBase64(msg.audio.data);
    } else if (msg.type === 'event' && msg.event) {
      if (msg.event.kind === 'watch_along') addMsg('ai', '🐳 [主动吐槽] ' + msg.event.text);
      else if (msg.event.kind === 'screen_reply') addMsg('ai', '🐳 [通话看屏] ' + msg.event.text);
      else addMsg('sys', msg.event.text);
    }
  };
}

async function startShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return toast('当前浏览器不支持录屏，请用电脑 Chrome/Edge 访问', 'err');
  }
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
      } else throw firstErr;
    }
    $('vid').srcObject = stream; $('vid').style.display = 'block'; $('ph').style.display = 'none';
    $('btnStop').disabled = false; $('btnShare').disabled = true;
    prevGrid = null; sentCount = 0; lastPushAt = 0;
    const vTrack = stream.getVideoTracks()[0];
    const surface = vTrack?.getSettings?.()?.displaySurface || 'unknown';
    vTrack.onended = () => stopShare();
    timer = setInterval(captureAndPush, 1000);
    setTimeout(captureAndPush, 250);

    const gotAudio = wantAudio && startAudioPipeline(stream, surface);
    if (gotAudio) {
      addMsg('sys', '已开启物理三通道：1080p 画面 + ' + (surface === 'browser' ? '标签页独立音频' : '系统音频（AI 说话自动防回声）'));
      $('subText').textContent = '通道 2 已接通，正在静默等待视频/游戏台词…';
    } else if (wantAudio) {
      addMsg('sys', '已共享画面（未捕获音频轨；如需听视频台词，重新共享时勾选弹窗底部的「分享音频」）');
    } else {
      addMsg('sys', '已开启纯画面共享');
    }
  } catch (e) {
    addMsg('sys', '未开启共享：' + e.message);
  }
}

function stopShare() {
  if (timer) { clearInterval(timer); timer = null; }
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

function captureAndPush() {
  if (!stream || !ws || ws.readyState !== 1 || curMode === 'off') return;
  const v = $('vid');
  if (!v.videoWidth || !v.videoHeight) return;
  diffCtx.drawImage(v, 0, 0, 16, 9);
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
  if (prevGrid && diff < 0.025 && now - lastPushAt < 8000) {
    $('statLeft').textContent = '画面静止，省流待机 (Δ=' + diff.toFixed(3) + ')';
    return;
  }
  prevGrid = grid; lastPushAt = now;
  const maxW = Number($('resSel').value) || 1280;
  const scale = Math.min(1, maxW / v.videoWidth);
  const w = Math.round(v.videoWidth * scale), h = Math.round(v.videoHeight * scale);
  capC.width = w; capC.height = h;
  capCtx.drawImage(v, 0, 0, w, h);
  const dataUrl = capC.toDataURL('image/jpeg', 0.78);
  ws.send(JSON.stringify({
    type: 'frame', data: dataUrl.slice(dataUrl.indexOf(',') + 1),
    changeScore: Number(diff.toFixed(3)), lumaGrid: grid,
    width: w, height: h, label: $('labelInput').value.trim() || '桌面窗口'
  }));
  sentCount++;
  $('statLeft').textContent = '推送中 ' + w + 'x' + h + ' (Δ=' + diff.toFixed(3) + ')';
  $('statRight').textContent = '已推送 ' + sentCount + ' 帧';
}

function sendAsk() {
  const txt = $('askInput').value.trim();
  if (!txt || !ws || ws.readyState !== 1) return;
  $('askInput').value = '';
  addMsg('me', txt);
  ws.send(JSON.stringify({ type: 'ask', text: txt, tts: $('ttsChk').checked }));
}
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
  setModeUi(b.dataset.mode);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'set_mode', mode: b.dataset.mode }));
});

// 启动自动检测会话
api('/auth/me').then(() => showApp()).catch(() => showLogin());
</script>
</body>
</html>`;
}

// ── 主网关服务 ──
const cfg = loadConfig();
let authRecord = loadOrInitAuth();
const tlsInfo = ensureTlsCert(cfg);

// 内存会话表 + 登录防爆破表
const sessions = new Map(); // sid -> { username, createdAt, lastSeenAt }
const loginFails = new Map(); // ip -> { count, resetAt }

// SnowLuma 好友/群列表 30s 缓存
let rosterCache = { at: 0, friends: [], groups: [] };

async function fetchRoster(force = false) {
  const now = Date.now();
  if (!force && now - rosterCache.at < 30000 && (rosterCache.friends.length || rosterCache.groups.length)) {
    return rosterCache;
  }
  const cur = loadConfig();
  const headers = { 'content-type': 'application/json' };
  if (cur.onebotToken) headers.authorization = `Bearer ${cur.onebotToken}`;
  const [fRes, gRes] = await Promise.all([
    fetchJsonSafe(`${cur.onebotHttp}/get_friend_list`, { method: 'POST', headers, body: '{}' }).catch(() => null),
    fetchJsonSafe(`${cur.onebotHttp}/get_group_list`, { method: 'POST', headers, body: '{}' }).catch(() => null)
  ]);
  const friends = (Array.isArray(fRes?.json?.data) ? fRes.json.data : []).map((f) => ({
    uin: String(f.user_id || f.uin || ''),
    nickname: String(f.nickname || ''),
    remark: String(f.remark || '')
  })).filter((f) => f.uin);
  const groups = (Array.isArray(gRes?.json?.data) ? gRes.json.data : []).map((g) => ({
    groupId: String(g.group_id || ''),
    groupName: String(g.group_name || ''),
    memberCount: Number(g.member_count || 0)
  })).filter((g) => g.groupId);
  rosterCache = { at: now, friends, groups };
  return rosterCache;
}

function getValidSession(req) {
  const sid = parseCookies(req)[SESSION_COOKIE];
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  const now = Date.now();
  if (now - s.lastSeenAt > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  s.lastSeenAt = now;
  return { sid, ...s };
}

function recordLoginFail(ip) {
  const now = Date.now();
  const cur = loginFails.get(ip);
  if (!cur || now > cur.resetAt) {
    loginFails.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    cur.count += 1;
  }
}

function isIpLocked(ip) {
  const cur = loginFails.get(ip);
  if (!cur) return false;
  if (Date.now() > cur.resetAt) {
    loginFails.delete(ip);
    return false;
  }
  return cur.count >= LOGIN_MAX_FAILS;
}

const server = https.createServer({ key: tlsInfo.key, cert: tlsInfo.cert }, async (req, res) => {
  try {
    const urlObj = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
    const pathname = urlObj.pathname;

    // 1. 主页 HTML
    if (req.method === 'GET' && (pathname === '/' || pathname === '/screen')) {
      setSecurityHeaders(res, true);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPortalHtml());
      return;
    }

    // 2. 登录 / 退出 / 检查会话
    if (req.method === 'POST' && pathname === '/auth/login') {
      if (!checkSameOrigin(req)) return sendJson(res, { ok: false, error: '非法来源' }, 403);
      const ip = getClientIp(req);
      if (isIpLocked(ip)) {
        return sendJson(res, { ok: false, error: '密码错误次数过多，请 10 分钟后再试' }, 429);
      }
      const body = await readJsonBody(req);
      const user = String(body.username || '').trim();
      const pass = String(body.password || '');
      authRecord = loadOrInitAuth();
      if (user !== authRecord.username || !verifyPassword(pass, authRecord)) {
        recordLoginFail(ip);
        log(`登录失败 ip=${ip} user=${user}`);
        return sendJson(res, { ok: false, error: '账号或密码错误' }, 401);
      }
      loginFails.delete(ip);
      const sid = crypto.randomBytes(32).toString('hex');
      sessions.set(sid, { username: user, createdAt: Date.now(), lastSeenAt: Date.now() });
      if (sessions.size > 32) {
        const oldest = sessions.keys().next().value;
        if (oldest) sessions.delete(oldest);
      }
      log(`管理员登录成功 ip=${ip}`);
      return sendJson(res, { ok: true, username: user }, 200, {
        'Set-Cookie': `${SESSION_COOKIE}=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
      });
    }

    if (req.method === 'POST' && pathname === '/auth/logout') {
      const s = getValidSession(req);
      if (s) sessions.delete(s.sid);
      return sendJson(res, { ok: true }, 200, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
      });
    }

    // 以下全部路由严格要求已登录会话 Cookie
    const session = getValidSession(req);
    if (!session) {
      return sendJson(res, { ok: false, error: '未登录' }, 401);
    }

    if (req.method === 'GET' && pathname === '/auth/me') {
      return sendJson(res, { ok: true, username: session.username });
    }

    if (req.method === 'GET' && pathname === '/auth/cert.crt') {
      setSecurityHeaders(res, false);
      res.writeHead(200, {
        'content-type': 'application/x-x509-ca-cert',
        'content-disposition': 'attachment; filename="dsh-pet-portal.crt"'
      });
      res.end(fs.readFileSync(tlsInfo.certPath));
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/password') {
      if (!checkSameOrigin(req)) return sendJson(res, { ok: false, error: '非法来源' }, 403);
      const body = await readJsonBody(req);
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '').trim();
      if (newPassword.length < 8) return sendJson(res, { ok: false, error: '新密码至少 8 位' }, 400);
      if (!verifyPassword(oldPassword, authRecord)) return sendJson(res, { ok: false, error: '当前密码错误' }, 400);
      authRecord = saveAuthRecord(authRecord.username, newPassword);
      try { fs.rmSync(path.join(STATE_DIR, 'portal-initial-password.txt'), { force: true }); } catch {}
      // 注销除当前外的所有其他会话
      for (const k of sessions.keys()) {
        if (k !== session.sid) sessions.delete(k);
      }
      log('管理员已更新登录密码');
      return sendJson(res, { ok: true });
    }

    const cur = loadConfig();
    const internalTok = readConsoleToken();
    const internalHeaders = { 'content-type': 'application/json', ...(internalTok ? { 'X-Console-Token': internalTok } : {}) };

    // 3. 总览状态（最小字段暴露）
    if (req.method === 'GET' && pathname === '/api/overview') {
      const [br, ca] = await Promise.all([
        fetchJsonSafe(`${cur.bridgeBase}/api/status`, { headers: internalHeaders }).catch(() => null),
        fetchJsonSafe(`${cur.callBase}/health`).catch(() => null)
      ]);
      return sendJson(res, {
        ok: true,
        bridgeOnline: Boolean(br?.ok),
        mode: br?.json?.mode || '',
        ownerQQ: br?.json?.ownerQQ || null,
        call: ca?.json || null
      });
    }

    // 4. 白名单读取与热更新
    if (req.method === 'GET' && pathname === '/api/whitelists') {
      const force = urlObj.searchParams.get('refresh') === '1';
      const [chatWl, callWl, roster] = await Promise.all([
        fetchJsonSafe(`${cur.bridgeBase}/api/whitelist`, { headers: internalHeaders }).catch(() => null),
        fetchJsonSafe(`${cur.callBase}/api/call/whitelist`, { headers: internalHeaders }).catch(() => null),
        fetchRoster(force)
      ]);
      return sendJson(res, {
        ok: true,
        chat: chatWl?.json || { allow: { private: [], groups: [] }, deny: { private: [], groups: [] } },
        call: callWl?.json || { enabled: true, whitelist: [], allowGroupCall: false },
        friends: roster.friends,
        groups: roster.groups
      });
    }

    if (req.method === 'POST' && pathname === '/api/whitelists/chat') {
      if (!checkSameOrigin(req)) return sendJson(res, { ok: false, error: '非法来源' }, 403);
      const body = await readJsonBody(req);
      // 先拉取当前配置以无损保留 deny 与 ownerQQ（禁止从网页清空 ownerQQ）
      const prev = await fetchJsonSafe(`${cur.bridgeBase}/api/whitelist`, { headers: internalHeaders });
      if (!prev.ok || !prev.json) return sendJson(res, { ok: false, error: '无法连接 qq-bridge' }, 502);
      const cleanList = (arr, fallback) => Array.isArray(arr)
        ? [...new Set(arr.map((x) => String(x || '').trim()).filter((x) => /^\d{5,15}$/.test(x)).map(Number))]
        : fallback;
      const payload = {
        allow: {
          private: cleanList(body.private, prev.json.allow?.private || []),
          groups: cleanList(body.groups, prev.json.allow?.groups || [])
        },
        deny: prev.json.deny || { private: [], groups: [] }
      };
      const upd = await fetchJsonSafe(`${cur.bridgeBase}/api/whitelist`, {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify(payload)
      });
      if (!upd.ok) return sendJson(res, { ok: false, error: upd.json?.error || '保存失败' }, upd.status);
      log(`聊天白名单已更新：私聊=${payload.allow.private.join(',')} 群=${payload.allow.groups.join(',')}`);
      return sendJson(res, { ok: true, ...upd.json });
    }

    if (req.method === 'POST' && pathname === '/api/whitelists/call') {
      if (!checkSameOrigin(req)) return sendJson(res, { ok: false, error: '非法来源' }, 403);
      const body = await readJsonBody(req);
      const upd = await fetchJsonSafe(`${cur.callBase}/api/call/whitelist`, {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify(body)
      });
      if (!upd.ok) return sendJson(res, { ok: false, error: upd.json?.error || '保存通话白名单失败' }, upd.status);
      return sendJson(res, upd.json);
    }

    // 5. 看屏 HTTP 接口透传（仅限安全子路径）
    if (pathname === '/api/screen/status' && req.method === 'GET') {
      const r = await fetchJsonSafe(`${cur.callBase}/api/screen/status`, { headers: internalHeaders });
      return sendJson(res, r.json || { ok: false }, r.status);
    }
    if ((pathname === '/api/screen/mode' || pathname === '/api/screen/ask' || pathname === '/api/screen/audio-text') && req.method === 'POST') {
      if (!checkSameOrigin(req)) return sendJson(res, { ok: false, error: '非法来源' }, 403);
      const body = await readJsonBody(req);
      const r = await fetchJsonSafe(`${cur.callBase}${pathname}`, {
        method: 'POST',
        headers: internalHeaders,
        body: JSON.stringify(body),
        timeoutMs: 30000
      });
      return sendJson(res, r.json || { ok: false }, r.status);
    }

    sendJson(res, { ok: false, error: 'not found' }, 404);
  } catch (err) {
    sendJson(res, { ok: false, error: String(err?.message ?? err) }, 500);
  }
});

// ── 受鉴权 WebSocket 透传（支持 JSON 文本帧 + 二进制 16kHz PCM 屏幕音轨帧） ──
const wss = new WebSocketServer({ noServer: true, maxPayload: 3 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const urlObj = new URL(req.url || '/', 'https://localhost');
  if (urlObj.pathname !== '/ws/screen') {
    socket.destroy();
    return;
  }
  const session = getValidSession(req);
  if (!session || !checkSameOrigin(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (clientWs) => {
    wss.emit('connection', clientWs, req);
  });
});

wss.on('connection', (clientWs) => {
  const cur = loadConfig();
  const tok = readConsoleToken();
  const upstreamUrl = `ws://127.0.0.1:${cur.callPort}/ws/screen?token=${encodeURIComponent(tok)}`;
  const upstreamWs = new WebSocket(upstreamUrl, { maxPayload: 3 * 1024 * 1024 });
  const pendingToUp = [];

  upstreamWs.on('open', () => {
    for (const item of pendingToUp) {
      if (upstreamWs.readyState === WebSocket.OPEN) {
        try { upstreamWs.send(item.data, { binary: item.isBinary }); } catch {}
      }
    }
    pendingToUp.length = 0;
  });

  clientWs.on('message', (data, isBinary) => {
    if (upstreamWs.readyState === WebSocket.OPEN) {
      try { upstreamWs.send(data, { binary: isBinary }); } catch {}
    } else if (upstreamWs.readyState === WebSocket.CONNECTING && pendingToUp.length < 40) {
      pendingToUp.push({ data, isBinary });
    }
  });

  upstreamWs.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      try { clientWs.send(data, { binary: isBinary }); } catch {}
    }
  });

  const closeBoth = () => {
    try { if (clientWs.readyState === WebSocket.OPEN || clientWs.readyState === WebSocket.CONNECTING) clientWs.close(); } catch {}
    try { if (upstreamWs.readyState === WebSocket.OPEN || upstreamWs.readyState === WebSocket.CONNECTING) upstreamWs.close(); } catch {}
  };
  clientWs.on('close', closeBoth);
  clientWs.on('error', closeBoth);
  upstreamWs.on('close', closeBoth);
  upstreamWs.on('error', closeBoth);
});

server.listen(cfg.port, cfg.host, () => {
  log(`HTTPS 远程管理台已监听 https://${cfg.publicHost || cfg.host}:${cfg.port}/`);
});
