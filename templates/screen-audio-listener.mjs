/**
 * screen-audio-listener.mjs — 通道 2：屏幕独立音轨后台静默听译器（ESM）
 *
 * 物理三通道核心组件：
 *   - 只接收来自「屏幕/标签页独立音频」的 16kHz PCM16 单声道音频流
 *   - 永远不触发用户说话 VAD、永远不打断 AI 回复、永远不修改通道 1 的底噪阈值
 *   - 仅把视频/电影/游戏里的旁白与台词实时写入 ScreenVisionEngine 的 45 秒纯内存滚动字幕缓存
 *   - 省流与防误识保护：
 *       1) 静音 / 暂停自动休眠（6 秒无有效音量即关闭 ASR 连接，0 额外费用）
 *       2) 纯音乐/游戏 BGM 自动探测（12 秒无文字识别即静默休眠 15 秒，不浪费额度）
 *       3) 整屏系统音频防回声：当捕获整个桌面系统音频且 AI 正在说话时，自动对屏幕音轨填静音，避免小鲸鲸自己声音混进台词
 *       4) 超长视频 4.5 分钟自动无感轮换会话，永不触碰单连接时长上限
 */

import fs from 'node:fs';
import { ParaformerStream } from './call-engine.mjs';

const PCM16K_BYTES_PER_MS = 32; // 16000 * 2 / 1000

