/**
 * RL 环境演示 / 基准：随机策略 & 简单启发式策略跑若干局，验证接口闭环并测吞吐。
 *   npm run rl -- public/episodes/ep002-guard-vs-intern.yaml --id intern --episodes 20 --policy kite
 *
 * 策略：
 *   random  均匀随机动作（底线基线）
 *   kite    启发式风筝：有投射武器就保持 380-560px 距离并始终出手，近战就贴脸
 *   chase   无脑冲脸（对照）
 * --check 额外做确定性自检：同 seed 两局 obs 序列必须逐位一致。
 */
import fs from 'node:fs';
import { parseEpisodeText } from '../core/loader';
import { BattleEnv } from '../rl/env';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Policy = (obs: number[], env: BattleEnv) => number[];

/** obs 布局见 src/rl/env.ts OBS_KEYS：8/9=敌相对位置，12=敌距(/H) */
function kitePolicyMaker(myId: string): Policy {
  return (_obs, env) => {
    const st = env.state!;
    const me = st.units.find((u) => u.def.id === myId);
    const foe = st.units.find((u) => u.alive && u.side !== (me?.side ?? 0)) ?? st.units[0];
    if (!me || !foe) return [0, 0, 1];
    const dx = foe.x - me.x;
    const dy = foe.y - me.y;
    const dist = Math.hypot(dx, dy) || 1;
    if (me.def.weapon?.kind === 'projectile') {
      // 风筝窗口（中距离）：太近拉开，太远回蹭——公文包在 250-380px 命中率最高
      if (dist < 250) return [-dx / dist, -dy / dist, 1];
      if (dist > 380) return [dx / dist, dy / dist, 1];
      return [-dy / dist, dx / dist, 1];
    }
    return [dx / dist, dy / dist, 1];
  };
}

function main(): void {
  const yamlPath = process.argv.find((a) => a.endsWith('.yaml') || a.endsWith('.yml'));
  if (!yamlPath) {
    console.error('用法: npm run rl -- <episode.yaml> [--id <fighterId>] [--episodes 20] [--policy random|kite|chase] [--seed 1] [--check]');
    process.exit(1);
  }
  const ep = parseEpisodeText(fs.readFileSync(yamlPath, 'utf8'), 'rl');
  const controlledId = argValue('--id') ?? ep.fighters[0].id;
  const episodes = Number(argValue('--episodes') ?? 20);
  const policyName = argValue('--policy') ?? 'random';
  const seed0 = Number(argValue('--seed') ?? 1);

  const env = new BattleEnv(ep, {
    controlledId,
    frameSkip: Number(argValue('--frame-skip') ?? 6),
    maxFightSec: Number(argValue('--max-fight-sec') ?? 90),
  });
  let rngState = seed0 * 2654435761;
  const rng = (): number => {
    // mulberry32：与引擎 RNG 同族，保证演示可复现
    rngState |= 0;
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const policy: Policy =
    policyName === 'kite'
      ? kitePolicyMaker(controlledId)
      : policyName === 'chase'
        ? (obs) => {
            const fx = obs[8];
            const fy = obs[9];
            const m = Math.hypot(fx, fy) || 1;
            return [fx / m, fy / m, 1];
          }
        : () => [rng() * 2 - 1, rng() * 2 - 1, 1];

  console.log(`剧本=${ep.id} 被控=${controlledId} 策略=${policyName} 局数=${episodes}`);
  const t0 = performance.now();
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let totalReward = 0;
  let totalLogicSteps = 0;
  let totalFightT = 0;
  let totalFoeEndHp = 0;
  let totalFoeMaxHp = 0;

  for (let i = 0; i < episodes; i++) {
    let { obs } = env.reset(seed0 + i * 101);
    let epReward = 0;
    let done = false;
    while (!done) {
      const r = env.step(policy(obs, env));
      obs = r.obs;
      epReward += r.reward;
      totalLogicSteps += 6; // frameSkip 默认值
      if (r.terminated || r.truncated) {
        done = true;
        totalFightT += r.info.fightT;
        totalFoeEndHp += r.info.enemyHp;
        totalFoeMaxHp += r.info.enemyMaxHp;
        if (r.terminated) {
          if (r.info.winner === -1) draws++;
          else if (r.info.winner === (env.state?.units.find((u) => u.def.id === controlledId)?.side ?? -2)) wins++;
          else losses++;
        } else draws++; // 超时截断按平局计
      }
    }
    totalReward += epReward;
  }

  const wall = (performance.now() - t0) / 1000;
  console.log(`胜负: ${wins}胜 ${losses}负 ${draws}平(含超时)`);
  console.log(`平均回报: ${(totalReward / episodes).toFixed(2)}`);
  console.log(`平均存活: ${(totalFightT / episodes).toFixed(1)}s | 平均打掉敌方血量: ${(((totalFoeMaxHp - totalFoeEndHp) / Math.max(1, totalFoeMaxHp)) * 100).toFixed(0)}%`);
  console.log(`吞吐: ${Math.round(totalLogicSteps / wall)} 逻辑步/秒（headless，比实时快 ${Math.round(totalLogicSteps / wall / 60)}x）`);

  if (process.argv.includes('--check')) {
    const trace = (seed: number): number[] => {
      let { obs } = env.reset(seed);
      const acc: number[] = [];
      for (let s = 0; s < 200; s++) {
        const r = env.step([0.31, -0.7, 1]);
        obs = r.obs;
        acc.push(Math.round(r.reward * 1e6), r.terminated ? 1 : 0, obs[0]);
      }
      return acc;
    };
    const a = trace(424242);
    const b = trace(424242);
    const ok = a.length === b.length && a.every((v, i) => v === b[i]);
    console.log(`确定性自检: ${ok ? 'PASS 同seed两局逐位一致' : 'FAIL 不一致！'}`);
    if (!ok) process.exit(1);
  }
}

main();
