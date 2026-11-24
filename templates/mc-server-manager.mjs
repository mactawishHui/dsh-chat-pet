/**
 * mc-server-manager.mjs — 零闲置内存 Minecraft 1.21.1 自休眠私服托管器 & IP 敲门唤醒代理（ESM）
 *
 * 核心能力：
 *   1. 默认休眠 = 0 MB Java 内存：PaperMC 平时完全不运行；仅由本轻量代理监听 0.0.0.0:25565
 *   2. 安全防公网扫描与熊孩子：PaperMC 仅监听 127.0.0.1:25566，公网无法直连；
 *      外层代理强制校验「pet-portal HTTPS 敲门授权 IP」+「可选用户名白名单」，陌生扫描 IP 直接静默拒绝且不唤醒服务器
 *   3. 进服即唤醒 / Portal 一键唤醒：
 *      - 已授权 IP 在 MC 多人列表刷新时直接返回 MOTD（不唤醒 JVM）
 *      - 点击加入或通过 pet-portal / QQ 指令唤醒时，在 systemd cgroup v2 硬限制（MemoryMax=1350M, OOMScoreAdjust=500）下拉起 PaperMC 1.21.1，并在就绪后自动召唤小鲸鲸（xiaojingjing）上线
 *   4. 无人自动存档休眠：最后一名人类玩家离开后满 10 分钟（可配置），自动 save-all + stop 释放全部内存
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

const STATE_DIR = process.env.QQ_BRIDGE_STATE_DIR || '/opt/qq-bridge/state';
const ACCESS_FILE = path.join(STATE_DIR, 'mc-access.json');

// ── Minecraft VarInt / String 协议编解码（零外部依赖） ──
function readVarInt(buf, offset = 0) {
  let numRead = 0;
  let result = 0;
  while (offset + numRead < buf.length && numRead < 5) {
    const byte = buf[offset + numRead];
    result |= (byte & 0x7f) << (7 * numRead);
    numRead++;
    if ((byte & 0x80) === 0) {
      return { value: result, size: numRead };
    }
  }
  return null; // 数据还不完整
}

function writeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let temp = v & 0x7f;
    v >>>= 7;
    if (v !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readMcString(buf, offset) {
  const lenInfo = readVarInt(buf, offset);
  if (!lenInfo) return null;
  const start = offset + lenInfo.size;
  const end = start + lenInfo.value;
  if (end > buf.length) return null;
  return { value: buf.subarray(start, end).toString('utf8'), nextOffset: end };
}

function buildMcPacket(packetId, payloadBuf) {
  const idBuf = writeVarInt(packetId);
  const body = Buffer.concat([idBuf, payloadBuf]);
  return Buffer.concat([writeVarInt(body.length), body]);
}

function buildMcString(str) {
  const b = Buffer.from(String(str), 'utf8');
  return Buffer.concat([writeVarInt(b.length), b]);
}

function parseHandshakePacket(buf) {
  const pktLen = readVarInt(buf, 0);
  if (!pktLen) return null;
  const totalLen = pktLen.size + pktLen.value;
  if (buf.length < totalLen) return null;

  let off = pktLen.size;
  const pktId = readVarInt(buf, off);
  if (!pktId || pktId.value !== 0x00) return { invalid: true };
  off += pktId.size;

  const proto = readVarInt(buf, off);
  if (!proto) return { invalid: true };
  off += proto.size;

  const host = readMcString(buf, off);
  if (!host) return { invalid: true };
  off = host.nextOffset;

  if (off + 2 > totalLen) return { invalid: true };
  const port = buf.readUInt16BE(off);
  off += 2;

  const nextState = readVarInt(buf, off);
  if (!nextState) return { invalid: true };

  return {
    protocol: proto.value,
    host: host.value,
    port,
    nextState: nextState.value, // 1 = Status, 2 = Login
    consumedBytes: totalLen,
  };
}

function parseLoginStartName(buf, offset) {
  const pktLen = readVarInt(buf, offset);
  if (!pktLen) return null;
  const totalLen = offset + pktLen.size + pktLen.value;
  if (buf.length < totalLen) return null;
  let off = offset + pktLen.size;
  const pktId = readVarInt(buf, off);
  if (!pktId || pktId.value !== 0x00) return null;
  off += pktId.size;
  const name = readMcString(buf, off);
  return name ? name.value : null;
}

function normalizeIp(ip) {
  return String(ip || '').trim().replace(/^::ffff:/, '');
}

export class McServerManager {
  constructor(opts = {}) {
    this.mcDir = opts.mcDir || process.env.MC_SERVER_DIR || '/opt/mc-server';
    this.jarName = opts.jarName || process.env.MC_JAR_NAME || 'paper-1.21.1.jar';
    this.publicPort = Number(opts.publicPort || process.env.MC_PUBLIC_PORT || 25565);
    this.internalPort = Number(opts.internalPort || process.env.MC_INTERNAL_PORT || 25566);
    this.hubPort = Number(opts.hubPort || process.env.GAME_HUB_PORT || 3350);
    this.botName = String(opts.botName || process.env.MC_BOT_NAME || 'xiaojingjing').trim();
    this.botScriptPath = opts.botScriptPath || path.join(path.dirname(new URL(import.meta.url).pathname), 'mc-companion.mjs');
    this.idleSleepMin = Number(opts.idleSleepMin ?? 10);
    this.xms = opts.xms || '384M';
    this.xmx = opts.xmx || '850M';
    this.cgroupMemoryHigh = opts.cgroupMemoryHigh || '1100M';
    this.cgroupMemoryMax = opts.cgroupMemoryMax || '1350M';
    this.log = opts.log || console.log;

    this.state = 'sleeping'; // sleeping | starting | running | stopping
    this.startedAt = 0;
    this.lastHumanSeenAt = 0;
    this.paperProc = null;
    this.botProc = null;
    this.botConnected = false;
    this.proxyServer = null;
    this.onlinePlayers = new Set(); // 所有在服玩家（含 bot）
    this.recentConsole = [];
    this.readyWaiters = [];
    this.idleTimer = null;

    // 持久化访问控制：已敲门 IP + 用户名白名单
    this.access = {
      ipKnockRequired: true,
      allowedIps: [],        // [{ ip, expiresAt (0=永久), note, addedAt }]
      allowedPlayers: [],    // [] 表示放行已敲门 IP 的任意玩家并自动记录；非空则严格校验
    };
    this._loadAccess();
  }

  _loadAccess() {
    try {
      const d = JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8'));
      if (d && typeof d === 'object') {
        this.access.ipKnockRequired = d.ipKnockRequired !== false;
        this.access.allowedIps = Array.isArray(d.allowedIps) ? d.allowedIps : [];
        this.access.allowedPlayers = Array.isArray(d.allowedPlayers) ? d.allowedPlayers : [];
      }
    } catch {}
    this._pruneExpiredIps();
  }

  _saveAccess() {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      const tmp = `${ACCESS_FILE}.tmp.${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.access, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, ACCESS_FILE);
    } catch {}
  }

  _pruneExpiredIps() {
    const now = Date.now();
    const before = this.access.allowedIps.length;
    this.access.allowedIps = this.access.allowedIps.filter((x) => x && x.ip && (!x.expiresAt || x.expiresAt > now));
    if (this.access.allowedIps.length !== before) this._saveAccess();
  }

  allowIp(rawIp, hours = 24, note = 'portal') {
    const ip = normalizeIp(rawIp);
    if (!ip || ip === 'unknown') return false;
    this._pruneExpiredIps();
    const expiresAt = hours > 0 ? Date.now() + hours * 3600 * 1000 : 0;
    const idx = this.access.allowedIps.findIndex((x) => x.ip === ip);
    const rec = { ip, expiresAt, note: String(note || 'portal').slice(0, 40), addedAt: Date.now() };
    if (idx >= 0) this.access.allowedIps[idx] = rec;
    else this.access.allowedIps.push(rec);
    this._saveAccess();
    this.log(`🔓 已放行 MC 连接 IP: ${ip} (${hours > 0 ? `${hours}h` : '永久'}, ${rec.note})`);
    return true;
  }

  isIpAllowed(rawIp) {
    const ip = normalizeIp(rawIp);
    if (ip === '127.0.0.1' || ip === '::1') return true;
    if (!this.access.ipKnockRequired) return true;
    this._pruneExpiredIps();
    return this.access.allowedIps.some((x) => x.ip === ip);
  }

  isPlayerAllowed(username) {
    const u = String(username || '').trim();
    if (!u) return false;
    if (u.toLowerCase() === this.botName.toLowerCase()) return true;
    if (!this.access.allowedPlayers.length) return true;
    return this.access.allowedPlayers.some((p) => p.toLowerCase() === u.toLowerCase());
  }

  updateAccess(body = {}) {
    if (typeof body.ipKnockRequired === 'boolean') {
      this.access.ipKnockRequired = body.ipKnockRequired;
    }
    if (body.addIp) {
      this.allowIp(body.addIp, Number(body.hours ?? 24), body.note || 'manual');
    }
    if (body.removeIp) {
      const target = normalizeIp(body.removeIp);
      this.access.allowedIps = this.access.allowedIps.filter((x) => x.ip !== target);
    }
    if (Array.isArray(body.allowedPlayers)) {
      this.access.allowedPlayers = [...new Set(
        body.allowedPlayers.map((x) => String(x || '').trim()).filter((x) => /^[A-Za-z0-9_]{2,20}$/.test(x))
      )];
    }
    if (body.addPlayer && /^[A-Za-z0-9_]{2,20}$/.test(String(body.addPlayer).trim())) {
      const p = String(body.addPlayer).trim();
      if (!this.access.allowedPlayers.some((x) => x.toLowerCase() === p.toLowerCase())) {
        this.access.allowedPlayers.push(p);
      }
    }
    if (body.removePlayer) {
      const rm = String(body.removePlayer).trim().toLowerCase();
      this.access.allowedPlayers = this.access.allowedPlayers.filter((x) => x.toLowerCase() !== rm);
    }
    this._saveAccess();
    return { access: this.access };
  }

  _humanPlayers() {
    const botLow = this.botName.toLowerCase();
    return [...this.onlinePlayers].filter((p) => p.toLowerCase() !== botLow);
  }

  _pushConsole(line) {
    const s = String(line || '').trim();
    if (!s) return;
    this.recentConsole.push(s.slice(0, 220));
    if (this.recentConsole.length > 35) this.recentConsole.shift();
  }

  _ensurePaperConfig() {
    fs.mkdirSync(this.mcDir, { recursive: true });
    // EULA
    const eulaPath = path.join(this.mcDir, 'eula.txt');
    if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf8').includes('eula=true')) {
      fs.writeFileSync(eulaPath, 'eula=true\n');
    }
    // 低内存优化 server.properties（仅监听 127.0.0.1:25566，绝不直接暴露公网）
    const propsPath = path.join(this.mcDir, 'server.properties');
    const desired = {
      'server-ip': '127.0.0.1',
      'server-port': String(this.internalPort),
      'online-mode': 'false',
      'enforce-secure-profile': 'false',
      'view-distance': '5',
      'simulation-distance': '4',
      'max-players': '8',
      'difficulty': 'normal',
      'gamemode': 'survival',
      'allow-flight': 'true',
      'spawn-protection': '0',
      'motd': 'XiaoJingJing Secret Base',
      'pause-when-empty-seconds': '60',
      'sync-chunk-writes': 'false',
    };
    if (!fs.existsSync(propsPath)) {
      const lines = Object.entries(desired).map(([k, v]) => `${k}=${v}`);
      fs.writeFileSync(propsPath, lines.join('\n') + '\n');
    } else {
      let txt = fs.readFileSync(propsPath, 'utf8');
      for (const [k, v] of Object.entries(desired)) {
        const re = new RegExp(`^${k}=.*$`, 'm');
        if (re.test(txt)) txt = txt.replace(re, `${k}=${v}`);
        else txt += `\n${k}=${v}`;
      }
      fs.writeFileSync(propsPath, txt.trim() + '\n');
    }

    // Paper 世界低内存配置（关闭 keep-spawn-loaded 与高频保存尖峰）
    const paperCfgDir = path.join(this.mcDir, 'config');
    fs.mkdirSync(paperCfgDir, { recursive: true });
    const worldDefPath = path.join(paperCfgDir, 'paper-world-defaults.yml');
    if (!fs.existsSync(worldDefPath)) {
      fs.writeFileSync(worldDefPath, [
        '_version: 31',
        'chunks:',
        '  max-auto-save-chunks-per-tick: 6',
        '  prevent-moving-into-unloaded-chunks: true',
        'spawn:',
        '  keep-spawn-loaded: false',
        'entities:',
        '  spawning:',
        '    per-player-mob-spawns: true',
        '',
      ].join('\n'));
    }
  }

  /**
   * 唤醒 PaperMC 1.21.1（带 systemd cgroup v2 硬内存护栏 + OOMScoreAdjust=500）
   */
  async wake({ reason = 'manual', spawnBot = true } = {}) {
    const jarPath = path.join(this.mcDir, this.jarName);
    if (!fs.existsSync(jarPath)) {
      return { started: false, error: `未找到服务端核心 ${jarPath}` };
    }
    if (this.state === 'running') {
      this.lastHumanSeenAt = Date.now();
      if (spawnBot && !this.botProc) this.startBot().catch(() => {});
      return { started: true, alreadyRunning: true, state: this.state };
    }
    if (this.state === 'starting') {
      return { started: true, starting: true, state: this.state };
    }

    this._ensurePaperConfig();
    this.state = 'starting';
    this.startedAt = Date.now();
    this.lastHumanSeenAt = Date.now();
    this.onlinePlayers.clear();
    this.log(`🌅 正在唤醒 PaperMC 1.21.1 (原因=${reason}, heap=${this.xms}~${this.xmx}, cgroupMax=${this.cgroupMemoryMax})…`);

    const javaCmd = [
      'echo 500 > /proc/$$/oom_score_adj 2>/dev/null || true;',
      `exec java -Xms${this.xms} -Xmx${this.xmx}`,
      '-DPaper.IgnoreJavaVersion=true',
      '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=50',
      '-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC',
      `-jar ${this.jarName} --nogui`,
    ].join(' ');

    const useSystemdScope = fs.existsSync('/usr/bin/systemd-run');
    const cmd = useSystemdScope ? 'systemd-run' : 'sh';
    const args = useSystemdScope
      ? [
          '--scope',
          '--quiet',
          `-p`, `MemoryHigh=${this.cgroupMemoryHigh}`,
          `-p`, `MemoryMax=${this.cgroupMemoryMax}`,
          'sh', '-c', javaCmd,
        ]
      : ['-c', javaCmd];

    const proc = spawn(cmd, args, {
      cwd: this.mcDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.paperProc = proc;

    const handleLine = (rawLine) => {
      const line = String(rawLine || '').trim();
      if (!line) return;
      this._pushConsole(line);

      if (this.state === 'starting' && /Done \([\d.]+s\)! For help, type "help"/i.test(line)) {
        this.state = 'running';
        this.lastHumanSeenAt = Date.now();
        const bootSec = ((Date.now() - this.startedAt) / 1000).toFixed(1);
        this.log(`✅ PaperMC 1.21.1 就绪！启动耗时 ${bootSec}s`);
        for (const fn of this.readyWaiters.splice(0)) fn(true);
        if (spawnBot) {
          setTimeout(() => {
            if (this.state === 'running' && !this.botProc) {
              this.startBot().catch((e) => this.log(`自动召唤小鲸鲸失败: ${e?.message ?? e}`));
            }
          }, 1500);
        }
      }

      const joinM = line.match(/:\s*([A-Za-z0-9_]{2,20}) joined the game/);
      if (joinM) {
        const p = joinM[1];
        this.onlinePlayers.add(p);
        if (p.toLowerCase() !== this.botName.toLowerCase()) {
          this.lastHumanSeenAt = Date.now();
          this.log(`👤 玩家加入世界: ${p} (当前人类=${this._humanPlayers().length})`);
          if (!this.botProc && this.state === 'running') {
            this.startBot().catch(() => {});
          }
        }
      }

      const leftM = line.match(/:\s*([A-Za-z0-9_]{2,20}) left the game/);
      if (leftM) {
        const p = leftM[1];
        this.onlinePlayers.delete(p);
        if (p.toLowerCase() !== this.botName.toLowerCase()) {
          this.lastHumanSeenAt = Date.now();
          this.log(`👋 玩家离开世界: ${p} (剩余人类=${this._humanPlayers().length})`);
        }
      }
    };

    let outRem = '';
    proc.stdout.on('data', (chunk) => {
      outRem += chunk.toString('utf8');
      const lines = outRem.split(/\r?\n/);
      outRem = lines.pop() || '';
      for (const l of lines) handleLine(l);
    });
    proc.stderr.on('data', (chunk) => {
      const txt = chunk.toString('utf8').trim();
      if (txt) this._pushConsole(`[stderr] ${txt.slice(0, 180)}`);
    });

    proc.on('exit', (code, sig) => {
      if (this.paperProc === proc) this.paperProc = null;
      this.onlinePlayers.clear();
      const prev = this.state;
      this.state = 'sleeping';
      for (const fn of this.readyWaiters.splice(0)) fn(false);
      this.log(`🌙 PaperMC 已退出 (code=${code}, sig=${sig}, prev=${prev})，内存已释放回 0 MB`);
      this.stopBot('server_stopped').catch(() => {});
    });

    return { started: true, starting: true, state: this.state };
  }

  waitUntilReady(timeoutMs = 20000) {
    if (this.state === 'running') return Promise.resolve(true);
    if (this.state !== 'starting') return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(ok);
      };
      const timer = setTimeout(() => {
        const idx = this.readyWaiters.indexOf(finish);
        if (idx >= 0) this.readyWaiters.splice(idx, 1);
        finish(false);
      }, timeoutMs);
      timer.unref?.();
      this.readyWaiters.push(finish);
    });
  }

  sendServerCommand(cmd) {
    if (!this.paperProc?.stdin?.writable) return false;
    try {
      this.paperProc.stdin.write(String(cmd).trim() + '\n');
      return true;
    } catch {
      return false;
    }
  }

  async stopServer(reason = 'manual') {
    if (this.state === 'sleeping' && !this.paperProc) {
      await this.stopBot('already_sleeping');
      return { stopped: true, alreadySleeping: true };
    }
    this.state = 'stopping';
    this.log(`💾 正在保存世界并休眠 PaperMC (原因=${reason})…`);
    await this.stopBot('server_stopping');
    const proc = this.paperProc;
    if (!proc) {
      this.state = 'sleeping';
      return { stopped: true };
    }
    this.sendServerCommand('save-all');
    await new Promise((r) => setTimeout(r, 1500));
    this.sendServerCommand('stop');

    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };
      proc.once('exit', done);
      const killTimer = setTimeout(() => {
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => {
          try { proc.kill('SIGKILL'); } catch {}
          done();
        }, 5000);
      }, 22000);
      killTimer.unref?.();
    });

    this.state = 'sleeping';
    return { stopped: true };
  }

  /**
   * 召唤小鲸鲸 Mineflayer 队友进入本地 127.0.0.1:25566
   */
  async startBot() {
    if (this.state !== 'running') {
      return { ok: false, error: 'MC 服务器尚未就绪' };
    }
    if (this.botProc) {
      return { ok: true, alreadyRunning: true };
    }
    if (!fs.existsSync(this.botScriptPath)) {
      return { ok: false, error: `未找到队友脚本 ${this.botScriptPath}` };
    }
    this.log(`🐳 正在召唤小鲸鲸 (${this.botName}) 进入 MC 世界…`);
    const p = spawn(process.execPath, [this.botScriptPath], {
      cwd: path.dirname(this.botScriptPath),
      env: {
        ...process.env,
        NODE_OPTIONS: '--max-old-space-size=192',
        MC_HOST: '127.0.0.1',
        MC_PORT: String(this.internalPort),
        MC_VERSION: '1.21.1',
        MC_USERNAME: this.botName,
        MC_AUTH: 'offline',
        NEURO_WS_URL: `ws://127.0.0.1:${this.hubPort}/ws/neuro`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.botProc = p;
    this.botConnected = true;

    p.stdout.on('data', (chunk) => {
      for (const l of chunk.toString('utf8').split(/\r?\n/)) {
        if (l.trim()) console.log(l);
      }
    });
    p.stderr.on('data', (chunk) => {
      for (const l of chunk.toString('utf8').split(/\r?\n/)) {
        if (l.trim()) console.error('[mc-bot]', l);
      }
    });
    p.on('exit', (code, sig) => {
      if (this.botProc === p) {
        this.botProc = null;
        this.botConnected = false;
      }
      this.log(`🐳 小鲸鲸 MC 队友进程已退出 (code=${code}, sig=${sig})`);
    });
    return { ok: true, spawned: true };
  }

  async stopBot(reason = 'manual') {
    const p = this.botProc;
    this.botProc = null;
    this.botConnected = false;
    if (!p) return { ok: true, alreadyStopped: true };
    this.log(`🐳 正在让小鲸鲸退出 MC 世界 (${reason})…`);
    try { p.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 600));
    try { p.kill('SIGKILL'); } catch {}
    return { ok: true, stopped: true };
  }

  /**
   * 启动 0.0.0.0:25565 轻量化 TCP 敲门 & 自唤醒代理
   */
  async startProxy() {
    if (this.proxyServer) return;
    this.proxyServer = net.createServer((clientSock) => {
      this._handleClientSocket(clientSock);
    });
    this.proxyServer.on('error', (err) => {
      this.log(`TCP 代理异常: ${err?.message ?? err}`);
    });
    await new Promise((resolve) => this.proxyServer.listen(this.publicPort, '0.0.0.0', resolve));
    this.log(`🛡️ MC 自休眠敲门代理已监听 0.0.0.0:${this.publicPort} -> 127.0.0.1:${this.internalPort} (默认休眠 0 MB 内存)`);

    // 每 30 秒检查闲置自动休眠
    this.idleTimer = setInterval(() => {
      if (this.state !== 'running') return;
      const humans = this._humanPlayers();
      if (humans.length > 0) {
        this.lastHumanSeenAt = Date.now();
        return;
      }
      const idleMs = Date.now() - (this.lastHumanSeenAt || this.startedAt);
      if (idleMs >= this.idleSleepMin * 60 * 1000) {
        this.log(`💤 连续 ${this.idleSleepMin} 分钟无人类玩家在线，自动存档休眠 PaperMC…`);
        this.stopServer('idle_timeout').catch(() => {});
      }
    }, 30000);
    this.idleTimer.unref?.();
  }

  _pipeToPaper(clientSock, initialBuf) {
    const up = net.createConnection({ host: '127.0.0.1', port: this.internalPort }, () => {
      if (initialBuf?.length) up.write(initialBuf);
      clientSock.pipe(up);
      up.pipe(clientSock);
    });
    const closeBoth = () => {
      try { clientSock.destroy(); } catch {}
      try { up.destroy(); } catch {}
    };
    up.on('error', closeBoth);
    clientSock.on('error', closeBoth);
    up.on('close', closeBoth);
    clientSock.on('close', closeBoth);
  }

  _sendLoginDisconnect(sock, reasonText) {
    try {
      const jsonStr = JSON.stringify({ text: reasonText });
      const pkt = buildMcPacket(0x00, buildMcString(jsonStr));
      sock.write(pkt);
    } catch {}
    setTimeout(() => { try { sock.end(); } catch {} }, 120);
  }

  _handleClientSocket(sock) {
    const ip = normalizeIp(sock.remoteAddress);
    sock.setTimeout(15000);
    sock.on('timeout', () => { try { sock.destroy(); } catch {} });
    sock.on('error', () => {});

    // 未通过 Portal 敲门的公网陌生 IP 直接静默丢弃（防全网扫描器发现和骚扰）
    if (!this.isIpAllowed(ip)) {
      this.log(`🚫 拦截未敲门 IP 连接: ${ip}`);
      sock.destroy();
      return;
    }

    let buf = Buffer.alloc(0);
    let handshake = null;
    let handled = false;

    const onData = async (chunk) => {
      if (handled) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 4096) {
        sock.destroy();
        return;
      }

      if (!handshake) {
        const hs = parseHandshakePacket(buf);
        if (!hs) return; // 等更多字节
        if (hs.invalid) {
          sock.destroy();
          return;
        }
        handshake = hs;
      }

      // ── 情况 1：多人服务器列表刷新（Status Ping，不唤醒 JVM） ──
      if (handshake.nextState === 1) {
        if (this.state === 'running') {
          handled = true;
          sock.off('data', onData);
          sock.setTimeout(0);
          this._pipeToPaper(sock, buf);
          return;
        }
        // 在休眠/启动中状态由代理直接回复 MOTD & Ping
        let cursor = handshake.consumedBytes;
        while (cursor < buf.length) {
          const pLen = readVarInt(buf, cursor);
          if (!pLen) break;
          const end = cursor + pLen.size + pLen.value;
          if (end > buf.length) break;
          const pId = readVarInt(buf, cursor + pLen.size);
          if (pId?.value === 0x00) {
            const desc = this.state === 'starting'
              ? '§e🐳 小鲸鲸的秘密基地 §7[正在唤醒世界，马上就好…]'
              : '§b🐳 小鲸鲸的秘密基地 §7[休眠省电中 · 点击进入自动唤醒]';
            const statusJson = JSON.stringify({
              version: { name: 'Paper 1.21.1', protocol: handshake.protocol || 767 },
              players: { max: 8, online: 0, sample: [{ name: this.botName, id: '00000000-0000-0000-0000-000000000001' }] },
              description: { text: desc },
            });
            sock.write(buildMcPacket(0x00, buildMcString(statusJson)));
          } else if (pId?.value === 0x01) {
            // Ping -> 原样回 Pong
            const payload = buf.subarray(cursor + pLen.size + pId.size, end);
            sock.write(buildMcPacket(0x01, payload));
            handled = true;
            setTimeout(() => { try { sock.end(); } catch {} }, 100);
          }
          cursor = end;
        }
        return;
      }

      // ── 情况 2：玩家点击加入游戏（Login） ──
      if (handshake.nextState === 2) {
        const playerName = parseLoginStartName(buf, handshake.consumedBytes);
        if (!playerName) return; // 等 Login Start 完整到达
        handled = true;
        sock.off('data', onData);
        sock.setTimeout(0);

        if (!this.isPlayerAllowed(playerName)) {
          this.log(`🚫 拒绝不在白名单内的玩家登录: ${playerName} (${ip})`);
          this._sendLoginDisconnect(sock, `§c玩家 ${playerName} 不在私服白名单内，请先在管理台添加`);
          return;
        }

        // 若当前已运行 -> 透明管道直连 PaperMC
        if (this.state === 'running') {
          this.lastHumanSeenAt = Date.now();
          this._pipeToPaper(sock, buf);
          return;
        }

        // 休眠中 -> 触发自动唤醒，并耐心等待最多 18s；若启动快则直接无缝放行进服！
        this.log(`⚡ 玩家 ${playerName} (${ip}) 触发进服自动唤醒！`);
        await this.wake({ reason: `join:${playerName}`, spawnBot: true });
        const ready = await this.waitUntilReady(18000);
        if (ready && !sock.destroyed) {
          this._pipeToPaper(sock, buf);
        } else if (!sock.destroyed) {
          this._sendLoginDisconnect(sock, '§a🐳 小鲸鲸正在唤醒 MC 世界（首次约 15~20 秒）\n§7请稍等 10 秒后重新点击加入即可直接进入！');
        }
        return;
      }

      sock.destroy();
    };

    sock.on('data', onData);
  }

  getStatus() {
    this._pruneExpiredIps();
    const humans = this._humanPlayers();
    const idleSec = this.state === 'running' && humans.length === 0
      ? Math.round((Date.now() - (this.lastHumanSeenAt || this.startedAt)) / 1000)
      : 0;
    return {
      state: this.state,
      version: '1.21.1',
      publicPort: this.publicPort,
      botName: this.botName,
      botRunning: Boolean(this.botProc),
      onlinePlayers: [...this.onlinePlayers],
      humanPlayers: humans,
      idleSec,
      idleSleepMin: this.idleSleepMin,
      uptimeSec: this.state === 'running' ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      jarExists: fs.existsSync(path.join(this.mcDir, this.jarName)),
      access: this.access,
      recentConsole: this.recentConsole.slice(-12),
    };
  }

  async shutdownAll() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    await this.stopServer('process_shutdown');
    if (this.proxyServer) {
      await new Promise((r) => this.proxyServer.close(r));
      this.proxyServer = null;
    }
  }
}
