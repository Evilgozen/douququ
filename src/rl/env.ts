/**
 * 强化学习环境：Gymnasium 风格 API（reset / step 五元组），纯 TS headless。
 *
 * 为什么这么做（调研结论见 docs/rl.md）：
 * - Gymnasium 的 reset(seed)→(obs, info)、step(action)→(obs, reward, terminated,
 *   truncated, info) 是事实标准；Python 侧训练生态（SB3/CleanRL/PettingZoo）都认它。
 * - JS 生态没有活跃的 Gym 兼容库（gym.js / RL.ts 均年久失修），所以这里原生实现
 *   同构 API：引擎本身是确定性固定步长模拟，天然适合 RL——同 seed 同动作序列
 *   逐帧一致，可复现实验。
 *
 * 接管方式：被控单位走 behavior='manual' 通道（Unit.cmd），移动 = 动作前两维，
 * 出招意图 = 第三维（autoAttack 时忽略）。对手照剧本 behavior（chase/random/flee）
 * 行动，当作 scripted 对手。战斗数值零随机（确定性伤害），随机性只在物理扰动，
 * 因此 reward 信号干净：输赢完全归因于走位策略。
 */
import { Battle, LOGIC_DT, MAX_SPEED, W, H, type Unit } from '../core/sim';
import type { Episode } from '../core/types';

export interface SpaceInfo {
  type: 'Box';
  shape: number[];
  low: number[];
  high: number[];
}

export interface EnvInfo {
  /** 战斗已进行秒数 */
  fightT: number;
  /** 胜方（0/1），未结束为 null，-1 平局 */
  winner: -1 | 0 | 1 | null;
  ownHp: number;
  enemyHp: number;
  /** 敌方总最大血量（算打掉百分比用） */
  enemyMaxHp: number;
  /** 本步对敌方造成的有效伤害（含护盾吸收） */
  dmgDealt: number;
  /** 本步受到的有效伤害 */
  dmgTaken: number;
  /** 决策步计数 */
  steps: number;
  seed: number;
}

export interface StepResult {
  obs: number[];
  reward: number;
  terminated: boolean;
  truncated: boolean;
  info: EnvInfo;
}

export interface RewardWeights {
  /** 打掉敌方总血量 1% 的奖励（默认 2，整局打满 ≈ +2） */
  dmgDealt: number;
  /** 损失自己总血量 1% 的惩罚（默认 -2） */
  dmgTaken: number;
  /** 终胜奖励（默认 +10） */
  win: number;
  /** 终负惩罚（默认 -10） */
  lose: number;
  /** 每决策步时间惩罚（默认 -0.005，90s×10Hz ≈ -4.5），防止拖延 */
  timePenalty: number;
}

export interface EnvOptions {
  /** 被接管的 fighter id（YAML 里的 id 字段；其余角色照剧本 behavior 行动） */
  controlledId: string;
  /** 每个动作推进的逻辑步数（60=1秒/动作；默认 6 → 10Hz 决策） */
  frameSkip?: number;
  /** 出招全自动（true 时动作只剩移动；false 时 action[2]>0 才出手）。默认 true */
  autoAttack?: boolean;
  /** 截断时长（战斗秒），到达即 truncated。默认 90 */
  maxFightSec?: number;
  reward?: Partial<RewardWeights>;
  /** reset 不带 seed 时的种子基准（每局 +7919 递增，保证局间多样且可复现） */
  seedBase?: number;
}

const DEFAULT_REWARD: RewardWeights = {
  dmgDealt: 2,
  dmgTaken: -2,
  win: 10,
  lose: -10,
  timePenalty: -0.005,
};

/** 速度归一化基数：MAX_SPEED × 碰撞爆发 1.5 */
const V_NORM = MAX_SPEED * 1.5;

