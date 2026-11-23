# Humanized Singing Engine — 「活人感」点歌翻唱与原创哼唱引擎

> **文档定位**：打破传统 RVC 翻唱“±0 音分修音太稳、换气被抹净、录音棚干冷感、与平时说话声线割裂”的 AI 感，提供一套同时支持 **点歌翻唱任意已有歌曲 (`qq_cover`)** 与 **原创写词谱曲哼唱 (`qq_sing`)** 的生产级活人感唱歌引擎，支持 **清唱 (`acappella`) / 房间外放跟唱 (`bedroom_bgm`) / KTV 包厢 (`ktv`)** 三种生活声学场景。  
> **核心模板**：[`templates/vocal-humanizer.py`](./templates/vocal-humanizer.py)（Praat TD-PSOLA 微瑕疵 + 呼吸/生活声学引擎）、[`templates/humanized-sing-engine.mjs`](./templates/humanized-sing-engine.mjs)（端到端检索/打点/分轨/定调/RVC/封装与自动清理引擎）。

---

## 1. 为什么传统 RVC 唱歌听起来“像 AI”？

单纯把原唱丢进 Demucs + RVC 只替换了**音色（共振峰）**，却 1:1 保留了录音棚母带的“非人完美度”：
1. **修音太死**：Melodyne / Auto-Tune 把每个音符锁死在 `±0` 音分，普通人唱歌的起音懒滑、尾音气短、慢速音准游走和偶发小跑调全被抹平；
2. **漏音与伪影**：低精度分离把架子鼓踩镲高频漏进干声，RVC 会把踩镲误转换成每句前的刺耳“大喘气”；若在 RVC 之后再拉音高，极易放大声码器颤抖与金属味；
3. **音域割裂**：直接翻唱男声或低音女声不测基频，唱出来的嗓音和宠物平时说话的 TTS 音色判若两人；
4. **声学割裂**：干冷录音棚人声配母带级伴奏，听起来像转发了一首 MP3，不像真人对着手机给你唱了一段发 QQ 语音。

---

## 2. 端到端流水线架构

```mermaid
flowchart TD
  A["用户点歌 (qq_cover)<br/>song + artist + mode"] --> B["B 站原唱精准检索<br/>(剔除音箱录屏/AMV/电影台词MV/大合唱)"]
  B --> C["阶段 A：Paraformer 宽裕粗切 62s<br/>(首句前倒退 3.2s，绝不吞轻声开头字)"]
  A2["用户让原创哼唱 (qq_sing)<br/>lyrics + tags + mode"] --> C2["Replicate ACE-Step<br/>生成全新旋律与人声"]
  C --> D["Demucs htdemucs_ft 零漏音分轨<br/>立体声 vocals.wav + other.wav"]
  C2 --> D
  D --> D2["阶段 B：纯净人声轨 10ms 精准锁句 (find_window)<br/>跳过残句与电影对白 · HNR+F0跳变+立体声宽度避开多人喊麦<br/>终点严守 < 下句起点-0.16s，绝不漏唱下句两字"]
  D2 --> E["Praat F0 基频测算<br/>172~440Hz 原调 0 / 低沉男声(<172Hz 且 p90×2≤620Hz)=+12<br/>(伴奏全程零变调无损)"]
  E --> F["[Pre-RVC] vocal-humanizer.py<br/>Mid/Side 居中主唱提纯 + 100Hz去嗡鸣 + 句间漏音门限 + 5 层微瑕"]
  F --> G["Replicate RVC v2 (rmvpe, protect=0.45, index=0.28)<br/>宠物专属声模换声 + 24h 过期自动 curl 续传"]
  G --> H["[Post-RVC] vocal-humanizer.py<br/>防叠加柔换气 + 交替极性无嗡鸣空间 + 伴奏挖槽/侧链避让 + 自然气口衔接"]
  T["同声纹 TTS 并行生成<br/>开场白 + 收尾碎碎念"] --> H
  H --> I["24kHz 单声道 WAV (≤58.8s 单条 QQ 语音)<br/>入 LRU 秒唱曲库 + finally 自动销毁临时目录"]
```

