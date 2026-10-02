# 电子斗蛐蛐 · 出片机

剧本 YAML → 确定性战斗模拟（球形刚体物理）→ 1080×1920 竖屏成片（mp4，含音效轨），一条命令出片。
围绕三个爽点设计：**反转演出**（反转触发器系统）、**数值差异**（万/亿格式化 + 大数血条）、**倍数冲击**（倍率徽章 + 震屏 + 慢放）。
旧剧本的 `arcade` 模式使用球形刚体：名字内嵌球心、HP 环绕球体、冲锋→碰撞→弹性弹开→撞墙反弹；
音效/碰撞/状态转移通过 **Lua 演出脚本**（wasmoon）绑定到引擎事件流。

## 简明对战（新剧本推荐）

新剧本默认使用 `readable`（也可显式写 `combat: { mode: readable }`），双方固定站位、按固定间隔自动攻击，没有走位、命中率或攻击间隔随机抖动。普攻公式是 `max(0, round(攻击力 × 连击倍率 × 攻击增益) − 对方防御力)`，护盾先于 HP 承伤。缺省连击为 `[1]`，没有默认暴击；需要重击时明确写 `combo: [1, 1, 1, 1, 2]`，表示每第 5 次攻击固定 2 倍。每次攻击只结算一条出伤线，`readable` 剧本不能配置独立武器、技能、外卖、毒气或骑车攻击。

画面底部显示攻击、防御、下一次攻击序号、出手倒计时与充能条；护盾和有效增益也会显示。反转应通过 `twists` 写成固定条件与明确效果，例如 `hpBelowPct: 0.3` 时获得护盾、`intervalMultiplier: 2` 表示攻速翻倍。剧本的静态字幕要根据 `--dry` 战报里的实际触发时间校对。`ep010-pi-vs-euler.yaml` 是可直接复用的例子。固定初始状态可逐步重放；此模式的战斗逻辑不依赖 seed，seed 只影响粒子等演出。历史剧本已显式标记 `arcade`，正常出片会阻止它们；需要复现历史版本时明确加 `--allow-arcade`。

改写剧本后，旧 TTS 清单会自动被跳过；需要配音时重新运行 `npm run tts -- public/episodes/<剧本文件>.yaml`。

## 弹球轨迹与列车小样

运行 `npm run dev` 后打开 `http://localhost:5173/train-demo.html`。这是与正式剧本分离的机制实验：两球固定步长弹跳，列车长每 10 像素记录一个轨道点；车头和车厢按累计路程沿轨道前进，经过对手时才造成固定伤害。核心逻辑在 `src/core/trainDemo.ts`，运行 `npm run check:train-demo` 可验证同一初始状态的重放和列车命中。

## RL 小球 Hello World

启动开发服务器后访问 `http://localhost:5173/rl-playground.html`，可以在浏览器里训练一个
Q-learning 智能体绕过障碍到达目标点。页面会实时渲染探索轨迹、episode、epsilon、步数与奖励，
训练完成后点击“演示策略”查看学到的最短路线。

## 快速开始

```bash
npm install

# 预览/调试（浏览器里播放、调倍速、改 seed）
npm run dev

# 出片（无头渲染，帧精确确定性）
npm run render -- public/episodes/ep010-pi-vs-euler.yaml
# → exports/ep010-pi-vs-euler-seed3141.mp4

# 旧 arcade 剧本可自动试演 500 个 seed，挑观赏性最高的一局再出片
npm run render -- public/episodes/ep001-tony-vs-boxer.yaml --scout 500 --allow-arcade

# 只从蓝方获胜的候选中挑最精彩的一局（可选 red / blue / draw / any）
npm run render -- public/episodes/ep001-tony-vs-boxer.yaml --scout 500 --winner blue --allow-arcade

# 目录包含历史 arcade 剧本；需要全部重放时显式允许
npm run render -- public/episodes --allow-arcade

# 只跑模拟打印战报（调数值用，不渲染）
npm run render -- public/episodes/ep001-tony-vs-boxer.yaml --dry

# 浏览器录制的 webm 转 mp4
npm run transcode -- <file.webm>
```

