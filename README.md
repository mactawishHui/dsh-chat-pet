# DSH Chat Pet — DeepSeek Harness + QQ 聊天宠物工程手册与增强模块

将基于 **DeepSeek Harness (`dsh`) + `qq-bridge` (reserved2 二代仿真) + SnowLuma (OneBot v11)** 的 QQ 聊天机器人，从默认状态调优为**响应快（6–11s）、表达自然无客服腔、长短有弹性、能自动刷热点/学梗/发对应梗图、且在 4G 轻量服务器上稳定运行**的完整工程化方案。

> **适合零背景 Agent 直接复现**：
> - 完整 QQ 聊天宠物调优 SOP：[chat-pet-tuning-playbook.md](./chat-pet-tuning-playbook.md)（Step 0 到 Step 6）
> - **独立可解耦「玩梗与接梗」模块指南**：[meme-engine-module.md](./meme-engine-module.md)（平台无关，可直接接入任意聊天平台 / 游戏 NPC / MCP 服务）
> - **独立可解耦「实时语音通话」模块指南**：[realtime-call-module.md](./realtime-call-module.md)（原生全双工通话、原声流式合成、瞬时打断零重叠、异步旁路工具、双向记忆打通，内核平台无关）
> - **独立可解耦「实时看屏陪聊」模块指南**：[screen-vision-module.md](./screen-vision-module.md)（物理三通道分离：纯净人声麦 + 1080p 浏览器画面与独立屏幕音轨后台听译 + AI 发声，原生多模态 ~1.3s 陪看电影/打游戏）
> - **统一远程 HTTPS 管理台与看屏网关**：[pet-portal-module.md](./pet-portal-module.md)（免 SSH 手机/电脑直连，白名单搜好友昵称热更新 + 物理三通道整合 + 主人 QQ 私聊 `/白名单` 快捷口令）
> - **「活人感」点歌翻唱与原创哼唱引擎**：[singing-module.md](./singing-module.md)（B 站原唱精准检索 + Paraformer 歌词打点 + `htdemucs_ft` 零漏音分轨 + 精确八度定调 + Pre-RVC Praat TD-PSOLA 5 层真人微瑕 + RVC 换声自动续期 + 防叠加换气/手机近麦/房间外放/KTV/同声纹口白）
> - **「自己的生活」与全景日记模块指南**：[life-diary-module.md](./life-diary-module.md)（每日闲逛输入 + 8 路全景记忆聚合 + 成长里程碑/回忆杀 + 重吐槽碎碎念风格锚点 + 动态手绘手账配图 + 睡眠海马体整理）

---

## 核心能力与调优成果

