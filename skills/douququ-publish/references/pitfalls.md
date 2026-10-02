# 已知深坑清单（改代码前必读）

每一个都是实际踩过、用 judge 验收或 dry 战报实锤过的。按层分类。

## 战斗引擎（src/core/sim.ts）

### 攻击冷却必须全程走表
冷却 `atkTimer` 要在每步递减、进攻击距离时才判出手。如果反过来（进距离才倒数），
碰撞弹开会让每次接触窗口只有 2-3 帧（0.05s），冷却永远攒不满 → 一场 220 秒只出手 3 次。

### 互追死锁轨道
两球互相追逐时可能陷入稳定绕圈：转向半径 v²/a（340²/950≈122px）小于轨道半径（~137px），
物理上永远追不上，战斗拖到 300 秒+。修复 = 拦截预判（瞄准 target 位置 + `vx*0.35` 的预测量）
+ 抖动力随距离衰减（近距离 wobble=0）。改 chase 逻辑时别把这两个去掉。

### 攻击距离必须 ≈ 接触距离
`ATTACK_RANGE = BALL_R*2 + 8`。调大到 150+ 会导致双方站桩隔空互殴，
碰撞事件归零（Lua 的碰撞音效/状态转移全部失效），且节奏崩坏。

### 结算必须清场
进入 end 阶段时清空 `popups/banners/feed/captions`，否则击杀瞬间的演出残影会穿透结算卡。
连带坑：TTS 的解说词收集是"边跑边捕获"（cli/tts.ts 的 collectLines），
因为对局结束时 captions 已被清空。

### 数值差异要配输出倍率
弱者翻盘剧本里，觉醒后的 DPS 必须 ≥ 拳王血量 / (自身生存窗口)。
ep001 的教训：45× 觉醒在接触-弹开节奏下打不完 5.4 万血，翻盘失败；
最终用 150×（残血路径）/180×（复活路径）才在生存窗口内完成融化。
调完看 dry 战报的"最高单次 x 倍率"徽章数值是否合理。

## 慢放与时间轴（全局）

**视频时长 = 模拟时长 + 慢放拉伸**（每段 slowmo 让时间轴多花 ~0.78 倍时长）。
所有"视频里第 X 秒"的换算（抽帧、音频对齐、卡点）必须走 CLI 里逐帧记录的
timeMap（sim→video 插值），不能直接用模拟时间。B 站配音混音已处理，别破坏。

## 渲染（src/render/draw.ts）

- 名字内嵌在球内后，结算卡统计块必须带半透明底板（胜者球会漂到文字下方）
- HP 环 `pct >= 0.999` 要画整圆（skia 对 start==end+2π 的弧可能不渲染）
- 皇冠星在 drawEnd 里最后绘制（统计面板之上）；drawOverlays 里那份是死代码已删，别加回来
- 伤害弹窗：垂直贴身时往侧面放飞、水平时在单位上方散开——这是消灭"数字压名字"的方案，
  改回中心生成会复现 judge 第一轮的 7 帧遮挡

## TTS（src/tts/）

### 火山（volc.ts）
- 鉴权 = `Authorization: "Bearer;<AK>"`（**分号**，AK 即访问令牌）。AK/SK 生成 JWT 的方案
  实测返回 3001 "grant not found"，不可用
- 3001 的另一种含义：应用没开通语音合成服务（控制台开通并绑定 AppID）
- 返回的 wav 是 44.1kHz 16bit mono，`durMs = (字节数-44)/2/44.1`
- 封面接口（B站侧）收 **base64 data URI 表单字段 `cover`** 且必须先裁 16:10，
  multipart 文件上传会报 -400

### MiniMax（minimax.ts）
- 1008 = 余额不足；1004 = key 错
- 请求 `audio_setting.format: "wav"` + `output_format: "hex"`，响应 data.audio 是 hex

## B 站投稿（scripts/publish_bili.py）

- preupload 参数必须用客户端通道：`r=upos, profile=ugcupos/bup, version=2.8.12,
  build=2081200` + upcdn/probe_version。网页版通道 `ugcfx/b/0` 会 403（WAF HTML 页）
- member 域名对无 buvid 的请求 403：先 GET `api.bilibili.com/x/frontend/finger/spi`
  领 buvid3/buvid4 写进 cookie
- upos 上传是三步：`?uploads&output=json` 拿 upload_id → 分片 PUT（带
  uploadId/chunks/total/chunk/size/partNumber/start/end 参数）→ POST 合并（params 带
  name/uploadId/biz_id/output/profile，body 是 parts 清单）。单次 PUT + output=json 会
  MethodNotAllowed
- endpoint 可能是 `//host` 协议相对格式，拼 URL 时注意
- 扫码登录端点必须 https（http 会 307，urllib 直接抛错）
- cookies.json 含 SESSDATA/bili_jct 等同账号凭据，已 gitignore，别泄露、别提交

## 版权与安全红线

- 角色素材用自绘/AI 生成（`sprite:` 槽位），不用真人抠图和版权角色
- 克隆真人声音（如"峰哥"）商用需本人授权，默认用平台预置解说音色
- B 站投稿走非官方接口：日更频率 OK，批量灌水会触发风控

## 特效与机关（2026-09 新增批次）

- **场地面板高 1114px，任何 >1.06 的变焦必然出框**（1080x1920 画布在标题/HUD 之间只留 ~1200px）。
  慢放/击杀镜头变焦上限 1.06，焦点 y 钳制在 926-944（几何推导值，别凭感觉调）
- 弹窗出生点在 mkPopup 里统一钳制（x 170-910 / y 200-1480），另有 avoidOverlap 同点错位——
  新弹窗类型记得走 mkPopup，别直接 push 对象
- 火山经典 volcano_tts HTTP **不支持 volume_ratio**（报 3031 unmapped key）。
  音量变化在混音层做：tts.ts 把每行 vol 写进 manifest，render.ts 混音时应用
- 地图机关参数：弹板弹性 1.8 + 额外冲量 180（冷却 0.25s）；加速带冲量 430（冷却 0.7s）。
  弹板多了会显著拖慢节奏（ep003 初版 357s 教训），新机关剧本务必 dry 验证时长
- 互追死锁轨道已修（拦截预判 lead 0.35 + 抖动随距离衰减），改追逐逻辑时保留这两点

## 角色抽象与确定性伤害（2026-09 二批）

- 角色抽象在 `src/core/fighter.ts`：Fighter 管出招（连击序列/技能冷却/增益），Unit 只管肉体。
  **别再把战斗逻辑写进 Battle 或直接改 Unit 乘数**——增益一律走 `fighter.addBuff(StatusEffect)`
- 伤害管线零随机：`round(atk × Πbuff × 节奏倍率)`。新增随机源前先想清楚"观众能不能推理出这个数字"
- 连击序列 `combo: [1,1,1,2.2]` 轮转出招，≥1.5 的拍子按暴击演出；技能拍不消耗连击游标
- StatusEffect 持续二选一：remainingHits（按刀）或 remainingTime（按秒），-1 = 无限；
  叠加是乘法链，施加顺序即结算顺序
- 改数值后必 dry：随机暴击移除后各集节奏整体偏移过一次（ep003 曾 357s 的教训同类），
  重点核对绝望期时长与突然死亡局的先手顺序
