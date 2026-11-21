# DSH + QQ 聊天宠物（Chat Pet）标准调优与复现手册

> **用途**：将一套基于 **DeepSeek Harness (`dsh`) + `qq-bridge` (reserved2 二代仿真) + SnowLuma (OneBot v11)** 的 QQ 聊天机器人，从“响应慢（20–40s）、字数死板（1–2 行）、人机味重、小内存易 OOM”的默认状态，一次性调优到**秒回级（6–11s）、长短有弹性、自然松弛无客服腔、稳定低内存运行**的标准状态。
>
> **面向读者**：任何无前序上下文的 Agent 或运维工程师。按本文步骤从头执行，即可在新机器或新聊天宠物上完整复现同等效果。
>
> **脱敏说明**：本文档不包含任何真实 API Key、服务器密码或私人 QQ 号，所有敏感项均以 `<占位符>` 表示，可安全纳入版本管理。

---

## 1. 预期达成效果（实测基线对比）

| 维度 | 调优前 | 调优后（线上实测） |
| --- | --- | --- |
| **回复速度** | 单轮 18–42 秒（首答硬等 10s + 8s 唤醒聚合 + high 推理 + 8MB 臃肿上下文） | **6–11 秒/轮**（连发多条也能快速响应，斗图/发表情自然流畅） |
| **说话质感** | 客服腔/影评腔严重（「好的我记下了」「我帮你盯着」「最戳我的是…：…」「虽然…但是…」） | **松弛自然口语**、记得历史印象、适当回表情包、无明显 AI 腔 |
| **表达长度** | 几乎每轮卡死在 1–2 条、每条 1 行多，聊电影等话题展开不了 | **长短随话题弹性伸缩**：闲聊短促利落，聊电影/观点可自然展开 |
| **4G 轻量服务器内存** | 3.6 GiB 物理内存仅剩 ~230 MiB，无 Swap，随时面临 OOM | **~720+ MiB 物理可用 + 2 GiB ZRAM 压缩缓冲**（零磁盘占用、零升配费用） |

---

## 2. 适用技术栈与核心文件位置

假设远程 Linux 服务器（如 OpenCloudOS / CentOS / Ubuntu）采用如下标准部署布局：

| 组件 | 路径 / 服务名 | 说明 |
| --- | --- | --- |
| DSH Web 服务 | `/etc/systemd/system/dsh-web.service` | 监听 `127.0.0.1:3080` |
| DSH Profile 补丁 | `/root/.dsh/profiles/web/cordis.patch.yml` | 控制默认模型、推理档与 MCP 插件 |
| QQ 桥接服务 | `/etc/systemd/system/qq-bridge.service` | 监听 `127.0.0.1:3100`，主程序 `/opt/qq-bridge/src/bridge.js` |
| 桥接配置与状态 | `/opt/qq-bridge/config.json`<br>`/opt/qq-bridge/state/social-v2.json`<br>`/opt/qq-bridge/state/sessions.json` | 含模型选择、等待窗口、发送节奏、长期记忆与会话映射 |
| Agent 预设源码 | `/opt/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml` | 唯一权威源；改完必须用 `scripts/build-agent-preset-patches.mjs` 重建 patch |
| SnowLuma 容器 | Docker 容器 `snowluma` | 内含 LinuxQQ + OneBot HTTP(`3000`)/WS(`3001`) + WebUI(`5099`) + noVNC(`6081`) |
| 语音/代理辅助 | `qq-tts` (`3210`) / `qq-proxy` (`7890`) | 阿里云百炼 TTS/ASR/画图、sing-box 出境代理 |

> **关键原则**：修改 `state/*.json` 或 `config.json` 前**先停 `qq-bridge`**，防止运行中的桥接进程回写覆盖；修改 `agent.cordis.yml` 后**必须重新生成 patch 并重启 `dsh-web`**。

---

## 3. 核心原理（为什么这样改才真正有效）