| 模块 | 解决的问题 | 关键方案 |
| --- | --- | --- |
| **小内存零成本优化** | 4G 服务器无 Swap、LinuxQQ 孤儿 `--relaunch` 进程泄漏导致 OOM | 2G `zram` (`zstd`) 压缩内存 + `NODE_OPTIONS=--max-old-space-size=384` + 精准清理孤儿 QQ 进程树（保留主进程零中断） |
| **响应提速（40s → 6–11s）** | 首答硬等 10s、历史会话 `batchWindowMs=8000`、高推理档叠加延迟 | `minQuietAfterNewMs=2500`、`batchWindowMs=2000`、`deepseek-flash`（保留原生全模态看图）+ `reasoningEffort: low` |
| **彻底去人机味 & 弹性长度** | 「好的我记下了」「虽然…但是…」「最戳我的是…」、每轮卡死 1–2 行 | 拆掉 `coding agent` 开头与消息流 `管理员` 标签、保留长期记忆前提下切断陈年 AI 腔回音壁、放宽预设字数/连发门槛 |
| **可选「脑嘴分离」层** | 换其他高助手腔模型时独立做熟人口语转译 | [`templates/mouth.mjs`](./templates/mouth.mjs) + [`templates/mouth-examples.json`](./templates/mouth-examples.json)（支持 DashScope / OpenAI 兼容 / Gemini 4 Hydrogen，默认可开关、超时自动回退） |
| **独立「玩梗与接梗」模块** | AI 只会当百科科普、听不懂空耳黑话、认不出无字人脸梗图、定时抓老梗/小众梗 | **[`meme-engine-module.md`](./meme-engine-module.md)** + [`templates/surf-kb.mjs`](./templates/surf-kb.mjs) + [`templates/reverse-image.mjs`](./templates/reverse-image.mjs)：4 层查梗（含 B 站+Serper 并发交叉佐证）+ Google Lens 以图搜图 + `replies`/`playTip` 接梗不科普 + **3 档破圈热度×生命力定时扩库** + MemeCub 自动配图（0 常驻内存、平台解耦） |
| **独立「实时语音通话」模块** | 机器人只能发离线语音条、端到端模型丢原声、打断重音、通话零工具无法查资料/记事 | **[`realtime-call-module.md`](./realtime-call-module.md)** + [`templates/call-engine.mjs`](./templates/call-engine.mjs) + [`templates/qq-call-adapter.mjs`](./templates/qq-call-adapter.mjs)：PulseAudio 双声卡物理零回声原生 QQ 接通 + 双层好友白名单（支持热更新 API）+ 零工具轻量大脑 + **异步旁路工具**（180ms 快慢通道查天气/查梗/联网搜/记备忘，不降主通话速）+ 原声整句 SSE 拟人合成 + **180ms 预充 1x 节拍器**瞬时打断零重叠 + 聊天/通话双向记忆互通（仅 ~67 MB 内存） |
| **独立「实时看屏陪聊」模块** | 语音聊电影/打游戏看不见画面、视频解说混进麦导致误打断与卡顿、绑死单一平台 | **[`screen-vision-module.md`](./screen-vision-module.md)** + [`templates/screen-vision-engine.mjs`](./templates/screen-vision-engine.mjs) + [`templates/screen-audio-listener.mjs`](./templates/screen-audio-listener.mjs) + [`templates/screen-web-endpoint.mjs`](./templates/screen-web-endpoint.mjs) + [`templates/qq-screen-adapter.mjs`](./templates/qq-screen-adapter.mjs)：**物理三通道分离**（通道 1 普通 QQ 语音纯人声、通道 2 浏览器独立推 1080p 画面 + 二进制屏幕音频后台静默听译 45 秒滚动台词槽、通道 3 AI 语音零卡顿输出），纯内存不落盘，支持独立脱离 QQ 运行与 QQ 原生共享备选 |
| **独立「自己的生活」与全景手账日记** | 说说只有一句话、冷冰冰流水账、记忆重复与过期乌龙、散文腔/鸡汤味、缺手绘插画与节气回忆 | **[`life-diary-module.md`](./life-diary-module.md)** + [`templates/qq-life.mjs`](./templates/qq-life.mjs) + [`templates/memory-consolidator.mjs`](./templates/memory-consolidator.mjs) + [`templates/weather-solar.mjs`](./templates/weather-solar.mjs) + [`templates/diary-examples.json`](./templates/diary-examples.json)：每日 2 次多渠道闲逛（B站/豆瓣/社区热议/播客/节气天气 + 限频宝藏安利）+ 8 路全景记忆与回忆杀纪念日引擎 + 重吐槽碎碎念风格锚点 + **动态手绘手账配图**（按氛围自动切涂鸦/水彩手账风 1–2 张）+ **夜间睡眠海马体记忆整理**（去重/日期锚定/过期归档，0 常驻内存） |
| **统一远程 HTTPS 管理台与看屏网关** | 外出没电脑无法给朋友加白名单、每次看屏需手动开 SSH 端口转发、暴露内网口不安全 | **[`pet-portal-module.md`](./pet-portal-module.md)** + [`templates/pet-portal.mjs`](./templates/pet-portal.mjs)：独立 TLS 1.3 HTTPS 网关（scrypt 密码哈希 + 防爆破锁定 + HttpOnly Cookie + 最小权限代理，内部 Token 绝不下发），手机一键搜 QQ 好友昵称热加私聊/群聊/语音白名单，电脑同页直开 1080p 物理三通道看屏，另附管理员 QQ 私聊 `/全白名单 加 QQ号` 快捷口令 |
| **「活人感」点歌翻唱与原创哼唱引擎** | 传统 RVC 翻唱修音太死、缺换气、踩镲漏音变喘气、与说话音域割裂、听感像转发 MP3 | **[`singing-module.md`](./singing-module.md)** + [`templates/vocal-humanizer.py`](./templates/vocal-humanizer.py) + [`templates/humanized-sing-engine.mjs`](./templates/humanized-sing-engine.mjs)：支持点歌翻唱任意已有歌曲 (`qq_cover`) 与原创写词哼唱 (`qq_sing`)；B 站原唱精准检索 + Paraformer 歌词黄金 45s 打点 + `htdemucs_ft` 零漏音分轨 + 女声原调/男声精确升八度 + **Pre-RVC Praat TD-PSOLA 5 层真人微瑕** + RVC 声模自动续期 + **Post-RVC 防叠加柔换气 / 手机近麦清唱 / 房间外放跟唱 / KTV / 同声纹口白无缝融合**，用完自动清空临时目录 |
| **私有资产库自动云端备份** | 梗库、梗图、记忆、日记、绘画长期积累不占本机空间、防服务器丢失 | [`templates/sync-vault.mjs`](./templates/sync-vault.mjs)：服务器经单仓库 Deploy Key 自动增量推送到私有 GitHub Vault，并自动生成 `MEMES.md` / `DRAWINGS.md` / `DIARY.md` 与 `memory/milestones.json` |

