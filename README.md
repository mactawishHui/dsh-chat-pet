# DSH Chat Pet — DeepSeek Harness + QQ 聊天宠物工程手册与增强模块

将基于 **DeepSeek Harness (`dsh`) + `qq-bridge` (reserved2 二代仿真) + SnowLuma (OneBot v11)** 的 QQ 聊天机器人，从默认状态调优为**响应快（6–11s）、表达自然无客服腔、长短有弹性、能自动刷热点/学梗/发对应梗图、且在 4G 轻量服务器上稳定运行**的完整工程化方案。

> **适合零背景 Agent 直接复现**：
> - 完整 QQ 聊天宠物调优 SOP：[chat-pet-tuning-playbook.md](./chat-pet-tuning-playbook.md)（Step 0 到 Step 6）
> - **独立可解耦「玩梗与接梗」模块指南**：[meme-engine-module.md](./meme-engine-module.md)（平台无关，可直接接入任意 QQ / Discord / Telegram / 微信 / 游戏 NPC / MCP 服务）

---

## 核心能力与调优成果

| 模块 | 解决的问题 | 关键方案 |
| --- | --- | --- |
| **小内存零成本优化** | 4G 服务器无 Swap、LinuxQQ 孤儿 `--relaunch` 进程泄漏导致 OOM | 2G `zram` (`zstd`) 压缩内存 + `NODE_OPTIONS=--max-old-space-size=384` + 精准清理孤儿 QQ 进程树（保留主进程零中断） |
| **响应提速（40s → 6–11s）** | 首答硬等 10s、历史会话 `batchWindowMs=8000`、高推理档叠加延迟 | `minQuietAfterNewMs=2500`、`batchWindowMs=2000`、`deepseek-flash`（保留原生全模态看图）+ `reasoningEffort: low` |
| **彻底去人机味 & 弹性长度** | 「好的我记下了」「虽然…但是…」「最戳我的是…」、每轮卡死 1–2 行 | 拆掉 `coding agent` 开头与消息流 `管理员` 标签、保留长期记忆前提下切断陈年 AI 腔回音壁、放宽预设字数/连发门槛 |
| **可选「脑嘴分离」层** | 换其他高助手腔模型时独立做熟人口语转译 | [`templates/mouth.mjs`](./templates/mouth.mjs) + [`templates/mouth-examples.json`](./templates/mouth-examples.json)（支持 DashScope / OpenAI 兼容 / Gemini 4 Hydrogen，默认可开关、超时自动回退） |
| **独立「玩梗与接梗」模块** | AI 只会当百科科普、听不懂空耳黑话、认不出无字人脸梗图、定时抓老梗/小众梗 | **[`meme-engine-module.md`](./meme-engine-module.md)** + [`templates/surf-kb.mjs`](./templates/surf-kb.mjs) + [`templates/reverse-image.mjs`](./templates/reverse-image.mjs)：4 层查梗（含 B 站+Serper 并发交叉佐证）+ Google Lens 以图搜图 + `replies`/`playTip` 接梗不科普 + **3 档破圈热度×生命力定时扩库** + MemeCub 自动配图（0 常驻内存、平台解耦） |
| **私有资产库自动云端备份** | 梗库、梗图、记忆、绘画长期积累不占本机空间、防服务器丢失 | [`templates/sync-vault.mjs`](./templates/sync-vault.mjs)：服务器经单仓库 Deploy Key 自动增量推送到私有 GitHub Vault，并自动生成 `MEMES.md` / `DRAWINGS.md` 图文相册 |

---

## 目录结构

```text
.
├── README.md
├── chat-pet-tuning-playbook.md   # QQ 聊天宠物完整零背景复现 SOP（含验收标准与踩坑速查）
├── meme-engine-module.md         # 独立可解耦「玩梗与接梗」模块架构与新环境接入指南（平台无关）
└── templates/
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