---

## 3. 核心声学设计与实测踩坑总结

### 3.1 两阶段「按完整乐句锁边」裁剪（根治半句开唱 & 漏下句两字）
- **为什么不能直接拿混音版 Paraformer 时间戳一刀切？**
  - 混音状态下轻声民谣（如《胡广生》）前 1~2 字极易被 ASR 漏识导致开唱缺字；结尾若盲目在上一句尾加固定缓冲秒数，会咬进下一句开头 1~2 字再突然断掉。
- **两阶段精准锁句方案**：
  1. **阶段 A（Demucs 前宽裕粗切）**：Paraformer 粗定位首句后**向前多留 3.2 秒**，切出 62 秒宽裕片段送进 `htdemucs_ft`；
  2. **阶段 B（Demucs 后纯净人声轨 10ms 锁句 `--stage find_window`）**：直接在零伴奏的 `vocals.wav` 上检测真实乐句边界：
     - 自动跳过粗切边缘 `<0.18s` 残句，以及后面紧跟 `≥4.5s` 超长空档的 MV 电影对白开场；
     - 快歌超长连唱段（`>8.5s`）自动按局部能量谷底细分句界；
     - 终点严格约束在 `next_phrase_start - 0.16s` 之前，**数学上彻底杜绝漏唱下一句半个字**；
     - 同步评估每句的 **Praat 谐波清晰度 (HNR)**、**基频剧烈跳变率** 以及 **立体声 Side/Mid 宽度比**（独唱居中宽度低，多人大合唱/喊麦宽度暴涨），自动避开不适合单人 RVC 的多人重合唱与喊麦尾段！

### 3.2 立体声 Mid/Side 主唱提纯 + Pre-RVC 真人微瑕
- **Mid/Side 维纳居中主唱提纯**：商业立体声混音中主唱严格居中（`M = (L+R)/2`），而大混响、宽声场和声/双人重唱及乐器漏音多分布在侧信号（`S = (L-R)/2`）。在 Pre-RVC 前先通过 STFT 软维纳掩码 `|M|² / (|M|² + 1.85|S|²)` 提纯干声，并配合 `100 Hz` 4 阶高通与 `-16 dB` 句间柔和门限，大幅消除多人合唱干扰与句间嗡鸣底噪。
- **Pre-RVC 注入 5 层普通人微瑕**：先对纯净干声执行 Praat TD-PSOLA 修改 `PitchTier` / `DurationTier`（只改元音周期、零损伤清辅音），再喂给 RVC（`protect=0.45` 保咬字、`index_rate=0.28` 去金属嗡声、`rms_mix_rate=0.32`）：
  1. 慢速 `1/f` 有机音准游走（±18~26 音分，0.5s 平滑窗口）；
  2. 起音懒滑入（句首 0.22s 略低滑入）；
  3. 长音尾音气短下坠（句尾 0.28s 微微掉气）；
  4. 高音区轻微吃力（Top 18% 高音微扁 20~30 音分）；
  5. 1~2 处可控可爱小跑调 + 伴奏时长严格守恒的句内微松弛（1ms 不脱拍）。

### 3.3 精确八度定调（常规 172~440Hz 原调 0 / 低沉男声 <172Hz 升 +12，伴奏零失真）
- `vocal-humanizer.py --stage measure_f0` 用 `soundfile` + `parselmouth` 测量原唱干声基频中位数与 `p90` 高音区（规避 DashScope 流式 WAV 占位头导致 Praat 报 OOM 的坑）。
- 原唱在 `172~440 Hz`（女声及高音男声）区间时直接 `pitch_change=0` 原调直出，防止高潮飙高音变尖锐花栗鼠；仅对真正低沉男声（`median < 172 Hz` 且 `p90 * 2 <= 620 Hz`）自动升一个精确八度（`+12`），既把人声抬进明亮少女音域，又让伴奏 `other.wav` **完全不需要做变调处理**。
- **防长任务 HTTP 300s 断连**：`qq-tts` 的 `/cover` 与 `/song` 采用 `streamLongJson`——立即响应 `200` 头 + 每 15 秒发送 1 字节合法 JSON 空白心跳（`res.write(' ')`），彻底免疫 Node.js `undici` 默认 300s `headersTimeout`（`fetch failed`），实测 Replicate 冷启动排队超 7 分钟仍稳定交付。