/** 观测向量布局（22 维，全部归一化到 [-1,1]） */
export const OBS_KEYS = [
  'ownHp', 'ownX', 'ownY', 'ownVx', 'ownVy', 'ownAtkReady', 'ownWeaponReady',
  'foeHp', 'foeRelX', 'foeRelY', 'foeRelVx', 'foeRelVy', 'foeDist',
  'proj1RelX', 'proj1RelY', 'proj1Dist',
  'proj2RelX', 'proj2RelY', 'proj2Dist',
  'time', 'ownShield', 'foeShield',
] as const;

export class BattleEnv {
  readonly actionSpace: SpaceInfo = { type: 'Box', shape: [3], low: [-1, -1, -1], high: [1, 1, 1] };
  readonly observationSpace: SpaceInfo = {
    type: 'Box',
    shape: [OBS_KEYS.length],
    low: new Array(OBS_KEYS.length).fill(-1),
    high: new Array(OBS_KEYS.length).fill(1),
  };
  readonly metadata = { name: 'douququ-battle-v1', render_modes: [] as string[] };

  private battle: Battle | null = null;
  private readonly frameSkip: number;
  private readonly autoAttack: boolean;
  private readonly maxFightSec: number;
  private readonly rewardW: RewardWeights;
  private readonly seedBase: number;
  private episodeCount = 0;
  private lastSeed = 0;
  private steps = 0;
  private prevOwnEff = 0;
  private prevFoeEff = 0;

  constructor(private readonly ep: Episode, private readonly options: EnvOptions) {
    if (!ep.fighters.some((f) => f.id === options.controlledId)) {
      throw new Error(`controlledId "${options.controlledId}" 不在剧本 fighters 里（可用：${ep.fighters.map((f) => f.id).join(', ')}）`);
    }
    this.frameSkip = Math.max(1, Math.floor(options.frameSkip ?? 6));
    this.autoAttack = options.autoAttack ?? true;
    this.maxFightSec = options.maxFightSec ?? 90;
    this.rewardW = { ...DEFAULT_REWARD, ...options.reward };
    this.seedBase = options.seedBase ?? 0;
  }

  /** Gymnasium: reset(seed?) → (obs, info)。开场 VS 卡快进掉，RL 只见战斗段 */
  reset(seed?: number): { obs: number[]; info: EnvInfo } {
    this.lastSeed = seed !== undefined ? Math.floor(seed) : (this.seedBase + this.episodeCount * 7919) % 0x7fffffff;
    this.episodeCount += 1;
    this.battle = new Battle(this.ep, this.lastSeed);
    const st = this.battle.st;
    let guard = 0;
    while (st.phase === 'intro' && guard++ < 3000) this.battle.step(LOGIC_DT);
    this.steps = 0;
    this.prevOwnEff = this.effHp(this.me());
    this.prevFoeEff = this.enemyTotalEffHp();
    return { obs: this.buildObs(), info: this.info(0, 0) };
  }

  /** Gymnasium: step(action) → (obs, reward, terminated, truncated, info) */
  step(action: number[]): StepResult {
    if (!this.battle) throw new Error('必须先 reset()');
    const a = this.sanitize(action);
    const me = this.me();
    me.cmd = { ax: a[0], ay: a[1], fire: this.autoAttack || a[2] > 0 };
    for (let i = 0; i < this.frameSkip; i++) {
      this.battle.step(LOGIC_DT);
      if (this.battle.st.phase === 'end') break; // 胜负已分，别再烧步数
    }
    me.cmd = null;
    this.steps += 1;

    const ownEff = this.effHp(me);
    const foeEff = this.enemyTotalEffHp();
    const dmgDealt = Math.max(0, this.prevFoeEff - foeEff);
    const dmgTaken = Math.max(0, this.prevOwnEff - ownEff);
    this.prevOwnEff = ownEff;
    this.prevFoeEff = foeEff;

    const foeMax = this.enemyTotalMaxHp();
    const ownMax = me.maxHp;
    const st = this.battle.st;
    const terminated = st.phase === 'end';
    const truncated = !terminated && st.fightT >= this.maxFightSec;

    let reward = this.rewardW.timePenalty;
    reward += this.rewardW.dmgDealt * (dmgDealt / foeMax);
    reward += this.rewardW.dmgTaken * (dmgTaken / ownMax);
    if (terminated) reward += st.winner === me.side ? this.rewardW.win : st.winner === -1 ? 0 : this.rewardW.lose;

    return {
      obs: this.buildObs(),
      reward,
      terminated,
      truncated,
      info: this.info(dmgDealt, dmgTaken),
    };
  }