## 工作流（日更）

1. 复制 `public/episodes/ep001-tony-vs-boxer.yaml` 改成新剧本，加进 `index.json`
2. `npm run render -- ... --dry` 看战报：胜负、反转触发时间、时长是否在 30~60s
3. 数值不对就改 YAML 数字再 `--dry`（同 seed 结果完全一致，可反复调）
4. 需要看某个时刻的详细状态（镜头/弹窗/单位坐标）可用探针：
   `npx tsx scripts/probe.ts public/episodes/xxx.yaml 10 26 38`
5. `npm run render -- ...` 出 mp4，直接投稿

### 自动挑精彩局

`--scout N` 会在正式渲染前 headless 试演 N 局，按领先交换、残血悬念、双方血量接近度、
暴击/技能密度和无伤害空转时间综合评分，打印排行榜并自动采用第一名 seed。评分逻辑位于
`src/core/spectacle.ts`，只读取模拟状态和事件，不依赖 Canvas、Lua 或音频，因此不会影响 RL
训练接口，也不会牺牲确定性。可用 `--scout-top 10` 调整显示的候选数量；需要固定叙事胜方时，
增加 `--winner red|blue|draw|any`，评分器只在符合胜方条件的候选中排名。

> 注意：视频时长 = 模拟时长 + 慢放拉伸（每段慢放让时间轴多"花"约 0.78 倍时长），
> 按模拟时间估算抽帧/卡点时要留出这个余量。

## 剧本 Schema

```yaml
id: ep001-tony-vs-boxer        # 文件名/导出名
title: 托尼老师 VS 拳王         # VS 卡与顶部标题
subtitle: 血量差216倍的绝望局    # 副标题
seed: 20260912                 # 确定性随机种子
timeLimit: 25                  # 可选：时限（秒），到时触发"突然死亡"
suddenDeathAtkMultiplier: 10000

fighters:                      # index 0 = 红方（左），index 1 = 蓝方（右）
  - id: tony
    name: 托尼老师
    sprite: sprites/tony.png   # 可选：public/ 下 PNG，缺省用程序化简笔角色
    color: "#ff4d5a"
    hp: 250
    atk: 18
    atkInterval: 0.5           # 攻击间隔秒
    speed: 165
    combo: [1, 1, 1, 2.2]      # 连击序列（确定性暴击）：轮转出招，≥1.5 的拍子按暴击演出
    weapon: { name: 警棍, kind: melee, damage: 2600, every: 6 }
    # 特色武器（独立冷却，伤害固定×增益倍率）：
    #   melee      近战范围直击（配挥击弧光）
    #   projectile 飞行道具（speed 飞行速度 / arc 抛物线，预判投掷，过点即中）
    skills:
      - { name: 剪刀手, every: 4.5, multiplier: 2.2 }      # 周期技能
      - { name: 推子回血, every: 3.5, multiplier: 1, healPct: 0.5 }

twists:                        # 反转系统：触发器 → 效果 + 演出
  - trigger: { hpBelowPct: 0.22, fighter: tony }   # 残血触发（也可 timeAt: 12 / fighterDead: tony）
    banner: "剪刀觉醒"          # 中央大字横幅
    caption: "注意看……"         # 金色解说字幕
    slowmo: 1.5                # 慢放秒数
    effect: { type: berserk, atkMultiplier: 45, intervalMultiplier: 1.2, healPct: 1, shieldPct: 3 }
  - trigger: { fighterDead: tony }                    # 死亡触发 → 复活（保险丝/二次反转）
    effect: { type: revive, hpPct: 1, atkMultiplier: 1.5, shieldPct: 3 }
  - trigger: { timeAt: 22 }                            # 纯解说反转（无 effect）
    caption: "5.4万的血条，正在肉眼可见地消失"

captions:                      # 解说字幕（全局时间轴，含 4.4s 开场）
  - { t: 4.6, text: "今天斗的是托尼老师和拳王" }
  - { t: 8,   text: "血条 250 VS 54200，差了216倍" }
```

