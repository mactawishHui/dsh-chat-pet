#!/usr/bin/env node
/**
 * pet-game-link.mjs — 跨平台（Windows / macOS / Linux）零依赖 Steam Neuro-SDK 本机桥接器
 *
 * 用途（路线 C：小丑牌 Balatro / 杀戮尖塔 / 恶魔轮盘 / Among Us 等 Steam 开源 Mod）：
 *   大多数 Steam Neuro-SDK 社区 Mod 默认只连接本机明文 ws://127.0.0.1:8000，不支持 HTTPS 自签证书与 Token 鉴权。
 *   本脚本无需任何 npm install（纯 Node.js 原生内置模块），在本机监听 ws://127.0.0.1:8000，
 *   并把游戏协议帧通过 TLS 加密安全转发到云端 https://<你的pet-portal>:8443/ws/neuro?token=<GameToken>。
 *
 * 用法（Windows PowerShell / CMD 或 macOS Terminal）：
 *   node pet-game-link.mjs --portal https://<服务器IP或域名>:8443 --token <管理台里的GameToken> [--port 8000] [--insecure]
 */

import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function parseArgs(argv) {
  const out = { portal: process.env.PET_PORTAL_URL || '', token: process.env.PET_GAME_TOKEN || '', port: Number(process.env.NEURO_LOCAL_PORT || 8000), insecure: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--portal' && argv[i + 1]) out.portal = argv[++i];
    else if (a === '--token' && argv[i + 1]) out.token = argv[++i];
    else if (a === '--port' && argv[i + 1]) out.port = Number(argv[++i]);
    else if (a === '--insecure' || a === '-k') out.insecure = true;
  }
  return out;
}

const cfg = parseArgs(process.argv);
if (!cfg.portal || !cfg.token) {
  console.error('用法: node pet-game-link.mjs --portal https://<主机>:8443 --token <GameToken> [--port 8000] [--insecure]');
  process.exit(1);
}

const portalUrl = new URL(cfg.portal.startsWith('http') || cfg.portal.startsWith('ws') ? cfg.portal : `https://${cfg.portal}`);
const upstreamIsTls = portalUrl.protocol === 'https:' || portalUrl.protocol === 'wss:';
const upstreamHost = portalUrl.hostname;
const upstreamPort = Number(portalUrl.port || (upstreamIsTls ? 443 : 80));
const upstreamPath = `/ws/neuro?token=${encodeURIComponent(cfg.token)}`;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[pet-game-link]', ...a);

// 极简 RFC6455 帧解码/编码（支持服务端与客户端双向无损透传）
function encodeWsFrame(opcode, payloadBuf, mask = false) {
  const len = payloadBuf.length;
  let headerLen = 2 + (mask ? 4 : 0);
  if (len >= 126 && len < 65536) headerLen += 2;
  else if (len >= 65536) headerLen += 8;
  const frame = Buffer.allocUnsafe(headerLen + len);
  frame[0] = 0x80 | (opcode & 0x0f);
  let off = 2;
  if (len < 126) {
    frame[1] = (mask ? 0x80 : 0) | len;
  } else if (len < 65536) {
    frame[1] = (mask ? 0x80 : 0) | 126;
    frame.writeUInt16BE(len, 2);
    off = 4;
  } else {
    frame[1] = (mask ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(len), 2);
    off = 10;
  }
  if (mask) {
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(frame, off);
    off += 4;
    for (let i = 0; i < len; i++) frame[off + i] = payloadBuf[i] ^ maskKey[i & 3];
  } else {
    payloadBuf.copy(frame, off);
  }
  return frame;
}

function attachFrameParser(socket, onFrame) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = Boolean(b1 & 0x80);
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const need = off + (masked ? 4 : 0) + len;
      if (buf.length < need) return;
      let payload;
      if (masked) {
        const key = buf.subarray(off, off + 4);
        off += 4;
        payload = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) payload[i] = buf[off + i] ^ key[i & 3];
      } else {
        payload = Buffer.from(buf.subarray(off, off + len));
      }
      buf = buf.subarray(need);
      onFrame(opcode, payload);
    }
  });
}

