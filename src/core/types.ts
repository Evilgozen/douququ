/** 剧本数据结构（Episode Schema）与运行时类型 */

export interface SkillDef {
  /** 技能名，会以弹窗形式演出 */
  name: string;
  /** 触发间隔（秒，战斗内时间） */
  every: number;
  /** 本次攻击的伤害倍率 */
  multiplier: number;
  /** 命中后为自己回复最大生命值的百分比（0.5 = 50%） */
  healPct?: number;
  /** 触发时为自己叠加护盾（最大生命值的百分比） */
  shieldPct?: number;
}

/** 武器：角色特色攻击（警棍/公文包…）。伤害固定、可预期，出手独立于连击序列 */
export interface WeaponDef {
  name: string;
  /** melee = 近战范围直击（如警棍）；projectile = 飞行道具（如公文包） */
  kind: 'melee' | 'projectile';
  /** 固定伤害基数（× wielder 增益倍率 = 最终伤害） */
  damage: number;
  /** 冷却秒 */
  every: number;
  /** 投射物飞行速度 px/s（projectile 必填） */
  speed?: number;
  /** 抛物线飞行（视觉），缺省直线 */
  arc?: boolean;
  /** 额外伤害倍率，缺省 1 */
  mult?: number;
  /** 击退倍率（缺省 1）：如大脚踹 5 = 击飞距离约 5 倍 */
  knockback?: number;
  /** 近战触发距离 = 角色range × 此倍率（缺省 1.7）；大脚踹这类长腿招可给 2.0+ */
  reachMult?: number;
}

/** 外卖轮盘的菜单项：按顺序轮转投掷，伤害由外卖类型决定（全部固定值） */
export interface TakeoutItem {
  name: string;
  /** 命中固定伤害（× wielder 增益倍率） */
  damage: number;
  /** 命中减速：持续秒（缺省不减） */
  slowSec?: number;
  /** 减速到的速度倍率（缺省 0.75） */
  slowMult?: number;
  /** 专属投掷物素材（public/ 下路径，如 sprites/item-hotpot.png），缺省画外卖袋 */
  sprite?: string;
}

/** MP4 预处理成透明帧序列和 WAV；播放与命中共用模拟时间。 */
export interface MemeSkillDef {
  name: string;
  trigger: 'timer' | 'collision';
  every: number;
  initialCooldown: number;
  duration: number;
  hitAt: number;
  damage: number;
  range: number;
  framePrefix: string;
  frameCount: number;
  fps: number;
  sound: string;
  effect?: { kind: 'eggs' | 'clones'; sprite?: string; launchTimes: number[]; speed: number; cloneGrowth?: boolean };
}

