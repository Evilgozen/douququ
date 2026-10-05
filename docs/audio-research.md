# 配音与战斗音效调研

调研日期：2026-10-04。本文区分代码审计结论、官方能力和建议；未调用付费合成、未完成音色试听，音质优劣需用本项目文案做 A/B 验证。

补充：国内方案已核实 Seed Audio 1.0 的独立音频创作能力和 MiniMax H3 的原生音视频生成能力；猫 meme 素材整理者及网盘入口见 [国内音效与猫 meme 调研](domestic-audio-and-cat-meme.md)。

## 结论与推荐路线

先修复采样率与字幕同步，再选择解说音色。通用打击声用现成素材，停时等特色技能用离线合成补足；生成完成后挑选、剪辑并缓存为本地音效，播放由确定性战斗事件触发。

推荐组合：豆包语音合成 2.0 做中文解说 + Kenney CC0 补通用音效 + Sonniss GDC 或 Freesound CC0 补机械/破空声。特殊技能优先试 ElevenLabs Sound Effects；需要本地生成时再评估 Stable Audio Open 的设备和授权条件。

## 1. 当前实现与已经修复的问题

### 当前接入

- `src/tts/volc.ts` 使用 `/api/v1/tts`，`src/cli/tts.ts` 固定传 `volcano_tts`，不是明确选择 `seed-tts-2.0` 的 v3 接入。
- 第 14 期配置 `BV002_streaming`，基础语速 0.55。需要换接口、对应资源与音色，单改名为“2.0”不会升级模型。
- 金色字幕默认加速到基础语速的 1.18 倍，会使反转行和普通行的说话节奏不同。
- 当前工作树没有 `public/tts` 配音缓存（该目录被 git 忽略），因此不能据此认定用户现有音频的实际采样率，也不能完成旧成片听感复现。

### 已修复：离线重采样和时长估算

原混音函数按输入采样向输出数组写入，却使用 `sourceRate / outputRate` 作为位置步长，方向不对，也会造成采样重叠或空洞。24kHz 的一秒音频混入 44.1kHz 音轨时，原逻辑只占约 0.296 秒；这可以导致声音加速、变调和字幕仍然停留。

现在按输出采样读取输入，使用线性插值；配音保留原时长、音高，音效的 rate=2 正确缩短到半秒。这是基础重采样修复，尚未实现高质量抗混叠滤波。

TTS 时长不再使用 `(文件长度 - 44) / 2 / 44100` 的假设，改为解析 WAV 的 data 块和采样率。缓存命中与渲染已有清单时也重新计算实际时长，不需要为修正时长重新付费合成。

检查：`npm run check:audio` 覆盖 16/24/44.1/48kHz 的时长、幅度、升采样空洞、440Hz 音高与两倍速。

### 尚待修复：时间轴与预览播放

1. 浏览器 `src/ui/main.ts` 默认 `speed=2`，字幕/模拟推进更快，配音却用 rate=1。倍速、暂停、重启或换剧本时，已播放的声音也没有统一的暂停/停止管理。
2. 导出 `syncCaptions` 把音频秒数直接作为模拟时间字幕时长；配音起点则映射到视频时间。慢放时字幕持续时间和音频持续时间不是同一个尺度。
3. 只在渲染初始化时修改已存在字幕，运行中新增字幕没有统一同步；TTS 采集按文本去重，也会漏掉同文案的重复事件。
4. 两条字幕过近时，新字幕会覆盖前一条，配音没有重叠检查。整行停留不等于逐字/分句对齐。

建议输出一个共享的 narration schedule，记录 `cueId / text / videoStart / audioDuration / words / gain`。字幕、人声、BGM ducking 一起消费最终视频时间表。动态字幕使用时间与事件 ID，不能只按文本去重。无字级时间戳时先保证分句级起止一致。

倍速预览需要一个统一播放时钟；建议先默认 1 倍速。语音倍速若直接使用 WebAudio playbackRate 会改变音高，保音高倍速需要额外的时间伸缩方案。暂停和重启应停止或重建正在播放的节点。

不要通过持续压缩整段配音来挤进字幕窗口。先缩短文案、合理分句和安排解说时机；必要的音频变速必须同步修改字幕时间戳。结算清除字幕时也要明确未播完解说的截断或收尾策略。

## 2. 火山配音升级

