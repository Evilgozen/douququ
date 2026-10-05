/**
 * 战斗模拟核心：固定步长 + seeded RNG，保证同 seed 重放逐帧一致。
 * v2：角色为球形刚体——追逐用转向力、碰撞用冲量弹开、墙壁反弹，击退变成真实冲量，
 * 大幅增加走位随机性。演出元素（伤害数字/横幅/震屏/慢放）由模拟状态驱动；
 * 音效/额外演出通过事件流交给 Lua 脚本层绑定（见 script/luaHost.ts）。
 */
import { RNG } from './rng';
import { fmt } from './bignum';
import { evalTwists } from './twists';
import { Fighter, type AttackResult } from './fighter';
import { pointOnTrack, type TrackPoint } from './trainDemo';
import { memeProjectilePosition } from './memeMotion';
import type { Episode, FighterDef, SkillDef } from './types';

export const W = 1080;
export const H = 1920;
export const LOGIC_DT = 1 / 60;
export const INTRO_DUR = 4.4;
export const END_DUR = 4.6;
export const ARENA = { left: 110, right: 970, top: 430, bottom: 1440 };

// 球体物理参数
export const BALL_R = 64;
const ACCEL = 950; // 追逐转向加速度 px/s²
const WOBBLE = 260; // 垂直于追击方向的抖动力
const DRAG = 2.3; // 线性阻力系数
export const MAX_SPEED = 340;
const REST_UNIT = 0.72; // 球-球弹性
const REST_WALL = 0.78; // 球-墙弹性
const ATTACK_RANGE = BALL_R * 2 + 8; // 贴身接触才出手 → 冲锋-碰撞-弹开节奏

export type Phase = 'intro' | 'fight' | 'end';

export interface Unit {
  uid: number;
  side: 0 | 1;
  def: FighterDef;
  name: string;
  color: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** 碰撞后分离驱动剩余秒数：期间追逐被抑制，沿分离法线加速弹开 */
  sepT: number;
  sepNx: number;
  sepNy: number;
  /** 机关冷却（秒）：弹板/加速带各自的触发间隔 */
  bumperCd: number;
  boostCd: number;
  /** 追逐冷却（秒）：分离结束后先惯性滑行再重新追击 */
  chaseCd: number;
  /** random/flee 的游走状态：换向倒计时 + 当前游走方向单位向量 */
  wanderT: number;
  wanderNx: number;
  wanderNy: number;
  /** RL 外部接管指令（存在时覆盖行为策略：ax/ay 移动意图、fire 出招意图）；仅程序注入，不进剧本 */
  cmd: { ax: number; ay: number; fire: boolean } | null;
  /** 眩晕剩余秒（骑车摔倒等）：无驱动力自然减速 */
  stunT: number;
  /** 护盾刚吸收伤害后的格挡姿势剩余时间 */
  blockT: number;
  /** 毒气释放计时 */
  gasT: number;
  /** 骑车冲刺剩余秒（>0 = 骑行中） */
  bikeT: number;
  /** 骑车冷却 */
  bikeCd: number;
  /** 外卖轮盘计时与菜单游标 */
  takeoutT: number;
  takeoutIdx: number;
  /** 空中翻滚：当前旋转角与角速度（被强击退踹飞时赋予，速度衰减后回正） */
  spinA: number;
  spinV: number;
  /** 强击退飞行窗口：期间速度上限抬到 1200（否则限速器会把击飞速度当场钳回 286） */
  launchT: number;
  /** 角色抽象：出招（连击序列/技能/增益）都在这里，Unit 只管肉体 */
  fighter: Fighter;
  hp: number;
  maxHp: number;
  dispHp: number; // 底部血条动画用（平滑追 hp）
  shield: number;
  atkInterval: number;
  atkTimer: number;
  speed: number;
  range: number;
  alive: boolean;
  hitFlash: number;
  punchT: number;
  punchAngle: number;
  walkPhase: number;
  facing: 1 | -1;
  phase0: number;
  /** Lua 状态转移用的自定义属性（如 hyped/rage 计数） */
  props: Record<string, number>;
  meme: { cooldown: number; elapsed: number | null; hit: boolean; casts: number };
  totalDamage: number;
  biggestHit: number;
  biggestMult: number;
  kills: number;
}

export type PopupKind = 'damage' | 'crit' | 'skill' | 'heal' | 'shield' | 'block' | 'down' | 'up';

export interface Popup {
  kind: PopupKind;
  x: number;
  y: number;
  text: string;
  mult: number; // >1.6 时画倍率徽章
  life: number;
  maxLife: number;
  color: string;
  size: number;
}

export interface Banner {
  text: string;
  life: number;
  maxLife: number;
  color: string;
}

export interface FeedItem {
  text: string;
  life: number;
}

export interface RuntimeCaption {
  t: number;
  dur: number;
  text: string;
  gold: boolean;
}

export interface SfxEvent {
  name: string;
  t: number; // 模拟时间轴（秒）
  vol: number;
  rate: number;
}

/** 交给 Lua 脚本层的结构化事件 */
export type GameEvent =
  | { type: 'meme_skill'; t: number; unit: string; sound: string; name: string }
  | { type: 'collision'; t: number; a: string; b: string; speed: number; x: number; y: number }
  | { type: 'wall'; t: number; unit: string; wall: string; speed: number }
  | { type: 'bumper'; t: number; unit: string; speed: number }
  | { type: 'projectile'; t: number; unit: string; weapon: string }
  | { type: 'train_depart'; t: number; unit: string }
  | { type: 'gas'; t: number; unit: string }
  | { type: 'bike'; t: number; unit: string }
  | { type: 'crash'; t: number; unit: string }
  | { type: 'takeout'; t: number; unit: string; item: string }
  | { type: 'boost'; t: number; unit: string; speed: number }
  | { type: 'attack'; t: number; attacker: string; victim: string; dmg: number; mult: number; skill: string | null; crit: boolean }
  | { type: 'block'; t: number; attacker: string; victim: string; absorbed: number; broken: boolean; x: number; y: number }
  | { type: 'crit'; t: number; attacker: string; victim: string; dmg: number; mult: number }
  | { type: 'death'; t: number; unit: string; killer: string }
  | { type: 'twist'; t: number; name: string }
  | { type: 'phase'; t: number; name: string };

/** 特效粒子（模拟态，保证确定性重放） */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  kind: 'spark' | 'dust' | 'frag' | 'aura';
}

/** 飞行道具（公文包等）：确定性弹道，命中结算走统一 AttackResult 管线 */
export interface Projectile {
  ownerUid: number;
  side: 0 | 1;
  weaponName: string;
  damage: number;
  /** 直线飞行速度 */
  speed: number;
  /** 起点（抛物线视觉用） */
  sx: number;
  sy: number;
  /** 预测命中点 */
  tx: number;
  ty: number;
  /** 飞行进度 0..1 */
  t: number;
  /** 总飞行时间秒 */
  totalTime: number;
  arc: boolean;
  life: number;
  /** 外卖轮盘：显示名（珍珠奶茶…）与袋子颜色 */
  label?: string;
  color?: string;
  /** 专属素材（火锅/奶茶等），优先于袋子绘制 */
  sprite?: string;
  meme?: { kind: 'eggs' | 'clones'; delay: number; launched: boolean; radius: number; volleyOffset?: { x: number; y: number } };
  /** 命中减速（冰美式等），单位：秒/倍率 */
  slowSec?: number;
  slowMult?: number;
}

/** 毒气云（奶娃）：区域持续掉血，伤害在放出时定格（确定性） */
export interface GasCloud {
  ownerUid: number;
  side: 0 | 1;
  x: number;
  y: number;
  r: number;
  life: number;
  maxLife: number;
  damage: number;
  tickT: number;
  tickEvery: number;
}

/** 技能/暴击光束 */
export interface Beam {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  life: number;
  maxLife: number;
  color: string;
  width: number;
}

export interface RosterEntry {
  name: string;
  wins: number;
  losses: number;
  h2h: Record<string, { w: number; l: number }>;
}

export interface BattleState {
  ep: Episode;
  seed: number;
  t: number; // 全局时间（含开场）
  fightT: number;
  phase: Phase;
  introT: number;
  endT: number;
  units: Unit[];
  popups: Popup[];
  banners: Banner[];
  feed: FeedItem[];
  captions: RuntimeCaption[];
  sfx: SfxEvent[];
  events: GameEvent[];
  particles: Particle[];
  beams: Beam[];
  projectiles: Projectile[];
  gases: GasCloud[];
  rail: {
    points: TrackPoint[];
    nextTrainT: number;
    pass: { points: TrackPoint[]; elapsed: number; duration: number; damage: number; cars: number; carGap: number; hitCd: number } | null;
    fading: { points: TrackPoint[]; remaining: number; total: number } | null;
    combo: { count: number; lastTrainHitT: number; wallPrimedUntil: number };
    dash: { phase: 'idle' | 'charging' | 'dashing'; timer: number; startX: number; startY: number; cooldown: number };
    echo: { activeT: number; cooldown: number; spawnT: number; releaseT: number; spawned: number; released: number; images: Array<{ x: number; y: number; order: number }> } | null;
  } | null;
  /** 冲击波（强击退命中/重事件）：扩散圆环演出 */
  shocks: Array<{ x: number; y: number; r: number; maxR: number; life: number; maxLife: number; color: string }>;
  arena: {
    bumpers: Array<{ x: number; y: number; r: number }>;
    boosts: Array<{ x: number; y: number; w: number; h: number }>;
  };
  /** 击杀镜头：结算特写阶段聚焦的 y（null = 无） */
  endFocusY: number | null;
  roster: Record<string, RosterEntry> | null;
  phys: {
    restitution: number;
    wallRestitution: number;
    separationTime: number;
    separateAccel: number;
    initialSpeed: number;
    knockback: number;
  };
  slowmo: number;
  shake: number;
  flash: number;
  zoom: number;
  zoomX: number;
  zoomY: number;
  firedTwists: boolean[];
  suddenDeathFired: boolean;
  winner: -1 | 0 | 1 | null; // null = 未结束
  uidSeq: number;
  rng: RNG;
  /** 纯演出随机流：音高/粒子等不得消耗物理 RNG，否则挂 Lua 会改变战斗结果。 */
  fxRng: RNG;
}

export const SIDE_COLORS = ['#ff4d5a', '#8c52ff'] as const;