---

## 目录结构

```text
.
├── README.md
├── chat-pet-tuning-playbook.md   # QQ 聊天宠物完整零背景复现 SOP（含验收标准与踩坑速查）
├── meme-engine-module.md         # 独立可解耦「玩梗与接梗」模块架构与新环境接入指南（平台无关）
├── realtime-call-module.md       # 独立可解耦「实时语音通话」模块架构与新环境接入指南（平台无关）
├── screen-vision-module.md       # 独立可解耦「实时看屏陪聊」模块指南（平台无关内核 + 本地超清 Web 端 + QQ 屏幕共享）
├── pet-portal-module.md          # 统一远程 HTTPS 管理台与看屏网关（免 SSH 白名单热管理 + 物理三通道 + QQ 快捷口令）
├── singing-module.md             # 「活人感」点歌翻唱与原创哼唱引擎（Pre-RVC 微瑕 + 智能呼吸 + 生活声学 + 同声纹口白）
├── life-diary-module.md          # 「自己的生活」：闲逛输入 + 8 路全景记忆 + 手绘手账日记 + 睡眠记忆整理
└── templates/
    ├── vocal-humanizer.py        # Praat TD-PSOLA 真人微瑕 / F0 测算 / 防叠加柔换气 / 手机近麦·房间外放·KTV 声学引擎
    ├── humanized-sing-engine.mjs # 端到端活人唱歌引擎（B 站原唱检索 / Paraformer 打点 / htdemucs_ft / RVC 自动续期 / 零残留清理）
    ├── pet-portal.mjs            # 统一远程 HTTPS 安全网关（scrypt 鉴权 / 防爆破 / 白名单可视化 / 同源 WSS 三通道代理）
    ├── screen-vision-engine.mjs  # 平台无关实时看屏内核（帧差节流 / 纯内存环形池 / 45s 屏幕台词槽 / 三模式）
    ├── screen-audio-listener.mjs # 通道 2 独立屏幕音轨后台静默听译器（静音/BGM 自动休眠 / 整屏防回声 / 永不打断）
    ├── screen-web-endpoint.mjs   # Endpoint B：物理三通道 1080p 浏览器推屏+推音端 + WS/HTTP API + 独立陪看语音播报
    ├── disk-hygiene.mjs          # 零常驻磁盘代谢 GC（临时通话会话清理 / DSH 附件引用计数回收 / 旧 TTS 缓存清理）
    ├── qq-screen-adapter.mjs     # Endpoint A：QQ 原生屏幕共享容器 X11 捕获适配层
    ├── qq-life.mjs               # 多渠道闲逛 + 8 路全景记忆/回忆杀 + 动态手绘手账日记审查发布
    ├── memory-consolidator.mjs   # 睡眠海马体记忆整理（去重合并、日期锚定、过期代谢归档，热写回桥接）
    ├── weather-solar.mjs         # 二十四节气精确计算 + 免 Key 中文城市天气（双源回退 + 3h 缓存）
    ├── diary-examples.json       # 重吐槽 / 碎碎念 / 嘴硬心软活人感日记风格锚点库
    ├── life-journal.mjs          # 见闻流水账（JSONL，凌晨 5 点换日，保留 14 天）
    ├── qq-life-tools.mjs         # 闲逛会话工具边界（只读 B 站 / 安全搜索 + 共用日配额）
    ├── call-engine.mjs           # 平台无关全双工通话内核（VAD / 按需 ASR / SSE TTS / 1x 节拍器 / 打断 / 记忆摘要）
    ├── qq-call-adapter.mjs       # QQ 原生语音通话接入适配器与守护进程（PulseAudio / 双层白名单 / 音频桥接）
    ├── surf-kb.mjs               # 每日热点 + 4 层查梗链 + 3 档破圈热度×生命力选梗 + MemeCub 自动配图
    ├── reverse-image.mjs         # Serper Google Lens 以图搜图 + Google 搜索模块（支持 tbs 时间过滤）
    ├── mouth.mjs                 # 可选「脑嘴分离」口语转译层（支持 DashScope / Gemini / OpenAI 兼容）
    ├── mouth-examples.json       # 可热更新的真人聊天 Few-Shot 样例库
    ├── vision-bridge.mjs         # 纯文本模型（如 deepseek-v4-pro）自动视觉桥接层（原生看图模型自动直通）
    └── sync-vault.mjs            # 远程资产自动脱敏同步至私有 GitHub Vault + 生成图文画廊
```

---

## 安全说明

- 本工程仓库**不包含任何 API Key、SSH 私钥、OneBot Token、服务器 IP 或私人聊天数据**。
- 个人长期记忆、梗图、绘画与聊天记录请单独存放于 **Private 私有资源仓库**，并仅给远程服务器颁发**单仓库专用 SSH Deploy Key**。
