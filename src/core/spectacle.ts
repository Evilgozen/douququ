/**
 * 对局观赏性评分。
 *
 * 目标不是判断策略强弱，而是替日更流水线从大量确定性 seed 中挑出更值得看的对局：
 * 有领先交换、有残血阶段、结尾接近，同时避免长时间无伤害和单方面碾压。
 * 评分只读取 Battle 状态和结构化事件，不依赖渲染器、Lua 或音频。
 */
import { Battle, LOGIC_DT, type GameEvent, type Unit } from './sim';
import type { Episode } from './types';

export interface SpectacleMetrics {
  duration: number;
  winner: -1 | 0 | 1 | null;
  leadChanges: number;
  lowHpSeconds: number;
  idleSeconds: number;
  balance: number;
  winnerHpPct: number;
  damageEvents: number;
  crits: number;
  skills: number;
  deaths: number;
}

export interface SpectacleResult {
  seed: number;
  score: number;
  metrics: SpectacleMetrics;
}

export interface ScoutOptions {
  count: number;
  /** 缺省从剧本 seed 开始连续搜索。 */
  startSeed?: number;
  /** 连续 seed 最容易理解，也便于复现；需要稀疏采样时可覆盖。 */
  seedStep?: number;
  maxSeconds?: number;
}

function sideHp(units: Unit[], side: 0 | 1): { hp: number; max: number } {
  let hp = 0;
  let max = 0;
  for (const u of units) {
    if (u.side !== side) continue;
    hp += Math.max(0, u.hp) + Math.max(0, u.shield);
    max += u.maxHp;
  }
  return { hp, max: Math.max(1, max) };
}

function scoreMetrics(m: SpectacleMetrics): number {
  // 领先交换是最强的反转信号；封顶避免来回抖动的局刷爆分数。
  let score = Math.min(4, m.leadChanges) * 15;
  score += Math.min(12, m.lowHpSeconds) * 1.6;
  score += m.balance * 18;
  // 胜者也残血时，最后一击通常更有悬念。
  score += (1 - Math.min(1, m.winnerHpPct)) * 18;
  score += Math.min(10, m.crits) * 0.8;
  score += Math.min(12, m.skills) * 0.45;
  score += Math.min(4, m.deaths) * 1.5;
  score += Math.min(30, m.damageEvents) * 0.12;
  score -= m.idleSeconds * 1.4;

  // 日更短视频偏好的战斗区间；过短像碾压，过长容易掉完播。
  if (m.duration >= 18 && m.duration <= 48) score += 8;
  else if (m.duration < 12) score -= (12 - m.duration) * 3;
  else if (m.duration > 65) score -= (m.duration - 65) * 0.8;
  if (m.winner === -1 || m.winner === null) score -= 25;
  return Number(score.toFixed(3));
}

/** 跑一局 headless 模拟并返回可解释的观赏性分数。 */
export function evaluateSpectacle(ep: Episode, seed: number, maxSeconds = 120): SpectacleResult {
  const battle = new Battle(ep, seed);
  let lastDamageAt = 0;
  let idleSeconds = 0;
  let lowHpSeconds = 0;
  let balanceSum = 0;
  let balanceSamples = 0;
  let leader: -1 | 0 | 1 = -1;
  let leadChanges = 0;
  let damageEvents = 0;
  let crits = 0;
  let skills = 0;
  let deaths = 0;

  const onEvent = (ev: GameEvent): void => {
    if (ev.type === 'attack') {
      damageEvents++;
      lastDamageAt = battle.st.fightT;
      if (ev.skill) skills++;
    } else if (ev.type === 'crit') {
      crits++;
    } else if (ev.type === 'death') {
      deaths++;
    }
  };
  battle.onEvent = onEvent;

  while (!battle.done && battle.st.t < maxSeconds) {
    battle.step(LOGIC_DT);
    const st = battle.st;
    if (st.phase !== 'fight') continue;

    const a = sideHp(st.units, 0);
    const b = sideHp(st.units, 1);
    const ar = Math.min(1, a.hp / a.max);
    const br = Math.min(1, b.hp / b.max);
    balanceSum += 1 - Math.abs(ar - br);
    balanceSamples++;

    if (st.units.some((u) => u.alive && u.hp / u.maxHp <= 0.25)) lowHpSeconds += LOGIC_DT;
    if (st.fightT - lastDamageAt > 2.5) idleSeconds += LOGIC_DT;

    // 小于 6% 的差距视为胶着，不计领先，避免血条微抖制造假反转。
    const diff = ar - br;
    const nextLeader: -1 | 0 | 1 = Math.abs(diff) < 0.06 ? -1 : diff > 0 ? 0 : 1;
    if (nextLeader !== -1) {
      if (leader !== -1 && nextLeader !== leader) leadChanges++;
      leader = nextLeader;
    }
  }

  const st = battle.st;
  const winnerHp = st.winner === 0 || st.winner === 1 ? sideHp(st.units, st.winner) : { hp: 0, max: 1 };
  const metrics: SpectacleMetrics = {
    duration: Number(st.fightT.toFixed(3)),
    winner: st.winner,
    leadChanges,
    lowHpSeconds: Number(lowHpSeconds.toFixed(3)),
    idleSeconds: Number(idleSeconds.toFixed(3)),
    balance: balanceSamples > 0 ? balanceSum / balanceSamples : 0,
    winnerHpPct: Math.max(0, winnerHp.hp / winnerHp.max),
    damageEvents,
    crits,
    skills,
    deaths,
  };
  return { seed, score: scoreMetrics(metrics), metrics };
}

/** 批量搜索并按观赏性从高到低返回。 */
export function scoutSpectacle(ep: Episode, options: ScoutOptions): SpectacleResult[] {
  const count = Math.max(1, Math.floor(options.count));
  const start = Math.floor(options.startSeed ?? ep.seed);
  const step = Math.max(1, Math.floor(options.seedStep ?? 1));
  const results: SpectacleResult[] = [];
  for (let i = 0; i < count; i++) {
    results.push(evaluateSpectacle(ep, start + i * step, options.maxSeconds));
  }
  return results.sort((a, b) => b.score - a.score || a.seed - b.seed);
}