function calcRms16(buf) {
  const n = buf.length >> 1;
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export class ScreenAudioListener {
  constructor({
    screenEngine,
    dashscopeKeyFile = '/opt/qq-tts/apikey.txt',
    asrModel = 'paraformer-realtime-v2',
    isAiSpeaking = () => false,
    log = console.log
  }) {
    this.screenEngine = screenEngine;
    this.dashscopeKeyFile = dashscopeKeyFile;
    this.asrModel = asrModel;
    this.isAiSpeaking = isAiSpeaking;
    this.log = log;

    this._surface = 'unknown'; // browser | window | monitor | unknown
    this._asr = null;
    this._streamOpenedAt = 0;
    this._lastChunkAt = 0;
    this._lastSoundAt = 0;
    this._voicedMs = 0;
    this._charsThisSession = 0;
    this._bgmCooldownUntil = 0;
    this._bgmCooldownRms = 0;
    this._preRoll = []; // 最近 ~400ms 缓冲，避免唤醒瞬间吞掉第一个字
    this._preRollBytes = 0;

    this._watchdog = setInterval(() => this._tickWatchdog(), 3000);
    this._watchdog.unref?.();
  }

  _apiKey() {
    try {
      return fs.readFileSync(this.dashscopeKeyFile, 'utf8').trim();
    } catch {
      return '';
    }
  }

  setSurface(surface) {
    this._surface = String(surface || 'unknown').slice(0, 24);
  }

  /**
   * 喂入来自浏览器或本地推流端的 16kHz PCM16 单声道音频块
   */
  pushPcm16k(pcmBuf) {
    if (!Buffer.isBuffer(pcmBuf) || pcmBuf.length < 320) return;
    if (!this.screenEngine || this.screenEngine.mode === 'off' || !this.screenEngine.audioEnabled) {
      if (this._asr) this.stop('disabled');
      return;
    }

    const aligned = pcmBuf.length % 2 === 0 ? pcmBuf : pcmBuf.subarray(0, pcmBuf.length - 1);
    const now = Date.now();
    const chunkMs = Math.max(10, Math.round(aligned.length / PCM16K_BYTES_PER_MS));
    this._lastChunkAt = now;
    this.screenEngine.noteAudioActivity({ ts: now, surface: this._surface });

    // 防回声保护：若捕获的是整个桌面/系统音频（非独立浏览器标签页），且小鲸鲸此刻正在出声，
    // 用等长静音替换该片段，防止她自己的声音被系统音轨录进「屏幕台词」
    const needEchoMute = this._surface !== 'browser' && Boolean(this.isAiSpeaking());
    const effectiveBuf = needEchoMute ? Buffer.alloc(aligned.length) : aligned;
    const rms = needEchoMute ? 0 : calcRms16(effectiveBuf);

    // 维护 400ms 预录缓冲
    this._preRoll.push(Buffer.from(effectiveBuf));
    this._preRollBytes += effectiveBuf.length;
    while (this._preRollBytes > PCM16K_BYTES_PER_MS * 420 && this._preRoll.length > 1) {
      this._preRollBytes -= this._preRoll.shift().length;
    }

    if (!this._asr) {
      if (now < this._bgmCooldownUntil && rms < Math.max(600, this._bgmCooldownRms * 2.2)) {
        return;
      }
      if (rms >= 180) {
        this._voicedMs += chunkMs;
        if (this._voicedMs >= 200) {
          this._openStream(now);
        }
      } else {
        this._voicedMs = 0;
      }
      return;
    }

    // 正在后台静默听译
    this._asr.sendAudio(effectiveBuf);
    if (rms >= 140) {
      this._lastSoundAt = now;
    }

    const sessionAge = now - this._streamOpenedAt;
    // 1. 静音/暂停超过 6 秒：立即关闭 ASR 省流休眠
    if (now - this._lastSoundAt >= 6000) {
      this._closeStream('idle_sleep', true);
      return;
    }
    // 2. 连续 12 秒有声但一个字都没认出来（纯音乐/游戏音效）：休眠 15 秒省流
    if (sessionAge >= 12000 && this._charsThisSession === 0) {
      this._bgmCooldownUntil = now + 15000;
      this._bgmCooldownRms = rms;
      this.log('[screen-audio] 通道 2 检测到纯 BGM/无对白，休眠 15s 省流');
      this._closeStream('bgm_cooldown', false);
      return;
    }
    // 3. 长视频 4.5 分钟无感轮换连接
    if (sessionAge >= 270000) {
      this.log('[screen-audio] 通道 2 后台听译会话满 4.5 分钟，无感轮换');
      this._closeStream('rotate', true);
    }
  }

  _openStream(now) {
    const apiKey = this._apiKey();
    if (!apiKey) return;
    this._voicedMs = 0;
    this._streamOpenedAt = now;
    this._lastSoundAt = now;
    this._charsThisSession = 0;

    const stream = new ParaformerStream({
      apiKey,
      model: this.asrModel,
      onPartial: (txt) => {
        if (stream._discarded) return;
        this._charsThisSession += txt.length;
        this.screenEngine.pushAudioTranscript(txt, { isFinal: false, source: 'screen-audio' });
      },
      onSentence: (txt) => {
        if (stream._discarded) return;
        this._charsThisSession += txt.length;
        const pushed = this.screenEngine.pushAudioTranscript(txt, { isFinal: true, source: 'screen-audio' });
        if (pushed) {
          this.log(`[screen-audio] 🎬 通道 2 台词: "${txt.slice(0, 72)}"`);
        }
      },
      onClose: () => {
        if (this._asr === stream) this._asr = null;
      },
      log: (msg) => this.log(String(msg).replace('[call-asr]', '[screen-audio]'))
    });

    for (const f of this._preRoll) stream.sendAudio(f);
    this._asr = stream;
    this.log(`[screen-audio] 通道 2 后台听译已唤醒 (surface=${this._surface})`);
  }

  _closeStream(reason = 'stop', graceful = true) {
    const s = this._asr;
    this._asr = null;
    this._voicedMs = 0;
    if (!s) return;
    if (graceful) {
      s.finish(1500).then(() => {
        if (s._discarded) return;
        const tailPartial = String(s.currentPartial || '').trim();
        if (tailPartial) {
          this.screenEngine.pushAudioTranscript(tailPartial, { isFinal: true, source: 'screen-audio' });
        }
      }).catch(() => {});
    } else {
      s._discarded = true;
      s.abort();
    }
    if (reason === 'idle_sleep') {
      this.log('[screen-audio] 通道 2 画面静音超过 6s，已休眠省流');
    }
  }

  _tickWatchdog() {
    if (!this._asr) return;
    const now = Date.now();
    if (!this.screenEngine?.audioEnabled || this.screenEngine?.mode === 'off') {
      this._closeStream('disabled', false);
      return;
    }
    if (this._lastChunkAt && now - this._lastChunkAt >= 5000) {
      this._closeStream('stream_stopped', true);
    }
  }

  stop(reason = 'manual') {
    this._preRoll = [];
    this._preRollBytes = 0;
    this._bgmCooldownUntil = 0;
    this._closeStream(reason, false);
  }

  destroy() {
    if (this._watchdog) clearInterval(this._watchdog);
    this.stop('destroy');
  }
}
