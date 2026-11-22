/**
 * qq-screen-adapter.mjs — Endpoint A：QQ 原生屏幕共享画面捕获适配层（ESM）
 *
 * 与核心引擎彻底解耦：
 *   - 仅在 QQ 语音通话进行期间运行，挂断瞬间自动停止并清空 qq-screen 来源帧
 *   - 自动监测 snowluma 容器内 DISPLAY=:1 窗口变化（支持新建共享窗口或原通话窗口变大）
 *   - 每次单帧轻量抓屏（ffmpeg -f x11grab -frames:v 1），零僵尸进程残留、纯内存传 JPEG 给 ScreenVisionEngine
 *   - 当更清晰的 Endpoint B（本地 1080p 浏览器直连）活跃时自动静默避让，零 CPU 浪费
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseXwinTree(raw) {
  const wins = [];
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^\s*(0x[0-9a-fA-F]+)\s+"([^"]*)".*?(\d+)x(\d+)\+(-?\d+)\+(-?\d+)\s+\+(-?\d+)\+(-?\d+)/);
    if (!m) continue;
    const w = Number(m[3]);
    const h = Number(m[4]);
    const x = Number(m[7]);
    const y = Number(m[8]);
    if (w < 200 || h < 200) continue;
    wins.push({ wid: m[1], title: m[2], w, h, x: Math.max(0, x), y: Math.max(0, y) });
  }
  return wins;
}

export class QQScreenShareAdapter {
  constructor({
    screenEngine,
    containerName = process.env.SNOWLUMA_CONTAINER || 'snowluma',
    pollIntervalMs = 2800,
    maxWidth = 768,
    isPaused = () => false,
    log = console.log
  }) {
    this.screenEngine = screenEngine;
    this.containerName = containerName;
    this.pollIntervalMs = pollIntervalMs;
    this.maxWidth = maxWidth;
    this.isPaused = isPaused;
    this.log = log;

    this._running = false;
    this._timer = null;
    this._busy = false;
    this._callWid = '';
    this._baselineWids = new Set();
    this._activeShareWin = null;
  }

  async _dockerCmd(cmd, timeoutMs = 5000) {
    const { stdout } = await execFileAsync('docker', ['exec', this.containerName, 'sh', '-c', cmd], {
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024
    });
    return stdout;
  }

  async _listQQWindows() {
    try {
      const out = await this._dockerCmd('export LC_ALL=C.UTF-8; DISPLAY=:1 xwininfo -root -tree 2>/dev/null | grep -iE \'"QQ"|"屏幕共享"|"共享屏幕"|"Screen"\' || true');
      return parseXwinTree(out);
    } catch {
      return [];
    }
  }

  async _isViewable(wid) {
    try {
      const out = await this._dockerCmd(`export LC_ALL=C.UTF-8; DISPLAY=:1 xwininfo -id ${wid} 2>/dev/null | grep "Map State:" || true`);
      return out.includes('IsViewable');
    } catch {
      return false;
    }
  }

  /**
   * 精准查找当前屏幕上真实可见（IsViewable）的「屏幕共享」查看器窗口
   */
  async findVisibleShareWindow() {
    const wins = await this._listQQWindows();
    const candidates = wins
      .filter((w) => /屏幕共享|共享屏幕|screen/i.test(w.title) && w.w >= 320 && w.h >= 240)
      .sort((a, b) => (b.w * b.h) - (a.w * a.h));
    for (const c of candidates) {
      if (await this._isViewable(c.wid)) return c;
    }
    return null;
  }

  async _captureWindowJpeg(win) {
    const w = Math.max(200, win.w - (win.w % 2));
    const h = Math.max(200, win.h - (win.h % 2));
    const x = Math.max(0, win.x);
    const y = Math.max(0, win.y);
    const { stdout } = await execFileAsync('docker', [
      'exec', this.containerName, 'nice', '-n', '15', 'ffmpeg',
      '-loglevel', 'error',
      '-f', 'x11grab',
      '-video_size', `${w}x${h}`,
      '-i', `:1+${x},${y}`,
      '-frames:v', '1',
      '-vf', `scale='min(${this.maxWidth},iw)':-2`,
      '-q:v', '7',
      '-f', 'mjpeg',
      'pipe:1'
    ], {
      encoding: 'buffer',
      timeout: 5000,
      maxBuffer: 3 * 1024 * 1024
    });
    return Buffer.isBuffer(stdout) && stdout.length > 800 ? stdout : null;
  }

  /**
   * 诊断探测：列出当前容器内所有 QQ 相关窗口（供首次校准 QQ 屏幕共享窗口布局使用）
   */
  async probe() {
    const wins = await this._listQQWindows();
    return {
      running: this._running,
      callWid: this._callWid,
      activeShareWin: this._activeShareWin,
      windows: wins
    };
  }

  async start(callWid = '', { forceShareWin = null } = {}) {
    if (this._running) {
      if (forceShareWin) {
        this._forceShareWin = forceShareWin;
        this._activeShareWin = forceShareWin;
      }
      return;
    }
    this._running = true;
    this._callWid = String(callWid || '');
    this._forceShareWin = forceShareWin || null;
    const wins = await this._listQQWindows();
    this._baselineWids = new Set(wins.filter((w) => !forceShareWin || w.wid !== forceShareWin.wid).map((w) => w.wid));
    this._activeShareWin = forceShareWin || null;
    this.log(`[qq-screen] 已挂载通话屏幕共享监测 (baseline=${this._baselineWids.size} 窗口, callWid=${this._callWid || '?'}${forceShareWin ? `, locked=${forceShareWin.wid}(${forceShareWin.w}x${forceShareWin.h})` : ''})`);
    this._timer = setInterval(() => this._tick(), this.pollIntervalMs);
    this._timer.unref?.();
    if (forceShareWin) setTimeout(() => this._tick(), 300);
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._activeShareWin = null;
    this._forceShareWin = null;
    if (this.screenEngine.getLatestFrame()?.source === 'qq-screen') {
      this.screenEngine.clear('qq_call_ended');
    }
    this.log('[qq-screen] 已停止 QQ 屏幕共享监测');
  }

  _pickShareWindow(wins) {
    // 0. 若直接通过屏幕共享邀请进入并锁定了查看窗口，优先跟住该窗口（刷新其最新几何坐标）
    if (this._forceShareWin) {
      const matched = wins.find((w) => w.wid === this._forceShareWin.wid);
      if (matched) return matched;
    }
    // 1. 优先选标题含「共享/Screen」的独立窗口
    const titled = wins.find((w) => /共享|screen/i.test(w.title) && w.w >= 320 && w.h >= 240);
    if (titled) return titled;
    // 2. 通话开始后新弹出的大窗口（常见于 LinuxQQ 接收远端桌面共享，含中文标题失败回退窗口）
    const newlyOpened = wins
      .filter((w) => !this._baselineWids.has(w.wid) && w.wid !== this._callWid && w.w >= 420 && w.h >= 300)
      .sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
    if (newlyOpened) return newlyOpened;
    // 3. 原 360x640 通话窗口被拉宽/放大（屏幕共享内嵌展开）
    if (this._callWid) {
      const expanded = wins.find((w) => w.wid === this._callWid && (w.w >= 450 || w.h >= 680));
      if (expanded) return expanded;
    }
    return null;
  }

  async _tick() {
    if (!this._running || this._busy) return;
    if (this.screenEngine.mode === 'off') return;
    // 小鲸鲸正在开口说话的 1~3 秒内暂停抓屏，把 CPU 全部让给 PulseAudio 播放，彻底消除音频卡顿
    if (this.isPaused()) return;
    // 若更高清晰度的浏览器直连流正在活跃，省掉所有容器抓屏开销
    const latest = this.screenEngine.getLatestFrame();
    if (latest && latest.source !== 'qq-screen' && Date.now() - latest.ts < 5000) return;

    this._busy = true;
    try {
      let target = await this.findVisibleShareWindow();
      if (!target) {
        const wins = await this._listQQWindows();
        const fallback = this._pickShareWindow(wins);
        if (fallback && await this._isViewable(fallback.wid)) target = fallback;
      }
      if (!target) {
        if (this._activeShareWin) {
          this.log('[qq-screen] 检测到 QQ 屏幕共享已关闭');
          this._activeShareWin = null;
          if (this.screenEngine.getLatestFrame()?.source === 'qq-screen') {
            this.screenEngine.clear('qq_share_stopped');
          }
        }
        return;
      }
      if (!this._activeShareWin || this._activeShareWin.wid !== target.wid) {
        this.log(`[qq-screen] 检测到 QQ 屏幕共享画面: wid=${target.wid} "${target.title}" ${target.w}x${target.h}+${target.x}+${target.y}`);
      }
      this._activeShareWin = target;
      const jpeg = await this._captureWindowJpeg(target);
      if (jpeg) {
        this.screenEngine.pushFrame(jpeg, {
          source: 'qq-screen',
          label: 'QQ屏幕共享',
          width: target.w,
          height: target.h
        });
      }
    } catch {
      // ignore transient x11 capture errors
    } finally {
      this._busy = false;
    }
  }
}