官方 v3 支持选择豆包语音合成 2.0。资源 ID 为 `seed-tts-2.0`，须使用该模型对应音色；不能沿用经典音色并假定自动获得新模型效果。[官方 WebSocket 文档](https://docs.volcengine.com/docs/DoubaoVoice/WebSocketBidirectionalStreaming-V3?lang=zh)

对于离线短句出片，可选 HTTP 单向流式 `/api/v3/tts/unidirectional`，一次提交文案并收集返回音频。当前 HTTP 文档列出 `X-Api-Key`、资源 ID 与请求 ID；不能把现有 v1 的 `Bearer;token` 原样搬过去。账号是否已开通资源、凭证能否使用尚未验证。[官方 HTTP 文档](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh)

双向流式文档区分 standard 与 expressive：standard 延迟更优，expressive 表现力较强且支持更多语音指令，但官方提示存在效果抽卡。离线出片适合在支持的接口和音色上评估 expressive 的情绪效果并保存选定结果，不能据此直接断言其音色最好。文档的 `enable_timestamp` 可返回字级时间戳；选定接入方式后须验证返回格式以及所用音色的支持情况。[官方能力说明](https://docs.volcengine.com/docs/DoubaoVoice/WebSocketBidirectionalStreaming-V3?lang=zh)

实施顺序：

1. 增加独立的 `volc-v3` provider，保留旧 provider；明确配置 resource、model、speaker、speech_rate 和时间戳开关。
2. 从官方音色列表/控制台筛选 3 个中文解说音色，使用同一组战斗文案试听。不要凭音色名字决定最好听的方案。[ListSpeakers](https://api.volcengine.com/api-docs/view?action=ListSpeakers&serviceCode=speech_saas_prod&version=2025-05-20)
3. 用“蓄力 1 秒”“固定 165”“斯安威斯坦”等短句检查数字、专名、情绪、自然停顿和可理解性；先使用接近自然的语速，再比较兴奋片段。
4. 缓存键纳入接口版本、模型、资源、音色、语速、情绪与文案；manifest 保存实际时长、采样率和字级时间戳。升级音色后不能命中旧模型缓存。
5. 流式 PCM 统一包装为合法 WAV，避免简单拼接多段 WAV 头；音频与时间戳属于同一次合成结果，后期裁切或变速也要一起变换。

## 3. 音效来源比较

| 来源 | 适合本项目的用途 | 成本/接入 | 授权与限制 |
| --- | --- | --- | --- |
| [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds) / [Sci-fi Sounds](https://kenney.nl/assets/sci-fi-sounds) | 肉感打击、金属撞击、电子启动等 | 免费素材，离线 WAV | CC0，可商用免署名；项目已经使用 Impact Sounds，继续扩充比换平台更直接 |
| [Sonniss GDC](https://sonniss.com/gameaudiogdc/) | 机械、列车、破空、电影化冲击 | 免费大体积素材包，挑选成本较高 | 可用于商业成片、免署名；不可把素材作为音效库再分发，不能用于训练/增强 AI；非 CC0，保存下载日许可 |
| [Freesound](https://freesound.org/help/faq/) | 列车实录、刀刃、环境和零散补充 | 下载后离线处理，逐条筛选 | 优先 CC0；CC BY 要署名；CC BY-NC 不用于商业出片，不能把整站称为可商用库 |
| [ElevenLabs Sound Effects](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert) | 停时启动、时空恢复、科幻残影、独特技能音色 | 在线付费生成 API，指定文本/时长，可支持循环 | 免费计划无商用许可；付费计划通常包含商业许可，Beta 与服务专项条款需核对 |
| [Stable Audio Open 1.0](https://huggingface.co/stabilityai/stable-audio-open-1.0) | 离线实验、特色音效和音景 | 本地模型，需评估 GPU、显存和速度；英文 prompt 更适合 | 最长 47 秒、44.1kHz 立体声；不是无限制开源，按具体社区许可注册及收入条件使用 |
| [TangoFlux](https://huggingface.co/declare-lab/TangoFlux) | 文本到音频研究和对比 | 开放权重，最长 30 秒 | 模型卡明确为非商业研究用途，不作为商业出片默认依赖 |
| [Sony Woosh](https://github.com/SonyResearch/Woosh) | 文本/视频生成音效的研究对比 | 公开代码与权重 | 代码 MIT/Apache，开放权重 CC BY-NC；不能把代码许可当成模型商用许可 |

许可证依据：[Kenney FAQ](https://kenney.nl/support)、[Sonniss GDC 许可](https://sonniss.com/gdc-bundle-license/)、[ElevenLabs 商用说明](https://help.elevenlabs.io/hc/en-us/articles/13313564601361-Can-I-publish-the-content-I-generate-on-the-platform)、[Stable Audio Open 随模型许可](https://huggingface.co/stabilityai/stable-audio-open-1.0/blob/main/LICENSE.md)。Stable Audio Open 许可列出商业使用注册要求，超过合计年收入 100 万美元需另行许可；不能只看模型名中的 Open。

以上是能力与授权调研，未完成素材试听、生成质量评测或项目实测延迟；不把生成音效描述为已达到某种音质。

## 4. 技能声音如何落地

目前 `public/scripts/default.lua` 有列车发车声、突刺命中声，残影命中走普通 attack 音效，列车命中复用 ko。没有各技能阶段的完整声音设计。`boost` 还复用玻璃敲击，与高速移动的声音语义不匹配。

| 机制 | 建议独立事件/音效 | 声音设计 |
| --- | --- | --- |
| 刺客 | charge_start、dash_release、dash_hit | 蓄力上升声 → 短促破空 → 肉感冲击；落空不播放命中层 |
| 列车 | train_depart、train_hit、train_end | 发车机械/汽笛 → 车轮滚动 → 撞击；滚动持续到实际离场，不能只放固定长度与列车时长无关的音频 |
| 停时 | time_stop_start、time_stop_end | 瞬态电子声加低频下沉 → 恢复脉冲；停时可压低环境层，让观众听出世界被冻结 |
| 残影 | echo_spawn、echo_hit、echo_miss | 生成轻短提示，命中明确冲击，落空只有消散；每 0.18 秒结算避免堆叠低频长尾 |
| 墙体/普通碰撞 | wall、collision | 较弱、短、按强度节流，避免掩盖真正伤害 |

新增事件应在确定性状态转换/伤害判定完成时发出，由 Lua 或音频编排层消费。声音随机选变体用独立演出 RNG，不能进入战斗决策。为每个技能规定 onset、尾音、增益、优先级、重复间隔与最大并发。80ms 节流目前只是保留先到的碰撞，不能称为自动选最重的一声。

打击音可以叠三层：瞬态脆响、低频主体、短尾音；优先通过音色、瞬态和动态空间制造重击感，避免只提高音量。先检查 SFX 峰值和人声可懂度，再决定是否让 BGM 在技能命中时短暂压低。

建议首次准备约 12 个明确用途的音效：轻/重/金属/墙体打击各一，蓄力、突刺破空、停时启动、停时恢复、残影命中、残影消散、列车发车和滚动。每项选 2–3 个候选，放进第 12–14 期短片比较。

生成提示词示例：`A single sharp sci-fi time-freeze activation, crisp electric snap with a short deep pulse, no voice, no music, dry isolated sound.` 生成后仍需人工挑选、裁掉开头静音，将瞬态对齐事件；模型生成的第一个采样不等于打击发生时刻。

保留 `public/sfx/index.json` 的别名兼容，增加独立素材清单记录 URL、作者、许可、原文件、处理方式、生成模型/prompt 与缓存 hash。标准化为当前混音器支持的 16-bit PCM WAV；它目前把立体声折为单声道，立体声空间效果需要后续扩展。Sonniss 等受限再分发素材应放本地忽略目录，不能直接作为公开仓库的公共素材分发。

## 5. 下一轮验收

- 字幕与实际语音起止在 1 倍速、慢放和动态字幕下同步；检查同文案重复事件、过长配音、相邻句重叠及结算截断。
- 浏览器 0.5/1/2 倍速的音画规则一致，暂停/重启/换剧本不会留下旧声音。
- 三个候选中文音色经过同文案试听并保存样例，确认资源开通和实际 API 成功后才切换默认。
- 技能释放、命中、落空声音可区分，伤害音效恰好对齐判定，技能变化不改胜负。
- `check:audio`、`typecheck`、三期战斗回归与 dry 战报；最终仍需试听导出成片验证听感。
