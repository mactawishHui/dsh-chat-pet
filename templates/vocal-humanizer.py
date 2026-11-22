#!/usr/bin/env python3
"""
vocal-humanizer.py — 「活人感」声乐微瑕疵与生活场景声学引擎（纯 CPU，~2 秒处理 35 秒歌声）

核心理念：
  RVC 只换了“音色”，却完整保留了录音棚原唱的 ±0 音分修音、死板节拍网格与无换气感。
  本引擎基于 Praat TD-PSOLA（无金属味、清辅音零损伤）对干声注入真实普通人的声乐微瑕疵：
    1. 慢速有机音准漂移（1/f 平滑游走，绝非高频机械抖动）
    2. 起音懒滑入（Lazy Scoop）+ 长音尾音气短下坠（Breath-Decay Sag）
    3. 高音区吃力感（Top 18% 高音轻度偏低 + 轻气声张力）
    4. 可控 1~2 处可爱小跑调名场面（平滑余弦钟形偏离后自然找回调）
    5. 微节拍松弛（清唱弹性拖放；伴奏模式采用零累积漂移微松弛，绝不脱拍）
    6. 真人换气/急促偷换气系统（支持真声呼吸库 + 女声声道三共振峰拟真吸气）
    7. 生活化声学空间（手机近麦清唱 / 房间外放伴奏跟唱 / KTV 包厢）+ 同声纹前后口白无缝衔接
"""

import argparse
import glob
import json
import math
import os
import sys
import numpy as np
import soundfile as sf
from scipy import signal
from scipy.ndimage import gaussian_filter1d
import parselmouth
from parselmouth.praat import call


LEVEL_PRESETS = {
    'subtle': {
        'drift_cents': 12.0,
        'scoop_cents': 18.0,
        'sag_cents': 12.0,
        'high_flat_cents': 14.0,
        'offkey_count': 1,
        'offkey_cents': 32.0,
        'rubato_amt': 0.022,
        'breath_db': -27.5,
        'stolen_breaths': 0,
        'high_air_db': -34.0,
    },
    'natural': {
        'drift_cents': 18.0,
        'scoop_cents': 26.0,
        'sag_cents': 18.0,
        'high_flat_cents': 22.0,
        'offkey_count': 2,
        'offkey_cents': 44.0,
        'rubato_amt': 0.035,
        'breath_db': -24.5,
        'stolen_breaths': 1,
        'high_air_db': -31.0,
    },
    'casual': {
        'drift_cents': 26.0,
        'scoop_cents': 34.0,
        'sag_cents': 24.0,
        'high_flat_cents': 30.0,
        'offkey_count': 2,
        'offkey_cents': 56.0,
        'rubato_amt': 0.048,
        'breath_db': -22.5,
        'stolen_breaths': 1,
        'high_air_db': -29.0,
    },
    'offkey': {
        'drift_cents': 34.0,
        'scoop_cents': 42.0,
        'sag_cents': 30.0,
        'high_flat_cents': 38.0,
        'offkey_count': 3,
        'offkey_cents': 66.0,
        'rubato_amt': 0.055,
        'breath_db': -21.5,
        'stolen_breaths': 2,
        'high_air_db': -27.5,
    },
}


