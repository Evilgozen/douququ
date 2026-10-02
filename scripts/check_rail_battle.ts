import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Battle, type GameEvent } from '../src/core/sim';
import { parseEpisodeText } from '../src/core/loader';

const ep = parseEpisodeText(fs.readFileSync('public/episodes/ep012-conductor-vs-assassin.yaml', 'utf8'));
assert.equal(ep.combat?.movement, 'bounce');

function play(seed: number) {
  const b = new Battle(ep, seed);
  const attacks: Array<Pick<Extract<GameEvent, { type: 'attack' }>, 'attacker' | 'dmg' | 't'>> = [];
  const departures: number[] = [];
  const arrivals: number[] = [];
  const passDurations: number[] = [];
  let trainHits = 0;
  let maxCombo = 0;
  let maxPath = 0;
  let fadingFrames = 0;
  let previousPass = false;
  while (!b.done) {
    b.step();
    for (const e of b.drainEvents()) if (e.type === 'attack') {
      attacks.push({ attacker: e.attacker, dmg: e.dmg, t: e.t });
      if (e.attacker === 'conductor') {
        trainHits++;
        const assassin = b.st.units.find((u) => u.def.id === 'assassin')!;
        assert(Math.abs(Math.hypot(assassin.vx, assassin.vy) - 620) < 1, '列车碰撞应把刺客弹开');
      }
    }
    const pass = b.st.rail?.pass;
    const fading = b.st.rail?.fading;
    maxCombo = Math.max(maxCombo, b.st.rail?.combo.count ?? 0);
    if (pass || fading) assert.equal(b.st.rail?.points.length, 0, '列车行驶及旧轨消失期间不可继续铺轨');
    if (fading) {
      fadingFrames++;
      assert.equal(fading.total, 2);
    }
    if (pass && !previousPass) {
      departures.push(b.st.fightT);
      passDurations.push(pass.duration);
      maxPath = Math.max(maxPath, pass.points[pass.points.length - 1].s);
      assert.equal(pass.cars, 10);
      const distance = pass.points[pass.points.length - 1].s;
      const oldTail = (5 - 1) * pass.carGap + 40;
      const newTail = (pass.cars - 1) * pass.carGap + 40;
      assert(newTail >= oldTail * 2, '车身长度应至少翻倍');
      const oldSpeed = (distance + oldTail + 40) / 3;
      const actualSpeed = (distance + newTail + 40) / pass.duration;
      assert(Math.abs(actualSpeed / oldSpeed - 2) < 1e-9, '列车行驶速度应精确翻倍');
    }
    if (!pass && previousPass) arrivals.push(b.st.fightT);
    previousPass = Boolean(pass);
  }
  return { winner: b.st.winner, attacks, departures, arrivals, passDurations, trainHits, maxCombo, maxPath, fadingFrames, hp: b.st.units.map((u) => u.hp) };
}

const a = play(12012);
assert.deepEqual(a, play(12012), '相同 seed 必须逐帧重放一致');
assert.deepEqual(a, play(1), '可读对战不应依赖 seed');
assert.equal(a.winner, 1);
assert(a.attacks.filter((e) => e.attacker === 'assassin').every((e) => e.dmg === 165));
assert(a.attacks.filter((e) => e.attacker === 'conductor').every((e) => e.dmg === 110));
assert.equal(a.departures.length, a.arrivals.length);
assert(a.departures.length >= 3);
assert(a.trainHits >= 1, '列车至少需要撞击并弹开刺客一次');
assert(a.maxCombo >= 2, '应出现列车—墙体—列车的连续碰撞');
assert(a.maxPath >= 2500, '提速后的列车长应铺出较长轨道');
assert(a.fadingFrames >= 110, '旧轨应至少淡出接近两秒');
for (let i = 0; i < a.departures.length; i++) {
  assert(Math.abs(a.arrivals[i] - a.departures[i] - a.passDurations[i]) < 1 / 60 + 1e-6, '车尾必须在计算出的时间内完整离场');
}
console.log('ep012 固定伤害、跨 seed 重放、长轨铺设、旧轨延时消失及列车墙体二连撞检查通过');