export function makeUnit(ep: Episode, def: FighterDef, side: 0 | 1, st: { rng: RNG; uidSeq: number }): Unit {
  const top = side === 0;
  const readable = ep.combat?.mode === 'readable';
  const bounce = readable && ep.combat?.movement === 'bounce';
  return {
    uid: st.uidSeq++,
    side,
    def,
    name: def.name,
    color: def.color ?? SIDE_COLORS[side],
    x: readable ? (top ? 330 : 750) : W / 2 + st.rng.range(-60, 60),
    y: bounce ? (top ? 750 : 1110) : readable ? 940 : top ? ARENA.top + 150 : ARENA.bottom - 150,
    vx: bounce ? (top ? (def.speed ?? 210) * 0.78 : -(def.speed ?? 210) * 0.68) : 0,
    vy: bounce ? (def.speed ?? 210) * (top ? 0.626 : -0.733) : 0,
    r: def.radius ?? BALL_R,
    sepT: 0,
    sepNx: 0,
    sepNy: 0,
    bumperCd: 0,
    boostCd: 0,
    chaseCd: 0,
    wanderT: 0,
    wanderNx: 0,
    wanderNy: 0,
    cmd: null,
    stunT: 0,
    blockT: 0,
    gasT: def.gasTrail ? def.gasTrail.every * 0.5 : 0,
    bikeT: 0,
    bikeCd: def.bikeRush ? (def.bikeRush.delay ?? 3) : 0,
    takeoutT: def.takeout ? def.takeout.every * 0.6 : 0,
    takeoutIdx: 0,
    spinA: 0,
    spinV: 0,
    launchT: 0,
    fighter: new Fighter(def, st.uidSeq),
    hp: def.hp,
    maxHp: def.hp,
    dispHp: def.hp,
    shield: 0,
    atkInterval: def.atkInterval ?? 1,
    atkTimer: readable ? (def.atkInterval ?? 1) : 0.3 + ((st.uidSeq % 3) * 0.1),
    speed: def.speed ?? 140,
    range: def.range ?? ATTACK_RANGE,
    alive: true,
    hitFlash: 0,
    punchT: 0,
    punchAngle: top ? Math.PI / 2 : -Math.PI / 2,
    walkPhase: st.rng.range(0, Math.PI * 2),
    facing: top ? 1 : -1,
    phase0: st.rng.range(0, Math.PI * 2),
    props: {},
    meme: { cooldown: def.memeSkill?.initialCooldown ?? 0, elapsed: null, hit: false, casts: 0 },
    totalDamage: 0,
    biggestHit: 0,
    biggestMult: 1,
    kills: 0,
  };
}

function initState(ep: Episode, seed: number): BattleState {
  if (ep.fighters.length < 2) throw new Error('剧本至少需要 2 名 fighters');
  const st: BattleState = {
    ep,
    seed,
    t: 0,
    fightT: 0,
    phase: 'intro',
    introT: 0,
    endT: 0,
    units: [],
    popups: [],
    banners: [],
    feed: [],
    captions: [],
    sfx: [],
    events: [],
    particles: [],
    beams: [],
    projectiles: [],
    gases: [],
    rail: ep.combat?.movement === 'bounce' && !ep.fighters.every((f) => f.memeSkill)
      ? { points: [], nextTrainT: ep.fighters.find((f) => f.trainTrail)?.trainTrail?.every ?? 7, pass: null, fading: null, combo: { count: 0, lastTrainHitT: -99, wallPrimedUntil: -99 }, dash: { phase: 'idle', timer: 0, startX: 0, startY: 0, cooldown: 2.2 }, echo: ep.fighters.some((f) => f.speedEcho) ? { activeT: 0, cooldown: ep.fighters.find((f) => f.speedEcho)!.speedEcho!.initialCooldown ?? 2.5, spawnT: 0, releaseT: 0, spawned: 0, released: 0, images: [] } : null }
      : null,
    shocks: [],
    arena: {
      bumpers: ep.arena?.bumpers ?? [],
      boosts: ep.arena?.boostZones ?? [],
    },
    endFocusY: null,
    roster: null,
    phys: {
      restitution: ep.physics?.restitution ?? 0.72,
      wallRestitution: ep.physics?.wallRestitution ?? 0.78,
      separationTime: ep.physics?.separationTime ?? 0.5,
      separateAccel: ep.physics?.separateAccel ?? 340,
      initialSpeed: ep.physics?.initialSpeed ?? 300,
      knockback: ep.physics?.knockback ?? 1,
    },
    slowmo: 0,
    shake: 0,
    flash: 0,
    zoom: 1,
    zoomX: W / 2,
    zoomY: H * 0.52,
    firedTwists: [],
    suddenDeathFired: false,
    winner: null,
    uidSeq: 1,
    rng: new RNG(seed),
    // 与物理 RNG 确定性隔离；黄金比例常量用于把相近 seed 打散。
    fxRng: new RNG((seed ^ 0x9e3779b9) >>> 0),
  };
  ep.fighters.forEach((f, i) => {
    st.units.push(makeUnit(ep, f, i === 0 ? 0 : 1, st));
  });
  st.firedTwists = (ep.twists ?? []).map(() => false);
  for (const c of ep.captions ?? []) {
    st.captions.push({ t: c.t, dur: c.dur ?? 3, text: c.text, gold: false });
  }
  st.captions.sort((a, b) => a.t - b.t);
  return st;
}

export class Battle {
  st: BattleState;
  /** 事件回调：每步结束 flush，由脚本层（Lua）接管演出 */
  onEvent: ((ev: GameEvent) => void) | null = null;

  constructor(ep: Episode, seed?: number) {
    this.st = initState(ep, seed ?? ep.seed);
  }

  get done(): boolean {
    return this.st.phase === 'end' && this.st.endT >= (this.st.ep.endDuration ?? END_DUR);
  }

  /** 取走累积事件（不注册 onEvent 时手动拉取用） */
  drainEvents(): GameEvent[] {
    const ev = this.st.events;
    this.st.events = [];
    return ev;
  }

  step(dt: number = LOGIC_DT): void {
    this._stepInner(dt);
    if (this.onEvent && this.st.events.length > 0) {
      for (const ev of this.drainEvents()) this.onEvent(ev);
    }
  }

  private _stepInner(dt: number): void {
    const st = this.st;
    if (st.phase === 'end' && st.endT >= (st.ep.endDuration ?? END_DUR)) return;

    // 实时演出的衰减（不受慢放影响，保证节奏感）
    if (st.flash > 0) st.flash = Math.max(0, st.flash - dt * 2.2);
    st.shake *= Math.exp(-5.2 * dt);
    if (st.shake < 0.15) st.shake = 0;
    const zTarget = st.slowmo > 0 ? 1.06 : 1;
    st.zoom += (zTarget - st.zoom) * Math.min(1, dt * 6);

    let sdt = dt;
    if (st.slowmo > 0) {
      st.slowmo -= dt;
      sdt = dt * 0.22;
    }
    st.t += sdt;

    // 血条平滑与闪白衰减
    for (const u of st.units) {
      u.dispHp += (u.hp - u.dispHp) * Math.min(1, dt * 9);
      if (u.hitFlash > 0) u.hitFlash = Math.max(0, u.hitFlash - dt);
      if (u.punchT > 0) u.punchT = Math.max(0, u.punchT - dt);
      if (u.blockT > 0) u.blockT = Math.max(0, u.blockT - dt);
    }
    for (const p of st.popups) p.life -= dt;
    st.popups = st.popups.filter((p) => p.life > 0);
    // 特效粒子/光束演化（确定性，随重放一致）
    for (const p of st.particles) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= Math.exp(-2.2 * dt);
      p.vy *= Math.exp(-2.2 * dt);
    }
    st.particles = st.particles.filter((p) => p.life > 0);
    for (const b of st.beams) b.life -= dt;
    st.beams = st.beams.filter((b) => b.life > 0);
    for (const s of st.shocks) s.life -= dt;
    st.shocks = st.shocks.filter((s) => s.life > 0);
    this.updateProjectiles(st.ep.fighters.some((f) => f.memeSkill) ? sdt : dt);
    this.updateGases(dt);
    for (const b of st.banners) b.life -= dt;
    st.banners = st.banners.filter((b) => b.life > 0);
    for (const f of st.feed) f.life -= dt;
    st.feed = st.feed.filter((f) => f.life > 0);

    if (st.phase === 'intro') {
      st.introT += sdt;
      if (st.introT >= INTRO_DUR) {
        st.phase = 'fight';
        // 开战：给每球一个带随机方向的初速度（参考弹珠对战的开球节奏）
        for (const u of st.ep.combat?.mode === 'readable' ? [] : st.units) {
          const ang = st.rng.range(0, Math.PI * 2);
          const spd = st.phys.initialSpeed * st.rng.range(0.75, 1.05);
          u.vx = Math.cos(ang) * spd;
          u.vy = Math.sin(ang) * spd;
        }
        st.events.push({ type: 'phase', t: st.t, name: 'fight' });
      }
      return;
    }
    if (st.phase === 'end') {
      st.endT += sdt;
      // 击杀镜头：前 1.3s 停在倒地特写，之后镜头滑回全景
      if (st.endT > 1.3 && st.endFocusY !== null) {
        st.zoomY += (H * 0.52 - st.zoomY) * Math.min(1, dt * 3);
        if (Math.abs(st.zoomY - H * 0.52) < 2) st.endFocusY = null;
      }
      return;
    }

    st.fightT += sdt;
    if (st.ep.combat?.mode === 'readable') {
      if (st.ep.combat.movement === 'bounce') {
        if (st.units.every((u) => u.def.memeSkill)) this.stepMemeDuel(sdt);
        else if (st.units.some((u) => u.def.trainTrail)) this.stepReadableBounce(sdt);
        else this.stepReadableSkillDuel(sdt);
      }
      else this.stepReadable(sdt);
    } else {
      this.stepUnits(sdt);
      this.resolveCollisions();
      this.resolveMechanisms();
    }
    evalTwists(this); // hpBelowPct / timeAt / fighterDead（复活在判负之前）
    this.checkSuddenDeath();
    this.checkEnd();