export interface FighterDef {
  id: string;
  name: string;
  /**
   * 行动策略（缺省 chase）：
   * - chase  追踪对手：拦截预判 + 近身出刀（近战默认）
   * - random 随机运动：定时换向的混乱游走 + 边墙内推（远程/混乱系）
   * - flee   躲避对手：被靠近就反向拉开，拉开足够距离后缓慢游走（风筝流）
   * - manual 仅 RL 接管时使用（YAML 里不允许写），移动/出招由外部指令控制
   */
  behavior?: 'chase' | 'random' | 'flee' | 'manual';
  /** 连击序列（确定性暴击）：如 [1, 1, 1, 2.2]，轮转出招；≥1.5 的拍子按暴击演出 */
  combo?: number[];
  /** 球体半径 px（缺省 64） */
  radius?: number;
  /** 特色武器：独立冷却，不消耗连击 */
  weapon?: WeaponDef;
  /** 大脚踹击演出：出手时脚迅速放大并前伸踹击（奶娃） */
  kickFx?: boolean;
  /** 大脚踹击专属素材（public/ 下路径，脚尖朝右画）；缺省用程序化拼的卡通脚 */
  kickSprite?: string;
  /** 身后毒气：定时在自己身后放毒气云，敌人入云按固定间隔掉血 */
  gasTrail?: {
    /** 间隔秒 */
    every: number;
    /** 云半径 px */
    radius: number;
    /** 云存活秒 */
    dur: number;
    /** 每 tick 固定伤害（× 出云时自身增益倍率） */
    damage: number;
    /** 掉血间隔秒，缺省 0.5 */
    tick?: number;
  };
  /** 骑车冲刺：加速并加密毒气，dur 秒后必定摔倒（固定自伤 + 眩晕） */
  bikeRush?: {
    /** 冷却秒 */
    every: number;
    /** 首次触发延迟秒，缺省 3 */
    delay?: number;
    /** 骑行期间速度倍率 */
    speedMult: number;
    /** 骑行秒数（到点摔倒） */
    dur: number;
    /** 骑行期间毒气间隔秒（覆盖 gasTrail.every） */
    gasEvery: number;
    /** 摔倒固定自伤 */
    crashDamage: number;
    /** 摔倒眩晕秒 */
    crashStun: number;
  };
  /** 外卖轮盘：按菜单顺序轮转投掷，命中弹窗显示外卖名 */
  takeout?: {
    /** 出手间隔秒（受增益 intervalMult 影响：爆单模式=派单更快） */
    every: number;
    /** 投掷飞行速度 px/s，缺省 460 */
    speed?: number;
    items: TakeoutItem[];
  };
  /** 可选：public/ 下的 PNG 素材路径（如 "sprites/tony.png"），缺省用程序化简笔角色 */
  sprite?: string;
  memeSkill?: MemeSkillDef;
  /**
   * 状态立绘：单位进入对应状态时替换主素材（路径写法同 sprite）。
   * 提供对应状态素材时，该状态的程序化演出（单车/摔倒旋转）自动关闭
   */
  stateSprites?: {
    /** 骑车冲刺中（bikeT > 0），如奶娃骑单车立绘 */
    bike?: string;
    /** 摔倒眩晕中（stunT > 0），如奶娃摔倒立绘 */
    stun?: string;
    /** 护盾吸收伤害后的短暂格挡姿势 */
    block?: string;
    /** berserk/revive 反转触发后的持续状态立绘 */
    berserk?: string;
  };
  /** 阵营主色，缺省按左右侧给默认色 */
  color?: string;
  hp: number;
  atk: number;
  /** 简明对战的固定防御；普通攻击伤害 = max(0, 攻击力 - 防御力) */
  defense?: number;
  /** 沿运动轨迹铺轨；duration 是参考车身的通过时间，实际速度由 speedMultiplier 调整 */
  trainTrail?: { every: number; duration: number; damage: number; cars?: number; carGap?: number; speedMultiplier?: number; referenceCars?: number; fadeSeconds?: number };
  /** 蓄力后追踪突刺，命中固定伤害 */
  dashStrike?: { every: number; charge: number; duration: number; damage: number };
  /** 超速期定时留下残影；残影延迟后追击，实体依旧会被列车撞击 */
  speedEcho?: { every: number; initialCooldown?: number; active: number; speedMultiplier: number; echoEvery: number; releaseEvery: number; hitRadius: number; damage: number; maxEchoes: number };
  /** 攻击间隔（秒） */
  atkInterval?: number;
  /** 移动速度 px/s */
  speed?: number;
  /** 攻击距离 px */
  range?: number;
  critChance?: number;
  critMultiplier?: number;
  skills?: SkillDef[];
}

export type TwistTrigger =
  | { hpBelowPct: number; fighter?: string }
  | { timeAt: number; fighter?: string }
  | { fighterDead: string };

export type TwistEffect =
  | {
      type: 'berserk';
      atkMultiplier?: number;
      intervalMultiplier?: number;
      speedMultiplier?: number;
      healPct?: number;
      shieldPct?: number;
      /** 增益持续：按命中数（缺省无限） */
      durationHits?: number;
      /** 增益持续：按秒（缺省无限） */
      durationSec?: number;
    }
  | {
      type: 'revive';
      hpPct?: number;
      atkMultiplier?: number;
      intervalMultiplier?: number;
      speedMultiplier?: number;
      shieldPct?: number;
      durationHits?: number;
      durationSec?: number;
    }
  | { type: 'statMultiply'; atkMultiplier: number; targets?: 'self' | 'all' | 'enemy' }
  | { type: 'shield'; hpPct?: number }
  | { type: 'heal'; hpPct?: number }
  | { type: 'reinforce'; fighter: FighterDef; side?: 0 | 1; count?: number };