def load_mono(path, target_sr=44100):
    data, sr = sf.read(path, dtype='float64', always_2d=True)
    mono = np.mean(data, axis=1)
    if sr != target_sr:
        g = math.gcd(sr, target_sr)
        mono = signal.resample_poly(mono, target_sr // g, sr // g)
    return mono.astype(np.float64), target_sr


def calc_rms(x):
    if len(x) == 0:
        return 1e-6
    return float(np.sqrt(np.mean(x * x) + 1e-12))


def detect_phrases(y, sr, hop_ms=20):
    hop = int(sr * hop_ms / 1000)
    n_frames = max(1, len(y) // hop)
    rms = np.array([
        np.sqrt(np.mean(y[i * hop:(i + 1) * hop] ** 2) + 1e-12)
        for i in range(n_frames)
    ])
    rms_smooth = gaussian_filter1d(rms, sigma=2.2)
    p90 = float(np.percentile(rms_smooth, 90))
    thresh = max(0.010, p90 * 0.11)
    active = rms_smooth >= thresh

    # 合并 <160ms 的清辅音短停顿
    min_gap_frames = int(160 / hop_ms)
    i = 0
    while i < len(active):
        if not active[i]:
            j = i
            while j < len(active) and not active[j]:
                j += 1
            if i > 0 and j < len(active) and (j - i) < min_gap_frames:
                active[i:j] = True
            i = j
        else:
            i += 1

    phrases = []
    i = 0
    while i < len(active):
        if active[i]:
            j = i
            while j < len(active) and active[j]:
                j += 1
            s = i * hop_ms / 1000.0
            e = j * hop_ms / 1000.0
            if e - s >= 0.15:
                phrases.append((s, e))
            i = j
        else:
            i += 1
    return phrases, rms_smooth, hop_ms


def synth_female_breath(sr, dur_s, rng, deep=False, exhale=False):
    """女声声道三共振峰拟真呼吸/换气合成（平滑气流感，无刺耳白噪）"""
    n = max(64, int(sr * dur_s))
    white = rng.standard_normal(n)

    # 粉红化底噪
    b_pink, a_pink = signal.butter(1, 1400 / (sr * 0.5), btype='low')
    base = signal.lfilter(b_pink, a_pink, white)

    # 女声吸气/呼气声道共振峰（微随机化，避免每次换气一模一样）
    if exhale:
        f1, f2, f3 = rng.uniform(700, 900), rng.uniform(1900, 2300), rng.uniform(3500, 4100)
    elif deep:
        f1, f2, f3 = rng.uniform(950, 1180), rng.uniform(2550, 3050), rng.uniform(4300, 5000)
    else:
        f1, f2, f3 = rng.uniform(1050, 1300), rng.uniform(2750, 3300), rng.uniform(4600, 5400)

    def bp(x, fc, q):
        w0 = min(0.92, max(0.02, fc / (sr * 0.5)))
        b, a = signal.iirpeak(w0, q)
        return signal.lfilter(b, a, x)

    breath = 0.65 * bp(base, f1, 1.6) + 0.55 * bp(base, f2, 2.0) + 0.18 * bp(white, f3, 2.4)
    # 柔和低通 3400Hz，彻底去掉“呲呲蒸汽声”，只留温暖自然的真实吸气声
    b_hp, a_hp = signal.butter(2, 320 / (sr * 0.5), btype='high')
    b_lp, a_lp = signal.butter(2, 3400 / (sr * 0.5), btype='low')
    breath = signal.lfilter(b_lp, a_lp, signal.lfilter(b_hp, a_hp, breath))

    # 非对称自然包络（吸气：渐强到 60% 处后迅速闭声门收住；呼气：快起慢落）
    t = np.linspace(0.0, 1.0, n)
    if exhale:
        env = np.maximum(0.0, np.sin(np.pi * np.minimum(1.0, t / 0.25) * 0.5)) * np.exp(-3.2 * np.maximum(0.0, t - 0.12))
    else:
        peak = 0.62 if deep else 0.55
        u1 = np.clip(t / peak, 0.0, 1.0)
        u2 = np.clip((t - peak) / (1.0 - peak), 0.0, 1.0)
        env = np.where(
            t < peak,
            np.maximum(0.0, np.sin(0.5 * np.pi * u1)) ** 1.35,
            np.maximum(0.0, np.cos(0.5 * np.pi * u2)) ** 1.8
        )
    breath = np.nan_to_num(breath * env, nan=0.0, posinf=0.0, neginf=0.0)
    # 归一化到 RMS = 1.0，方便外部按 dB 精确混入
    return breath / (calc_rms(breath) + 1e-9)


def load_real_breaths(breath_dir, sr):
    clips = []
    if not breath_dir or not os.path.isdir(breath_dir):
        return clips
    for p in sorted(glob.glob(os.path.join(breath_dir, '*.wav'))):
        try:
            x, _ = load_mono(p, sr)
            if 0.08 * sr <= len(x) <= 0.6 * sr:
                x = x / (calc_rms(x) + 1e-9)
                clips.append(x)
        except Exception:
            pass
    return clips


def humanize_pitch_and_timing(y, sr, phrases, preset, mode, rng):
    """基于 Praat TD-PSOLA 修改基频曲线与微节拍（清辅音完全无损）"""
    snd = parselmouth.Sound(y, sampling_frequency=sr)
    dur_total = snd.get_total_duration()
    manip = call(snd, 'To Manipulation', 0.01, 85, 650)
    pt = call(manip, 'Extract pitch tier')
    n_pts = call(pt, 'Get number of points')

    if n_pts < 5:
        return y.copy(), np.zeros_like(y)

    times = np.array([call(pt, 'Get time from index', i) for i in range(1, n_pts + 1)], dtype=np.float64)
    freqs = np.array([call(pt, 'Get value at index', i) for i in range(1, n_pts + 1)], dtype=np.float64)

    p82_f0 = float(np.percentile(freqs, 82))
    med_f0 = float(np.median(freqs))

    # 1) 全曲慢速 1/f 有机音准游走（带宽 ~0.4Hz，绝非电音高频抖动）
    grid_n = max(50, int(dur_total * 50))
    grid_t = np.linspace(0.0, dur_total, grid_n)
    raw_walk = rng.standard_normal(grid_n)
    smooth_walk = gaussian_filter1d(raw_walk, sigma=28.0)  # ~0.56s 平滑窗口
    smooth_walk = smooth_walk / (np.max(np.abs(smooth_walk)) + 1e-9) * preset['drift_cents']

    # 2) 随机挑选 1~3 个非首句的有声过渡片段作为“可爱小跑调名场面”
    bells = []
    eligible = [p for idx, p in enumerate(phrases) if idx > 0 and (p[1] - p[0]) >= 0.75]
    rng.shuffle(eligible)
    for ps, pe in eligible[:preset['offkey_count']]:
        span = pe - ps
        b_dur = float(rng.uniform(0.45, min(0.85, span * 0.65)))
        b_center = float(rng.uniform(ps + b_dur * 0.55, pe - b_dur * 0.45))
        # 真人跑调约 70% 偏低、30% 偏高
        sign = -1.0 if rng.random() < 0.70 else 1.0
        amp = sign * float(rng.uniform(preset['offkey_cents'] * 0.72, preset['offkey_cents']))
        bells.append((b_center, b_dur, amp))

    # 3) 逐点计算最终音分偏移
    new_pt = call('Create PitchTier', 'human', 0.0, dur_total)
    high_mask_t = np.zeros(len(y), dtype=np.float64)

    for t_i, f0_i in zip(times, freqs):
        dc = float(np.interp(t_i, grid_t, smooth_walk))

        # 所属乐句：起音懒滑入 + 尾音气息下坠
        for ps, pe in phrases:
            if ps - 0.03 <= t_i <= pe + 0.03:
                dt_start = max(0.0, t_i - ps)
                if dt_start <= 0.22:
                    dc -= preset['scoop_cents'] * math.exp(-dt_start / 0.08)
                dt_end = max(0.0, pe - t_i)
                if (pe - ps) >= 0.85 and dt_end <= 0.28:
                    u = 1.0 - (dt_end / 0.28)
                    dc -= preset['sag_cents'] * (u ** 1.65)
                break

        # 高音吃力轻微偏低 + 记录高音气声区
        if f0_i > p82_f0:
            excess = min(1.0, (f0_i - p82_f0) / max(55.0, p82_f0 * 0.32))
            dc -= preset['high_flat_cents'] * excess
            idx_s = max(0, min(len(y) - 1, int(t_i * sr)))
            s0, s1 = max(0, idx_s - int(0.015 * sr)), min(len(y), idx_s + int(0.015 * sr))
            high_mask_t[s0:s1] = np.maximum(high_mask_t[s0:s1], excess)

        # 可控小跑调钟形曲线
        for bc, bd, bamp in bells:
            if abs(t_i - bc) <= bd * 0.5:
                u = (t_i - (bc - bd * 0.5)) / bd
                dc += bamp * 0.5 * (1.0 - math.cos(2.0 * math.pi * u))

        dc = max(-85.0, min(72.0, dc))
        new_f0 = max(75.0, min(720.0, f0_i * (2.0 ** (dc / 1200.0))))
        call(new_pt, 'Add point', float(t_i), float(new_f0))

    call([manip, new_pt], 'Replace pitch tier')

    # 4) 微节拍松弛（DurationTier）
    dur_tier = call('Create DurationTier', 'rubato', 0.0, dur_total)
    amt = preset['rubato_amt']
    if mode == 'acappella':
        # 清唱模式：乐句可自由微加速/放慢，情绪更自然
        for ps, pe in phrases:
            if pe - ps < 0.35:
                continue
            factor = float(rng.uniform(1.0 - amt * 1.1, 1.0 + amt * 1.35))
            mid = 0.5 * (ps + pe)
            call(dur_tier, 'Add point', max(0.005, ps), 1.0)
            call(dur_tier, 'Add point', mid, factor)
            call(dur_tier, 'Add point', min(dur_total - 0.005, pe), 1.0)
    else:
        # 带伴奏模式：句内前半微拖、后半微追（总时长守恒，绝不脱拍！）
        for ps, pe in phrases:
            span = pe - ps
            if span < 0.65:
                continue
            delta = float(rng.uniform(-amt * 0.75, amt * 0.85))
            call(dur_tier, 'Add point', max(0.005, ps), 1.0)
            call(dur_tier, 'Add point', ps + span * 0.28, 1.0 + delta)
            call(dur_tier, 'Add point', ps + span * 0.72, 1.0 - delta)
            call(dur_tier, 'Add point', min(dur_total - 0.005, pe), 1.0)

    call([manip, dur_tier], 'Replace duration tier')
    out_snd = call(manip, 'Get resynthesis (overlap-add)')
    out_y = out_snd.values[0].astype(np.float64)

    # 精确对齐原长（带伴奏时确保 1 毫秒都不飘）
    if mode != 'acappella':
        if len(out_y) > len(y):
            out_y = out_y[:len(y)]
        elif len(out_y) < len(y):
            out_y = np.pad(out_y, (0, len(y) - len(out_y)))
    high_mask = gaussian_filter1d(high_mask_t, sigma=sr * 0.03)
    if len(high_mask) != len(out_y):
        high_mask = np.interp(np.linspace(0, 1, len(out_y)), np.linspace(0, 1, len(high_mask)), high_mask)
    return out_y, high_mask


def inject_breaths_and_air(y, sr, phrases, high_mask, preset, real_breaths, rng):
    out = y.copy()
    vocal_rms = calc_rms(y[np.abs(y) > 0.015]) if np.any(np.abs(y) > 0.015) else calc_rms(y)
    base_gain = vocal_rms * (10.0 ** (preset['breath_db'] / 20.0))

    def get_breath(dur_s, deep=False, exhale=False):
        if real_breaths and not exhale and rng.random() < 0.45:
            clip = real_breaths[int(rng.integers(0, len(real_breaths)))]
            target_n = max(64, int(sr * dur_s))
            if len(clip) != target_n:
                clip = signal.resample(clip, target_n)
            return clip
        return synth_female_breath(sr, dur_s, rng, deep=deep, exhale=exhale)

    def mix_at(arr, clip, start_idx, gain):
        n = len(clip)
        s0 = max(0, start_idx)
        c0 = s0 - start_idx
        s1 = min(len(arr), start_idx + n)
        c1 = c0 + (s1 - s0)
        if s1 > s0 and c1 > c0:
            arr[s0:s1] += clip[c0:c1] * gain

    # 1) 乐句前真实吸气声（只在真正长停顿 ≥0.34s 或长乐句前轻柔出现，绝不每句“嘶嘶”刷屏）
    breath_placed = 0
    for idx, (ps, pe) in enumerate(phrases):
        prev_end = phrases[idx - 1][1] if idx > 0 else 0.0
        gap = ps - prev_end
        if idx == 0 and ps < 0.25:
            continue
        is_long_next = (pe - ps) >= 2.2
        if gap < (0.28 if is_long_next else 0.42):
            continue
        # 非长句随机跳过一半，模拟真人并不是每句话前都大喘气
        if not is_long_next and rng.random() < 0.45:
            continue
        b_dur = min(gap * 0.62, float(rng.uniform(0.20, 0.29) if is_long_next else rng.uniform(0.14, 0.20)))
        if b_dur < 0.13:
            continue
        gain = base_gain * (1.22 if is_long_next else rng.uniform(0.65, 0.92))
        breath = get_breath(b_dur, deep=is_long_next, exhale=False)
        lead = float(rng.uniform(0.035, 0.065))
        start_idx = int((ps - b_dur - lead) * sr)
        # 若原干声在该句前已自带明显呼吸声，避免叠加变双倍喘气
        chk0 = max(0, start_idx)
        chk1 = min(len(out), start_idx + int(b_dur * sr))
        if chk1 > chk0 and calc_rms(out[chk0:chk1]) > vocal_rms * 0.055:
            continue
        mix_at(out, breath, start_idx, gain)
        breath_placed += 1

    # 2) 不那么标准的“句中急促偷换气”（仅挑超长乐句的能量低谷处柔和插入）
    if preset['stolen_breaths'] > 0:
        long_phrases = [(ps, pe) for (ps, pe) in phrases if (pe - ps) >= 3.2]
        rng.shuffle(long_phrases)
        for ps, pe in long_phrases[:preset['stolen_breaths']]:
            i0 = int((ps + (pe - ps) * 0.48) * sr)
            i1 = int((ps + (pe - ps) * 0.76) * sr)
            if i1 - i0 < int(0.3 * sr):
                continue
            win = int(0.08 * sr)
            step = int(0.02 * sr)
            best_pos = i0
            best_e = 1e9
            for pos in range(i0, i1 - win, step):
                e = float(np.mean(out[pos:pos + win] ** 2))
                if e < best_e:
                    best_e = e
                    best_pos = pos
            # 轻柔压低 130ms 并插入一次 145ms 急吸气
            duck_n = int(0.13 * sr)
            s0 = max(0, best_pos)
            s1 = min(len(out), s0 + duck_n)
            if s1 - s0 > 64:
                t_u = np.linspace(0.0, 1.0, s1 - s0)
                duck_curve = 1.0 - 0.82 * (0.5 * (1.0 - np.cos(2.0 * np.pi * t_u)))
                out[s0:s1] *= duck_curve
                b_quick = get_breath(0.145, deep=False, exhale=False)
                mix_at(out, b_quick, s0 - int(0.01 * sr), base_gain * 1.15)

    # 3) 整段唱完后的轻叹呼气
    if phrases:
        last_end = phrases[-1][1]
        if last_end + 0.25 < len(out) / sr:
            exh = get_breath(0.24, deep=False, exhale=True)
            mix_at(out, exh, int((last_end + 0.05) * sr), base_gain * 0.65)

    # 4) 高音区轻气声张力
    if np.max(high_mask) > 0.05:
        air = rng.standard_normal(len(out))
        b_hp, a_hp = signal.butter(2, 2600 / (sr * 0.5), btype='high')
        b_lp, a_lp = signal.butter(2, 6800 / (sr * 0.5), btype='low')
        air = signal.lfilter(b_lp, a_lp, signal.lfilter(b_hp, a_hp, air))
        air = air / (calc_rms(air) + 1e-9)
        air_gain = vocal_rms * (10.0 ** (preset['high_air_db'] / 20.0))
        out += air * high_mask * air_gain

    return out


def apply_phone_mic_and_room(y, sr, room_style='bedroom'):
    """模拟真实手机近麦频响 + 卧室/KTV 声学反射（彻底告别干冷录音棚味）"""
    # 1) 手机麦克风温暖频响（切超低频 + 轻微中频临场感 + 高频自然柔化）
    b_hp, a_hp = signal.butter(2, 95 / (sr * 0.5), btype='high')
    b_lp, a_lp = signal.butter(2, 9500 / (sr * 0.5), btype='low')
    x = signal.lfilter(b_lp, a_lp, signal.lfilter(b_hp, a_hp, y))

    # 轻微 2.6kHz 人声临场提升 (+1.8dB)
    b_pk, a_pk = signal.iirpeak(2600 / (sr * 0.5), 1.4)
    x = x + 0.16 * signal.lfilter(b_pk, a_pk, x)

    # 2) 极自然近场房间早反射
    wet = np.zeros_like(x)
    if room_style == 'ktv':
        taps = [(0.021, 0.24), (0.043, 0.20), (0.071, 0.16), (0.113, 0.12), (0.167, 0.08), (0.235, 0.05)]
        damp_fc = 3400
    else:
        # bedroom / phone close-mic：轻微温馨近场反射，不闷不空
        taps = [(0.014, 0.11), (0.029, 0.075), (0.048, 0.045)]
        damp_fc = 3800

    for d_s, g in taps:
        d = int(d_s * sr)
        if d < len(x):
            wet[d:] += x[:-d] * g
    b_d, a_d = signal.butter(2, damp_fc / (sr * 0.5), btype='low')
    wet = signal.lfilter(b_d, a_d, wet)
    return x + wet


def apply_room_speaker_bgm(inst, sr, mode='bedroom_bgm'):
    """把无损母带伴奏滤成「房间电脑/手机外放感」或 KTV 伴奏"""
    if mode == 'ktv':
        b_hp, a_hp = signal.butter(2, 55 / (sr * 0.5), btype='high')
        b_lp, a_lp = signal.butter(2, 12000 / (sr * 0.5), btype='low')
        x = signal.lfilter(b_lp, a_lp, signal.lfilter(b_hp, a_hp, inst))
        return x
    # bedroom_bgm：小音箱外放感（弱超低频 + 柔高频 + 轻微房间散射）
    b_hp, a_hp = signal.butter(2, 150 / (sr * 0.5), btype='high')
    b_lp, a_lp = signal.butter(2, 7800 / (sr * 0.5), btype='low')
    x = signal.lfilter(b_lp, a_lp, signal.lfilter(b_hp, a_hp, inst))
    wet = np.zeros_like(x)
    for d_s, g in [(0.019, 0.16), (0.037, 0.11), (0.061, 0.06)]:
        d = int(d_s * sr)
        if d < len(x):
            wet[d:] += x[:-d] * g
    return x + wet


def soft_limit(x, target_rms=0.14):
    cur = calc_rms(x)
    if cur > 1e-6:
        x = x * (target_rms / cur)
    # 柔和模拟饱和防削波
    peak = float(np.max(np.abs(x)) + 1e-9)
    if peak > 0.92:
        x = np.tanh(x / 0.92) * 0.92
    return x


def main():
    ap = argparse.ArgumentParser(description='Vocal Humanizer — 活人感唱歌后处理引擎')
    ap.add_argument('--vocal', required=True, help='干声 WAV 路径（RVC 转换前/后）')
    ap.add_argument('--inst', default='', help='可选伴奏 WAV 路径')
    ap.add_argument('--out', default='', help='输出 WAV 路径（measure_f0 模式可省略）')
    ap.add_argument('--mode', choices=['acappella', 'bedroom_bgm', 'ktv'], default='acappella')
    ap.add_argument('--level', choices=list(LEVEL_PRESETS.keys()), default='natural')
    ap.add_argument('--bgm-db', type=float, default=None, help='伴奏相对人声的 dB 偏移（默认 bedroom=-10.5, ktv=-7.0）')
    ap.add_argument('--intro', default='', help='可选开场碎碎念 WAV（同音色 TTS）')
    ap.add_argument('--outro', default='', help='可选收尾碎碎念 WAV（同音色 TTS）')
    ap.add_argument('--breath-dir', default='', help='可选真声换气样本目录')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--out-sr', type=int, default=24000)
    ap.add_argument('--stage', choices=['full', 'pre_rvc', 'post_rvc', 'measure_f0'], default='full',
                    help='measure_f0=测算原唱基频并输出自动定调建议(JSON); pre_rvc=纯净 Praat 人性化; post_rvc=换气/声学空间/口白混音; full=一步全做')
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    preset = LEVEL_PRESETS[args.level]
    sr = 44100

    vocal, _ = load_mono(args.vocal, sr)

    if args.stage == 'measure_f0':
        snd = parselmouth.Sound(vocal, sampling_frequency=sr)
        pitch = snd.to_pitch(pitch_floor=75, pitch_ceiling=680)
        vals = pitch.selected_array['frequency']
        vals = vals[vals > 0]
        if len(vals) < 10:
            res = {'median_hz': 0.0, 'p25_hz': 0.0, 'p75_hz': 0.0, 'p90_hz': 0.0, 'suggested_pitch_shift': 0}
        else:
            med = float(np.median(vals))
            p90 = float(np.percentile(vals, 90))
            # 仅对真正低沉男声 (<172Hz 且高音区翻倍后 <=620Hz) 升八度 (+12) 以保持伴奏原调无损；
            # 高男声/女中低音 (172~440Hz) 直接原调 0，避免副歌飙高音变尖锐花栗鼠！
            if med < 172.0 and p90 * 2.0 <= 620.0:
                shift = 12
            elif med > 450.0:
                shift = -12
            else:
                shift = 0
            res = {
                'median_hz': round(med, 1),
                'p25_hz': round(float(np.percentile(vals, 25)), 1),
                'p75_hz': round(float(np.percentile(vals, 75)), 1),
                'p90_hz': round(p90, 1),
                'suggested_pitch_shift': shift,
            }
        print(json.dumps(res, ensure_ascii=False))
        return

    if not args.out:
        ap.error('--out is required unless --stage measure_f0')

    phrases, _, _ = detect_phrases(vocal, sr)

    if args.stage == 'pre_rvc':
        hum_vocal, _ = humanize_pitch_and_timing(vocal, sr, phrases, preset, args.mode, rng)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        sf.write(args.out, hum_vocal, sr, subtype='PCM_16')
        print(f'[vocal-humanizer:pre_rvc] OK mode={args.mode} level={args.level} phrases={len(phrases)} dur={len(hum_vocal)/sr:.1f}s -> {args.out}')
        return

    if args.stage == 'post_rvc':
        hum_vocal = vocal.copy()
        high_mask = np.zeros_like(hum_vocal)
    else:
        # 1. Praat TD-PSOLA 音准微瑕疵 + 微节拍松弛
        hum_vocal, high_mask = humanize_pitch_and_timing(vocal, sr, phrases, preset, args.mode, rng)

    # 2. 注入真人换气、急促偷换气与高音气声
    hum_phrases, _, _ = detect_phrases(hum_vocal, sr)
    real_breaths = load_real_breaths(args.breath_dir, sr)
    hum_vocal = inject_breaths_and_air(hum_vocal, sr, hum_phrases, high_mask, preset, real_breaths, rng)

    # 3. 手机近麦 + 房间声学空间
    room_style = 'ktv' if args.mode == 'ktv' else 'bedroom'
    vox_proc = apply_phone_mic_and_room(hum_vocal, sr, room_style=room_style)
    vox_rms = calc_rms(vox_proc[np.abs(vox_proc) > 0.01]) if np.any(np.abs(vox_proc) > 0.01) else calc_rms(vox_proc)

    # 4. 伴奏混合（仅 bedroom_bgm / ktv）
    body = vox_proc.copy()
    if args.mode in ('bedroom_bgm', 'ktv') and args.inst and os.path.exists(args.inst):
        inst_raw, _ = load_mono(args.inst, sr)
        if len(inst_raw) > len(body):
            inst_raw = inst_raw[:len(body)]
        elif len(inst_raw) < len(body):
            inst_raw = np.pad(inst_raw, (0, len(body) - len(inst_raw)))
        inst_proc = apply_room_speaker_bgm(inst_raw, sr, mode=args.mode)
        inst_rms = calc_rms(inst_proc)
        rel_db = args.bgm_db if args.bgm_db is not None else (-10.5 if args.mode == 'bedroom_bgm' else -7.0)
        inst_gain = (vox_rms * (10.0 ** (rel_db / 20.0))) / (inst_rms + 1e-9)
        # 伴奏头尾 0.35s 柔和淡入淡出
        fade_n = min(int(0.35 * sr), len(inst_proc) // 4)
        if fade_n > 10:
            inst_proc[:fade_n] *= np.linspace(0.0, 1.0, fade_n)
            inst_proc[-fade_n:] *= np.linspace(1.0, 0.0, fade_n)
        body = body + inst_proc * inst_gain

    # 5. 同声纹开场白与收尾碎碎念无缝拼接（共用同一套手机麦+房间声学）
    segments = []
    if args.intro and os.path.exists(args.intro):
        intro_raw, _ = load_mono(args.intro, sr)
        intro_proc = apply_phone_mic_and_room(intro_raw, sr, room_style=room_style)
        intro_rms = calc_rms(intro_proc[np.abs(intro_proc) > 0.01]) if np.any(np.abs(intro_proc) > 0.01) else calc_rms(intro_proc)
        intro_proc = intro_proc * ((vox_rms * 0.88) / (intro_rms + 1e-9))
        segments.append(intro_proc)
        segments.append(np.zeros(int(0.18 * sr), dtype=np.float64))

    segments.append(body)

    if args.outro and os.path.exists(args.outro):
        outro_raw, _ = load_mono(args.outro, sr)
        outro_proc = apply_phone_mic_and_room(outro_raw, sr, room_style=room_style)
        outro_rms = calc_rms(outro_proc[np.abs(outro_proc) > 0.01]) if np.any(np.abs(outro_proc) > 0.01) else calc_rms(outro_proc)
        outro_proc = outro_proc * ((vox_rms * 0.86) / (outro_rms + 1e-9))
        segments.append(np.zeros(int(0.16 * sr), dtype=np.float64))
        segments.append(outro_proc)

    final = np.concatenate(segments)

    # 极微弱真实房间底噪（-60dBFS 粉红噪，避免停顿处死寂像电子剪辑）
    room_noise = rng.standard_normal(len(final))
    b_rn, a_rn = signal.butter(1, 1200 / (sr * 0.5), btype='low')
    room_noise = signal.lfilter(b_rn, a_rn, room_noise)
    room_noise = room_noise / (calc_rms(room_noise) + 1e-9) * (vox_rms * 0.0022)
    final = soft_limit(final + room_noise, target_rms=0.145)

    # 重采样到目标采样率写出 16-bit PCM WAV
    if args.out_sr != sr:
        g = math.gcd(sr, args.out_sr)
        final = signal.resample_poly(final, args.out_sr // g, sr // g)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sf.write(args.out, final, args.out_sr, subtype='PCM_16')
    print(f'[vocal-humanizer] OK mode={args.mode} level={args.level} phrases={len(phrases)} dur={len(final)/args.out_sr:.1f}s -> {args.out}')


if __name__ == '__main__':
    main()