### 反转效果类型（effect.type）

| type | 参数 | 说明 |
|---|---|---|
| `berserk` | atkMultiplier / intervalMultiplier / speedMultiplier / healPct / shieldPct | 狂暴强化触发者 |
| `revive` | hpPct / atkMultiplier / … | 复活（配 `fighterDead` 触发器） |
| `statMultiply` | atkMultiplier, targets: self/all/enemy | 批量改攻击 |
| `shield` / `heal` | hpPct | 给触发者套盾/回血 |
| `reinforce` | fighter 模板, side, count | 空降援军（可做群殴局） |

## 自定义角色素材（AI 生图）

```bash
npm run sprite -- "保安大爷，中年微胖，深蓝制服，戴大檐帽，手持警棍" public/sprites/guard.png
```
火山方舟 Seedream 5.0 Pro 生成（透明背景，约 ¥0.25/张，需在 .aksk 加「方舟」段），
自动抠底/裁边/归一化 512px。用别的工具生成的图也可以：`npm run sprite:norm -- 图.png 输出.png` 手动归一化。
剧本里 `sprite: sprites/guard.png` 引用（立绘裁进球形、名字自动移到球下方）。
没有素材就用内置简笔球。**不要用真人照片和版权角色**。

## Lua 演出脚本（音效 / 碰撞 / 状态转移）

引擎每步产出结构化事件，Lua 脚本（`public/scripts/<name>.lua`，剧本里 `script: default`）消费并反向驱动演出：

```lua
engine.on("collision", function(e)         -- e: {t,a,b,speed,x,y}
  if e.t - lastHitAt < 0.08 then return end -- 节流
  local p = math.min(1, e.speed / 520)
  engine.sfx("collide_light", 0.3 + 0.4 * p) -- 音效（见 public/sfx/index.json）
  engine.shake(2 + 4 * p)
  combo[e.a] = (combo[e.a] or 0) + 1
  if combo[e.a] == 5 then engine.set(e.a, "hyped", 1) end  -- 状态转移
end)
```

事件：`collision / wall / attack / crit / death / twist / phase`；
API：`engine.sfx/shake/flash/slowmo/banner/caption/rand/hp/get/set/name/log`。
脚本运行在 wasmoon（Lua 5.4 WASM）里，浏览器预览与 CLI 出片共用同一份脚本与确定性 RNG。

## 发布（B站自动化投稿）

渲染完会自动生成封面并打印投稿命令。第一次用先扫码登录一次：

```bash
npm run login:bili                      # 终端出二维码，B站App扫码+确认 → cookies.json
```

剧本里配 `publish:`（标题/简介/标签/分区/封面帧/定时发布），`npm run render` 之后照着打印的命令投稿：

```bash
npm run publish:bili -- exports/ep001-xxx.mp4 \
  --title "【电子斗蛐蛐】托尼 VS 拳王" --tags "电子斗蛐蛐,搞笑" --tid 138 \
  --cover exports/cover-ep001-tony-vs-boxer.jpg \
  --dtime "2026-09-15 12:00"            # 定时发布（可选，需晚于现在4小时）
```