export interface TwistDef {
  trigger: TwistTrigger;
  /** 纯解说型反转可省略（只出横幅/字幕） */
  effect?: TwistEffect;
  /** 默认 true：每条反转只触发一次 */
  once?: boolean;
  /** 屏幕中央大字横幅 */
  banner?: string;
  /** 随反转插入的解说字幕（金色） */
  caption?: string;
  /** 慢动作时长（秒，真实时间），0/缺省不慢放 */
  slowmo?: number;
}

export interface CaptionDef {
  /** 全局时间轴秒（含开场 VS 卡，战斗约在 4.4s 开始） */
  t: number;
  text: string;
  /** 持续秒数，缺省 3 */
  dur?: number;
}

export interface Episode {
  id: string;
  title: string;
  subtitle?: string;
  seed: number;
  /** readable：固定站位、固定出手节拍、单一普攻伤害公式；新剧本默认 readable */
  combat?: { mode: 'readable' | 'arcade'; movement?: 'stationary' | 'bounce' };
  /** 至少 2 名：index 0 为左侧（红方），index 1 为右侧（蓝方） */
  fighters: FighterDef[];
  twists?: TwistDef[];
  captions?: CaptionDef[];
  /** 战斗时限（秒），到时双方存活则触发"突然死亡" */
  timeLimit?: number;
  /** 结算画面停留秒数，缺省 4.6 */
  endDuration?: number;
  /** 突然死亡时全体攻击倍率，缺省 8 */
  suddenDeathAtkMultiplier?: number;
  /** 演出脚本（public/scripts/<name>.lua），缺省 "default" */
  script?: string;
  /** 音频：sfx 总音量 */
  audio?: { volume?: number };
  /** 解说配音。跑 `npm run tts -- <yaml>` 生成后渲染自动混入并对齐字幕 */
  narration?: {
    /** 'minimax'（默认）、'volc'（经典）或 'volc-v3'（豆包语音合成 2.0） */
    provider?: string;
    voice?: string;
    model?: string;
    speed?: number;
    pitch?: number;
    vol?: number;
    emotion?: string;
    /** 配音轨音量，缺省 1 */
    volume?: number;
  };
  /** 球体物理参数（缺省见 sim.ts） */
  physics?: {
    /** 球-球弹性 0..1 */
    restitution?: number;
    /** 球-墙弹性 0..1 */
    wallRestitution?: number;
    /** 碰撞后分离驱动时长（秒），期间追逐被抑制、按分离加速度弹开 */
    separationTime?: number;
    /** 分离加速度 px/s² */
    separateAccel?: number;
    /** 开战初速度 px/s */
    initialSpeed?: number;
    /** 击退系数（0 = 纯数值对决不击飞，缺省 1） */
    knockback?: number;
  };
  /** BGM 垫乐（缺省开启，public/bgm/chill-loop.wav；vol:0 关闭） */
  bgm?: {
    /** public/ 下的音频文件，缺省 bgm/chill-loop.wav */
    file?: string;
    /** 基础音量，缺省 0.9 */
    vol?: number;
    /** 解说期间压到的倍数，缺省 0.3 */
    duckTo?: number;
  };
  /** 地图机关：中央弹板 / 加速带（缺省无机关的空场） */
  arena?: {
    bumpers?: Array<{ x: number; y: number; r: number }>;
    boostZones?: Array<{ x: number; y: number; w: number; h: number }>;
  };
  /** 发布配置：渲染完自动出封面 + 生成一条可复制的投稿命令 */
  publish?: {
    title?: string;
    /** 短标题：视频号等平台的展示标题（建议 ≤16 字），缺省从 title 截取 */
    shortTitle?: string;
    desc?: string;
    tags?: string[];
    /** B站分区，默认 138（生活-搞笑） */
    tid?: number;
    /** 取该秒的帧做封面，缺省全片 40% 处 */
    coverAt?: number;
    /** 定时发布 "YYYY-MM-DD HH:MM"（需晚于现在 4 小时以上） */
    dtime?: string;
  };
}
