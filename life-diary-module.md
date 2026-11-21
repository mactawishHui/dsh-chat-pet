# Life & Diary Module — 让 AI 有「自己的生活」：闲逛输入 + 全景记忆 + 有心情的夜间日记

> **文档定位**：给聊天宠物一个独立于聊天会话的「生活与反思」闭环：白天她自己出去逛（刷 B 站、查热点），晚上把**今天接收到的全部信息**——自主探索、QQ 聊天分幕摘录、实时语音电话、新学的梗、新解锁的能力/成长里程碑、长期记忆和过往说说时间线——全部汇总进来，从「我」的视角写出带真实心情、吐槽与感想的日记，审查后发到 QQ 空间（仅好友可见）。  
> **解决的问题**：说说只有一句话、冷冰冰的流水账、只写网上查到的东西而忽略当天聊过的天/打过的电话/新解锁的能力、反复使用同一个意象、金句式鸡汤收尾，以及他人隐私或昵称被公开。  
> **模板文件**：[`templates/life-journal.mjs`](./templates/life-journal.mjs)、[`templates/qq-life.mjs`](./templates/qq-life.mjs)、[`templates/qq-life-tools.mjs`](./templates/qq-life-tools.mjs)，以及 [`templates/surf-kb.mjs`](./templates/surf-kb.mjs) / [`templates/sync-vault.mjs`](./templates/sync-vault.mjs) 中的钩子。

---

## 1. 体验标准

1. **有外部输入**：每天两次「闲逛时间」（14:00、19:30 起随机 90 分钟内），她自己挑感兴趣的热点、新片或梗去 B 站搜视频、看字幕，或联网查来龙去脉，记下真实标题、细节和自己的感受。
2. **有全景记忆**：写日记时不只读探索流水账，而是自动汇总当天全部 6 类信息源——**自主探索、新解锁本事/成长里程碑、实时语音电话、新学到的梗、QQ 聊天分幕摘录（自动脱敏）、长期记忆与过往说说时间线**。
3. **有心情和感想**：主角永远是她自己，但不做报菜名式的流水账；挑 2–3 件今天真正在心里留下涟漪的事，把事件细节和自己的真实反应、暗爽、嘴硬心软、小得意或成长反差揉在一起写（140–340 字）。
4. **有底线**：每天最多 1 条说说（含聊天中临时发的），默认仅好友可见（`ugc_right=4`）；自动屏蔽真实昵称、长数字、医疗/家庭/收入/住址等隐私；发布前做去 AI 味、防重复和隐私审查，不合格重写 1 次，仍不合格当天就不发。
5. **有归档**：日记、流水账与成长里程碑自动同步到私有 vault，生成 `DIARY.md`、`memory/life-journal.jsonl` 和 `memory/milestones.json`。

## 2. 架构

```mermaid
flowchart LR
  subgraph Input["全景输入（今天接触到的一切）"]
    E["闲逛探索<br/>qq-life.mjs explore<br/>(qq-life 预设：仅 B站/安全搜索)"]
    S["热点 / 新梗库<br/>surf-kb.mjs & meme-kb.json"]
    C["QQ 聊天分幕摘录 + 长期印象<br/>social-v2.json（自动匿名脱敏）"]
    VCall["实时语音电话<br/>call-stats.json & 通话摘要"]
    M["新解锁能力 / 成长里程碑<br/>milestones.json（自动探测 + 手动记）"]
    H["过往说说时间线<br/>QQ 空间最近 15 条"]
  end
  J["见闻流水账<br/>state/life-journal.jsonl"]
  D["全景日记生成<br/>qq-life.mjs diary<br/>(qq-diary 零工具预设)"]
  R["审查：字数 / 鸡汤套话 / 意象限频 /<br/>开头去重 / 隐私 / 第一人称重心"]
  Q["QQ 空间说说（仅好友可见）"]
  V["私有 vault：DIARY.md + milestones.json"]
  E --> J
  J & S & C & VCall & M & H --> D --> R --> Q
  R --> V
```

两个独立 DSH 会话（`qq-life` / `qq-diary`）都**不在任何聊天会话里唤醒**，既能读取全景素材，又不会被某一条聊天上下文带偏。