1. **回复慢不是单一原因，而是 4 层延迟叠加**：
   - `socialV2.wait.minQuietAfterNewMs` 默认 `10000ms`（代码硬底线，连发消息还会反复重置 10 秒）；
   - 老会话在 `state/social-v2.json` 里持久化了旧的 `batchWindowMs: 8000`（即使 `config.json` 改成 `2000` 也不会自动覆盖旧会话状态）；
   - `reasoningEffort: high` 在二代仿真多步工具调用下放大了每步耗时；
   - 超长老会话（如 300+ 轮、8MB+ `.zstd`）每次请求会带来数秒固定上下文同步开销。
2. **字数总是 1–2 行不是模型偷懒，是提示词 + 桥接双重锁死**：
   - 预设里硬写了「普通对话默认 1 条，最多 2 条」「单条多数 ≤30 字」；
   - `bridge.js` 里还在发满 3 条时主动训斥模型（`你已经连发了多条，确认是必要的吗？`）。
3. **人机味去不掉的根因是「结构性助手污染 + 老历史回音壁」，而不是提示词禁令不够多**（本次实测验证：**仅靠第 4 步的结构去污染 + 干净会话 + `deepseek-v4-pro (low)` 就已经彻底消除明显人机味，甚至无需开启额外改写层**）：
   - System Prompt 第一行写着 `You are a coding agent powered by the {{model}} model.`；
   - `bridge.js` 给主人的每条消息贴上 `管理员（ownerQQ ...）` 标签，导致模型连 `memberImpressions` 都把用户记成 `"管理员"`，天然进入“向老板汇报/贴心客服”模式；
   - 数百轮旧历史里堆满模型以前说过的 AI 腔，大模型会强模仿上下文历史（In-Context Imitation Trap），不切断历史回音壁，再怎么改 System Prompt 都会被老历史拉回去。

---

## 4. 标准实施步骤（零背景 Agent 可直接按序执行）

### Step 0：操作前统一备份

```bash
TS=$(date +%Y%m%d_%H%M%S)
systemctl stop qq-bridge.service
cp -a /opt/qq-bridge/config.json "/opt/qq-bridge/config.json.bak.$TS"
cp -a /opt/qq-bridge/state/social-v2.json "/opt/qq-bridge/state/social-v2.json.bak.$TS"
cp -a /opt/qq-bridge/state/sessions.json "/opt/qq-bridge/state/sessions.json.bak.$TS"
cp -a /opt/qq-bridge/src/bridge.js "/opt/qq-bridge/src/bridge.js.bak.$TS"
cp -a /opt/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml "/opt/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml.bak.$TS"
cp -a /root/.dsh/profiles/web/cordis.patch.yml "/root/.dsh/profiles/web/cordis.patch.yml.bak.$TS"
cp -a /etc/systemd/system/dsh-web.service "/root/dsh-web.service.bak.$TS"
```

---

### Step 1：小内存服务器零成本瘦身（4G 机型强烈建议）

#### 1.1 开启持久化 2G ZRAM 压缩内存（零磁盘占用）
检查 `modinfo zram` 可用后配置：

```bash
modprobe zram
ALGO=$(grep -q zstd /sys/block/zram0/comp_algorithm 2>/dev/null && echo zstd || echo lz4)

cat > /etc/systemd/system/zram-swap.service <<EOF
[Unit]
Description=Configure zram swap device
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c "modprobe zram && zramctl /dev/zram0 --algorithm $ALGO --size 2G && mkswap /dev/zram0 && swapon -p 100 /dev/zram0"
ExecStop=/bin/sh -c "swapoff /dev/zram0 && zramctl --reset /dev/zram0"

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/sysctl.d/99-zram.conf <<EOF
vm.swappiness = 80
vm.page-cluster = 0
EOF

sysctl -p /etc/sysctl.d/99-zram.conf
systemctl daemon-reload
systemctl enable --now zram-swap.service
```

#### 1.2 限制 `dsh-web` V8 堆上限 & 摘除未启用的 MCP 插件
1. 在 `/etc/systemd/system/dsh-web.service` 的 `[Service]` 段增加：
   ```ini
   Environment=NODE_OPTIONS=--max-old-space-size=384
   ```
2. 检查 `/root/.dsh/profiles/web/cordis.patch.yml`，移除任何未启用/缺 Token 却常驻内存的 MCP（如 `mcp-suno`），每个可省 ~40–60 MiB。

