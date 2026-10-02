import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ARENA, Battle } from '../src/core/sim';
import { parseEpisodeText } from '../src/core/loader';
import { ScriptHost, bindHooks } from '../src/script/luaHost';

const ep = parseEpisodeText(fs.readFileSync('public/episodes/ep014-assassin-vs-sandevistan.yaml', 'utf8'));

function play(seed: number) {
  const battle = new Battle(ep, seed);
  const hits: Array<[string, number, string | null]> = [];
  let frozenSteps = 0;
  let maxEchoes = 0;
  const freezePositions: Array<[number, number]> = [];
  while (!battle.done) {
    const assassin = battle.st.units.find((u) => u.def.dashStrike)!;
    const frozen = (battle.st.rail?.echo?.activeT ?? 0) > 0;
    const old = [assassin.x, assassin.y, assassin.hp, battle.st.rail!.dash.timer];
    battle.step();
    if (!frozen && (battle.st.rail?.echo?.activeT ?? 0) > 0) freezePositions.push([assassin.x, assassin.y]);
    if (frozen) {
      frozenSteps++;
      assert.deepEqual([assassin.x, assassin.y, assassin.hp, battle.st.rail!.dash.timer], old, '停时必须冻结刺客和蓄力');
    }
    maxEchoes = Math.max(maxEchoes, battle.st.rail?.echo?.spawned ?? 0);
    for (const event of battle.drainEvents()) {
      if (event.type !== 'attack') continue;
      hits.push([event.attacker, event.dmg, event.skill]);
      if (event.attacker === 'sandevistan') assert.equal(battle.st.rail?.echo?.activeT, 0, '残影只能在时间恢复后结算');
    }
  }
  return { hits, winner: battle.st.winner, hp: battle.st.units.map((u) => u.hp), frozenSteps, maxEchoes, freezePositions };
}

const actual = play(ep.seed);
assert.deepEqual(actual, play(ep.seed), '同一初始状态必须可重放');
assert.deepEqual(actual, play(1), '物理和伤害不应随演出 seed 改变');
assert(actual.frozenSteps > 60);
assert.equal(actual.maxEchoes, 8);
assert(actual.hits.some(([who]) => who === 'assassin'));
assert(actual.hits.some(([who]) => who === 'sandevistan'));
assert(actual.hits.every(([who, damage]) => damage === (who === 'assassin' ? 165 : 110)));
assert.equal(actual.winner, 1);
assert(actual.freezePositions.length >= 2);
const [secondX, secondY] = actual.freezePositions[1];
assert(secondX > ARENA.left + 150 && secondX < ARENA.right - 150);
assert(secondY > ARENA.top + 150 && secondY < ARENA.bottom - 150, '第二次停时不应把刺客定在墙角');

const withAudio = new Battle(ep);
const host = await ScriptHost.create(fs.readFileSync('public/scripts/default.lua', 'utf8'), bindHooks(() => withAudio.st, { sfxVol: 1 }));
withAudio.onEvent = (event) => host.dispatch(event);
while (!withAudio.done) withAudio.step();
const dashHits = actual.hits.filter(([who]) => who === 'assassin').length;
const heavyHits = withAudio.st.sfx.filter((event) => event.name === 'hit_heavy').length;
assert.equal(heavyHits, dashHits, '每次突刺命中都应播放一次重击音效');
console.log('ep014 双技能对战、第二次停时位置、突刺命中音效、固定伤害及跨 seed 重放检查通过');