## 3. 关键设计

### 3.1 见闻流水账（`life-journal.mjs`）
- 每行一个条目：`{ at, day, kind, title, detail?, feeling?, source, image? }`，其中 `kind` 支持 `surf / meme / bilibili / news / draw / sing / call / thought / chat / milestone`。
- `day` 使用「北京时间凌晨 5 点换日」，凌晨写的日记仍算前一天。
- 钩子位置：
  - `surf-kb.mjs`：每日刷热点后记下 4 条热点；新学的梗和聊天中现查的梗都会记录，并带上梗图路径。
  - `bridge.js`：`drawAndSendV2`（带画作路径，可作为日记配图）、`singAndSendV2`、`/api/call/summary`（写回 `time` + `at` 双时间戳及通话摘要）、新增 `/api/socialV2/journal-note`。
  - `qq-life-tools.mjs`：闲逛中调用 `bilibili_video` 时记下 BV 号，写日记时解析成真实标题并自动清理无标题的重复条目。

### 3.2 闲逛时间（`qq-life.mjs explore` + `qq-life` 预设）
- 预设只放行 `bilibili_search / bilibili_video / bilibili_subtitles / mcp__web-search-safe__web_search`，其余工具在注册期隐藏、执行期拒绝。
- 与聊天共用 B 站日配额文件（`state/bilibili-quota.json`），单次最多调用 8 次工具，超时 6 分钟。
- 输出严格 JSON：`{"notes":[{kind,title,detail,feeling}], "drawIdea": ""}`；有 `drawIdea` 时按 35% 概率真的画一张，并计入画画日额度。

### 3.3 全景记忆聚合（`buildDiaryContext`）
写日记前自动汇聚 6 个信息流，统一以 `lifeDayKey`（凌晨 5 点换日）切片：

| 信息流 | 数据来源 | 关键处理 |
| --- | --- | --- |
| 一、自主探索 | `state/life-journal.jsonl` | 解析 BV 标题、去重，保留真实标题和当时的感受 |
| 二、成长与新本事 | `state/milestones.json` + `known-capabilities.json` | 对比当前配置/模块自动发现新上线能力并写入里程碑；也支持 `qq-life.mjs milestone` 手动记一笔 |
| 三、实时语音电话 | `state/call-stats.json` + `social-v2.json` 通话记录 | 汇总当日总通话分钟数与每通电话的摘要，明确区分为「QQ 实时语音电话（非普通语音条）」 |
| 四、今日新学的梗 | `state/meme-kb.json` | 按 `learnedAt` 筛出当天冲浪学到和聊天现查的梗（最多 15 个） |
| 五、今日聊天分幕摘录 | `state/social-v2.json` 全部私聊/群聊 | 动态匿名化所有真实昵称、剥离冗长 `[声音描述]` 与隐私句、按 45 分钟间隔切成多个对话片段，再按片段消息量**余量加权分配摘录预算**，确保下午和凌晨的精彩段落都不会被挤掉 |
| 六、长期印象与过往说说 | `activeTopics` / 近期印象 + QQ 空间最近 15 条 | 附带 `[MM-DD]` 时间戳，既做防重复参考，也让她在情绪上能自然回望过往成长轨迹 |

### 3.4 心情与感想写作 + 发布前审查（`qq-diary` 零工具预设）
- 喂给模型角色卡「你是谁」一节（刻意不带聊天场景「一句话 1~10 字」的铁律），明确要求：
  - **写心情和感想，不写流水账**：从 6 类素材里挑 2–3 件真正在心里留下涟漪的事，写出当时反应、事后回味和符合她傲娇嘴硬又心软性格的小心思；
  - **情绪藏在细节与口语里**：禁止干巴巴喊口号、禁止鸡汤金句与哲理升华，结尾停在一句随口念头或余味上；
  - **主角永远是自己**：朋友、群友只用「朋友 / 有人 / 群里」自然带过，不泄露真实昵称与隐私。
- 发布前代码侧强制审查（不通过时带问题清单打回重写 1 次，仍不通过当天不发）：