### 3.4 零嗡鸣生活化声学 + 人声侧链避让 + 自然口白气口衔接
- **彻底消灭低中频“嗡嗡声”**：
  - 人声总线：`110 Hz` 高通 + `280 Hz` (`-2.5 dB`) 去浑浊凹槽 + `2.8 kHz` (`+1.8 dB`) 清晰临场；房间早反射先过 **`380 Hz` 高通**并采用**正负极性交替质数延迟抽头**，彻底消灭同相梳状滤波产生的盒子嗡鸣。
  - 伴奏总线：`bedroom_bgm` 切掉 `220 Hz` 以下轰鸣，精准在 `350 Hz (-3.5 dB)` 与 `2.4 kHz (-3.0 dB)` 挖出人声频段凹槽；用**分帧 `P75` 响度**对齐电平（防止安静前奏拉爆副歌音量），默认 `bedroom_bgm = -12.8 dB` / `ktv = -9.2 dB`，并叠加 **`-2.5 dB` 柔和人声侧链避让**（唱歌时伴奏轻柔退让、句间停顿自然回升）。
- **防叠加柔换气**：最多 5 次/曲、仅在 `≥0.36s` 真实停顿且原声无自带呼吸处混入 `-25.8 dB` 暖气声。
- **自然气口衔接**：开场白后留 `0.36~0.48s` 呼吸气口 + 伴奏 `0.55s` 柔和淡入，完整唱完最后一句后伴奏 `0.90s` 自然淡出 + `0.38~0.45s` 气口再接收尾吐槽，与《红色高跟鞋》同等丝滑；总长超 `58.8s` 自动省略收尾口白，保证单条 60s QQ 语音完整不截断。

### 3.5 工程稳定性、选源避坑与零磁盘膨胀
- **B 站原唱精准避坑**：自动屏蔽“录音棚大声听/百万豪装/音响试听”（外放录屏大混响）、AMV 混剪、多人大合唱与翻唱，并在同等条件下优先纯无损音频源而非夹带电影台词的影视 MV。
- **全链路无损 FLAC 分轨传输 + `curl` 上传 + 同曲并发合并**：
  - 送入 Demucs 的粗切音频与分轨输出均采用 **100% 无损 FLAC**（`acappella` 模式跳过 `other` 伴奏下载），传输体积相比原始 WAV 缩减 **3~6 倍**且逐比特保留立体声相位（零损 Mid/Side 主唱提取），同时 `uploadToReplicate` 改用 `curl` 带重试流式上传，消除低带宽云主机多 MB 断链；
  - `INFLIGHT_COVERS` 对相同 `(歌名, 模式)` 的并发点歌做 Promise 合并，彻底杜绝重复拉源、重复分轨与 Replicate 冷启动排队互掐。
- **会话态唱歌任务感知**：`qq-bridge` 实时追踪每条会话的 `singTask` 状态（`running` / `done` / `failed`）并注入唤醒提示，杜绝失败后 AI 误以为仍在后台录歌而光嘴上敷衍“正在弄”却不调工具。
- **声模 24h 过期自动续期 + 磁盘零膨胀**：`ensureRvcModelUrl()` 自动 `HEAD` 校验 + 单飞锁 `curl` 续传；任务结束 `finally` 即清工作目录，[`templates/disk-hygiene.mjs`](./templates/disk-hygiene.mjs) 夜间兜底清理残留。

---

## 4. 部署与接入要点

### 4.1 Python 轻量环境（纯 CPU，~2 秒处理 45 秒歌声）
```bash
python3.11 -m venv /opt/qq-cover/venv
/opt/qq-cover/venv/bin/pip install --no-cache-dir numpy scipy praat-parselmouth soundfile
```

