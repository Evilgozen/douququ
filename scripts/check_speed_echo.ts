import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ARENA, Battle } from '../src/core/sim';
import { parseEpisodeText } from '../src/core/loader';

const ep = parseEpisodeText(fs.readFileSync('public/episodes/ep013-conductor-vs-sandevistan.yaml', 'utf8'));

function play(seed: number) {
  const battle = new Battle(ep, seed);
  const hits: Array<[string, number, number, string | null]> = [];
  let trainHits = 0;
  let maxEchoes = 0;
  let frozenSteps = 0;
  let overlapsDuringFreeze = 0;
  let misses = 0;
  while (!battle.done) {
    const before = battle.st.rail?.echo;
    const frozenBefore = (before?.activeT ?? 0) > 0;
    const conductor = battle.st.units.find((u) => u.def.trainTrail)!;
    const oldX = conductor.x; const oldY = conductor.y;
    const oldSpeedsterHp = battle.st.units.find((u) => u.def.speedEcho)!.hp;
    const oldPass = battle.st.rail?.pass?.elapsed;
    battle.step();
    const echo = battle.st.rail?.echo;
    maxEchoes = Math.max(maxEchoes, echo?.spawned ?? 0);
    const speedster = battle.st.units.find((u) => u.def.speedEcho)!;
    if (frozenBefore) {
      frozenSteps++;
      assert.equal(conductor.x, oldX, '停时期间列车长位置必须定格');
      assert.equal(conductor.y, oldY, '停时期间列车长位置必须定格');
      if (oldPass !== undefined) assert.equal(battle.st.rail?.pass?.elapsed, oldPass, '停时期间列车必须定格');
      assert.equal(speedster.hp, oldSpeedsterHp, '停时期间本体应无视列车碰撞伤害');
      if (Math.hypot(speedster.x - conductor.x, speedster.y - conductor.y) < speedster.r + conductor.r) overlapsDuringFreeze++;
    }
    misses += battle.st.popups.filter((p) => p.text.includes('落空') && p.life === p.maxLife).length;
    for (const e of battle.drainEvents()) {
      if (e.type !== 'attack') continue;
      hits.push([e.attacker, e.dmg, Number(e.t.toFixed(3)), e.skill]);
      if (e.attacker === 'conductor') trainHits++;
      if (e.attacker === 'sandevistan') {
        assert.equal(echo?.activeT, 0, '残影必须在时间恢复后才结算伤害');
        assert.equal(Number(e.skill?.match(/残影 (\d+)\/8/)?.[1]), echo?.released, '命中编号必须与当前消失的残影一致');
      }
    }
  }
  return { hits, winner: battle.st.winner, hp: battle.st.units.map((u) => u.hp), trainHits, maxEchoes, frozenSteps, overlapsDuringFreeze, misses };
}

const actual = play(13013);
assert.deepEqual(actual, play(13013), '同一 seed 应重放一致');
assert.deepEqual(actual, play(1), '可读对战的伤害与胜负不应依赖 seed');
assert.equal(actual.winner, 1);
assert.equal(actual.maxEchoes, 8);
assert(actual.frozenSteps > 60, '停时阶段应持续足够多的视频帧');
assert(actual.overlapsDuringFreeze > 0, '停时本体应能穿过对手碰撞体积');
assert(actual.misses > 0, '未重叠的残影必须落空');
assert(actual.trainHits >= 1, '实体仍须被列车撞击');
assert(actual.hits.some(([who]) => who === 'sandevistan'));
assert(actual.hits.some(([who]) => who === 'conductor'));
assert(actual.hits.every(([, damage]) => damage === 110));
function releaseWithConductorOnFirstEcho(overlap: boolean): number {
  const battle = new Battle(ep);
  while (battle.st.phase !== 'fight' || !battle.st.rail?.echo?.images.length || battle.st.rail.echo.activeT > 0) battle.step();
  const image = battle.st.rail.echo.images[0];
  const conductor = battle.st.units.find((u) => u.def.trainTrail)!;
  const speedster = battle.st.units.find((u) => u.def.speedEcho)!;
  if (overlap) { conductor.x = image.x; conductor.y = image.y; }
  else {
    const corners = [
      [ARENA.left + conductor.r, ARENA.top + conductor.r],
      [ARENA.right - conductor.r, ARENA.top + conductor.r],
      [ARENA.left + conductor.r, ARENA.bottom - conductor.r],
      [ARENA.right - conductor.r, ARENA.bottom - conductor.r],
    ];
    const far = corners.sort((a, b) => Math.hypot(b[0] - image.x, b[1] - image.y) - Math.hypot(a[0] - image.x, a[1] - image.y))[0];
    conductor.x = far[0]; conductor.y = far[1];
  }
  conductor.vx = 0; conductor.vy = 0;
  speedster.x = overlap ? ARENA.right - speedster.r : ARENA.left + speedster.r;
  speedster.y = ARENA.bottom - speedster.r;
  speedster.vx = 0; speedster.vy = 0;
  const hpBefore = conductor.hp;
  while (battle.st.rail.echo.released === 0) battle.step();
  return hpBefore - conductor.hp;
}
assert.equal(releaseWithConductorOnFirstEcho(true), 110, '残影消失时重叠必须扣固定伤害');
assert.equal(releaseWithConductorOnFirstEcho(false), 0, '残影消失时未重叠必须落空');
console.log('ep013 停时穿透、残影重叠/落空判定、固定伤害和跨 seed 重放检查通过');