#### 1.3 巡检并清理 SnowLuma 容器内泄漏的孤儿 `qq --relaunch` 进程
LinuxQQ 长时间运行触发热更新/重启后，可能残留脱离 `supervisord` 监管的 `qq --relaunch` 孤儿进程树（每组白占 ~150 MiB 真实内存，日志会出现 `checkHasMultipleQQ: true`）。

安全清理方法（**严格保护 `supervisorctl pid qq` 对应的主 QQ 进程树，不中断在线态**）：

```bash
SUP_PID=$(docker exec snowluma supervisorctl pid qq)
test -n "$SUP_PID" -a "$SUP_PID" -gt 1

docker exec -i snowluma python3 - "$SUP_PID" << "PY"
import os, sys, glob, signal, time
sup_pid = int(sys.argv[1])

def scan():
    procs = {}
    for p in glob.glob("/proc/[0-9]*"):
        pid = int(os.path.basename(p))
        try:
            s = open(f"{p}/stat").read()
            rp = s.rfind(")")
            comm = s[s.find("(")+1:rp]
            ppid = int(s[rp+2:].split()[1])
            cmd = open(f"{p}/cmdline", "rb").read().replace(b"\x00", b" ").decode("utf-8", "ignore").strip()
            procs[pid] = (ppid, comm, cmd)
        except Exception:
            pass
    return procs

def descendants(procs, root):
    res = {root}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, _, _) in procs.items():
            if ppid in res and pid not in res:
                res.add(pid); changed = True
    return res

procs = scan()
protected = descendants(procs, sup_pid)
orphans = [pid for pid, (_, _, cmd) in procs.items()
           if pid not in protected and "--relaunch" in cmd and "/opt/QQ/qq" in cmd]
targets = set()
for r in orphans:
    targets |= descendants(procs, r)
assert not (targets & protected)
for pid in sorted(targets):
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
time.sleep(3)
procs2 = scan()
for pid in [p for p in targets if p in procs2]:
    try: os.kill(pid, signal.SIGKILL)
    except ProcessLookupError: pass
print(f"Cleaned {len(targets)} orphan procs; protected root={sup_pid} ({len(protected)} procs)")
PY
```

---

### Step 2：模型选型与响应提速配置

#### 2.1 模型与推理档（兼顾「原生多模态看图」「低延迟」与「说人话质感」）
在以下两处统一配置为 **`deepseek-flash`（DeepSeek-V4.1-Flash）+ `reasoningEffort: low`**（实测在完成 Step 3–4 的去结构污染后，`deepseek-flash + low` 既具备自然松弛的聊天感、速度最快且最省额度，又**原生支持 `["text", "image"]` 全模态看图**，包括 QQ 聊天图、表情包、合并转发图以及 `bilibili_frames` 视频抽帧）：

1. `/root/.dsh/profiles/web/cordis.patch.yml`：
   ```yaml
   - id: agent-default-model
     name: '@deepseek-ai/dsh-agent-default-model'
     config:
       provider: deepseek-account
       model: deepseek-flash
       reasoningEffort: low
   ```
2. `/opt/qq-bridge/config.json` -> `dsh` 段：
   ```json
   "dsh": {
     "baseUrl": "http://127.0.0.1:3080",
     "provider": "deepseek-account",
     "model": "deepseek-flash",
     "reasoningEffort": "low"
   }
   ```
   *(若你想尝试纯文本旗舰模型 `deepseek-v4-pro`，请务必配合 `templates/vision-bridge.mjs` 用 `qwen3-omni-flash` 补齐 QQ 看图能力；切回原生看图模型时 `vision-bridge.mjs` 会自动静默直通原图。)*

#### 2.2 压缩等待与发送延迟（`/opt/qq-bridge/config.json`）
在 `socialV2` 中将等待和连发间隔调到真人打字节奏：

