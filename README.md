# DSH Chat Pet — DeepSeek Harness + QQ 聊天宠物工程手册与增强模块

将基于 **DeepSeek Harness (`dsh`) + `qq-bridge` (reserved2 二代仿真) + SnowLuma (OneBot v11)** 的 QQ 聊天机器人，从默认状态调优为**响应快（6–11s）、表达自然无客服腔、长短有弹性、能自动刷热点/学梗/发对应梗图、且在 4G 轻量服务器上稳定运行**的完整工程化方案。

> **适合零背景 Agent 直接复现**：
> - 完整 QQ 聊天宠物调优 SOP：[chat-pet-tuning-playbook.md](./chat-pet-tuning-playbook.md)（Step 0 到 Step 6）
> - **独立可解耦「玩梗与接梗」模块指南**：[meme-engine-module.md](./meme-engine-module.md)（平台无关，可直接接入任意聊天平台 / 游戏 NPC / MCP 服务）
> - **独立可解耦「实时语音通话」模块指南**：[realtime-call-module.md](./realtime-call-module.md)（原生全双工通话、原声流式合成、瞬时打断零重叠、双向记忆打通，内核平台无关）
> - **「自己的生活」与全景日记模块指南**：[life-diary-module.md](./life-diary-module.md)（每日闲逛输入 + 6 路全景记忆聚合 + 成长里程碑探测 + 重吐槽碎碎念风格锚点 + 发布前去 AI 味与隐私审查）

---

## 核心能力与调优成果

| 模块 | 解决的问题 | 关键方案 |
| --- | --- | --- |
| **小内存零成本优化** | 4G 服务器无 Swap、LinuxQQ 孤儿 `--relaunch` 进程泄漏导致 OOM | 2G `zram` (`zstd`) 压缩内存 + `NODE_OPTIONS=--max-old-space-size=384` + 精准清理孤儿 QQ 进程树（保留主进程零中断） |
| **响应提速（40s → 6–11s）** | 首答硬等 10s、历史会话 `batchWindowMs=8000`、高推理档叠加延迟 | `minQuietAfterNewMs=2500`、`batchWindowMs=2000`、`deepseek-flash`（保留原生全模态看图）+ `reasoningEffort: low` |
| **彻底去人机味 & 弹性长度** | 「好的我记下了」「虽然…但是…」「最戳我的是…」、每轮卡死 1–2 行 | 拆掉 `coding agent` 开头与消息流 `管理员` 标签、保留长期记忆前提下切断陈年 AI 腔回音壁、放宽预设字数/连发门槛 |
| **可选「脑嘴分离」层** | 换其他高助手腔模型时独立做熟人口语转译 | [`templates/mouth.mjs`](./templates/mouth.mjs) + [`templates/mouth-examples.json`](./templates/mouth-examples.json)（支持 DashScope / OpenAI 兼容 / Gemini 4 Hydrogen，默认可开关、超时自动回退） |
| **独立「玩梗与接梗」模块** | AI 只会当百科科普、听不懂空耳黑话、认不出无字人脸梗图、定时抓老梗/小众梗 | **[`meme-engine-module.md`](./meme-engine-module.md)** + [`templates/surf-kb.mjs`](./templates/surf-kb.mjs) + [`templates/reverse-image.mjs`](./templates/reverse-image.mjs)：4 层查梗（含 B 站+Serper 并发交叉佐证）+ Google Lens 以图搜图 + `replies`/`playTip` 接梗不科普 + **3 档破圈热度×生命力定时扩库** + MemeCub 自动配图（0 常驻内存、平台解耦） |
| **独立「实时语音通话」模块** | 机器人只能发离线语音条、端到端模型丢原声、打断重音、通话与聊天记忆割裂 | **[`realtime-call-module.md`](./realtime-call-module.md)** + [`templates/call-engine.mjs`](./templates/call-engine.mjs) + [`templates/qq-call-adapter.mjs`](./templates/qq-call-adapter.mjs)：PulseAudio 双声卡物理零回声原生 QQ 接通 + 双层好友白名单 + 零工具轻量大脑 + 原声整句 SSE 拟人合成 + **80ms 预充 1x 节拍器**瞬时打断零重叠 + 聊天/通话双向记忆互通（仅 ~67 MB 内存） |
| **独立「自己的生活」与全景日记** | 说说只有一句话、冷冰冰流水账、散文腔/鸡汤味、反复用同一意象、忽略聊天/通话/新解锁本事 | **[`life-diary-module.md`](./life-diary-module.md)** + [`templates/qq-life.mjs`](./templates/qq-life.mjs) + [`templates/diary-examples.json`](./templates/diary-examples.json) + [`templates/life-journal.mjs`](./templates/life-journal.mjs)：每日 2 次独立闲逛刷 B 站/热搜 + 6 路全景记忆聚合（探索/新本事里程碑/实时通话/新梗/脱敏聊天分幕摘录/过往说说时间线）+ 重吐槽碎碎念风格锚点库 + 仅好友可见每天最多 1 条 + 隐私与去 AI 味强制审查（0 常驻内存） |
| **私有资产库自动云端备份** | 梗库、梗图、记忆、日记、绘画长期积累不占本机空间、防服务器丢失 | [`templates/sync-vault.mjs`](./templates/sync-vault.mjs)：服务器经单仓库 Deploy Key 自动增量推送到私有 GitHub Vault，并自动生成 `MEMES.md` / `DRAWINGS.md` / `DIARY.md` 与 `memory/milestones.json` |

---

## 目录结构

```text
.
├── README.md
├── chat-pet-tuning-playbook.md   # QQ 聊天宠物完整零背景复现 SOP（含验收标准与踩坑速查）
├── meme-engine-module.md         # 独立可解耦「玩梗与接梗」模块架构与新环境接入指南（平台无关）
├── realtime-call-module.md       # 独立可解耦「实时语音通话」模块架构与新环境接入指南（平台无关）
├── life-diary-module.md          # 「自己的生活」：闲逛输入 + 6 路全景记忆 + 重吐槽碎碎念夜间日记
└── templates/
    ├── qq-life.mjs               # 闲逛时间 + 6 路全景记忆聚合 + 成长里程碑 + 夜间日记审查发布
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