    if (st.t > 600) {
      st.phase = 'end';
      st.winner = -1;
      st.endT = 0;
      st.events.push({ type: 'phase', t: st.t, name: 'end' });
    }
  }

  /** 静态移动、触发后原地播放动作；命中只读取确定性几何与固定时间。 */
  private stepMemeDuel(dt: number): void {
    const st = this.st;
    const [a, b] = st.units;
    for (const u of [a, b]) {
      if (!u.alive) continue;
      u.meme.cooldown = Math.max(0, u.meme.cooldown - dt);
      if (u.meme.elapsed === null && a.alive && b.alive) {
        u.x += u.vx * dt; u.y += u.vy * dt;
        if (u.x < ARENA.left + u.r || u.x > ARENA.right - u.r) u.vx *= -1;
        if (u.y < ARENA.top + u.r || u.y > ARENA.bottom - u.r) u.vy *= -1;
        u.x = Math.max(ARENA.left + u.r, Math.min(ARENA.right - u.r, u.x));
        u.y = Math.max(ARENA.top + u.r, Math.min(ARENA.bottom - u.r, u.y));
      }
    }
    const dx = b.x - a.x, dy = b.y - a.y;
    const distance = Math.hypot(dx, dy);
    const contact = a.alive && b.alive && distance <= a.r + b.r;
    if (contact) {
      const nx = distance > 0.001 ? dx / distance : 1, ny = distance > 0.001 ? dy / distance : 0;
      const overlap = (a.r + b.r - distance) / 2;
      a.x -= nx * overlap; a.y -= ny * overlap;
      b.x += nx * overlap; b.y += ny * overlap;
      // 分离后始终恢复各自固定速度，不用演出随机流决定轨迹。
      a.vx = -nx * a.speed; a.vy = -ny * a.speed;
      b.vx = nx * b.speed; b.vy = ny * b.speed;
    }
    for (const [u, target] of [[a, b], [b, a]]) {
      const m = u.def.memeSkill!;
      if (u.alive && target.alive && u.meme.elapsed === null && u.meme.cooldown <= 0 && (m.trigger !== 'collision' || contact)) {
        u.meme.elapsed = 0; u.meme.hit = false; u.meme.casts++;
        st.popups.push(mkPopup('skill', u.x, u.y - 150, m.effect?.cloneGrowth ? `${m.name} ×${u.meme.casts}` : m.name, 1, u.color, 34));
        st.events.push({ type: 'meme_skill', t: st.t, unit: u.def.id, sound: m.sound, name: m.name });
        if (m.effect) {
          const d = Math.hypot(target.x - u.x, target.y - u.y) || 1;
          const nx = (target.x - u.x) / d, ny = (target.y - u.y) / d;
          const growing = m.effect.cloneGrowth === true;
          const count = growing ? u.meme.casts : m.effect.launchTimes.length;
          const launchTimes = growing ? Array.from({ length: count }, (_, i) => m.effect!.launchTimes[0] + (count === 1 ? 0 : i / (count - 1)) * (m.effect!.launchTimes[1] - m.effect!.launchTimes[0])) : m.effect.launchTimes;
          for (const [index, delay] of launchTimes.entries()) {
            const side = index === 0 ? -1 : 1;
            const offset = m.effect.kind === 'clones' ? (growing ? count === 1 ? 150 : Math.abs(index - (count - 1) / 2) * 150 : 150) : 76;
            const cloneSide = growing && count > 1 ? Math.sign(index - (count - 1) / 2) : side;
            const centerCloneBack = growing && offset === 0 ? 150 : 0;
            const pullback = m.effect.kind === 'eggs' ? 75 : 0;
            const volleyOffset = m.effect.kind === 'eggs' ? { x: -ny * offset * side, y: nx * offset * side } : undefined;
            // 双蛋先限制共同起点，再加左右偏移，保证靠墙时仍保持并排。
            const marginX = 45 + (volleyOffset ? Math.abs(volleyOffset.x) : 0);
            const marginY = 70 + (volleyOffset ? Math.abs(volleyOffset.y) : 0);
            const sx = volleyOffset ? Math.max(ARENA.left + marginX, Math.min(ARENA.right - marginX, u.x - nx * pullback)) + volleyOffset.x : Math.max(ARENA.left + 45, Math.min(ARENA.right - 45, u.x - nx * centerCloneBack - ny * offset * cloneSide));
            const sy = volleyOffset ? Math.max(ARENA.top + marginY, Math.min(ARENA.bottom - marginY, u.y - ny * pullback)) + volleyOffset.y : Math.max(ARENA.top + 70, Math.min(ARENA.bottom - 70, u.y - ny * centerCloneBack + nx * offset * cloneSide));
            st.projectiles.push({ ownerUid: u.uid, side: u.side, weaponName: m.name, damage: m.damage, speed: m.effect.speed, sx, sy, tx: target.x, ty: target.y, t: 0, totalTime: 1, arc: m.effect.kind === 'eggs', life: delay + 5, sprite: m.effect.sprite ?? u.def.sprite, color: u.color, meme: { kind: m.effect.kind, delay, launched: false, radius: m.effect.kind === 'eggs' ? 32 : 55, volleyOffset } });
          }
        }
      }
      if (u.meme.elapsed === null) continue;
      u.meme.elapsed += dt;
      if (!m.effect && u.alive && target.alive && !u.meme.hit && u.meme.elapsed + 1e-9 >= m.hitAt) {
        u.meme.hit = true;
        if (Math.hypot(target.x - u.x, target.y - u.y) <= m.range + target.r) {
          st.beams.push({ x1: u.x, y1: u.y, x2: target.x, y2: target.y, life: 0.3, maxLife: 0.3, color: u.color, width: 8 });
          this.applyDamage(u, target, a2r({ name: m.name }, m.damage, 1));
        } else st.popups.push(mkPopup('block', u.x, u.y - 120, '落空', 1, '#aaaaaa', 30));
      }
      if (u.meme.elapsed + 1e-9 >= m.duration) {
        u.meme.elapsed = null; u.meme.cooldown = m.every;
      }
    }
  }

  /** 简明对战：固定站位、固定节拍，伤害只由攻击、防御、明示连击与 buff 决定。 */
  private stepReadable(dt: number): void {
    const [red, blue] = this.st.units;
    for (const [attacker, target] of [[red, blue], [blue, red]] as const) {
      if (!attacker.alive || !target.alive) continue;
      attacker.fighter.tick(dt);
      if (attacker.props.berserk > 0 && attacker.fighter.buffs.length === 0) attacker.props.berserk = 0;
      attacker.atkTimer -= dt * attacker.fighter.effIntervalMult;
      if (attacker.atkTimer > 0) continue;
      attacker.atkTimer += attacker.atkInterval;
      this.attack(attacker, target, Math.atan2(target.y - attacker.y, target.x - attacker.x));
    }
  }

  /** 突刺与停时残影直接对战；停时冻结刺客和蓄力计时。 */
  private stepReadableSkillDuel(dt: number): void {
    const st = this.st;
    const rail = st.rail!;
    const assassin = st.units.find((u) => u.def.dashStrike)!;
    const speedster = st.units.find((u) => u.def.speedEcho)!;
    const dashDef = assassin.def.dashStrike!;
    const echoDef = speedster.def.speedEcho!;
    const dash = rail.dash;
    const echo = rail.echo!;
    const frozen = echo.activeT > 0;

    for (const u of [assassin, speedster]) {
      if (!u.alive || (u === assassin && frozen)) continue;
      u.fighter.tick(dt);
      if (u === assassin && dash.phase !== 'idle') continue;
      if (u === speedster && frozen) {
        const oldX = u.x; const oldY = u.y;
        const dx = u.x - assassin.x; const dy = u.y - assassin.y;
        const dist = Math.hypot(dx, dy) || 1;
        const orbit = Math.min(echoDef.hitRadius + assassin.r - 18, 118);
        let travel = (u.def.speed ?? 210) * echoDef.speedMultiplier * dt;
        if (dist > orbit) {
          const approach = Math.min(travel, dist - orbit);
          u.x -= dx / dist * approach; u.y -= dy / dist * approach;
          travel -= approach;
        }
        if (travel > 0) {
          const angle = Math.atan2(u.y - assassin.y, u.x - assassin.x) + travel / orbit;
          u.x = assassin.x + Math.cos(angle) * orbit;
          u.y = assassin.y + Math.sin(angle) * orbit;
        }
        u.x = Math.max(ARENA.left + u.r, Math.min(ARENA.right - u.r, u.x));
        u.y = Math.max(ARENA.top + u.r, Math.min(ARENA.bottom - u.r, u.y));
        const moved = Math.hypot(u.x - oldX, u.y - oldY);
        if (moved > 0) { u.vx = (u.x - oldX) / moved * (u.def.speed ?? 210); u.vy = (u.y - oldY) / moved * (u.def.speed ?? 210); }
      } else {
        u.x += u.vx * dt; u.y += u.vy * dt;
        if (u.x < ARENA.left + u.r) { u.x = 2 * (ARENA.left + u.r) - u.x; u.vx = Math.abs(u.vx); }
        if (u.x > ARENA.right - u.r) { u.x = 2 * (ARENA.right - u.r) - u.x; u.vx = -Math.abs(u.vx); }
        if (u.y < ARENA.top + u.r) { u.y = 2 * (ARENA.top + u.r) - u.y; u.vy = Math.abs(u.vy); }
        if (u.y > ARENA.bottom - u.r) { u.y = 2 * (ARENA.bottom - u.r) - u.y; u.vy = -Math.abs(u.vy); }
      }
      u.facing = u.vx >= 0 ? 1 : -1;
      u.walkPhase += dt * (u === speedster && frozen ? 18 : 8);
    }

    if (!frozen && dash.phase === 'idle' && assassin.alive && speedster.alive) {
      const dx = speedster.x - assassin.x; const dy = speedster.y - assassin.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0 && dist < assassin.r + speedster.r) {
        const nx = dx / dist; const ny = dy / dist;
        const overlap = (assassin.r + speedster.r - dist) / 2;
        assassin.x -= nx * overlap; assassin.y -= ny * overlap;
        speedster.x += nx * overlap; speedster.y += ny * overlap;
        const relative = (speedster.vx - assassin.vx) * nx + (speedster.vy - assassin.vy) * ny;
        if (relative < 0) {
          assassin.vx += relative * nx; assassin.vy += relative * ny;
          speedster.vx -= relative * nx; speedster.vy -= relative * ny;
        }
      }
    }

    if (!frozen && assassin.alive && speedster.alive) {
      if (dash.phase === 'idle') {
        dash.cooldown -= dt;
        if (dash.cooldown <= 0) {
          dash.phase = 'charging'; dash.timer = dashDef.charge;
          st.banners.push({ text: '刺客蓄力', life: 1.1, maxLife: 1.1, color: '#c4b5fd' });
        }
      } else if (dash.phase === 'charging') {
        dash.timer -= dt;
        if (dash.timer <= 0) { dash.phase = 'dashing'; dash.timer = dashDef.duration; dash.startX = assassin.x; dash.startY = assassin.y; }
      } else {
        dash.timer -= dt;
        const progress = Math.min(1, 1 - dash.timer / dashDef.duration);
        const dx = speedster.x - dash.startX; const dy = speedster.y - dash.startY;
        const dist = Math.hypot(dx, dy) || 1;
        const stop = Math.max(0, dist - speedster.r - assassin.r + 7);
        const eased = 1 - (1 - progress) * (1 - progress);
        assassin.x = dash.startX + dx / dist * stop * eased;
        assassin.y = dash.startY + dy / dist * stop * eased;
        assassin.punchT = 0.2; assassin.punchAngle = Math.atan2(dy, dx);
        if (dash.timer <= 0) {
          dash.phase = 'idle'; dash.cooldown = dashDef.every;
          assassin.vx = -dx / dist * (assassin.def.speed ?? 210);
          assassin.vy = -dy / dist * (assassin.def.speed ?? 210);
          this.applyDamage(assassin, speedster, a2r({ name: '蓄力突刺' }, dashDef.damage, 1));
        }
      }
    }

    if (speedster.alive && assassin.alive) {
      if (echo.activeT > 0) {
        echo.activeT = Math.max(0, echo.activeT - dt);
        echo.spawnT -= dt;
        if (echo.spawnT <= 0 && echo.spawned < echoDef.maxEchoes) {
          echo.images.push({ x: speedster.x, y: speedster.y, order: echo.spawned + 1 });
          echo.spawned++; echo.spawnT += echoDef.echoEvery;
        }
        if (echo.activeT <= 0) echo.releaseT = echoDef.releaseEvery;
      } else if (echo.images.length > 0) {
        echo.releaseT -= dt;
        if (echo.releaseT <= 0) {
          const image = echo.images.shift()!;
          echo.released++; echo.releaseT += echoDef.releaseEvery;
          const overlap = Math.hypot(assassin.x - image.x, assassin.y - image.y) <= echoDef.hitRadius + assassin.r;
          st.shocks.push({ x: image.x, y: image.y, r: 12, maxR: echoDef.hitRadius, life: 0.28, maxLife: 0.28, color: overlap ? '#67e8f9' : '#64748b' });
          if (overlap) this.applyDamage(speedster, assassin, a2r({ name: `残影 ${image.order}/${echoDef.maxEchoes}` }, echoDef.damage, 1));
          else st.popups.push(mkPopup('skill', image.x, image.y - 76, `${image.order} 落空`, 1, '#94a3b8', 25));
        }
      } else {
        echo.cooldown -= dt;
        if (echo.cooldown <= 0) {
          echo.activeT = echoDef.active; echo.cooldown = echoDef.every;
          echo.spawnT = 0; echo.spawned = 0; echo.released = 0;
          st.banners.push({ text: '斯安威斯坦 · 时间冻结', life: 0.9, maxLife: 0.9, color: '#67e8f9' });
        }
      }
    } else {
      echo.images = [];
    }
  }

  /** 弹球版简明对战：运动确定，伤害只来自可见的列车和角色技能。 */
  private stepReadableBounce(dt: number): void {
    const st = this.st;
    const rail = st.rail!;
    const conductor = st.units.find((u) => u.def.trainTrail)!;
    const assassin = st.units.find((u) => u.def.dashStrike || u.def.speedEcho)!;
    const trainDef = conductor.def.trainTrail!;
    const dashDef = assassin.def.dashStrike;
    const echoDef = assassin.def.speedEcho;
    const timeFrozen = Boolean(echoDef && rail.echo && rail.echo.activeT > 0);
    const primeWallCombo = (): void => {
      if (st.fightT - rail.combo.lastTrainHitT > 1.1 || !assassin.alive) return;
      if (rail.combo.wallPrimedUntil < st.fightT) {
        st.feed.push({ text: '列车撞墙反弹！', life: 1.2 });
        st.events.push({ type: 'wall', t: st.t, unit: assassin.def.id, wall: 'train-combo', speed: Math.hypot(assassin.vx, assassin.vy) });
      }
      rail.combo.wallPrimedUntil = st.fightT + 1.1;
    };
    for (const u of [conductor, assassin]) {
      if (!u.alive) continue;
      if (u === conductor && timeFrozen) continue;
      u.fighter.tick(dt);
      if (u === assassin && dashDef && rail.dash.phase !== 'idle') continue;
      if (u === assassin && echoDef && timeFrozen) {
        // 停时期间高速接近并绕过定格的对手。只保留画面边界；角色和车厢的实体碰撞全部忽略。
        const oldX = u.x; const oldY = u.y;
        const dx = u.x - conductor.x; const dy = u.y - conductor.y;
        const distance = Math.hypot(dx, dy) || 1;
        const orbitRadius = Math.min(echoDef.hitRadius + conductor.r - 18, 118);
        let travel = (u.def.speed ?? 210) * echoDef.speedMultiplier * dt;
        if (distance > orbitRadius) {
          const approach = Math.min(travel, distance - orbitRadius);
          u.x -= dx / distance * approach;
          u.y -= dy / distance * approach;
          travel -= approach;
        }
        if (travel > 0) {
          const angle = Math.atan2(u.y - conductor.y, u.x - conductor.x) + travel / orbitRadius;
          u.x = conductor.x + Math.cos(angle) * orbitRadius;
          u.y = conductor.y + Math.sin(angle) * orbitRadius;
        }
        u.x = Math.max(ARENA.left + u.r, Math.min(ARENA.right - u.r, u.x));
        u.y = Math.max(ARENA.top + u.r, Math.min(ARENA.bottom - u.r, u.y));
        const moved = Math.hypot(u.x - oldX, u.y - oldY);
        if (moved > 0) {
          u.vx = (u.x - oldX) / moved * (u.def.speed ?? 210);
          u.vy = (u.y - oldY) / moved * (u.def.speed ?? 210);
        }
        u.facing = u.vx >= 0 ? 1 : -1;
        u.walkPhase += dt * 18;
        continue;
      }
      u.x += u.vx * dt;
      u.y += u.vy * dt;
      let hitWall = false;
      if (u.x < ARENA.left + u.r) { u.x = 2 * (ARENA.left + u.r) - u.x; u.vx = Math.abs(u.vx); hitWall = true; }
      if (u.x > ARENA.right - u.r) { u.x = 2 * (ARENA.right - u.r) - u.x; u.vx = -Math.abs(u.vx); hitWall = true; }
      if (u.y < ARENA.top + u.r) { u.y = 2 * (ARENA.top + u.r) - u.y; u.vy = Math.abs(u.vy); hitWall = true; }
      if (u.y > ARENA.bottom - u.r) { u.y = 2 * (ARENA.bottom - u.r) - u.y; u.vy = -Math.abs(u.vy); hitWall = true; }
      if (hitWall && u === assassin) primeWallCombo();
      u.facing = u.vx >= 0 ? 1 : -1;
      u.walkPhase += dt * 8;
    }
    if (!timeFrozen && rail.dash.phase === 'idle' && conductor.alive && assassin.alive) {
      const dx = assassin.x - conductor.x;
      const dy = assassin.y - conductor.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 0 && dist < conductor.r + assassin.r) {
        const nx = dx / dist; const ny = dy / dist;
        const overlap = (conductor.r + assassin.r - dist) / 2;
        conductor.x -= nx * overlap; conductor.y -= ny * overlap;
        assassin.x += nx * overlap; assassin.y += ny * overlap;
        const relative = (assassin.vx - conductor.vx) * nx + (assassin.vy - conductor.vy) * ny;
        if (relative < 0) {
          conductor.vx += relative * nx; conductor.vy += relative * ny;
          assassin.vx -= relative * nx; assassin.vy -= relative * ny;
        }
      }
    }

    // 蓄力时原地锁定；突刺 0.35 秒内追到列车长身前，并只结算一次固定伤害。
    const dash = rail.dash;
    if (dashDef && assassin.alive && conductor.alive) {
      if (dash.phase === 'idle') {
        dash.cooldown -= dt;
        if (dash.cooldown <= 0) {
          dash.phase = 'charging'; dash.timer = dashDef.charge;
          st.banners.push({ text: '刺客蓄力', life: 1.1, maxLife: 1.1, color: '#c4b5fd' });
        }
      } else if (dash.phase === 'charging') {
        dash.timer -= dt;
        if (dash.timer <= 0) {
          dash.phase = 'dashing'; dash.timer = dashDef.duration;
          dash.startX = assassin.x; dash.startY = assassin.y;
        }
      } else {
        dash.timer -= dt;
        const progress = Math.min(1, 1 - dash.timer / dashDef.duration);
        const dx = conductor.x - dash.startX;
        const dy = conductor.y - dash.startY;
        const dist = Math.hypot(dx, dy) || 1;
        const stop = Math.max(0, dist - conductor.r - assassin.r + 7);
        const eased = 1 - (1 - progress) * (1 - progress);
        assassin.x = dash.startX + dx / dist * stop * eased;
        assassin.y = dash.startY + dy / dist * stop * eased;
        assassin.punchT = 0.2;
        assassin.punchAngle = Math.atan2(dy, dx);
        if (dash.timer <= 0) {
          dash.phase = 'idle'; dash.cooldown = dashDef.every;
          assassin.vx = -dx / dist * (assassin.def.speed ?? 210);
          assassin.vy = -dy / dist * (assassin.def.speed ?? 210);
          this.applyDamage(assassin, conductor, a2r({ name: '蓄力突刺' }, dashDef.damage, 1));
        }
      }
    }

    // 先冻结列车长和列车；本体无视实体碰撞留下快照。恢复后逐个消失，仅在当下重叠时扣血。
    const echo = rail.echo;
    if (echoDef && echo && assassin.alive && conductor.alive) {
      if (echo.activeT > 0) {
        echo.activeT = Math.max(0, echo.activeT - dt);
        echo.spawnT -= dt;
        if (echo.spawnT <= 0 && echo.spawned < echoDef.maxEchoes) {
          echo.images.push({ x: assassin.x, y: assassin.y, order: echo.spawned + 1 });
          echo.spawned++;
          echo.spawnT += echoDef.echoEvery;
        }
        if (echo.activeT <= 0) {
          echo.releaseT = echoDef.releaseEvery;
        }
      } else if (echo.images.length > 0) {
        echo.releaseT -= dt;
        if (echo.releaseT <= 0) {
          const image = echo.images.shift()!;
          echo.released++;
          echo.releaseT += echoDef.releaseEvery;
          const overlap = Math.hypot(conductor.x - image.x, conductor.y - image.y) <= echoDef.hitRadius + conductor.r;
          st.shocks.push({ x: image.x, y: image.y, r: 12, maxR: echoDef.hitRadius, life: 0.28, maxLife: 0.28, color: overlap ? '#67e8f9' : '#64748b' });
          if (overlap) this.applyDamage(assassin, conductor, a2r({ name: `残影 ${image.order}/${echoDef.maxEchoes}` }, echoDef.damage, 1));
          else st.popups.push(mkPopup('skill', image.x, image.y - 76, `${image.order} 落空`, 1, '#94a3b8', 25));
        }
      } else {
        echo.cooldown -= dt;
        if (echo.cooldown <= 0) {
          echo.activeT = echoDef.active;
          echo.cooldown = echoDef.every;
          echo.spawnT = 0;
          echo.spawned = 0;
          echo.released = 0;
          st.banners.push({ text: '斯安威斯坦 · 时间冻结', life: 0.9, maxLife: 0.9, color: '#67e8f9' });
        }
      }
    } else if (echo) {
      echo.images = [];
    }

    // 发车后暂停铺轨；车尾离场后旧轨再淡出数秒，消失了才开启下一段。
    if (rail.fading && !timeFrozen) {
      rail.fading.remaining -= dt;
      if (rail.fading.remaining <= 0) {
        rail.fading = null;
        rail.points = [];
        rail.nextTrainT = trainDef.every;
      }
    }
    if (conductor.alive && !rail.pass && !rail.fading && !timeFrozen) {
      if (rail.points.length === 0) rail.points.push({ x: conductor.x, y: conductor.y, s: 0 });
      let last = rail.points[rail.points.length - 1];
      let dx = conductor.x - last.x; let dy = conductor.y - last.y;
      let dist = Math.hypot(dx, dy);
      while (dist >= 12) {
        last = { x: last.x + dx / dist * 12, y: last.y + dy / dist * 12, s: last.s + 12 };
        rail.points.push(last);
        dx = conductor.x - last.x; dy = conductor.y - last.y; dist = Math.hypot(dx, dy);
      }
    }
    if (!rail.pass && !rail.fading && !timeFrozen) rail.nextTrainT -= dt;
    if (!rail.pass && !rail.fading && !timeFrozen && rail.nextTrainT <= 0 && rail.points.length >= 2) {
      const pathLength = rail.points[rail.points.length - 1].s;
      const cars = trainDef.cars ?? 5;
      const carGap = trainDef.carGap ?? 52;
      const referenceTail = ((trainDef.referenceCars ?? cars) - 1) * carGap + 40;
      const actualTail = (cars - 1) * carGap + 40;
      const referenceSpeed = (pathLength + referenceTail + 40) / trainDef.duration;
      const actualDuration = (pathLength + actualTail + 40) / (referenceSpeed * (trainDef.speedMultiplier ?? 1));
      rail.pass = { points: rail.points, elapsed: 0, duration: actualDuration, damage: trainDef.damage, cars, carGap, hitCd: 0 };
      rail.points = [];
      rail.nextTrainT = trainDef.every;
      st.banners.push({ text: '列车发车 · 双倍速度', life: 0.65, maxLife: 0.65, color: '#facc15' });
      st.events.push({ type: 'train_depart', t: st.t, unit: conductor.def.id });
    }
    const pass = rail.pass;
    if (pass) {
      if (!timeFrozen) pass.elapsed = Math.min(pass.duration, pass.elapsed + dt);
      if (!timeFrozen) pass.hitCd = Math.max(0, pass.hitCd - dt);
      const pathLength = pass.points[pass.points.length - 1].s;
      const tailLength = (pass.cars - 1) * pass.carGap + 40;
      const headS = -40 + (pathLength + tailLength + 40) * (pass.elapsed / pass.duration);
      if (assassin.alive && !timeFrozen) {
        for (let i = 0; i < pass.cars; i++) {
          const car = pointOnTrack(pass.points, headS - i * pass.carGap);
          if (!car) continue;
          const dx = assassin.x - car.x; const dy = assassin.y - car.y;
          const along = Math.max(-25, Math.min(25, dx * car.nx + dy * car.ny));
          const offX = dx - along * car.nx; const offY = dy - along * car.ny;
          const distance = Math.hypot(offX, offY);
          const penetration = assassin.r + 18 - distance;
          if (penetration > 0) {
            const side = dx * -car.ny + dy * car.nx >= 0 ? 1 : -1;
            const nx = distance > 0.001 ? offX / distance : -car.ny * side;
            const ny = distance > 0.001 ? offY / distance : car.nx * side;
            assassin.x += nx * (penetration + 3);
            assassin.y += ny * (penetration + 3);
            if (pass.hitCd <= 0) {
              rail.combo.count = rail.combo.wallPrimedUntil >= st.fightT && st.fightT - rail.combo.lastTrainHitT <= 1.5 ? rail.combo.count + 1 : 1;
              rail.combo.lastTrainHitT = st.fightT;
              rail.combo.wallPrimedUntil = -99;
              assassin.vx = nx * 620;
              assassin.vy = ny * 620;
              assassin.spinV = (side || 1) * 8;
              assassin.spinA = 0;
              st.shocks.push({ x: assassin.x, y: assassin.y, r: 20, maxR: 145, life: 0.34, maxLife: 0.34, color: '#facc15' });
              this.applyDamage(conductor, assassin, a2r({ name: '列车撞击' }, pass.damage, 1));
              if (rail.combo.count >= 2) st.feed.push({ text: `列车·墙体连撞 ×${rail.combo.count}`, life: 1.5 });
              pass.hitCd = 0.55;
            }
            let pushedIntoWall = false;
            if (assassin.x < ARENA.left + assassin.r) { assassin.x = ARENA.left + assassin.r; assassin.vx = Math.abs(assassin.vx); pushedIntoWall = true; }
            if (assassin.x > ARENA.right - assassin.r) { assassin.x = ARENA.right - assassin.r; assassin.vx = -Math.abs(assassin.vx); pushedIntoWall = true; }
            if (assassin.y < ARENA.top + assassin.r) { assassin.y = ARENA.top + assassin.r; assassin.vy = Math.abs(assassin.vy); pushedIntoWall = true; }
            if (assassin.y > ARENA.bottom - assassin.r) { assassin.y = ARENA.bottom - assassin.r; assassin.vy = -Math.abs(assassin.vy); pushedIntoWall = true; }
            if (pushedIntoWall) primeWallCombo();
            break;
          }
        }
      }
      if (pass.elapsed >= pass.duration) {
        rail.fading = { points: pass.points, remaining: trainDef.fadeSeconds ?? 2, total: trainDef.fadeSeconds ?? 2 };
        rail.pass = null;
      }
    }
  }

  private stepUnits(sdt: number): void {
    const st = this.st;
    for (const u of st.units) {
      if (!u.alive) continue;
      const enemies = st.units.filter((e) => e.side !== u.side && e.alive);
      if (enemies.length === 0) continue;
      let target = enemies[0];
      let best = Infinity;
      for (const e of enemies) {
        const d = (e.x - u.x) ** 2 + (e.y - u.y) ** 2;
        if (d < best) {
          best = d;
          target = e;
        }
      }
      const dx = target.x - u.x;
      const dy = target.y - u.y;
      const dist = Math.hypot(dx, dy) || 1;
      u.facing = dx >= 0 ? 1 : -1;
      // 行为策略：骑车期间强制 flee（骑车=逃离工具，脱离敌人方向狂飙）
      const beh: NonNullable<FighterDef['behavior']> = u.def.bikeRush && u.bikeT > 0 ? 'flee' : (u.def.behavior ?? 'chase');

      u.fighter.tick(sdt);
      // 攻击冷却全程走表：碰撞弹开期间也在转，进攻击距离即可出手（下限钳制：手动压刀不攒刀）
      u.atkTimer = Math.max(-0.05, u.atkTimer - sdt * u.fighter.effIntervalMult);

      // 追逐改为拦截预判：瞄准目标预测位置，避免互追形成稳定轨道永远差一步碰不上
      const lead = 0.35;
      const tx = target.x + target.vx * lead;
      const ty = target.y + target.vy * lead;
      const cdx = tx - u.x;
      const cdy = ty - u.y;
      const cdist = Math.hypot(cdx, cdy) || 1;

      // 转向力：分离驱动期间强制弹开；之后按行为策略（chase 追击 / random 游走 / flee 拉开 / cmd 外部接管）
      let ax: number;
      let ay: number;
      if (u.sepT > 0) {
        u.sepT -= sdt;
        // 分离驱动：沿弹开方向加速（碰撞后强制脱战）
        ax = u.sepNx * st.phys.separateAccel;
        ay = u.sepNy * st.phys.separateAccel;
      } else if (u.stunT > 0) {
        // 摔倒眩晕：无驱动力，靠阻力自然滑停
        u.stunT -= sdt;
        ax = 0;
        ay = 0;
      } else if (u.cmd) {
        // RL 手动接管：外部指令即转向力；追击冷却作废（贴不贴脸由策略自己决定）。
        // 贴墙反射：指向墙内的分量镜像翻转发（橡皮墙），角落里也能弹出来，指令永不被清零
        u.chaseCd = 0;
        let cx = u.cmd.ax;
        let cy = u.cmd.ay;
        const wm = u.r + 60;
        if (u.x < ARENA.left + wm && cx < 0) cx = -cx;
        if (u.x > ARENA.right - wm && cx > 0) cx = -cx;
        if (u.y < ARENA.top + wm && cy < 0) cy = -cy;
        if (u.y > ARENA.bottom - wm && cy > 0) cy = -cy;
        const mag = Math.hypot(cx, cy);
        const k = Math.min(1, mag) * ACCEL * 1.25;
        ax = mag > 0.02 ? (cx / mag) * k : 0;
        ay = mag > 0.02 ? (cy / mag) * k : 0;
      } else if (beh === 'chase' || beh === 'manual') {
        if (u.chaseCd > 0) {
          // 脱战滑行：与最近敌人拉开到 380px（约 3 倍接触距离）就提前恢复追击；冷却自然耗尽为兜底
          const nearDist = Math.min(...st.units.filter((e) => e.alive && e.side !== u.side).map((e) => Math.hypot(e.x - u.x, e.y - u.y)));
          if (nearDist >= 380) u.chaseCd = 0;
          ax = 0;
          ay = 0;
        } else {
          const chase = dist > u.range * 0.7 ? ACCEL : 0;
          const wobK = Math.min(1, Math.max(0, (dist - 260) / 400));
          const wob = Math.sin(st.t * 2.1 + u.phase0) * WOBBLE * wobK;
          ax = (cdx / cdist) * chase + (-cdy / cdist) * wob;
          ay = (cdy / cdist) * chase + (cdx / cdist) * wob;
        }
      } else if (beh === 'random') {
        // 目标点制随机走（参考"中央缠斗"类对战视频的移动语言，2026-09 逐帧规格书）：
        // 每条腿（1.6-3.2s）选中央带内一个随机目标点直线滑行——长直线 + 天然汇聚中央 + 零角落时间。
        // 相比"随机航向"游走：不会相关性流连在上一次的区域，也不会被墙卡住
        u.wanderT -= sdt;
        if (u.wanderT <= 0) {
          u.wanderT = st.rng.range(1.8, 3.4);
          // 目标点收在离墙 220px 以内缩的中央区（目标贴墙 = 终点停在贴边带，覆盖率会掉）
          const tx = st.rng.range(ARENA.left + 220, ARENA.right - 220);
          const ty = st.rng.range(ARENA.top + 220, ARENA.bottom - 220);
          const tdx = tx - u.x;
          const tdy = ty - u.y;
          const td = Math.hypot(tdx, tdy) || 1;
          u.wanderNx = tdx / td;
          u.wanderNy = tdy / td;
        }
        const cr = ACCEL * 0.55;
        // 靠墙保险：被撞飞/击退进深墙区时，把游走方向向场心插值（<80px 完全朝心）
        const edge = Math.min(u.x - ARENA.left, ARENA.right - u.x, u.y - ARENA.top, ARENA.bottom - u.y);
        let hx = u.wanderNx;
        let hy = u.wanderNy;
        let drive = 1;
        if (edge < 200) {
          const wgt = edge < 80 ? 1 : 1 - (edge - 80) / 120;
          const dx0 = (ARENA.left + ARENA.right) / 2 - u.x;
          const dy0 = (ARENA.top + ARENA.bottom) / 2 - u.y;
          const dd = Math.hypot(dx0, dy0) || 1;
          hx = u.wanderNx + (dx0 / dd) * 2.2 * wgt;
          hy = u.wanderNy + (dy0 / dd) * 2.2 * wgt;
          const hd = Math.hypot(hx, hy) || 1;
          hx /= hd;
          hy /= hd;
          drive = 1 + 0.6 * wgt;
        }
        ax = hx * cr * drive;
        ay = hy * cr * drive;
      } else {
        // 躲避对手：被贴近就反向拉开。贴墙用"投影掉指墙分量"顺墙滑走（不是叠加反向力——
        // 对抗力会把单位钉死在墙角低速徘徊，遥测实锤过）。骑行时加速度 ×2.4：阻力 2.3 下
        // 默认 950 只能推到 ~413px/s，×2.4 才压得住 800px/s 的骑行限速，"狂飙"才成立
        const keep = 470;
        if (dist < keep) {
          const boost = u.bikeT > 0 ? 2.4 : 1;
          let fx2 = (-dx / dist) * ACCEL * boost;
          let fy2 = (-dy / dist) * ACCEL * boost;
          const wm2 = u.r + 90;
          if (u.x < ARENA.left + wm2) fx2 = Math.max(fx2, 0);
          if (u.x > ARENA.right - wm2) fx2 = Math.min(fx2, 0);
          if (u.y < ARENA.top + wm2) fy2 = Math.max(fy2, 0);
          if (u.y > ARENA.bottom - wm2) fy2 = Math.min(fy2, 0);
          // 角落死锁保险：敌人斜对角压迫时投影会把两个分量都钳成 0（整车冻在角上），
          // 驱动力过小就直接朝场心跑
          if (Math.hypot(fx2, fy2) < ACCEL * 0.3) {
            const dcx = (ARENA.left + ARENA.right) / 2 - u.x;
            const dcy = (ARENA.top + ARENA.bottom) / 2 - u.y;
            const dcd = Math.hypot(dcx, dcy) || 1;
            fx2 = (dcx / dcd) * ACCEL * boost;
            fy2 = (dcy / dcd) * ACCEL * boost;
          }
          ax = fx2;
          ay = fy2;
        } else {
          u.wanderT -= sdt;
          if (u.wanderT <= 0) {
            const a = st.rng.range(0, Math.PI * 2);
            u.wanderNx = Math.cos(a);
            u.wanderNy = Math.sin(a);
            u.wanderT = st.rng.range(0.5, 1.4);
          }
          ax = u.wanderNx * ACCEL * (u.bikeT > 0 ? 1.1 : 0.4);
          ay = u.wanderNy * ACCEL * (u.bikeT > 0 ? 1.1 : 0.4);
        }
      }
      u.vx += ax * sdt;
      u.vy += ay * sdt;

      // 阻力 + 限速：def.speed 以 140（schema 默认值）为 1.0 基准缩放个体限速，钳 [0.6, 1.6]
      const dragK = Math.exp(-DRAG * sdt);
      u.vx *= dragK;
      u.vy *= dragK;
      const sp = Math.hypot(u.vx, u.vy);
      const spdFactor = Math.min(1.6, Math.max(0.6, u.speed / 140));
      let maxS = MAX_SPEED * spdFactor * u.fighter.effSpeedMult * (u.sepT > 0 || u.chaseCd > 0 ? 1.5 : 1);
      if (u.launchT > 0) {
        // 击飞飞行窗口：限速让位于冲量，靠阻力自然衰减
        u.launchT -= sdt;
        maxS = Math.max(maxS, 1200);
      }
      if (sp > maxS) {
        u.vx = (u.vx / sp) * maxS;
        u.vy = (u.vy / sp) * maxS;
      }

      u.x += u.vx * sdt;
      u.y += u.vy * sdt;
      u.walkPhase += (sp / maxS) * sdt * 10;
      // 空中翻滚：高速（被踹飞）时按角速度自转；速度衰减后角速度归零、角度归一化后指数回正
      if (u.alive) {
        if (sp > 250) {
          u.spinA += u.spinV * sdt;
        } else {
          u.spinV *= Math.exp(-6 * sdt);
          u.spinA = ((((u.spinA % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.exp(-3 * sdt);
        }
      }
      if (u.bumperCd > 0) u.bumperCd -= sdt;
      if (u.boostCd > 0) u.boostCd -= sdt;
      if (u.chaseCd > 0 && u.sepT <= 0) u.chaseCd -= sdt;

      // 狂暴/觉醒状态的金色光环粒子
      if (u.fighter.effAtkMult > 1.5 && st.rng.next() < sdt * 14) {
        const a = st.rng.range(0, Math.PI * 2);
        st.particles.push({
          x: u.x + Math.cos(a) * u.r,
          y: u.y + Math.sin(a) * u.r,
          vx: Math.cos(a) * 30 + st.rng.range(-15, 15),
          vy: -40 - st.rng.range(0, 40),
          life: 0.7,
          maxLife: 0.7,
          size: st.rng.range(3, 6),
          color: '#ffd32a',
          kind: 'aura',
        });
      }

      // 接触攻击：进距离且冷却好了就出手（一帧最多一刀）；被 RL 接管时须有出招意图
      if (dist <= u.range && u.atkTimer <= 0 && (!u.cmd || u.cmd.fire)) {
        this.attack(u, target, Math.atan2(dy, dx));
        // 出招节拍软抖动（seeded，确定性重放不变；伤害数字不受影响）
        u.atkTimer += u.atkInterval * (0.92 + st.rng.range(0, 0.16));
      }

      // 特色武器：独立冷却，不消耗连击序列（RL 接管时同样须有出招意图）
      const w = u.def.weapon;
      if (w && u.fighter.weaponReady() && (!u.cmd || u.cmd.fire)) {
        if (w.kind === 'melee' && dist <= u.range * (w.reachMult ?? 1.7)) {
          u.fighter.fireWeapon();
          const angle = Math.atan2(dy, dx);
          u.punchT = 0.55;
          u.punchAngle = angle;
          const atkRes = a2r(w, Math.max(1, Math.round(w.damage * u.fighter.effAtkMult * (w.mult ?? 1))), u.fighter.effAtkMult);
          // 挥击弧光
          st.beams.push({
            x1: u.x + Math.cos(angle) * 20, y1: u.y + Math.sin(angle) * 20,
            x2: u.x + Math.cos(angle) * (u.r + 62), y2: u.y + Math.sin(angle) * (u.r + 62),
            life: 0.16, maxLife: 0.16, color: '#ffffff', width: 14,
          });
          this.applyDamage(u, target, atkRes);
          u.fighter.consumeHitBuffs();
        } else if (w.kind === 'projectile' && dist > u.range) {
          u.fighter.fireWeapon();
          // 预判投掷：瞄准目标当前位置 + 一段速度提前量（确定性）
          const flight = dist / (w.speed ?? 400);
          const tx = target.x + target.vx * flight * 0.6;
          const ty = target.y + target.vy * flight * 0.6;
          st.projectiles.push({
            ownerUid: u.uid, side: u.side, weaponName: w.name,
            damage: Math.max(1, Math.round(w.damage * u.fighter.effAtkMult * (w.mult ?? 1))),
            speed: w.speed ?? 400, sx: u.x, sy: u.y, tx, ty,
            t: 0, totalTime: Math.max(0.35, Math.hypot(tx - u.x, ty - u.y) / (w.speed ?? 400)),
            arc: Boolean(w.arc), life: 6,
          });
          st.events.push({ type: 'projectile', t: st.t, unit: u.def.id, weapon: w.name });
          u.fighter.consumeHitBuffs();
        }
      }
      // ===== 角色机制：毒气尾迹 / 骑车冲刺（5 秒必摔）/ 外卖轮盘 =====
      const gas = u.def.gasTrail;
      if (gas && u.stunT <= 0) {
        u.gasT -= sdt;
        if (u.gasT <= 0) {
          const cadence = u.bikeT > 0 ? (u.def.bikeRush?.gasEvery ?? gas.every) : gas.every;
          u.gasT += cadence;
          // 身后 = 速度反方向（基本静止时用面朝反方向）
          const spd0 = Math.hypot(u.vx, u.vy);
          const bx = spd0 > 40 ? -u.vx / spd0 : -u.facing;
          const by = spd0 > 40 ? -u.vy / spd0 : 0;
          st.gases.push({
            ownerUid: u.uid,
            side: u.side,
            x: u.x + bx * u.r * 0.9,
            y: u.y + by * u.r * 0.9,
            r: gas.radius,
            life: gas.dur,
            maxLife: gas.dur,
            damage: Math.max(1, Math.round(gas.damage * u.fighter.effAtkMult)),
            tickT: gas.tick ?? 0.5,
            tickEvery: gas.tick ?? 0.5,
          });
          st.events.push({ type: 'gas', t: st.t, unit: u.def.id });
        }
      }

      const bike = u.def.bikeRush;
      if (bike && u.stunT <= 0) {
        if (u.bikeT > 0) {
          u.bikeT -= sdt;
          // 骑行尘土：真速度上来后脚下甩土，速度感的数据来源（确定性 rng）
          if (Math.hypot(u.vx, u.vy) > 320 && st.rng.next() < sdt * 14) {
            const spd1 = Math.hypot(u.vx, u.vy) || 1;
            this.spawnBurst(u.x - (u.vx / spd1) * u.r, u.y - (u.vy / spd1) * u.r + u.r * 0.7, '#5b6472', 2, 90, 'dust');
          }
          if (u.bikeT <= 0) {
            // 骑车到时：必定摔倒——固定自伤 + 眩晕（喜剧保险丝）
            u.fighter.removeBuffByLabel('骑车冲刺');
            u.stunT = bike.crashStun;
            u.hp -= bike.crashDamage;
            st.popups.push(mkPopup('down', u.x, u.y - 170, `摔倒 -${bike.crashDamage}`, 1, '#ff6b81', 42));
            this.spawnBurst(u.x, u.y, '#ffd32a', 12, 220, 'frag');
            st.shake = Math.min(34, st.shake + 16);
            st.events.push({ type: 'crash', t: st.t, unit: u.def.id });
            if (u.hp <= 0) this.onLethal(u, u);
          }
        } else {
          u.bikeCd -= sdt;
          if (u.bikeCd <= 0) {
            u.bikeCd += bike.every;
            u.bikeT = bike.dur;
            u.fighter.addBuff({
              label: '骑车冲刺',
              atkMult: 1,
              intervalMult: 1,
              speedMult: bike.speedMult,
              remainingHits: -1,
              remainingTime: bike.dur,
            });
            st.feed.push({ text: `${u.name} 骑上小单车狂飙！`, life: 2.5 });
            st.events.push({ type: 'bike', t: st.t, unit: u.def.id });
          }
        }
      }

      const tk = u.def.takeout;
      if (tk && u.stunT <= 0) {
        // 派单间隔吃 intervalMult：爆单模式 = 外卖来得更快
        u.takeoutT -= sdt * u.fighter.effIntervalMult;
        if (u.takeoutT <= 0) {
          u.takeoutT += tk.every;
          const item = tk.items[u.takeoutIdx % tk.items.length];
          u.takeoutIdx += 1;
          const flight = dist / (tk.speed ?? 460);
          const tx2 = target.x + target.vx * flight * 0.6;
          const ty2 = target.y + target.vy * flight * 0.6;
          st.projectiles.push({
            ownerUid: u.uid,
            side: u.side,
            weaponName: item.name,
            damage: Math.max(1, Math.round(item.damage * u.fighter.effAtkMult)),
            speed: tk.speed ?? 460,
            sx: u.x,
            sy: u.y,
            tx: tx2,
            ty: ty2,
            t: 0,
            totalTime: Math.max(0.35, Math.hypot(tx2 - u.x, ty2 - u.y) / (tk.speed ?? 460)),
            arc: true,
            life: 6,
            label: item.name,
            color: TAKEOUT_COLORS[(u.takeoutIdx - 1) % TAKEOUT_COLORS.length],
            sprite: item.sprite,
            slowSec: item.slowSec,
            slowMult: item.slowMult,
          });
          st.events.push({ type: 'takeout', t: st.t, unit: u.def.id, item: item.name });
          u.fighter.consumeHitBuffs();
        }
      }

      this.clampArena(u);
    }
  }

  private clampArena(u: Unit): void {
    const st = this.st;
    // 撞墙灰尘（速度够快才出效果）
    const dust = (x: number, y: number): void => {
      this.spawnBurst(x, y, '#8ea0c0', 6, 110, 'dust');
    };
    // 墙壁反弹
    if (u.x - u.r < ARENA.left) {
      u.x = ARENA.left + u.r;
      if (u.vx < 0) {
        st.events.push({ type: 'wall', t: st.t, unit: u.def.id, wall: 'left', speed: Math.abs(u.vx) });
        if (Math.abs(u.vx) > 240) dust(u.x - u.r, u.y);
        u.vx = -u.vx * st.phys.wallRestitution;
      }
    } else if (u.x + u.r > ARENA.right) {
      u.x = ARENA.right - u.r;
      if (u.vx > 0) {
        st.events.push({ type: 'wall', t: st.t, unit: u.def.id, wall: 'right', speed: Math.abs(u.vx) });
        if (Math.abs(u.vx) > 240) dust(u.x + u.r, u.y);
        u.vx = -u.vx * st.phys.wallRestitution;
      }
    }
    if (u.y - u.r < ARENA.top) {
      u.y = ARENA.top + u.r;
      if (u.vy < 0) {
        st.events.push({ type: 'wall', t: st.t, unit: u.def.id, wall: 'top', speed: Math.abs(u.vy) });
        if (Math.abs(u.vy) > 240) dust(u.x, u.y - u.r);
        u.vy = -u.vy * st.phys.wallRestitution;
      }
    } else if (u.y + u.r > ARENA.bottom) {
      u.y = ARENA.bottom - u.r;
      if (u.vy > 0) {
        st.events.push({ type: 'wall', t: st.t, unit: u.def.id, wall: 'bottom', speed: Math.abs(u.vy) });
        if (Math.abs(u.vy) > 240) dust(u.x, u.y + u.r);
        u.vy = -u.vy * st.phys.wallRestitution;
      }
    }
  }

  /** 球-球弹性碰撞：位置修正 + 冲量弹开 */
  private resolveCollisions(): void {
    const st = this.st;
    const alive = st.units.filter((u) => u.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.hypot(dx, dy);
        const minD = a.r + b.r;
        if (d >= minD || d < 0.001) continue;
        const nx = dx / d;
        const ny = dy / d;
        const overlap = (minD - d) / 2;
        a.x -= nx * overlap;
        a.y -= ny * overlap;
        b.x += nx * overlap;
        b.y += ny * overlap;
        const relV = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (relV < 0) {
          const imp = (-(1 + st.phys.restitution) * relV) / 2; // 等质量
          a.vx -= imp * nx;
          a.vy -= imp * ny;
          b.vx += imp * nx;
          b.vy += imp * ny;
          // 碰撞后进入分离驱动：沿法线加速弹开，抑制追逐（参考弹珠对战的分离节奏）
          a.sepT = st.phys.separationTime;
          a.sepNx = -nx;
          a.sepNy = -ny;
          a.chaseCd = st.phys.separationTime + 0.6;
          b.sepT = st.phys.separationTime;
          b.sepNx = nx;
          b.sepNy = ny;
          b.chaseCd = st.phys.separationTime + 0.6;
          st.events.push({
            type: 'collision',
            t: st.t,
            a: a.def.id,
            b: b.def.id,
            speed: -relV,
            x: a.x + nx * (a.r + overlap),
            y: a.y + ny * (a.r + overlap),
          });
        }
      }
    }
  }

  /** 地图机关：弹板（强弹开）与加速带（方向冲量，带冷却） */
  private resolveMechanisms(): void {
    const st = this.st;
    if (st.arena.bumpers.length === 0 && st.arena.boosts.length === 0) return;
    for (const u of st.units) {
      if (!u.alive) continue;
      for (const bp of st.arena.bumpers) {
        if (u.bumperCd > 0) continue;
        const dx = u.x - bp.x;
        const dy = u.y - bp.y;
        const d = Math.hypot(dx, dy);
        const minD = bp.r + u.r;
        if (d >= minD || d < 0.001) continue;
        const nx = dx / d;
        const ny = dy / d;
        u.x = bp.x + nx * minD;
        u.y = bp.y + ny * minD;
        const vn = u.vx * nx + u.vy * ny;
        if (vn < 0) {
          u.vx -= 1.8 * vn * nx; // 高弹性 + 额外冲量
          u.vy -= 1.8 * vn * ny;
          u.vx += nx * 180;
          u.vy += ny * 180;
          u.bumperCd = 0.25;
          st.events.push({ type: 'bumper', t: st.t, unit: u.def.id, speed: -vn });
        }
      }
      if (u.boostCd > 0) continue;
      for (const z of st.arena.boosts) {
        if (u.x > z.x && u.x < z.x + z.w && u.y > z.y && u.y < z.y + z.h) {
          // 加速方向：沿"场地中心 → 单位"的径向向外
          const cx = u.x - (ARENA.left + ARENA.right) / 2;
          const cy = u.y - (ARENA.top + ARENA.bottom) / 2;
          const cd = Math.hypot(cx, cy) || 1;
          u.vx += (cx / cd) * 430;
          u.vy += (cy / cd) * 430;
          u.boostCd = 0.7;
          st.events.push({ type: 'boost', t: st.t, unit: u.def.id, speed: 430 });
          break;
        }
      }
    }
  }

  /** 飞行道具推进与命中结算：命中判定确定性（过点即中），伤害固定 */
  private updateProjectiles(dt: number): void {
    const st = this.st;
    for (const pr of st.projectiles) pr.life -= dt;
    const alive: Projectile[] = [];
    for (const pr of st.projectiles) {
      if (pr.life <= 0) continue;
      if (pr.meme) {
        pr.meme.delay -= dt;
        if (pr.meme.delay > 1e-9) { alive.push(pr); continue; }
        if (!pr.meme.launched) {
          pr.meme.launched = true;
          const target = st.units.find((u) => u.side !== pr.side);
          if (target) { pr.tx = target.x + (pr.meme.volleyOffset?.x ?? 0); pr.ty = target.y + (pr.meme.volleyOffset?.y ?? 0); }
          pr.totalTime = Math.max(pr.meme.kind === 'eggs' ? 0.9 : 0.65, Math.hypot(pr.tx - pr.sx, pr.ty - pr.sy) / pr.speed);
          pr.life = pr.totalTime + 0.1;
        }
        const previous = memeProjectilePosition(pr);
        pr.t = Math.min(1, pr.t + dt / pr.totalTime);
        const point = memeProjectilePosition(pr);
        const target = st.units.find((u) => {
          if (!u.alive || u.side === pr.side) return false;
          const dx = point.x - previous.x, dy = point.y - previous.y;
          const length2 = dx * dx + dy * dy;
          const t = length2 > 0 ? Math.max(0, Math.min(1, ((u.x - previous.x) * dx + (u.y - previous.y) * dy) / length2)) : 0;
          return Math.hypot(u.x - previous.x - dx * t, u.y - previous.y - dy * t) <= u.r + pr.meme!.radius;
        });
        if (target || pr.t >= 1) {
          if (target) {
            const owner = st.units.find((u) => u.uid === pr.ownerUid)!;
            if (st.units.every((u) => u.alive)) this.applyDamage(owner, target, a2r({ name: pr.weaponName }, pr.damage, 1));
          } else st.popups.push(mkPopup('block', point.x, point.y - 50, '落空', 1, '#aaaaaa', 28));
          // 固定方向的蛋壳碎片 / 分身星光，只是演出，不消耗战斗 RNG。
          for (let i = 0; i < 12; i++) {
            const angle = i * Math.PI * 2 / 12;
            st.particles.push({ x: point.x, y: point.y, vx: Math.cos(angle) * 180, vy: Math.sin(angle) * 180, life: 0.6, maxLife: 0.6, size: pr.meme.kind === 'eggs' ? 9 : 5, color: pr.meme.kind === 'eggs' ? '#ffe1ae' : '#ffb347', kind: 'frag' });
          }
          st.shocks.push({ x: point.x, y: point.y, r: 15, maxR: 120, life: 0.4, maxLife: 0.4, color: pr.color ?? '#ffffff' });
          continue;
        }
        alive.push(pr); continue;
      }
      pr.t += dt / pr.totalTime;
      const x = pr.sx + (pr.tx - pr.sx) * pr.t;
      const y = pr.sy + (pr.ty - pr.sy) * pr.t;
      // 尾迹
      if (st.rng.next() < dt * 30) {
        st.particles.push({ x, y, vx: st.rng.range(-20, 20), vy: st.rng.range(-20, 20), life: 0.35, maxLife: 0.35, size: 3.5, color: pr.side === 0 ? '#ffb4a2' : '#c4b5fd', kind: 'spark' });
      }
      // 命中：道具落点接近任意敌方单位
      const target = st.units.find((u) => u.alive && u.side !== pr.side && Math.hypot(u.x - x, u.y - y) < u.r + 26);
      if (target) {
        const owner = st.units.find((u) => u.uid === pr.ownerUid);
        if (owner) {
          this.applyDamage(owner, target, a2r({ name: pr.weaponName }, pr.damage, owner.fighter.effAtkMult));
          // 冰饮类外卖：命中减速（固定倍率固定时长，入 buff 链）
          if (pr.slowSec && pr.slowSec > 0) {
            target.fighter.addBuff({
              label: `${pr.label ?? '冰饮'}冰凉`,
              atkMult: 1,
              intervalMult: 1,
              speedMult: pr.slowMult ?? 0.75,
              remainingHits: -1,
              remainingTime: pr.slowSec,
            });
          }
          this.spawnBurst(x, y, pr.color ?? '#ffd32a', 8, 160, 'spark');
        }
        continue;
      }
      if (pr.t >= 1) {
        this.spawnBurst(pr.tx, pr.ty, '#8ea0c0', 6, 120, 'dust');
        continue;
      }
      alive.push(pr);
    }
    st.projectiles = alive;
  }

  /** 毒气云演化与结算：敌方入云按固定间隔掉血（silent：只掉血不刷屏） */
  private updateGases(dt: number): void {
    const st = this.st;
    const alive: GasCloud[] = [];
    for (const g of st.gases) {
      g.life -= dt;
      if (g.life <= 0) continue;
      g.tickT -= dt;
      if (g.tickT <= 0) {
        g.tickT += g.tickEvery;
        const owner = st.units.find((u) => u.uid === g.ownerUid);
        for (const v of st.units) {
          if (!v.alive || v.side === g.side) continue;
          if (Math.hypot(v.x - g.x, v.y - g.y) > g.r + v.r * 0.5) continue;
          if (owner) {
            this.applyDamage(
              owner,
              v,
              { damage: g.damage, rhythmMult: 1, crit: false, skill: null, healAmount: 0, shieldAmount: 0, totalAtkMult: 1 },
              { silent: true },
            );
          }
        }
      }
      alive.push(g);
    }
    st.gases = alive;
  }

  private spawnBurst(x: number, y: number, color: string, n: number, power: number, kind: Particle['kind']): void {
    const st = this.st;
    if (st.particles.length > 380) return; // 防爆内存
    for (let i = 0; i < n; i++) {
      const a = st.rng.range(0, Math.PI * 2);
      const p = power * st.rng.range(0.4, 1.15);
      st.particles.push({
        x,
        y,
        vx: Math.cos(a) * p,
        vy: Math.sin(a) * p - power * 0.25,
        life: st.rng.range(0.4, 0.85),
        maxLife: 0.85,
        size: kind === 'frag' ? st.rng.range(5, 11) : st.rng.range(2.5, 6),
        color,
        kind,
      });
    }
  }

  private attack(a: Unit, b: Unit, angle: number): void {
    const st = this.st;
    // 确定性出招：伤害 = round(atk × Πbuff固定倍率 × 连击/技能倍率)，零随机
    const atk = a.fighter.nextAttack();
    if (atk.healAmount > 0) {
      const healed = Math.min(a.maxHp - a.hp, atk.healAmount);
      a.hp += healed;
      if (healed > 0) st.popups.push(mkPopup('heal', a.x - 140, a.y - 120, `+${fmt(healed)}`, 1, '#4ade80', 34));
    }
    if (atk.shieldAmount > 0) {
      a.shield += atk.shieldAmount;
      st.popups.push(mkPopup('shield', a.x + 150, a.y - 120, `护盾 ${fmt(a.shield)}`, 1, '#a5b4fc', 30));
    }
    a.punchT = 0.22;
    a.punchAngle = angle;
    this.applyDamage(a, b, atk);
  }

  /** 统一伤害结算。opts.silent = 毒气等环境伤害：只掉血，不出弹窗/震屏/击退/事件（防刷屏） */
  applyDamage(a: Unit, b: Unit, atk: AttackResult, opts?: { silent?: boolean }): void {
    const st = this.st;
    const silent = opts?.silent ?? false;
    const dmg = st.ep.combat?.mode === 'readable'
      ? Math.max(0, atk.damage - Math.round(b.def.defense ?? 0))
      : atk.damage;
    const crit = atk.crit;
    const skillName = atk.skill?.name ?? null;
    if (!silent && atk.skill) {
      // 技能光束：从攻击者到目标的发光弹道
      st.beams.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, life: 0.2, maxLife: 0.2, color: '#7dd3fc', width: 9 });
      // 技能名标签（垂直贴身时往侧面放飞，避免压住另一单位的名牌）
      const ddx0 = b.x - a.x;
      const ddy0 = b.y - a.y;
      if (Math.abs(ddy0) > Math.abs(ddx0)) {
        const side = ddx0 >= 0 ? 1 : -1;
        st.popups.push(mkPopup('skill', a.x + side * (150 + st.rng.range(0, 60)), a.y - 110, skillName ?? '', 1, '#7dd3fc', 36));
      } else {
        st.popups.push(mkPopup('skill', a.x, a.y - 210, skillName ?? '', 1, '#7dd3fc', 36));
      }
    }
    let d = dmg;
    if (b.shield > 0) {
      const absorbed = Math.min(b.shield, d);
      b.shield -= absorbed;
      d -= absorbed;
      if (absorbed > 0 && !silent) {
        b.blockT = 0.38;
        st.events.push({
          type: 'block',
          t: st.t,
          attacker: a.def.id,
          victim: b.def.id,
          absorbed,
          broken: b.shield <= 0,
          x: b.x,
          y: b.y,
        });
        if (b.shield <= 0) {
          st.popups.push(mkPopup('block', b.x, b.y - 230, '盾碎！', 1, '#fbbf24', 42));
          st.shocks.push({ x: b.x, y: b.y, r: 18, maxR: 145, life: 0.36, maxLife: 0.36, color: '#93c5fd' });
        }
      }
      if (d <= 0 && !silent) {
        st.popups.push(mkPopup('block', b.x + st.rng.range(-24, 24), b.y - 195, `${fmt(dmg)} 格挡`, atk.rhythmMult * atk.totalAtkMult, '#94a3b8', 32));
      }
    }
    b.hp -= d;
    b.hitFlash = silent ? 0.06 : 0.15;
    // 受击火花（伤害越大越密集；毒气只留一点绿雾感）
    if (silent) {
      this.spawnBurst(b.x, b.y, '#4ade80', 3, 60, 'spark');
    } else {
      this.spawnBurst(b.x, b.y, crit ? '#ffd32a' : '#ffffff', Math.min(12, 4 + Math.floor(Math.log10(dmg + 1) * 2)), 90 + Math.log10(dmg + 1) * 55, 'spark');
    }

    if (!silent) {
      if (st.ep.combat?.mode !== 'readable') {
      // 击退：普通攻击 = 加冲量（会被来袭速度抵消，全局 phys.knockback 缩水）；
      // 武器强击退（kbMult>1，如大脚踹 5 倍）= 定向设定离向速度：不被抵消、不吃全局系数，飞多远直接可预期
      const kd = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const kbMult = atk.kbMult ?? 1;
      if (kbMult > 1) {
        const launch = Math.min(1200, (45 + Math.log10(dmg + 1) * 85) * kbMult);
        const lnx = (b.x - a.x) / kd;
        const lny = (b.y - a.y) / kd;
        b.vx = lnx * launch;
        b.vy = lny * launch;
        b.launchT = 0.85;
        // 强击退演出三件套：空中翻滚角速度（主轴方向决定顺/逆时针）+ 冲击波 + hit-stop 白闪
        b.spinA = 0;
        const sdir = Math.abs(lnx) > Math.abs(lny) ? Math.sign(lnx) : -Math.sign(lny);
        b.spinV = (sdir || 1) * st.rng.range(9, 14);
        st.shocks.push({ x: b.x, y: b.y, r: 20, maxR: 90 + launch * 0.28, life: 0.42, maxLife: 0.42, color: '#ffffff' });
        st.slowmo = Math.max(st.slowmo, 0.22);
        st.flash = Math.max(st.flash, 0.5);
        st.shake = Math.min(40, st.shake + 18);
      } else {
        const kb = Math.min(430, 45 + Math.log10(dmg + 1) * 85) * st.phys.knockback;
        b.vx += ((b.x - a.x) / kd) * kb;
        b.vy += ((b.y - a.y) / kd) * kb;
      }
      a.vx -= ((b.x - a.x) / kd) * 30 * st.phys.knockback;
      a.vy -= ((b.y - a.y) / kd) * 30 * st.phys.knockback;
      }

      const size = crit ? 62 + Math.log10(dmg + 1) * 5 : 42 + Math.log10(dmg + 1) * 5;
      // 暴击：金色贯穿光束
      if (crit) {
        st.beams.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, life: 0.24, maxLife: 0.24, color: '#ffd32a', width: 7 });
      }
      // 倍率徽章：技能/暴击倍率 × 全局攻击倍率（狂暴/突然死亡），突出纯粹的倍数冲击
      const shownMult = atk.rhythmMult * atk.totalAtkMult;
      // 简明模式伤害数字固定出现在受击者旁；旧模式保留散开演出。
      const ddx = b.x - a.x;
      const ddy = b.y - a.y;
      let px: number;
      let py: number;
      if (st.ep.combat?.mode === 'readable') {
        px = b.x + (b.side === 0 ? -100 : 100);
        py = b.y - 160;
      } else if (Math.abs(ddy) > Math.abs(ddx)) {
        const side = ddx >= 0 ? 1 : -1;
        px = b.x + side * (150 + st.rng.range(0, 80));
        py = b.y - 110 - st.rng.range(0, 40);
      } else {
        px = b.x + st.rng.range(-38, 38);
        py = b.y - 185 - st.rng.range(0, 48);
      }
      const avoided = avoidOverlap(st, px, py);
      st.popups.push(mkPopup(crit ? 'crit' : 'damage', avoided.x, avoided.y, fmt(dmg), shownMult, crit ? '#ffd32a' : '#ffffff', size));
      st.shake = Math.min(34, st.shake + 3 + Math.log10(dmg + 1) * 3.2);
    }

    a.totalDamage += dmg;
    if (dmg > a.biggestHit) a.biggestHit = dmg;

    if (!silent) {
      const shownMult2 = atk.rhythmMult * atk.totalAtkMult;
      if (shownMult2 > a.biggestMult) a.biggestMult = shownMult2;
      const ev: GameEvent = {
        type: 'attack',
        t: st.t,
        attacker: a.def.id,
        victim: b.def.id,
        dmg,
        mult: shownMult2,
        skill: skillName,
        crit,
      };
      st.events.push(ev);
      if (crit) st.events.push({ type: 'crit', t: st.t, attacker: a.def.id, victim: b.def.id, dmg, mult: shownMult2 });
    }

    if (b.hp <= 0) this.onLethal(a, b);
  }

  private onLethal(killer: Unit, victim: Unit): void {
    const st = this.st;
    victim.hp = 0;
    victim.alive = false;
    // 反转系统有机会先救人（fighterDead 触发器）
    evalTwists(this);
    if (victim.alive) return; // 被复活了
    // 死亡碎片爆开
    this.spawnBurst(victim.x, victim.y, victim.color, 16, 320, 'frag');
    st.popups.push(mkPopup('down', victim.x, victim.y - 140, '击倒!', 1, '#ff6b81', 46));
    killer.kills += 1;
    st.feed.push({ text: `${killer.name} 击倒了 ${victim.name}`, life: 3.2 });
    st.events.push({ type: 'death', t: st.t, unit: victim.def.id, killer: killer.def.id });
  }

  /** 突然死亡：时限到双方存活 → 全体攻击倍率暴涨 */
  private checkSuddenDeath(): void {
    const st = this.st;
    if (st.suddenDeathFired || !st.ep.timeLimit) return;
    if (st.fightT < st.ep.timeLimit) return;
    const side0 = st.units.some((u) => u.side === 0 && u.alive);
    const side1 = st.units.some((u) => u.side === 1 && u.alive);
    if (!side0 || !side1) return;
    st.suddenDeathFired = true;
    const m = st.ep.suddenDeathAtkMultiplier ?? 8;
    for (const u of st.units) {
      if (u.alive)
        u.fighter.addBuff({
          label: '突然死亡',
          atkMult: m,
          intervalMult: 1,
          speedMult: 1,
          remainingHits: -1,
          remainingTime: -1,
        });
    }
    st.banners.push({ text: '突然死亡', life: 2.4, maxLife: 2.4, color: '#ff4757' });
    st.captions.push({ t: st.t, dur: 3.2, text: '时限已到，双方攻击力暴涨，谁先倒下？！', gold: true });
    st.flash = 1;
    st.slowmo = 1.2;
    st.feed.push({ text: `突然死亡：全体攻击 x${m}`, life: 4 });
  }

  private checkEnd(): void {
    const st = this.st;
    if (st.phase !== 'fight') return;
    const side0 = st.units.some((u) => u.side === 0 && u.alive);
    const side1 = st.units.some((u) => u.side === 1 && u.alive);
    if (side0 && side1) return;
    // 已开播的猫 meme 原视频与原声完整播完，再进入结算；不再启动新技能。
    if (st.units.some((u) => u.def.memeSkill && u.meme.elapsed !== null)) return;
    st.phase = 'end';
    st.endT = 0;
    st.winner = side0 ? 0 : side1 ? 1 : -1;
    // 击杀镜头：慢放 + 特写倒地位置（结算阶段先停留再滑回全景）
    const dead = st.units.find((u) => !u.alive);
    if (dead && st.winner !== -1 && !st.units.some((u) => u.def.memeSkill)) {
      st.endFocusY = Math.min(944, Math.max(926, dead.y));
      st.zoomY = st.endFocusY;
      st.slowmo = 1.1;
    } else {
      st.slowmo = 0;
      st.zoomX = W / 2;
      st.zoomY = H * 0.52;
    }
    // 结算清场：击杀瞬间的横幅/弹窗/字幕不穿透结算卡
    st.popups = [];
    st.banners = [];
    st.feed = [];
    st.captions = [];
    if (st.rail?.echo) st.rail.echo.images = [];
    st.feed.push({ text: '战斗结束', life: 3 });
    st.events.push({ type: 'phase', t: st.t, name: 'end' });
  }

  /** 供 twists.ts 调用：生成援军 */
  spawnUnit(def: FighterDef, side: 0 | 1): Unit {
    const st = this.st;
    const u = makeUnit(st.ep, def, side, st);
    u.y = side === 0 ? ARENA.bottom - 150 : ARENA.top + 150;
    u.x = st.rng.range(ARENA.left + 80, ARENA.right - 80);
    st.units.push(u);
    st.popups.push(mkPopup('up', u.x, u.y - 205, '援军入场', 1, '#ffd32a', 40));
    st.feed.push({ text: `${def.name} 加入战场！`, life: 3.2 });
    return u;
  }
}