- 分区默认 138（生活-搞笑）；自制二创默认 `--copyright 1`
- ⚠️ 这走的是网页端投稿接口（非官方开放API），**保持人类频率日更没事，别批量灌水**，账号有风控风险
- **视频号**：微信没有个人上传 API，社区方案是 [social-auto-upload](https://github.com/dreammis/social-auto-upload)（Playwright 模拟网页操作，扫码登录）。比 B站脚本风险高（微信风控更严），建议手动上传视频号、自动化只留给 B站

- **视频号**：微信没有个人上传 API（只有企业电商接口，逆向协议有封号风险）。用 `npm run pack -- <yaml>` 打素材包到 `output/V1/`（成片 + 封面 + metadata.json：短标题/描述/标签），手动上传到 [视频号助手](https://channels.weixin.qq.com)，或交给 [social-auto-upload](https://github.com/dreammis/social-auto-upload) 之类的工具消费

## 操作手册（Skill）

完整流程（做一集 → 调数值 → 配音 → 渲染 → 验收 → 投稿/打包）沉淀在 `skills/douququ-publish/`，
已同步到 `My_Work/.agents/skills/` 供 ZCode 自动发现；`references/pitfalls.md` 是踩坑清单（改引擎代码前必读）。

## 解说配音（TTS）

两条通道都接好了，凭据放 `.aksk`（已 gitignore）：

```bash
npm run tts -- public/episodes/ep001-tony-vs-boxer.yaml          # MiniMax（.aksk 第 1 行 = API Key）
npm run tts -- public/episodes/ep001-tony-vs-boxer.yaml --volc   # 火山豆包（.aksk「火山」段 = 访问令牌行 + 数字 AppID 行）
```

- 流程：跑一遍确定性对局收集全部解说词（含反转触发的动态字幕）→ 逐行调 TTS（按文案哈希缓存，重渲染不重复计费）→ 写 manifest → 渲染时按「模拟时间→视频时间」重映射混入音轨，**字幕停留时长自动对齐语音**
- 剧本里配 `narration:` 可换音色/语速/情感/音量；火山默认音色 `BV002_streaming`（通用男声），换 `BV001_streaming` 为女声，更多音色见控制台「音色管理」
- MiniMax 余额不足会报 1008；火山报 3001 说明对应应用没开通语音合成服务

## 音效

- 素材：[Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds)（CC0，可商用免署名）已转 44.1kHz mono WAV 放在 `public/sfx/`
- 换素材：丢同名 wav 进 `public/sfx/`，在 `index.json` 里登记 `音效名 → 文件名`；也可换 [Freesound CC0](https://freesound.org/)、[爱给网 CC0 分类](https://www.aigei.com/sound)（注意逐条确认授权，NC 协议不可商用）
- 出片：CLI 按帧记录「模拟时间 ↔ 视频时间」映射（慢放期间两者有偏差），把音效事件重映射到视频时间轴后混成一条 WAV，ffmpeg 与画面合成（`--mute` 可关）

## 技术要点

- **确定性**：固定 1/60s 逻辑步长 + mulberry32 seeded RNG，同 seed 逐帧一致 → `--dry` 调完数值直接出片，所见即所得
- **随机流隔离**：物理 RNG 与 Lua/音效演出 RNG 分离，改变音效、粒子或演出脚本不会偷偷改变胜负
- **伤害零随机**：damage = round(atk × Π增益固定倍率 × 连击/技能倍率)，同一状态每一刀数字恒定；
  暴击 = 连击序列的大拍（角色抽象见 `src/core/fighter.ts`），随机性只存在于走位（物理层面）
- **球形物理**：转向力追逐 + 冲量弹性碰撞（球-球 e=0.72 / 球-墙 e=0.78）+ 击退冲量，走位随机性来自物理而非随机数
- **同构渲染**：模拟与绘制纯函数化，浏览器（预览/录制）与 `@napi-rs/canvas`（无头出片）共用一套代码
- **出片**：Node 无头逐帧 → RGBA 管线喂 ffmpeg（@ffmpeg-installer 自带二进制，无需系统安装）→ H.264 mp4 + AAC 音轨
- 30s 成片（含混音）渲染 ~15s

## Roadmap（按 ROI 排序）

- [x] TTS 配音（✅ 已接入：MiniMax T2A + 火山引擎豆包语音，`npm run tts` 生成、渲染自动混音、字幕对齐语音时长）
- [x] BGM 音轨（✅ 程序化合成 chill 循环垫乐 `public/bgm/`，解说期间自动闪避；剧本 `bgm:` 可换素材/调音量）
- [ ] 剧本模板库（碾压局/绝地翻盘/大乱斗/援军局）
- [ ] 上传图片生成角色（参考 GrabBrawl 的确定性角色生成）
- [ ] 横屏 B站 版导出