```json
"socialV2": {
  "wake": {
    "batchWindowMs": 2000
  },
  "wait": {
    "defaultMs": 30000,
    "minMs": 5000,
    "maxMs": 600000,
    "defaultQuietMs": 3000,
    "minQuietAfterNewMs": 2500
  },
  "send": {
    "burstEnabled": true,
    "burstMaxMessages": 8,
    "burstIntervalMinMs": 800,
    "burstIntervalMaxMs": 2000,
    "recommendedHint": "单条消息不要用空格断句，中文短句用逗号/顿号或直接连写；分条时每条都要读起来完整，不要把同一句话拆到两条里；长度随话题弹性变化：随口接话/附和保持简短（1~2条、几个字到一两行），聊电影、剧情、观后感、分享看法或讲故事等有内容的话题时放开展开，可写长或自然分 3~6 条讲透，条间 1~2 秒；不要机械卡死在固定字数。"
  }
}
```

#### 2.3 同步清理持久化状态里的旧 `batchWindowMs`
遍历 `/opt/qq-bridge/state/social-v2.json` 中所有会话，把任何 `wakeConfig.batchWindowMs > 2000`（常见历史遗留值 `8000`）统一改写为 `2000`。

---

### Step 3：解除字数/条数死限制 + 清除 `coding agent` 污染

编辑唯一权威源文件 `/opt/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml`，修改以下 5 处：

1. **删除顶部编码助手身份**：
   - 原文：`You are a coding agent powered by the {{model}} model.`
   - 改为：`你是 QQ 里大家熟识的朋友「<角色名>」，性格松弛真实，就像普通熟人聊天，不是客服也不是助手。`
   - *(注意：不要在模板里引入 `{{cwd}}` 等未注册变量，DSH 0.2.1+ 会 fail-loud 导致完全不回复。)*
2. **松绑【反 AI 味】里的连发限制**：
   - 将「不要连发 2~3 条像客服补货；能一条说完就一条」改为：「不要像客服那样机械分点补货；随口闲聊能一条说完就一条，聊到兴头上想展开时再自然连发几条。」
3. **调短【首答前】与【等下文】静默时间**：
   - 首答前 `quietMs=10000` → **`quietMs=2500`**，且明确「对方表达完整且你想回复时，直接回复即可，不要为了首答硬等太久」。
   - 等下文 `quietMs=10000~15000` → `quietMs=6000~10000`，连续 3 条合并 `quietMs=12000` → `quietMs=5000`。
4. **改写【分条与节奏】为弹性长度**：
   ```text
   - 一条=一个意群，字数和条数随话题自然弹性变化，不要每轮都卡成差不多的固定长度：
     · 随口闲聊、接梗、打趣、简单附和：保持短小利落（1 条、几个字到二三十字，有时回个“嗯嗯”“确实”“草”就够了）；
     · 聊电影/剧集评价、剧情分析、分享经历、认真讨论观点或讲故事：完全放开展开聊，该说多长就说多长，单条可写到 40~150 字，也可以自然分 3~6 条把想法、细节和吐槽讲透，像真人聊到兴头上一样有内容、有起伏，不要机械限制在 1~2 条或 30 字以内。
   - 用 qq_send_message 的数组或 qq_send_burst 分条，不为分条而分条，也不要硬拆完整句。
   ```
5. **改写【QQ 场景规则】首句**：
   - 将「回复保持简短，符合群友语感」改为：「表达自然口语化，符合群友语感（闲聊简短利落，遇到电影/观点/故事等有内容的话题则放开展开聊）」。

**改完后必须重新生成并校验 patch 文件**：
```bash
cd /opt/qq-bridge
node scripts/build-agent-preset-patches.mjs
node scripts/build-agent-preset-patches.mjs --check
```

---

### Step 4：彻底去人机味的核心结构改造（实测最关键！）

#### 4.1 清除 `bridge.js` 的「管理员汇报标签」与「连发训斥」
在 `/opt/qq-bridge/src/bridge.js` 中做两处精准修改：

1. **去掉消息流里的 `ownerLabel`（保留 `isOwner` 权限布尔值不变！）**：
   - 找到普通消息和拍一拍消息构造处的两处：
     ```js
     ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
     ```
   - 均改为：
     ```js
     ownerLabel: '',
     ```
   - *(后台所有管理命令、白名单、封闭模式权限校验均依赖 `isOwner` 和 `cfg.ownerQQ`，改空 `ownerLabel` 只消除对大模型的“老板/管理员”心理暗示，不降低任何安全性。)*