  /** 当前战斗原始状态（调试/自定义 reward shaping 用） */
  get state() {
    return this.battle?.st ?? null;
  }

  private me(): Unit {
    const u = this.battle!.st.units.find((x) => x.def.id === this.options.controlledId);
    if (!u) throw new Error('被控单位不存在（被移除了？）');
    return u;
  }

  private enemies(): Unit[] {
    const me = this.me();
    return this.battle!.st.units.filter((e) => e.side !== me.side);
  }

  /** 有效血量 = hp + 护盾（护盾吸收也是真实战损） */
  private effHp(u: Unit): number {
    return Math.max(0, u.hp) + (u.alive ? u.shield : 0);
  }

  private enemyTotalEffHp(): number {
    return this.enemies().reduce((s, e) => s + this.effHp(e), 0);
  }

  private enemyTotalMaxHp(): number {
    return this.enemies().reduce((s, e) => s + e.maxHp, 0) || 1;
  }

  private buildObs(): number[] {
    const st = this.battle!.st;
    const me = this.me();
    const foes = this.enemies().filter((e) => e.alive);
    // 最近敌人（全灭时保留最后一个尸体位置，观测不爆维度）
    let foe: Unit = foes[0] ?? this.enemies()[0];
    for (const e of foes) {
      if (Math.hypot(e.x - me.x, e.y - me.y) < Math.hypot(foe.x - me.x, foe.y - me.y)) foe = e;
    }
    // 最近的两枚敌方飞行道具（没有就补 0）
    const projs = st.projectiles
      .filter((p) => p.side !== me.side)
      .map((p) => {
        const x = p.sx + (p.tx - p.sx) * p.t;
        const y = p.sy + (p.ty - p.sy) * p.t;
        return { x, y, d: Math.hypot(x - me.x, y - me.y) };
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, 2);
    while (projs.length < 2) projs.push({ x: me.x, y: me.y, d: 0 });

    const fdx = foe.x - me.x;
    const fdy = foe.y - me.y;
    return [
      me.hp / me.maxHp,
      me.x / W,
      me.y / H,
      me.vx / V_NORM,
      me.vy / V_NORM,
      me.atkTimer <= 0 ? 1 : 0,
      me.fighter.weaponReady() ? 1 : 0,
      foe.hp / foe.maxHp,
      fdx / W,
      fdy / H,
      (foe.vx - me.vx) / V_NORM,
      (foe.vy - me.vy) / V_NORM,
      Math.min(1, Math.hypot(fdx, fdy) / H),
      (projs[0].x - me.x) / W,
      (projs[0].y - me.y) / H,
      Math.min(1, projs[0].d / H),
      (projs[1].x - me.x) / W,
      (projs[1].y - me.y) / H,
      Math.min(1, projs[1].d / H),
      Math.min(1, st.fightT / this.maxFightSec),
      Math.min(1, me.shield / me.maxHp),
      Math.min(1, foe.shield / foe.maxHp),
    ];
  }

  private info(dmgDealt: number, dmgTaken: number): EnvInfo {
    const st = this.battle!.st;
    const me = this.me();
    return {
      fightT: st.fightT,
      winner: st.winner,
      ownHp: Math.max(0, me.hp),
      enemyHp: this.enemyTotalEffHp(),
      enemyMaxHp: this.enemyTotalMaxHp(),
      dmgDealt,
      dmgTaken,
      steps: this.steps,
      seed: this.lastSeed,
    };
  }

  private sanitize(action: number[]): [number, number, number] {
    const v = (i: number): number => {
      const n = Number(action?.[i]);
      if (!isFinite(n)) return 0;
      return Math.max(-1, Math.min(1, n));
    };
    return [v(0), v(1), v(2)];
  }
}