/** 武器攻击的统一 AttackResult 构造（伤害固定，走统一结算管线；武器可带击退倍率） */
function a2r(w: { name: string; knockback?: number }, damage: number, totalAtkMult: number): AttackResult {
  return { damage, rhythmMult: 1, crit: false, skill: { name: w.name, every: 1, multiplier: 1 }, healAmount: 0, shieldAmount: 0, totalAtkMult, kbMult: w.knockback ?? 1 };
}

/** 外卖袋配色（按菜单顺序轮转） */
const TAKEOUT_COLORS = ['#ffb347', '#7dd3fc', '#ff6b81', '#f9a8d4', '#facc15', '#86efac'] as const;

export function mkPopup(
  kind: PopupKind,
  x: number,
  y: number,
  text: string,
  mult: number,
  color: string,
  size: number,
): Popup {
  const maxLife = kind === 'skill' ? 0.9 : 1.0;
  // 出生点钳制在场地面板内，避免飘出面板被画布裁切
  const cx = Math.min(910, Math.max(170, x));
  const cy = Math.min(1480, Math.max(200, y));
  return { kind, x: cx, y: cy, text, mult, life: maxLife, maxLife, color, size };
}

/** 同点数字避让：与最近生成的存活弹窗重叠时向两侧错开 */
function avoidOverlap(st: BattleState, x: number, y: number): { x: number; y: number } {
  let px = x;
  const py = y;
  let side = 1;
  for (let i = st.popups.length - 1; i >= 0 && i >= st.popups.length - 4; i--) {
    const p = st.popups[i];
    if (p.life < p.maxLife - 0.4) continue; // 只避让刚出生的
    if (Math.abs(p.x - px) < 80 && Math.abs(p.y - py) < 46) {
      px = p.x + side * 105;
      side = -side;
    }
  }
  return { x: Math.min(930, Math.max(120, px)), y: py };
}