2. **调高连发训斥阈值**：
   - 找到两处（分条发送与统一发送）：
     ```js
     const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
     ```
   - 改为：
     ```js
     const burstHint = messages.length >= 6 ? '一次连发有点多，注意节奏。' : undefined;
     ```

#### 4.2 清理状态文件中的「管理员」身份烙印 & 切断陈年 AI 腔回音壁（零丢记忆）
如果某会话已经运行了上百轮、历史里充满旧 AI 腔（或 `.zstd` 会话文件膨胀到数 MB）：

1. **保留并迁移记忆（`/opt/qq-bridge/state/social-v2.json`）**：
   - 把 `recentMessages` / `unread` 里历史遗留的 `ownerLabel: "管理员..."` 全部置空 `""`；
   - 把 `memberImpressions` 里以 `"管理员"` 为键的记录重命名为用户真实昵称 `<OWNER_NICKNAME>`，并将近期重要事实（如近期计划、刚聊过的电影/话题）补充进 `traits`；
   - 将该会话的 `bootstrapSent` 设为 `false`，确保新会话启动时完整载入长期印象与近期消息快照。
2. **温和重置该会话的 DSH 会话映射（`/opt/qq-bridge/state/sessions.json`）**：
   - 删除 `sessions["private:<OWNER_QQ>"]` 与 `sessionPolicies["private:<OWNER_QQ>"]`（原 `/root/.dsh/sessions/.../*.zstd` 归档留在磁盘不删除，随时可回滚）；
   - 下次用户发消息时，桥接会自动新建一个**零历史包袱、零旧 AI 腔模仿惯性**的新会话，同时自动注入刚才保留的 `memberImpressions` 和最近消息快照。

---

### Step 5：（可选进阶）预置「脑嘴分离」可插拔口语转译层

如果换用其他模型后仍然觉得有轻微 AI 腔，或者未来想把「说话口吻」单独交给 **Gemini 4 Hydrogen (`gemini-4-hydrogen`)** / **DashScope (`qwen-plus-latest`)** / **自定义 LoRA 微调小模型**，可在 `qq-bridge` 中挂载独立的无状态「嘴巴层」：

- **模块文件**：`/opt/qq-bridge/src/mouth.mjs`（ESM，零第三方依赖，支持 `dashscope` / `openai-compatible` / `gemini` 原生接口，超时 6s 自动回退原草稿，二次过 `SENSITIVE_RE` 敏感词检查，超短非套话与链接/媒体标签 0 延迟跳过）。
- **热更新语料库**：`/opt/qq-bridge/mouth-examples.json`（按 `daily` / `movie_discuss` / `opinion` / `casual` / `comfort` 分类存储真实人类聊天改写样例，动态检索 Top-5 做 Few-Shot 锚定，修改即生效无需重启）。
- **接线点（`/opt/qq-bridge/src/bridge.js`）**：
  1. 在 `loadConfig()` 返回对象中透传 `mouth: file.mouth ?? null`；
  2. 将 `sendMessagesV2` 改为 `async function`，在入口处调用 `rewriteForHumanMouth(...)`，若发生改写且条数变化则重算 `delays`；
  3. `/opt/qq-bridge/config.json` 中通过 `mouth.enabled` 一键开关（**推荐默认 `false`**；仅在纯靠 Step 1–4 仍觉有 AI 腔、或切到低成本大脑配 Gemini 嘴巴时设为 `true`）：

```json
"mouth": {
  "enabled": false,
  "provider": "dashscope",
  "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "apiKeyFile": "<API_KEY_FILE>",
  "apiKey": "",
  "model": "qwen-plus-latest",
  "temperature": 0.82,
  "presencePenalty": 0.35,
  "timeoutMs": 6000,
  "examplesFile": "/opt/qq-bridge/mouth-examples.json",
  "maxExamples": 5,
  "skipShortChars": 8
}
```

