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
from scipy.ndimage import gaussian_filter, gaussian_filter1d
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
        'breath_db': -25.8,
        'stolen_breaths': 1,
        'high_air_db': -32.0,
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


def load_stereo_mid_side(path, target_sr=44100):
    """读取音频并返回 (mid, side, is_stereo)，供主唱提纯与多人合唱/宽声场检测使用"""
    data, sr = sf.read(path, dtype='float64', always_2d=True)
    if data.shape[1] >= 2:
        left, right = data[:, 0], data[:, 1]
        if sr != target_sr:
            g = math.gcd(sr, target_sr)
            left = signal.resample_poly(left, target_sr // g, sr // g)
            right = signal.resample_poly(right, target_sr // g, sr // g)
        return 0.5 * (left + right), 0.5 * (left - right), True
    mono = data[:, 0]
    if sr != target_sr:
        g = math.gcd(sr, target_sr)
        mono = signal.resample_poly(mono, target_sr // g, sr // g)
    return mono, np.zeros_like(mono), False


def extract_clean_lead_vocal(path, target_sr=44100, gate_bleed=False):
    """
    从 Demucs 立体声人声轨中提取纯净居中主唱干声：
      1. STFT Mid/Side 维纳掩码：剥离声像居两侧的房间大混响、宽声场和声/合唱层与残留立体声乐器漏音，保留居中主唱；
      2. 100Hz 4阶高通：彻底切掉 Demucs 漏进的低频贝斯/大鼓/大提琴“嗡嗡”轰鸣；
      3. 可选乐句间漏音柔和门限（-16dB）：防止 RVC 把句间微弱伴奏漏音误合成怪异喘气或嗡嗡杂音。
    """
    mid, side, is_stereo = load_stereo_mid_side(path, target_sr)
    if is_stereo:
        side_ratio = float(np.sum(side * side) / (np.sum(mid * mid) + 1e-9))
        if side_ratio > 0.035 and len(mid) > 4096:
            _, _, z_m = signal.stft(mid, fs=target_sr, nperseg=2048, noverlap=1536)
            _, _, z_s = signal.stft(side, fs=target_sr, nperseg=2048, noverlap=1536)
            pm = gaussian_filter(np.abs(z_m) ** 2, sigma=(1.0, 1.4))
            ps = gaussian_filter(np.abs(z_s) ** 2, sigma=(1.0, 1.4))
            mask = pm / (pm + 1.85 * ps + 1e-12)
            mask = np.clip(mask, 0.16, 1.0)
            _, lead = signal.istft(z_m * mask, fs=target_sr, nperseg=2048, noverlap=1536)
            if len(lead) >= len(mid):
                lead = lead[:len(mid)]
            else:
                lead = np.pad(lead, (0, len(mid) - len(lead)))
        else:
            lead = mid
    else:
        lead = mid

    lead = np.nan_to_num(lead.astype(np.float64), nan=0.0, posinf=0.0, neginf=0.0)
    # 100Hz 4阶高通切掉低频“嗡嗡”底噪
    b_hp, a_hp = signal.butter(4, 100.0 / (target_sr * 0.5), btype='high')
    lead = signal.lfilter(b_hp, a_hp, lead)

    if gate_bleed and len(lead) > target_sr:
        phrases, _, _ = detect_phrases(lead, target_sr, hop_ms=15, min_gap_ms=220, thresh_ratio=0.085)
        if phrases:
            env = np.full(len(lead), 0.16, dtype=np.float64)  # 句间柔和衰减 -16dB
            pad = int(0.14 * target_sr)
            for ps_t, pe_t in phrases:
                i0 = max(0, int(ps_t * target_sr) - pad)
                i1 = min(len(lead), int(pe_t * target_sr) + pad)
                env[i0:i1] = 1.0
            env = gaussian_filter1d(env, sigma=target_sr * 0.035)
            lead = lead * env

    return lead, target_sr


def calc_rms(x):
    if len(x) == 0:
        return 1e-6
    return float(np.sqrt(np.mean(x * x) + 1e-12))


def detect_phrases(y, sr, hop_ms=20, min_gap_ms=160, thresh_ratio=0.11):
    hop = int(sr * hop_ms / 1000)
    n_frames = max(1, len(y) // hop)
    rms = np.array([
        np.sqrt(np.mean(y[i * hop:(i + 1) * hop] ** 2) + 1e-12)
        for i in range(n_frames)
    ])
    rms_smooth = gaussian_filter1d(rms, sigma=2.0)
    p90 = float(np.percentile(rms_smooth, 90))
    thresh = max(0.008, p90 * thresh_ratio)
    active = rms_smooth >= thresh

    # 合并短于 min_gap_ms 的清辅音/字间停顿
    min_gap_frames = max(1, int(min_gap_ms / hop_ms))
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
            if e - s >= 0.16:
                phrases.append((s, e))
            i = j
        else:
            i += 1
    return phrases, rms_smooth, hop_ms


def find_phrase_locked_window(vocal, sr, min_dur=22.0, target_dur=40.0, max_dur=44.5, mid_raw=None, side_raw=None):
    """
    在 Demucs 分离出的纯净人声轨上做 10ms 级「按完整乐句锁边」裁剪定位：
      - 自动跳过开头 MV 电影对白/读白碎片（后面紧跟 >=4.5s 超长纯伴奏空档的短段）；
      - 起点严格落在完整首句之前的静音间隙（跳过被粗切片截断的残句，绝不从一句中间开唱）；
      - 遇到快节奏连唱超长段 (>8.5s) 自动按能量谷底细分句界，避免整段副歌粘成一句；
      - 终点严格落在完整乐句结尾后的静音间隙（严格 < 下一句起点 - 0.16s，绝不漏唱下一句半个字）；
      - 结合 Praat HNR 谐波清晰度 + 基频跳变率 + 逐句立体声宽度(Side/Mid 比)，精准识别多人合唱/喊麦混沌区并在其之前干净收尾！
    """
    total_dur = len(vocal) / float(sr)
    phrases, rms_s, hop_ms = detect_phrases(vocal, sr, hop_ms=15, min_gap_ms=220, thresh_ratio=0.075)
    if not phrases:
        return {
            'start': 0.0,
            'end': round(min(total_dur, target_dur), 3),
            'dur': round(min(total_dur, target_dur), 3),
            'phrases': 0,
            'avg_hnr': 0.0,
        }

    # 若快歌把整段粘成 >8.5s 超长句，在局部能量谷底细分句界（保证能切在合理乐句之间）
    refined = []
    for ps, pe in phrases:
        if pe - ps <= 8.5:
            refined.append((ps, pe))
            continue
        sub_phrases, _, _ = detect_phrases(
            vocal[int(ps * sr):int(pe * sr)], sr, hop_ms=15, min_gap_ms=100, thresh_ratio=0.16
        )
        if len(sub_phrases) >= 2:
            for sp, ep in sub_phrases:
                refined.append((ps + sp, ps + ep))
        else:
            refined.append((ps, pe))
    phrases = refined

    # 计算逐帧谐波清晰度 HNR 与基频连续性（识别多人喊麦/重合唱/说唱混沌段）
    hnr_vals, hnr_t0, hnr_dt = None, 0.0, 0.01
    f0_vals, f0_t0, f0_dt = None, 0.0, 0.01
    try:
        snd = parselmouth.Sound(vocal, sampling_frequency=sr)
        harm = call(snd, 'To Harmonicity (cc)', 0.01, 75, 0.1, 1.0)
        hnr_vals, hnr_t0, hnr_dt = harm.values[0], harm.x1, harm.dx
        pit = snd.to_pitch(time_step=0.01, pitch_floor=75, pitch_ceiling=680)
        f0_vals = pit.selected_array['frequency']
        f0_t0, f0_dt = pit.x1, pit.dx
    except Exception:
        pass

    def phrase_quality(ps_t, pe_t):
        hnr = 12.0
        if hnr_vals is not None and len(hnr_vals) > 0:
            i0 = max(0, int((ps_t - hnr_t0) / hnr_dt))
            i1 = min(len(hnr_vals), int((pe_t - hnr_t0) / hnr_dt) + 1)
            seg = hnr_vals[i0:i1]
            seg = seg[seg > -100.0]
            if len(seg) >= 3:
                hnr = float(np.median(seg))
        jump_rate = 0.0
        if f0_vals is not None and len(f0_vals) > 0:
            j0 = max(0, int((ps_t - f0_t0) / f0_dt))
            j1 = min(len(f0_vals), int((pe_t - f0_t0) / f0_dt) + 1)
            fseg = f0_vals[j0:j1]
            voiced = fseg[fseg > 0]
            if len(voiced) >= 6:
                diffs = np.abs(np.diff(np.log2(voiced + 1e-6))) * 12.0
                jump_rate = float(np.mean(diffs > 3.5))
        side_ratio = 0.0
        if mid_raw is not None and side_raw is not None and len(mid_raw) == len(side_raw):
            s0 = max(0, int(ps_t * sr))
            s1 = min(len(mid_raw), int(pe_t * sr))
            if s1 > s0 + 100:
                m_e = float(np.sum(mid_raw[s0:s1] ** 2)) + 1e-9
                s_e = float(np.sum(side_raw[s0:s1] ** 2))
                side_ratio = s_e / m_e
        return hnr, jump_rate, side_ratio

    p_quals = [phrase_quality(ps, pe) for ps, pe in phrases]
    p_hnrs = [q[0] for q in p_quals]
    p_jumps = [q[1] for q in p_quals]
    p_sides = [q[2] for q in p_quals]
    # 基线独唱立体声宽度（用于识别副歌突然切进多人大合唱/宽声场喊麦的跳变！）
    solo_side_base = float(np.percentile(p_sides[:max(2, len(p_sides) // 2)], 40)) if p_sides else 0.0

    def is_chaotic_phrase(idx_p):
        hnr_bad = p_hnrs[idx_p] < 9.2
        jump_bad = p_jumps[idx_p] > 0.12
        # 立体声宽度相对前面独唱段暴涨 (>2.4x 且绝对值 >0.22)，典型多人合唱/双声部重唱特征
        chorus_spike = (p_sides[idx_p] > max(0.24, solo_side_base * 2.4))
        return hnr_bad or jump_bad or chorus_spike

    # 1) 起点：跳过开头残句 + 跳过 MV 电影台词开场（后面紧跟 >=4.5s 超长纯伴奏停顿的短段）
    start_idx = 0
    if len(phrases) >= 2 and phrases[0][0] < 0.18:
        start_idx = 1
    while start_idx + 1 < len(phrases):
        ps_cur, pe_cur = phrases[start_idx]
        gap_next = phrases[start_idx + 1][0] - pe_cur
        remaining_after = total_dur - phrases[start_idx + 1][0]
        is_mv_dialogue_intro = (gap_next >= 4.5 and (pe_cur - ps_cur) <= 5.5 and remaining_after >= min_dur)
        if (pe_cur - ps_cur) < 0.45 or is_mv_dialogue_intro:
            start_idx += 1
        else:
            break

    ps0 = phrases[start_idx][0]
    prev_end = phrases[start_idx - 1][1] if start_idx > 0 else 0.0
    gap_before = max(0.0, ps0 - prev_end)
    if start_idx == 0:
        lead_pad = min(0.95, gap_before)
    else:
        lead_pad = min(0.95, max(0.20, gap_before * 0.55))
        if ps0 - lead_pad < prev_end + 0.18:
            lead_pad = max(0.05, ps0 - (prev_end + 0.18))
    trim_start = max(0.0, ps0 - lead_pad)

    # 2) 终点：枚举完整乐句结尾，综合打分（大停顿加分 + 贴近目标时长 + 强力避开多人合唱/喊麦混沌尾段）
    best_k = None
    best_score = -1e9
    for k in range(start_idx, len(phrases)):
        pe_k = phrases[k][1]
        next_start = phrases[k + 1][0] if k + 1 < len(phrases) else total_dur
        gap_after = max(0.0, next_start - pe_k)
        tail_pad = min(1.05, max(0.16, gap_after * 0.55))
        if k + 1 < len(phrases):
            max_safe_end = next_start - 0.16
            cand_end = min(pe_k + tail_pad, max_safe_end)
            if cand_end <= pe_k + 0.03:
                continue
        else:
            cand_end = min(total_dur, pe_k + 0.95)

        dur_k = cand_end - trim_start
        if dur_k < min_dur or dur_k > max_dur:
            continue

        gap_bonus = 44.0 if gap_after >= 0.70 else (28.0 if gap_after >= 0.40 else (14.0 if gap_after >= 0.22 else -10.0))
        dur_penalty = abs(dur_k - target_dur) * 1.15

        chaos_penalty = 0.0
        for idx_p in range(start_idx, k + 1):
            span_p = phrases[idx_p][1] - phrases[idx_p][0]
            if is_chaotic_phrase(idx_p):
                chaos_penalty += 28.0 + span_p * 3.5
        next_is_chaos = (k + 1 < len(phrases)) and is_chaotic_phrase(k + 1)
        stop_before_chaos_bonus = 36.0 if next_is_chaos else 0.0

        score = gap_bonus + stop_before_chaos_bonus - dur_penalty - chaos_penalty
        if score > best_score:
            best_score = score
            best_k = (k, cand_end, gap_after, float(np.mean(p_hnrs[start_idx:k + 1])))

    if best_k is None:
        for k in range(len(phrases) - 1, start_idx - 1, -1):
            pe_k = phrases[k][1]
            next_start = phrases[k + 1][0] if k + 1 < len(phrases) else total_dur
            cand_end = min(pe_k + 0.50, next_start - 0.14) if k + 1 < len(phrases) else min(total_dur, pe_k + 0.85)
            if cand_end - trim_start <= max_dur and cand_end > trim_start + 12.0:
                best_k = (k, cand_end, max(0.0, next_start - pe_k), float(np.mean(p_hnrs[start_idx:k + 1])))
                break

    if best_k is None:
        trim_end = min(total_dur, trim_start + max_dur)
        avg_h = float(np.mean(p_hnrs)) if p_hnrs else 10.0
        kept = len(phrases)
    else:
        k_idx, trim_end, _, avg_h = best_k
        kept = k_idx - start_idx + 1

    return {
        'start': round(float(trim_start), 3),
        'end': round(float(trim_end), 3),
        'dur': round(float(trim_end - trim_start), 3),
        'phrases': int(kept),
        'total_phrases': len(phrases),
        'avg_hnr': round(avg_h, 1),
    }


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

    # 1) 乐句前真实吸气声（只在真正停顿 ≥0.36s 且全曲不超过 5 次轻柔出现，绝不密集刷屏）
    breath_placed = 0
    for idx, (ps, pe) in enumerate(phrases):
        if breath_placed >= 5:
            break
        prev_end = phrases[idx - 1][1] if idx > 0 else 0.0
        gap = ps - prev_end
        if idx == 0 and ps < 0.28:
            continue
        is_long_next = (pe - ps) >= 2.2
        if gap < (0.32 if is_long_next else 0.46):
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


def apply_peaking_eq(x, sr, fc, q, gain_db):
    """标准 RBJ 参量峰值均衡器（正值提亮、负值精准挖槽去浑浊/让出人声频段）"""
    if abs(gain_db) < 0.05:
        return x
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * math.pi * min(sr * 0.46, max(20.0, fc)) / sr
    alpha = math.sin(w0) / (2.0 * q)
    b0 = 1.0 + alpha * A
    b1 = -2.0 * math.cos(w0)
    b2 = 1.0 - alpha * A
    a0 = 1.0 + alpha / A
    a1 = -2.0 * math.cos(w0)
    a2 = 1.0 - alpha / A
    b = np.array([b0 / a0, b1 / a0, b2 / a0], dtype=np.float64)
    a = np.array([1.0, a1 / a0, a2 / a0], dtype=np.float64)
    return signal.lfilter(b, a, x)


def apply_phone_mic_and_room(y, sr, room_style='bedroom'):
    """模拟真实手机近麦频响 + 无嗡鸣近场房间早反射（彻底告别干冷棚感与低中频浑浊嗡嗡声）"""
    # 1) 手机麦克风温暖清晰频响：110Hz 切低频轰鸣 + 280Hz 轻微去浑浊 + 2.8kHz 清晰临场 + 9.8kHz 自然柔化
    b_hp, a_hp = signal.butter(2, 110 / (sr * 0.5), btype='high')
    b_lp, a_lp = signal.butter(2, 9800 / (sr * 0.5), btype='low')
    x = signal.lfilter(b_lp, a_lp, signal.lfilter(b_hp, a_hp, y))
    x = apply_peaking_eq(x, sr, 280.0, 1.2, -2.5)
    x = apply_peaking_eq(x, sr, 2800.0, 1.3, 1.8)

    # 2) 无梳状“嗡嗡”共振的自然早反射：反射总线先 380Hz 高通去低频轰鸣，并采用正负极性交替质数延迟
    wet = np.zeros_like(x)
    if room_style == 'ktv':
        taps = [(0.019, 0.16), (0.037, -0.12), (0.067, 0.09), (0.109, -0.06), (0.163, 0.04)]
        damp_fc = 3400
    else:
        taps = [(0.013, 0.085), (0.029, -0.055), (0.047, 0.035)]
        damp_fc = 3600

    for d_s, g in taps:
        d = int(d_s * sr)
        if d < len(x):
            wet[d:] += x[:-d] * g
    b_whp, a_whp = signal.butter(2, 380 / (sr * 0.5), btype='high')
    b_wlp, a_wlp = signal.butter(2, damp_fc / (sr * 0.5), btype='low')
    wet = signal.lfilter(b_wlp, a_wlp, signal.lfilter(b_whp, a_whp, wet))
    return x + wet


def apply_room_speaker_bgm(inst, sr, mode='bedroom_bgm'):
    """把伴奏滤成清晰不抢麦的「房间外放/KTV 伴奏」（精准挖出人声频段，彻底消除嗡嗡盖人声）"""
    if mode == 'ktv':
        b_hp, a_hp = signal.butter(2, 95 / (sr * 0.5), btype='high')
        b_lp, a_lp = signal.butter(2, 10500 / (sr * 0.5), btype='low')
        x = signal.lfilter(b_lp, a_lp, signal.lfilter(b_hp, a_hp, inst))
        x = apply_peaking_eq(x, sr, 320.0, 1.0, -2.5)
        x = apply_peaking_eq(x, sr, 2400.0, 1.2, -2.5)
        return x
    # bedroom_bgm：小音箱外放感（220Hz 切掉低音轰鸣 + 350Hz/2.4kHz 人声避让凹槽 + 高通交替反射零嗡鸣）
    b_hp, a_hp = signal.butter(2, 220 / (sr * 0.5), btype='high')
    b_lp, a_lp = signal.butter(2, 7500 / (sr * 0.5), btype='low')
    x = signal.lfilter(b_lp, a_lp, signal.lfilter(b_hp, a_hp, inst))
    x = apply_peaking_eq(x, sr, 350.0, 1.0, -3.5)
    x = apply_peaking_eq(x, sr, 2400.0, 1.2, -3.0)
    wet = np.zeros_like(x)
    for d_s, g in [(0.017, 0.10), (0.037, -0.065), (0.059, 0.04)]:
        d = int(d_s * sr)
        if d < len(x):
            wet[d:] += x[:-d] * g
    b_whp, a_whp = signal.butter(2, 400 / (sr * 0.5), btype='high')
    wet = signal.lfilter(b_whp, a_whp, wet)
    return x + wet


def calc_active_percentile_rms(x, sr, pct=75, win_ms=200):
    """用分帧 P75 响度衡量伴奏能量，避免前奏安静导致副歌响度被错误拉爆"""
    hop = max(1, int(sr * win_ms / 1000))
    n = len(x) // hop
    if n < 3:
        return calc_rms(x)
    frames = np.array([np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2) + 1e-12) for i in range(n)])
    nonzero = frames[frames > 1e-4]
    if len(nonzero) < 2:
        return calc_rms(x)
    return float(np.percentile(nonzero, pct))


def apply_vocal_sidechain_ducking(inst, vocal, sr, duck_db=-2.5):
    """温和人声侧链避让：开口唱时伴奏自动柔和压低 2.5dB，句间停顿自然回升，清晰又不生硬"""
    if len(inst) != len(vocal) or len(inst) < sr:
        return inst
    hop = int(sr * 0.02)
    n = max(1, len(vocal) // hop)
    v_rms = np.array([np.sqrt(np.mean(vocal[i * hop:(i + 1) * hop] ** 2) + 1e-12) for i in range(n)])
    v_smooth = gaussian_filter1d(v_rms, sigma=4.0)
    p85 = float(np.percentile(v_smooth, 85)) + 1e-9
    activity = np.clip((v_smooth - p85 * 0.12) / (p85 * 0.45), 0.0, 1.0)
    activity = gaussian_filter1d(activity, sigma=5.0)  # ~100ms 平滑释放
    duck_lin = 10.0 ** (duck_db / 20.0)
    gain_frames = 1.0 - activity * (1.0 - duck_lin)
    gain = np.interp(np.linspace(0, n - 1, len(inst)), np.arange(n), gain_frames)
    return inst * gain


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
    ap.add_argument('--out', default='', help='输出 WAV 路径（measure_f0 / find_window 模式可省略）')
    ap.add_argument('--mode', choices=['acappella', 'bedroom_bgm', 'ktv'], default='acappella')
    ap.add_argument('--level', choices=list(LEVEL_PRESETS.keys()), default='natural')
    ap.add_argument('--bgm-db', type=float, default=None, help='伴奏相对人声的 dB 偏移（默认 bedroom=-12.8, ktv=-9.2）')
    ap.add_argument('--intro', default='', help='可选开场碎碎念 WAV（同音色 TTS）')
    ap.add_argument('--outro', default='', help='可选收尾碎碎念 WAV（同音色 TTS）')
    ap.add_argument('--breath-dir', default='', help='可选真声换气样本目录')
    ap.add_argument('--min-dur', type=float, default=27.0, help='find_window 最短时长(秒)')
    ap.add_argument('--target-dur', type=float, default=41.0, help='find_window 目标时长(秒)')
    ap.add_argument('--max-dur', type=float, default=44.5, help='find_window 最长时长(秒)')
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--out-sr', type=int, default=24000)
    ap.add_argument('--stage', choices=['full', 'pre_rvc', 'post_rvc', 'measure_f0', 'find_window'], default='full',
                    help='find_window=在纯净人声轨上精确锁句裁剪(JSON); measure_f0=测算原唱基频(JSON); pre_rvc=居中主唱提取+Praat人性化; post_rvc=呼吸/空间/口白混音')
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    preset = LEVEL_PRESETS[args.level]
    sr = 44100

    if args.stage == 'find_window':
        mid_raw, side_raw, _ = load_stereo_mid_side(args.vocal, sr)
        clean_lead, _ = extract_clean_lead_vocal(args.vocal, sr, gate_bleed=False)
        win = find_phrase_locked_window(
            clean_lead, sr, min_dur=args.min_dur, target_dur=args.target_dur, max_dur=args.max_dur,
            mid_raw=mid_raw, side_raw=side_raw
        )
        print(json.dumps(win, ensure_ascii=False))
        return

    if args.stage == 'measure_f0':
        vocal, _ = extract_clean_lead_vocal(args.vocal, sr, gate_bleed=False)
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
        ap.error('--out is required unless --stage measure_f0 or find_window')

    if args.stage == 'pre_rvc':
        # 立体声 Mid/Side 剥离宽混响与和声 + 100Hz 去嗡鸣 + 句间漏音柔和衰减 -> 再做纯净 Praat 人性化
        vocal, _ = extract_clean_lead_vocal(args.vocal, sr, gate_bleed=True)
        phrases, _, _ = detect_phrases(vocal, sr)
        hum_vocal, _ = humanize_pitch_and_timing(vocal, sr, phrases, preset, args.mode, rng)
        # 头尾 50ms 极柔淡入淡出，消除切片喀哒声
        edge_n = min(int(0.05 * sr), len(hum_vocal) // 8)
        if edge_n > 10:
            hum_vocal[:edge_n] *= np.linspace(0.0, 1.0, edge_n)
            hum_vocal[-edge_n:] *= np.linspace(1.0, 0.0, edge_n)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        sf.write(args.out, hum_vocal, sr, subtype='PCM_16')
        print(f'[vocal-humanizer:pre_rvc] OK mode={args.mode} level={args.level} phrases={len(phrases)} dur={len(hum_vocal)/sr:.1f}s -> {args.out}')
        return

    vocal, _ = load_mono(args.vocal, sr)
    phrases, _, _ = detect_phrases(vocal, sr)

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

    # 3. 手机近麦 + 无嗡鸣近场房间声学空间
    room_style = 'ktv' if args.mode == 'ktv' else 'bedroom'
    vox_proc = apply_phone_mic_and_room(hum_vocal, sr, room_style=room_style)
    vox_rms = calc_rms(vox_proc[np.abs(vox_proc) > 0.01]) if np.any(np.abs(vox_proc) > 0.01) else calc_rms(vox_proc)

    # 4. 伴奏混合（仅 bedroom_bgm / ktv）：P75 响度精准定级 + 人声避让凹槽 + -2.5dB 侧链避让 + 柔和淡入淡出
    body = vox_proc.copy()
    if args.mode in ('bedroom_bgm', 'ktv') and args.inst and os.path.exists(args.inst):
        inst_raw, _ = load_mono(args.inst, sr)
        if len(inst_raw) > len(body):
            inst_raw = inst_raw[:len(body)]
        elif len(inst_raw) < len(body):
            inst_raw = np.pad(inst_raw, (0, len(body) - len(inst_raw)))
        inst_proc = apply_room_speaker_bgm(inst_raw, sr, mode=args.mode)
        inst_ref_rms = calc_active_percentile_rms(inst_proc, sr, pct=75, win_ms=200)
        rel_db = args.bgm_db if args.bgm_db is not None else (-12.8 if args.mode == 'bedroom_bgm' else -9.2)
        inst_gain = (vox_rms * (10.0 ** (rel_db / 20.0))) / (inst_ref_rms + 1e-9)
        inst_scaled = apply_vocal_sidechain_ducking(inst_proc * inst_gain, vox_proc, sr, duck_db=-2.5)
        # 伴奏头 0.55s 柔和淡入、尾 0.90s 自然淡出，衔接丝滑不生硬
        fade_in = min(int(0.55 * sr), len(inst_scaled) // 4)
        fade_out = min(int(0.90 * sr), len(inst_scaled) // 4)
        if fade_in > 10:
            inst_scaled[:fade_in] *= np.linspace(0.0, 1.0, fade_in)
        if fade_out > 10:
            inst_scaled[-fade_out:] *= np.linspace(1.0, 0.0, fade_out)
        body = body + inst_scaled

    # 5. 同声纹开场白与收尾碎碎念无缝自然衔接（留足真人呼吸气口，告别生硬秒切）
    segments = []
    if args.intro and os.path.exists(args.intro):
        intro_raw, _ = load_mono(args.intro, sr)
        intro_proc = apply_phone_mic_and_room(intro_raw, sr, room_style=room_style)
        intro_rms = calc_rms(intro_proc[np.abs(intro_proc) > 0.01]) if np.any(np.abs(intro_proc) > 0.01) else calc_rms(intro_proc)
        intro_proc = intro_proc * ((vox_rms * 0.88) / (intro_rms + 1e-9))
        segments.append(intro_proc)
        gap_intro = 0.48 if args.mode == 'acappella' else 0.36
        segments.append(np.zeros(int(gap_intro * sr), dtype=np.float64))

    segments.append(body)

    if args.outro and os.path.exists(args.outro):
        outro_raw, _ = load_mono(args.outro, sr)
        outro_proc = apply_phone_mic_and_room(outro_raw, sr, room_style=room_style)
        outro_rms = calc_rms(outro_proc[np.abs(outro_proc) > 0.01]) if np.any(np.abs(outro_proc) > 0.01) else calc_rms(outro_proc)
        outro_proc = outro_proc * ((vox_rms * 0.86) / (outro_rms + 1e-9))
        gap_outro = 0.45 if args.mode == 'acappella' else 0.38
        segments.append(np.zeros(int(gap_outro * sr), dtype=np.float64))
        segments.append(outro_proc)

    final = np.concatenate(segments)

    # 极微弱真实房间底噪（-60dBFS 粉红噪，避免停顿处死寂像电子剪辑）
    room_noise = rng.standard_normal(len(final))
    b_rn, a_rn = signal.butter(1, 1200 / (sr * 0.5), btype='low')
    room_noise = signal.lfilter(b_rn, a_rn, room_noise)
    room_noise = room_noise / (calc_rms(room_noise) + 1e-9) * (vox_rms * 0.0020)
    final = soft_limit(final + room_noise, target_rms=0.140)

    # 重采样到目标采样率写出 16-bit PCM WAV
    if args.out_sr != sr:
        g = math.gcd(sr, args.out_sr)
        final = signal.resample_poly(final, args.out_sr // g, sr // g)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sf.write(args.out, final, args.out_sr, subtype='PCM_16')
    print(f'[vocal-humanizer] OK mode={args.mode} level={args.level} phrases={len(phrases)} dur={len(final)/args.out_sr:.1f}s -> {args.out}')


if __name__ == '__main__':
    main()
