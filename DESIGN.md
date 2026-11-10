# 设计文档 · 英语口语从小白到大师（oralenglishmaster）

> 纯静态、可离线的单页口语练习应用。本文档描述整体架构、数据模型与核心机制，供后续维护时对照。
> 配套文档：[进度记录](PROGRESS.md) · [使用说明](README.md)

## 1. 定位与设计目标

- **定位**：生存口语 + 场景熟练度训练器（约 CEFR A2 → B1 低段），不是"大师"级课程（见 §10 已知限制）。
- **形态**：零依赖、零构建的静态站点。`index.html` 单文件承载页面、样式、数据与逻辑，`audio/` 存放句级 MP3，可双击 `start_server.command` 本地起服务，也可部署到任意静态托管。
- **离线**：PWA + Service Worker，已访问的页面与音频进缓存，可安装到桌面/手机主屏。
- **数据**：学习记录全部存浏览器 `localStorage`，不上传、无账号。

## 2. 目录结构

```text
.
├── index.html                # 单页应用：CSS + 5 个页面 + 全部数据 + 全部逻辑
├── sw.js                     # Service Worker（文档 network-first / 资源 cache-first）
├── manifest.webmanifest      # PWA 信息
├── start_server.command      # macOS 一键启动（python3 http.server 8899）
├── audio/<chapter>/<lineId>.mp3   # 28 章目录 × 句级音频，共 1479 个
├── icons/                    # PWA 图标
└── tools/
    ├── check.js              # 数据完整性校验（发版前必跑）
    └── gen-manifest.js       # 从 audio/ 重新生成 index.html 的音频清单
```

## 3. index.html 内部分区（自上而下）

| 区块 | 内容 |
| --- | --- |
| CSS | `:root` 主题变量（浅色/深色两套）+ 全部组件样式 |
| 页面 | `#page-cover` / `#page-map` / `#page-chapter` / `#page-vocab` / `#page-settings`，顶部导航切换 |
| 浮层 | `#word-panel` 单词释义侧栏、`#score-panel` 跟读打分底部面板 |
| 数据 | `roles`（24 个角色嗓音档案）→ 各章 `xxxChunks/xxxSceneLines*/xxxQuizData` → `chapters`（28 章）→ `chapterDialogues`（84 段对话索引）→ `wordDictionary`（656 词条）→ `irregularWordMap` → `audioManifest`（1479 条音频清单 Set） |
| 逻辑 | 存储、导航、播放状态机、评分、词汇 SRS、跟读复习、统计、快捷键 |

## 4. 数据模型

### 4.1 章节与对话

```js
chapters.coffee = {
  number: "Chapter 01", title: "Coffee Shop", label: "...", lead: "...",
  staffRole: "barista", staffLabel: "Barista",
  chunks: coffeeChunks,          // 核心语块
  sceneLines: coffeeSceneLines,  // 第 1 段对话（兜底）
  quizData: coffeeQuizData,
  practice: { label1, label2, options1, options2, template(v1, v2) }
}
chapterDialogues.coffee = [       // 每章 3 段对话，28 × 3 = 84 段
  { title, desc, lines: coffeeSceneLines },
  { ..., lines: coffeeSceneLinesB },
  { ..., lines: coffeeSceneLinesC }
]
```

台词行结构（`line`）：

```js
{ id: "l1", role: "barista", text: "Hi there! ...", zh: "你好！...",
  emotion: "friendly", pauseAfterMs: 560 }
```

- `id` 在**章内唯一**（`tools/check.js` 保证），音频路径 = `audio/<chapterId>/<lineId>.mp3`。
- `emotion` 经 `emotionAdjust()` 微调 TTS 的 pitch/rate（仅 TTS 回退路径使用）。

### 4.2 难度分层

```js
chapterLevels = { coffee: "A2", ..., bank: "B1", ..., interview: "B1+", ... }  // 28 章
LEVEL_META    = { "A2": {name, desc}, "B1": {...}, "B1+": {...} }
```