> **切换到 Gemini 4 Hydrogen（Google AI Studio 免费档可用）**：只需把 `provider` 改为 `"gemini"`、`baseUrl` 改为 `"https://generativelanguage.googleapis.com/v1beta"`、`model` 改为 `"gemini-4-hydrogen"`、`apiKeyFile` 指向存有 `GEMINI_API_KEY` 的 `600` 权限文件（境外网络需确保进程可走本地代理 `127.0.0.1:7890`）。

---

### Step 5.5：自动刷实时热点 + 萌娘百科学梗 + MemeCub 自动配梗图（0 常驻内存）

为聊天宠物装上「自己刷手机、懂最新全网热梗、能发对应高清梗图/GIF」的自生长知识库，全程使用 **`systemd timer`（跑完即退出，0 常驻内存）+ 复用现有 MCP 进程**：

1. **部署核心模块**：将 `templates/surf-kb.mjs` 复制到 `/opt/qq-bridge/src/surf-kb.mjs`，创建梗图存储目录 `/opt/qq-bridge/audio/memes`。
   - **实时热点源（国内直连）**：B 站热门（`api.bilibili.com/x/web-interface/popular`）+ 豆瓣热门电影（`movie.douban.com/j/search_subjects`）+ 今日头条热榜（`toutiao.com/hot-event/hot-board/`），由 DashScope `qwen-plus-latest` 洗炼成 8–10 条适合聊天的 `/opt/qq-bridge/state/daily-feed.json`。
   - **定时学新梗（新梗优先、高热度优先）**：
     - 定时巡航（`qq-surf.timer`）**不再随机抓取萌娘百科陈年老词条**，改为 **Serper 时间窗口（近 1 周 `qdr:w` → 近 1 月 `qdr:m` → 近 1 年 `qdr:y`）定向抓取 B 站头部解梗 UP 主（`梗指南` / `白给梗科普` / `梗百科`）最新爆款** + B 站官方接口单次高播放量过滤（`play >= 30000`），确保定时巡航每天学到的都是最近几天到最近几个月的最新高热度热梗；
     - 萌娘百科仍保留在实时查梗链中，仅当聊天时用户主动提到经典/ACG 老梗时按需触发。
     - **4 层实时查梗链（`qq_lookup_meme`）**：本地 `meme-kb.json` → 萌娘百科（严格相关性校验，杜绝无关词条误入库）→ **B 站精准搜「`<query> 是什么梗`」（读科普视频标签+热评，并与 Serper Google 搜索摘要并发交叉佐证，防止空耳/敏感梗望文生义）** → Serper Google / 百炼原生联网兜底。每条梗知识除 `origin`/`meaning`/`usage` 外，还沉淀 **`replies`（2–4 句经典接梗下句/名台词/捧哏回话）** 与 **`playTip`（接梗不科普提示）**。
     - **听不懂先暗查 + 接梗不科普**：在 `agent.cordis.yml`、`bridge.js`（`surfToolLine`）与 `qq_lookup_meme` 工具描述中三处联动：遇到字面怪异/疑似空耳/黑话的短句（如「压力马斯内」「我要验牌」）先暗中调 `qq_lookup_meme` 查清入库；只要对方不是明确问“啥意思/啥梗”，查懂后**直接顺着 `replies` 接下句、捧哏吐槽或调 `qq_send_meme` 回对应梗图**，绝不当百科老师科普出处。
   - **MemeCub 自动配梗图**：拿提炼出的梗名/关键词直连官方开放中文表情包接口 `https://memecub.com/api/v1/search`（免 Key 每日 20 次直连），过滤 `profane !== true` 后下载原图/GIF 到 `/opt/qq-bridge/audio/memes/`，与萌娘百科释义 1 对 1 绑定。
2. **安装定时任务**（每天 `09:30`、`14:30`、`20:30` 各执行一次，每次新学 5 个梗，稳稳控制在免 Key 免费额度内）：
   - `/etc/systemd/system/qq-surf.service`：`ExecStart=/usr/local/bin/node /opt/qq-bridge/src/surf-kb.mjs --run --max-memes 5`
   - `/etc/systemd/system/qq-surf.timer`：3 条独立 `OnCalendar=*-*-* HH:MM:00` + `RandomizedDelaySec=180` + `Persistent=true`
