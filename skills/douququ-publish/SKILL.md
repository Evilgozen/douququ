---
name: douququ-publish
description: 电子斗蛐蛐视频从制作到投稿的全流程操作手册。凡是要做一集新视频、改剧本调数值、看 dry 战报、TTS 配音、渲染成片、视觉验收、投稿 B 站、打视频号素材包，或者用户提到"斗蛐蛐/做一集/投稿/调数值/render/dry/tts/视频号"时都用这个 skill。项目在 My_Work/douququ/。
---

# 电子斗蛐蛐：制作 → 投稿全流程

一条流水线：剧本 YAML → 确定性战斗模拟（球形物理）→ 1080×1920 竖屏成片（配音+音效）→ B 站投稿 / 视频号素材包。

## 前置认知

- 工作目录一律在 `douququ/`（所有 npm script 在这里跑）
- **核心资产是确定性**：固定 1/60s 步长 + seeded RNG，同 seed 重放逐帧一致。调数值全靠 `--dry` 战报，不要靠肉眼反复渲染
- 剧本 = `public/episodes/*.yaml`，字段 schema 和示例看 `public/episodes/ep001-tony-vs-boxer.yaml` 与 README
- 已知深坑清单在 `references/pitfalls.md`——**改引擎代码前必读**，里面每个坑都真实踩过

## 一、新建一集（剧本）

1. 复制一份已有 YAML 当模板，改 `id`（英文，是文件名/导出名）、`title`、`seed`（新题材换新 seed）
2. 结构模板（抖音 30-45s 节奏）：
   - **绝望期 5-10s**：弱者挨打，字幕铺垫"正常人都觉得TA没了"
   - **反转**（`twists:`）：残血 `hpBelowPct` 触发 `berserk`，或 `fighterDead` 触发 `revive`（复活保险丝，输出倍率要给够，见 ep001 的 180）
   - **融化期**：强 buff 碾压，倍率徽章 x 几百几千随便打
   - `captions:` 是解说词（也是 TTS 台词），一行一句钩子
3. 数值差异要极端（100 倍起步才有戏剧性）；音色/语速在 `narration:`，发布信息在 `publish:`（含视频号短标题）

## 二、数值调试循环（dry 战报）

```bash
npm run render -- public/episodes/xxx.yaml --dry
```

战报看四件事，不达标就改 YAML 再跑（同 seed 结果不变，可无限迭代）：

| 指标 | 目标 | 不达标调哪里 |
|---|---|---|
| 全局时长 | 25-45s（成片还要加慢放拉伸 ~1-2s） | 弱方 buff 倍率（调快融化）/ 强方 atk（调绝望期） |
| 反转时刻 | 绝望期 5-10s 触发 | `hpBelowPct` 阈值、弱方回血技能间隔 |
| 胜负 | 符合剧本意图 | 双方 atk/hp/buff 倍率；突然死亡局看触发后竞速差 |
| `状态(hyped=1)` | 应出现 | 没出现 = 碰撞太少，看 references/pitfalls.md 轨道死锁 |

## 三、配音

```bash
npm run tts -- public/episodes/xxx.yaml --volc    # 火山豆包（.aksk 火山段）
npm run tts -- public/episodes/xxx.yaml           # MiniMax（.aksk 第 1 行）
```

- 解说词 = 全部字幕（含反转动态字幕），按哈希缓存，改一句只合成一句
- 报 1008 = MiniMax 没余额；报 3001 = 火山应用没开通语音合成；报 1004 = key 错
- 音色/语速在剧本 `narration:` 里配（volc 默认 `BV002_streaming` 通用男声）

## 四、渲染出片

```bash
npm run render -- public/episodes/xxx.yaml
```

- 自动混音效+配音、自动出封面（有 `publish:` 配置时）、自动打印 B 站投稿命令
- ⚠️ **视频时长 = 模拟时长 + 慢放拉伸**，抽帧/卡点按视频时间轴算（README 有说明）

## 五、视觉验收（本项目惯例，别跳过）

```bash
# 抽 6-13 张关键帧（开场/碰撞/反转/结算卡）
ffmpeg -ss <t> -i exports/xxx.mp4 -frames:v 1 frames/xxx-t<t>.png
```

然后派 judge 子代理 Read 帧并给 verdict（pass/fail + 证据）。历史上 judge 抓出过：数字压名牌、字幕残留结算卡、变焦出画、满血环缺色。一过性演出（闪白/慢放淡入/横幅闪现）记 minor 不作为 fail 依据。

## 六、B 站投稿

```bash
npm run login:bili     # 仅首次：扫码，cookies.json 长期有效
npm run publish:bili -- exports/xxx.mp4 --title "..." --tags "..." --tid 138 --cover exports/cover-xxx.jpg
```

- 渲染完打印的投稿命令可直接复制执行
- 403/352/非 JSON → 大概率是接口参数或设备指纹问题，看 references/pitfalls.md 的 B 站段
- 风险红线：日更频率可以，批量灌水不行（非官方接口，账号风控）

## 七、视频号素材包

```bash
npm run pack -- public/episodes/xxx.yaml            # → output/V1/
npm run pack -- public/episodes/xxx.yaml --out output/V2
```

产出 `<id>.mp4 + cover.jpg + metadata.json`（shortTitle ≤20 字 / desc / tags）。视频号**没有个人发布 API**（只有企业电商接口，逆向协议有封号风险），所以这一步是手动上传到 channels.weixin.qq.com。

## 什么时候改代码 vs 改剧本

- **改剧本 YAML**：数值、台词、反转、发布信息——90% 的需求在这层
- **改引擎**：只有出现"这类内容做不出来"时（如需要新反转类型、新演出元素）。改前必读 `references/pitfalls.md`，改完必须 dry 两个现有剧本确认没劣化（ep001/ep002 的时长和胜负是回归基线）