三级：A2 生存必备（9 章）/ B1 生活与社交（11 章）/ B1+ 进阶表达（8 章）。学习地图按此渲染"推荐学习路径"，地图卡片与章节页头部显示等级徽章。注意超市章节 id 为 `market`、派对为 `party`、景点为 `tours`。

### 4.3 角色与声音

`roles` 定义 25 个角色档案（`name / role / lang / voiceHints / pitch / rate / volume / color`），定义后统一挂 `key` 字段供声音设置查找。声音解析优先级（`pickVoice`）：

1. **用户为该角色手动选择的声音**（`settings.roleVoices[roleKey]`，按 `voiceURI`/`name` 匹配）
2. `voiceHints` 精确/包含匹配
3. 任意英文声音 → 任意声音

**对话朗读引擎**（`settings.dialogVoice`）：

- `hd`（默认）：对话/角色扮演/跟读示范播 MP3 录音，角色声音设置不生效于对话；
- `tts`：上述场景改用角色配音（`speakText` + 各角色已选声音），角色声音设置直接体现在对话里。

所有"按句播放"入口统一经 `!prefersTts() && hasLineAudio(line)` 路由。单词、语块、例句、替换练习始终走 TTS（始终受角色声音影响的是 `customer` 声音）。

### 4.4 localStorage（键 `english-speaking-book-progress-v1`）

```js
progress = {
  lastPage, lastChapter,          // 恢复位置
  done: { "coffee:dialog": true, ... },   // 章节各环节完成标记
  quizScore, quizScores: { chapterId: 分数 },
  savedWords: { token: { word, ipa, zh, box, addedAt, lastReviewed, due } },  // 词汇 SRS
  activity: { "2026-11-09": 3, ... },      // 每日练习次数（打卡/目标统计）
  lineReviews: { "coffee/l1": { chapter, lineId, score, count, at } }        // 跟读复习队列
}
settings = { speed, hideChinese, theme, dailyGoal, dialogVoice: "hd"|"tts", roleVoices: { roleKey: voiceURI } }
```

读取时与默认对象浅合并（`loadStorage`），新增字段对老数据向后兼容；`resetProgress` 保留 `savedWords`、清空其余（含 `lineReviews` 与 `activity`）。

## 5. 播放体系（核心状态机）

### 5.1 三条互斥的运行令牌

`stopPlayback()` 统一递增三个令牌，任何播放链在 await 之后都会校验自己的令牌，失效即静默退出：

- `sceneRunId`：整段连播（`playScene` / `runRoleplayFrom`）
- `speechRunId`：TTS（`speakText`）
- `lineRunToken`：单句播放（`speakLineByIndex`，含单句循环重播）

**为什么需要**：MP3 的 `play()` promise 被打断时会以 AbortError 拒绝；没有令牌机制时会被误判为"加载失败"而走 TTS 回退，导致旧句子在新播放开始后又冒出来读一遍（v4 修复的实际 bug）。

### 5.2 `playAudioElement(line, forceSlow, chapterId, rateOverride)`

- MP3 播放统一入口；`superseded()`（`currentAudio !== audio`）判定是否被新播放取代，被取代时 resolve 而非 reject，防止误回退。
- 变速保持音调：`preservesPitch / webkitPreservesPitch / mozPreservesPitch`。
- 速率优先级：`rateOverride`（原速挑战）> `forceSlow ? 0.72` > `clamp(getSpeedFactor(), 0.5, 2)`。

### 5.3 语速档位

| 档位 | speed 值 | 因子 | 说明 |
| --- | --- | --- | --- |
| ⚡⚡ 1.5x | `faster` | 1.5 | |
| ⚡ 1.25x | `fast` | 1.25 | |
| Normal | `normal` | 1.0 | 录音本身约 100–120 wpm |
| 🐢 Slow | `slow` | 0.78 | |
| 🐢🐢 Turtle | `turtle` | 0.62 | |

连播句间停顿 = `max(120ms, pauseAfterMs × 0.6 ÷ 因子)`，随档位同比缩短。

### 5.4 播放入口一览