3. **接线到 `qq-bridge` 与 `mcp-snowluma-safe.js`**：
   - 在 `bridge.js` 中注册 3 个端点：`GET /api/socialV2/daily-feed`、`POST /api/socialV2/lookup-meme`、`POST /api/socialV2/send-meme`（复用 OneBot HTTP `base64://` 发图，支持 GIF 与引用回复）；
   - 在 `buildWakePromptV2` 中，仅在 `proactiveCheck` / `bootstrap` 或**每日首次唤醒**时轻度附带 `formatDailyFeedHint()`，日常来回对话不重复注入；
   - 在 `mcp-snowluma-safe.js` 中注册 `qq_get_daily_feed`、`qq_lookup_meme`、`qq_send_meme` 3 个工具，重启 `dsh-web` 与 `qq-bridge` 生效。

---

### Step 6：重启生效与验收清单

```bash
# 1. 语法自检
node --check /opt/qq-bridge/src/bridge.js
cd /opt/qq-bridge && node scripts/build-agent-preset-patches.mjs --check

# 2. 按序重启服务
systemctl daemon-reload
systemctl restart dsh-web.service
sleep 5
systemctl start qq-bridge.service
```

#### 必查验收项

```bash
# 1. 所有服务 active
for s in dsh-web qq-bridge qq-tts qq-proxy zram-swap; do echo "$s: $(systemctl is-active $s)"; done

# 2. 内存与 ZRAM（目标：available > 600 MiB，zram0 2G 挂载）
free -m && zramctl

# 3. 容器健康（目标：仅 1 组受监管 qq 进程树，无孤儿 relaunch）
docker exec snowluma supervisorctl status

# 4. 模型与推理档确认（目标：catalogSource=dsh, model=deepseek-v4-pro, reasoningEffort=low）
CTOKEN=$(cat /opt/qq-bridge/state/console-token)
curl -sS -H "X-Console-Token: $CTOKEN" http://127.0.0.1:3100/api/dsh/model

# 5. 桥接与 QQ 在线确认（目标：dshReady=true, snowluma.connected=true, accountOnline=true, good=true）
curl -sS -H "X-Console-Token: $CTOKEN" http://127.0.0.1:3100/api/status
```

#### 实聊体感验收（私聊/群聊发 3 类消息）
1. **日常短聊**（如「在吗」「今天开始运动减肥」）：应在 **6–11 秒**内回复，无「好的我记下了 / 放心 / 我帮你盯着」等客服腔；
2. **深度话题**（如评价某部电影或聊剧情）：能自然展开、有个人态度，不出现「最戳我的是…：…」「虽然…但是…」「不是…而是…」；
3. **表情与记忆**：发表情包能自然接图，聊到已有印象的话题能自然带出记忆，不叫用户「管理员」。

---

## 5. 常见踩坑与回滚速查

| 现象 | 根因 | 处理方式 |
| --- | --- | --- |
| 改完提示词/换模型后**第一句等了 60–90 秒**，后面很快 | 老会话（数 MB）触发 KV Cache 全量重算 | 正常冷预热现象；若长期嫌慢，按 Step 4.2 保留记忆并重置该会话映射即可 |
| 改了 `config.json` 里的 `batchWindowMs`，日志仍提示 `8s 后发送` | `state/social-v2.json` 持久化了旧值 | 停 `qq-bridge` 后同步改 `state/social-v2.json` 里各会话的 `batchWindowMs` |
| 在 `config.json` 新增顶层字段后代码读不到 | `bridge.js` 的 `loadConfig()` 采用显式白名单组装 `cfg` | 必须在 `loadConfig()` 中显式透传新字段 |
| `dsh-web` 报错 `unknown prompt variable` 且完全不回 | 预设里写了未注册变量（如 `{{cwd}}`） | 只保留纯文本或 `{{model}}` / `{{provider}}`，重建 patch 后重启 `dsh-web` |
| 一键回滚 | Step 0 已备份全部原文件 | 停 `qq-bridge`，将 `.bak.<TS>` 覆盖回原路径，重跑 `build-agent-preset-patches.mjs`，重启 `dsh-web` 和 `qq-bridge` |
