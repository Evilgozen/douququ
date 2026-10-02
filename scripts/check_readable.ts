import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Battle, type GameEvent } from '../src/core/sim';
import { parseEpisodeText } from '../src/core/loader';
import { narrationMatches } from '../src/core/narration';

const yaml = fs.readFileSync('public/episodes/ep010-pi-vs-euler.yaml', 'utf8');
const ep = parseEpisodeText(yaml);
assert.equal(ep.combat?.mode, 'readable');
assert.equal(parseEpisodeText(yaml.replace('combat: { mode: readable }', '')).combat?.mode, 'readable');

function play(seed: number): { attacks: Array<[string, number, boolean]>; winner: number | null; twist: boolean } {
  const battle = new Battle(ep, seed);
  const events: GameEvent[] = [];
  while (!battle.done) {
    battle.step();
    events.push(...battle.drainEvents());
  }
  return {
    attacks: events.filter((e): e is Extract<GameEvent, { type: 'attack' }> => e.type === 'attack')
      .map((e) => [e.attacker, e.dmg, e.crit]),
    winner: battle.st.winner,
    twist: battle.st.firedTwists[0],
  };
}

const first = play(3141);
assert.deepEqual(first, play(3141), '相同 seed 必须逐次结算一致');
assert.deepEqual(first, play(9999), '简明模式的战斗结果不能依赖 seed');
assert.equal(first.winner, 0);
assert.equal(first.twist, true);
assert.deepEqual(first.attacks.filter(([name]) => name === 'euler').map(([, damage]) => damage), [70, 70, 70, 70, 160, 70, 70]);
assert(first.attacks.filter(([name]) => name === 'pi').every(([, damage]) => damage === 60));
assert.throws(() => parseEpisodeText(yaml.replace('combo: [1]', 'weapon: { name: 随机炮, kind: melee, damage: 10, every: 1 }\n    combo: [1]')), /readable 模式只允许普攻/);
assert.equal(narrationMatches(ep, [{ text: '旧剧本', t: 0.5 }]), false);
console.log('readable 对战规则与 ep10 重放检查通过');