| 入口 | 行为 |
| --- | --- |
| `playScene()` | 整段连播，MP3 优先、TTS 兜底 |
| `playScene({native:true})` | 🚀 原速挑战：速率 = `clamp(档位×1.8, 1, 2)`、句间 150ms、`#dialogue.blind` 隐藏全部文本盲听；停止或点击任意句子恢复文本 |
| `speakLineByIndex(i)` | 单句播放；`sentenceLoop` 开启时播完 700ms 后自动重播（`scheduleSentenceLoop` 持令牌） |
| `runRoleplayFrom(i)` | 角色扮演：对方台词播完等待，轮到用户显示提示 |
| `playLineReviewSample()` | 跟读复习听示范（显式传 chapterId，跨章节） |

### 5.5 暂停

`togglePlaybackPause()` 用 `playbackPaused` 标志同时控制 MP3（`currentAudio.pause/play`）与 TTS（`speechSynthesis.pause/resume`）双通道；`stopPlayback()` 重置标志。

## 6. 评分体系

```
SpeechRecognition(maxAlternatives=3)
  → 逐候选 computeScore()（tokenize → alignWords 词级 Levenshtein 对齐 → 匹配率%）
  → 取最高分候选 renderScore()
```

`renderScore` 的副作用钩子：

- `pct ≥ 85`：普通模式 `markDone("shadow")`；跟读复习模式 → 移出 `lineReviews` + 1.2s 后自动下一句。
- `pct < 85`：写入 `lineReviews`（记录上次得分、累计次数、时间戳）——任何入口（跟读/角色扮演/复习）的低分都会进队列。

## 7. 复习体系（双循环）

| 循环 | 队列 | 调度 |
| --- | --- | --- |
| 词汇 SRS | `savedWords`，Box 0–4 | 认识 → Box+1，间隔 10min→1d→3d→7d→21d；模糊 → 4h；不会 → Box 0、10min。Box ≥ 3 视为掌握。复习队列优先取"到期且未掌握"，无到期则按最久未复习 |
| 跟读复习 | `lineReviews` | <85 分自动入队，复习达 85 分即出队；按时间戳排序逐句过（听示范/慢速/打分/跳过） |

## 8. 主题与 PWA

- **深色模式**：`:root` 变量两套取值，`data-theme="dark|light"` 手动指定，`prefers-color-scheme` 媒体查询跟随系统（`:not([data-theme="light"])`）。所有面板底色走 `--panel`/`--warm-2` 变量，新增样式不得硬编码浅色。
- **sw.js**：页面文档（navigate / `.html` / 目录）**network-first**——改版后刷新即生效，离线回退缓存；音频与图标 **cache-first**（首次访问即缓存，全量约 46MB）。缓存名 `enbook-v2`，破坏性更新时需手动 bump。

## 9. 维护脚本

```bash
node tools/gen-manifest.js   # 增删音频后重新生成清单（每行 6 条、行尾带逗号）
node tools/check.js          # 校验：清单↔磁盘↔台词ID、章内ID唯一、role 已定义、测验 answer 不越界
```

`check.js` 通过是发版前提。改 `index.html` 后建议抽取 `<script>` 块做 `node --check` 语法校验。

## 10. 已知限制（内容侧，2026-11-09 评估）

- 全书台词独立词 2,842、词典详解 656 条（A2–B1 带宽；流利表达需 4k–8k 活跃词）。
- 录音本身 ~100–120 wpm，"原速挑战"是变速而非真原生语速材料。
- 无开放性输出练习（角色扮演为照读固定台词）、无音素级发音反馈（评分只到词级对错）。
- 28 章平均句长 9.3–11.9 词，章内难度阶梯有限（分层为横向分级，非纵向爬坡）。

## 11. 路线图候选（按性价比）

1. AI 对话伙伴模式（开放对话 + 纠错，需接 LLM API，做成本地优先、联网增强）
2. 真原生语速第二套音频 / 引入外部原声材料
3. 测验错题联动跟读复习队列
4. 预备章（零基础 10 句）与章内难度爬坡
5. 音素级发音反馈（录音 + 音素对齐）