function connectUpstreamWs({ onOpen, onFrame, onClose, onError }) {
  const wsKey = crypto.randomBytes(16).toString('base64');
  const sock = upstreamIsTls
    ? tls.connect({ host: upstreamHost, port: upstreamPort, servername: net.isIP(upstreamHost) ? undefined : upstreamHost, rejectUnauthorized: !cfg.insecure })
    : net.connect({ host: upstreamHost, port: upstreamPort });

  let upgraded = false;
  let headBuf = Buffer.alloc(0);

  sock.on('connect', () => {
    const req = [
      `GET ${upstreamPath} HTTP/1.1`,
      `Host: ${upstreamHost}:${upstreamPort}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${wsKey}`,
      'Sec-WebSocket-Version: 13',
      '', ''
    ].join('\r\n');
    sock.write(req);
  });

  const onInitialData = (chunk) => {
    headBuf = Buffer.concat([headBuf, chunk]);
    const idx = headBuf.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const headStr = headBuf.subarray(0, idx).toString('utf8');
    const rest = headBuf.subarray(idx + 4);
    sock.off('data', onInitialData);
    if (!headStr.startsWith('HTTP/1.1 101')) {
      onError(new Error(`云端握手被拒绝: ${headStr.split('\r\n')[0]}`));
      sock.destroy();
      return;
    }
    upgraded = true;
    attachFrameParser(sock, onFrame);
    onOpen(sock);
    if (rest.length) sock.emit('data', rest);
  };

  sock.on('data', onInitialData);
  sock.on('close', () => onClose());
  sock.on('error', (err) => {
    if (!upgraded) onError(err);
    else onClose();
  });
  return sock;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`pet-game-link running -> ${upstreamHost}:${upstreamPort}\n`);
});

server.on('upgrade', (req, clientSock, head) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { clientSock.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  clientSock.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', ''
  ].join('\r\n'));

  log(`🎮 本机游戏 Mod 已接入 (${req.url || '/'})，正在连接云端小鲸鲸…`);
  let upSock = null;
  let upReady = false;
  const pending = [];

  const closeBoth = () => {
    try { clientSock.destroy(); } catch {}
    try { upSock?.destroy(); } catch {}
  };

  upSock = connectUpstreamWs({
    onOpen: (s) => {
      upReady = true;
      log('✅ 已安全桥接到云端 Game Hub！');
      for (const item of pending.splice(0)) {
        try { s.write(encodeWsFrame(item.opcode, item.payload, true)); } catch {}
      }
    },
    onFrame: (opcode, payload) => {
      if (opcode === 0x8) { closeBoth(); return; }
      if (opcode === 0x9) { try { upSock.write(encodeWsFrame(0xA, payload, true)); } catch {} return; }
      if (opcode === 0x1 || opcode === 0x2) {
        try { clientSock.write(encodeWsFrame(opcode, payload, false)); } catch {}
      }
    },
    onClose: () => {
      log('🔌 云端连接已关闭');
      closeBoth();
    },
    onError: (err) => {
      log(`❌ 连接云端失败: ${err?.message ?? err}`);
      closeBoth();
    },
  });

  attachFrameParser(clientSock, (opcode, payload) => {
    if (opcode === 0x8) { closeBoth(); return; }
    if (opcode === 0x9) { try { clientSock.write(encodeWsFrame(0xA, payload, false)); } catch {} return; }
    if (opcode === 0x1 || opcode === 0x2) {
      if (upReady && upSock && !upSock.destroyed) {
        try { upSock.write(encodeWsFrame(opcode, payload, true)); } catch {}
      } else if (pending.length < 50) {
        pending.push({ opcode, payload });
      }
    }
  });

  clientSock.on('close', closeBoth);
  clientSock.on('error', closeBoth);
  if (head?.length) clientSock.emit('data', head);
});

server.listen(cfg.port, '127.0.0.1', () => {
  log(`🌉 本机 Neuro-API 桥接器已就绪: ws://127.0.0.1:${cfg.port}  <===>  ${upstreamIsTls ? 'wss' : 'ws'}://${upstreamHost}:${upstreamPort}/ws/neuro`);
  log('💡 直接启动装好 Neuro-SDK Mod 的 Steam 游戏（如小丑牌 / 杀戮尖塔 / 恶魔轮盘 / Among Us）即可自动连上小鲸鲸！');
});
