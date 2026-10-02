/**
 * 角色抽象：出招与增益。
 * 设计原则（2026-09 与作者对齐）：
 * 1. 伤害是纯函数，零随机——damage = round(atk × Πbuff固定倍率 × 本次节奏倍率)
 *    同一状态下每一刀的数字永远相同，观众可以学会并预判。
 * 2. 暴击去概率化：改为角色固定的连击序列（如 [1,1,1,2.2]），序列轮转，
 *    倍率 >1.5 的拍子按"暴击"演出（金色大数字/重音效）。
 * 3. 状态增强 = StatusEffect：固定倍数 + 固定持续（按命中数 remainingHits 或
 *    秒数 remainingTime，-1 表示无限）。叠加为乘法链，施加顺序即结算顺序。
 *
 * 职责边界：Fighter 管"出招与增益"（攻击协议、连击、技能冷却、buff）；
 * Unit（sim.ts）管"肉体"（位置、物理、血量容器、视觉状态）。
 */
import type { FighterDef, SkillDef } from './types';

export interface StatusEffect {
  /** 展示名（dry 战报/悬浮标识用） */
  label: string;
  atkMult: number;
  intervalMult: number;
  speedMult: number;
  /** 按命中数衰减：每次攻击后 -1；-1 = 不按命中衰减 */
  remainingHits: number;
  /** 按秒衰减：tick 递减；-1 = 不按时间衰减 */
  remainingTime: number;
}

export interface AttackResult {
  /** 最终整数伤害：atk × Πbuff × 节奏/技能倍率，同状态恒定 */
  damage: number;
  /** 本次拍子的倍率（连击序列值或技能倍率），用于倍率徽章 */
  rhythmMult: number;
  /** 连击序列标记的重击（≥1.5），按暴击演出 */
  crit: boolean;
  skill: SkillDef | null;
  /** 技能自疗/自盾量（立即生效，仅展示用） */
  healAmount: number;
  shieldAmount: number;
  /** Πbuff 攻击倍率快照（= damage / (atk × rhythmMult)，供徽章） */
  totalAtkMult: number;
  /** 击退倍率（武器自带，如大脚踹 5 倍击飞），缺省 1 */
  kbMult?: number;
}

export class Fighter {
  readonly def: FighterDef;
  readonly uid: number;
  readonly combo: number[];
  buffs: StatusEffect[] = [];
  comboIndex = 0;
  private skills: Array<{ def: SkillDef; cd: number }>;
  /** 武器冷却剩余秒数（FighterDef.weapon 存在时有效） */
  weaponCd = 0;

  constructor(def: FighterDef, uid: number) {
    this.def = def;
    this.uid = uid;
    this.combo = def.combo && def.combo.length > 0 ? def.combo : [1];
    // 技能初始冷却：uid 决定的固定偏移（非随机），保证同剧本同角色时序稳定
    this.skills = (def.skills ?? []).map((d, i) => ({ def: d, cd: 0.8 + ((uid * 7 + i * 3) % 9) * 0.12 }));
  }

  get effAtkMult(): number {
    return this.buffs.reduce((m, b) => m * b.atkMult, 1);
  }
  get effIntervalMult(): number {
    return this.buffs.reduce((m, b) => m * b.intervalMult, 1);
  }
  get effSpeedMult(): number {
    return this.buffs.reduce((m, b) => m * b.speedMult, 1);
  }

  addBuff(b: StatusEffect): void {
    this.buffs.push(b);
  }

  /** 武器就绪判定与重置（冷却由 tick 递减） */
  weaponReady(): boolean {
    return Boolean(this.def.weapon) && this.weaponCd <= 0;
  }
  fireWeapon(): void {
    this.weaponCd = this.def.weapon?.every ?? 1e9;
  }

  removeBuffByLabel(label: string): void {
    this.buffs = this.buffs.filter((b) => b.label !== label);
  }

  /** 每逻辑步调用：技能冷却、武器冷却与按时长 buff 的衰减（-1 = 无限，不衰减） */
  tick(dt: number): void {
    if (this.weaponCd > 0) this.weaponCd -= dt;
    for (const s of this.skills) s.cd -= dt;
    for (const b of this.buffs) {
      if (b.remainingTime > 0) b.remainingTime = Math.max(0, b.remainingTime - dt);
    }
    this.buffs = this.buffs.filter((b) => b.remainingTime !== 0);
  }

  /**
   * 出下一招（确定性）：
   * - 技能冷却转好 → 技能拍（不消耗连击游标）
   * - 否则连击序列下一拍，倍率 ≥1.5 记为暴击演出
   * - 攻击型 buff 的 remainingHits 在出招时衰减
   */
  nextAttack(): AttackResult {
    for (const s of this.skills) {
      if (s.cd <= 0) {
        s.cd = s.def.every;
        const total = this.effAtkMult;
        const damage = Math.max(1, Math.round(this.def.atk * total * s.def.multiplier));
        let healAmount = 0;
        let shieldAmount = 0;
        if (s.def.healPct) healAmount = this.def.hp * s.def.healPct;
        if (s.def.shieldPct) shieldAmount = this.def.hp * s.def.shieldPct;
        this.decayHits();
        return { damage, rhythmMult: s.def.multiplier, crit: false, skill: s.def, healAmount, shieldAmount, totalAtkMult: total };
      }
    }
    const rhythmMult = this.combo[this.comboIndex % this.combo.length];
    this.comboIndex++;
    const total = this.effAtkMult;
    // 倍率为 0 的拍子是真空拍（e^iπ+1=0 的末项）：伤害 0，保底 1 只留给正常拍
    const damage = rhythmMult === 0 ? 0 : Math.max(1, Math.round(this.def.atk * total * rhythmMult));
    this.decayHits();
    return { damage, rhythmMult, crit: rhythmMult >= 1.5, skill: null, healAmount: 0, shieldAmount: 0, totalAtkMult: total };
  }

  private decayHits(): void {
    for (const b of this.buffs) {
      if (b.remainingHits >= 0) b.remainingHits -= 1;
    }
    this.buffs = this.buffs.filter((b) => b.remainingHits < 0 || b.remainingHits > 0);
  }

  /** 近战之外的出手（武器/弹幕）：按次增益同样在出手时衰减（伤害已按出手时倍率锁定） */
  consumeHitBuffs(): void {
    this.decayHits();
  }
}