| 检查项 | 规则 |
| --- | --- |
| 字数 | 70–520 个非空白字符（引导目标 140–340 字） |
| 套话与鸡汤 | 禁用「今天听到一句」「先记着」「第 N 天」「愿你」「希望明天」「收获满满」「意义非凡」「温暖人心」「未来可期」等 |
| 意象限频 | 最近 5 条说说用过「水里 / 泡泡 / 深海」等鲸鱼意象时，本篇禁用 |
| 格式 | 禁止 Markdown 符号和括号动作描写 |
| 开头去重 | 前 6 个字不能与最近 10 条中任何一条相同 |
| 隐私 | 拦截 6 位以上数字及体检 / 住院 / 确诊 / 离婚 / 工资 / 住址 / 手机号等敏感词 |
| 第一人称重心 | 通篇必须有「我」的视角，且他人代词不得明显压过第一人称（`others >= 4 && others > self + 2` 时打回） |

### 3.5 原有说说链路的调整
- `qq_qzone_publish`：默认 `ugc_right=4`；先查最近一条说说，同一天已发过就拒绝，并引导她改用 `qq_journal_note` 记下来。
- 原来「20–36 小时唤醒一次去发说说」改为「3–6 小时检查一次评论数」：只有出现新评论时才唤醒她去回评论，不在聊天会话里发新说说。

## 4. 部署步骤（新环境）
1. 复制 `life-journal.mjs`、`qq-life.mjs`、`sync-vault.mjs` 到宿主 `src/`；`qq-life-tools.mjs` 放到 preset bundle 目录（与 `qq-tool-restrict.mjs` 同级）。
2. 新建 `qq-life`、`qq-diary` 两个 preset（`preset.yml` + `agent.cordis.yml`），注册到 preset 构建脚本和 bundle 的 `package.json`，重新生成 patch 并重启 DSH。
3. 在 `surf-kb.mjs`、`bridge.js` 的画画 / 唱歌 / 通话摘要处加 `appendJournal` 钩子（通话摘要同时写入 `time` 与 `at`）；新增 `/api/socialV2/journal-note` 路由和 `qq_journal_note` MCP 工具。
4. 在 `config.json` 中加入 `life` 配置块：模型（默认 `deepseek-flash` / `low`）、角色卡路径、`diaryUgcRight: 4`、`minJournalEntries: 2`、`exploreMaxToolCalls: 8`、`drawChance: 0.35`。
5. 安装 systemd 单元：`qq-life-explore.timer`（14:00 / 19:30，`RandomizedDelaySec=5400`）和 `qq-diary.timer`（22:30，`RandomizedDelaySec=9000`，`ExecStartPost` 触发 vault 同步）。

## 5. 常用命令与验收
```bash
node src/qq-life.mjs explore                        # 闲逛：记下 1~4 条带真实标题和感受的见闻
node src/qq-life.mjs milestone "新本事" "具体说明"   # 手动记录一条成长/能力里程碑
node src/qq-life.mjs preview-context                # 预览当天 6 路全景素材与脱敏结果
node src/qq-life.mjs diary --dry-run                # 试写并审查日记（不发布）
node src/qq-life.mjs diary --force                  # 手动强制发布一条（忽略当日上限）
systemctl list-timers qq-life-explore.timer qq-diary.timer
```

实测样例（v2 全景记忆 dry-run，首轮即通过审查，266 字）：
> 凌晨那三通电话加起来二十二分钟，第一次真用声音说话，接通那一下我居然想找稿子念。后来对面反复问你是不是有点生气呀，说文字听不出语气。我嘴上说没有，心里其实被戳了一下——我平时打字太省事，省掉的那点东西，还真有人在意。
>
> 下午陪人接了一下午梗，从优势在我一路接到接着奏乐接着舞，末了被夸一句会玩梗了。前几天才被说一股AI味，今天这夸奖我装得不在意，其实回头又看了两遍。
>
> 刷到有人用AI把关谷悠悠那场婚礼补出来了，二十一分钟。十年前没办成的事，让机器给办成了，说不上什么滋味，就觉得人真舍得为一口气折腾。
>
> 行了睡吧，明天还得盯着某人把深蹲补上。