### 4.2 HTTP 接口（`qq-tts` 本地服务 `:3210`）
| 端点 | 参数 | 说明 |
| --- | --- | --- |
| `POST /cover` | `{ song, artist?, mode?, level?, file?, url?, start?, seconds?, intro?, outro? }` | 点歌翻唱已有歌曲（或翻唱外部音频），返回 `24kHz` 单声道 WAV |
| `POST /song` | `{ lyrics, tags?, duration?, mode?, level?, intro?, outro? }` | 原创写词谱曲并经同一套活人引擎渲染 |

### 4.3 QQ 聊天 Agent 工具（`mcp-snowluma-safe.js`）
- `qq_cover`：支持按 `song` / `artist` 点歌翻唱任意曲目，或翻唱用户发来的音频；可选 `mode`（`acappella` / `bedroom_bgm` / `ktv`）与 `level`（`subtle` / `natural` / `casual` / `offkey`）。
- `qq_sing`：支持即兴写词原创哼唱，同样可选 `mode` / `level` / `intro` / `outro`。
- 两个工具均为**后台异步执行 + 立即返回回执**，渲染完毕后由 `qq-bridge` 直接发出真实 QQ 语音，并自动写入每日活动与晚安日记流水。

### 4.4 实时语音通话内异步点歌 + 曲库秒唱缓存 + 唱歌状态机防幻觉（零阻塞）
- **LRU 曲库秒唱缓存 + 开场曲库注入**：[`templates/humanized-sing-engine.mjs`](./templates/humanized-sing-engine.mjs) 自动将每首已唱过的歌曲缓存至 `/opt/qq-bridge/audio/song-cache/`（LRU 上限默认 60 首 ≈ 150 MB，可通过 `SING_CACHE_MAX` 调整，QQ 聊天与实时语音通话共享）；通话建连时 [`templates/call-engine.mjs`](./templates/call-engine.mjs) 自动扫描曲库并注入首轮上下文，让小鲸鲸明确区分“曲库里 0 秒秒唱的熟歌”与“需要现找伴奏等 2~3 分钟的新歌”。
- **通话唱歌状态机与防“唱完啦”幻觉三道护栏**：
  1. **逐轮注入 `[唱歌实时状态]`**：新歌后台渲染期间（`preparing`），每轮对话都会注入已准备秒数与“一秒都还没开唱、严禁说唱完啦或重复发 `[SING]`”的强提醒；仅在音频真正通过 1x 节拍器播完最后一个字节后才切换 `done` 并写入“已完整唱完”。
  2. **TTS 前口播硬护栏 + 重复点歌去重**：若模型对未缓存新歌漏说等待提示，系统在送入 TTS 前自动补上自然告知；若模型在 `preparing` 期间仍误吐“唱完啦/咋样”，会被硬拦截并改口如实说明正在准备伴奏；同一首歌准备中再次收到 `[SING]` 自动去重，绝不重复并发打爆后端。
  3. **准备期静默防挂断 + 失败诚实播报 + 挂断兜底单发**：新歌准备期间暂停沉默自动挂断，静默满 45 秒主动安抚一句；音频就绪后等对话安静空档直接注入 1x 节拍器唱进听筒（全程支持随时开口 **0ms 打断**）；若未唱完前已挂断，仅对最新一次有效点歌（校验 `seq === _singSeq`）转成一条 QQ 语音私聊补发，绝不重复刷屏。

### 4.5 本地 CLI 快速单测
```bash
# 点歌翻唱（清唱 / 房间外放）
node /opt/qq-cover/humanized-sing-engine.mjs cover --song 红色高跟鞋 --artist 蔡健雅 --mode acappella
node /opt/qq-cover/humanized-sing-engine.mjs cover --song 晴天 --artist 周杰伦 --mode bedroom_bgm

# 原创哼唱
node /opt/qq-cover/humanized-sing-engine.mjs original --lyrics "[verse]\n晚风吹过窗台\n[chorus]\n今天也很开心" --mode bedroom_bgm
```
