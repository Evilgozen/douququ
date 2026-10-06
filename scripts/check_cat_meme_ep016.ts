import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Battle, ARENA, INTRO_DUR } from '../src/core/sim';
import { parseEpisodeText } from '../src/core/loader';
import { ScriptHost, bindHooks } from '../src/script/luaHost';
import { memeFrameAt } from '../src/render/memeFrames';
import { mixSfxFloat, parseWav } from '../src/audio/mixer';
import { memeProjectilePosition, soundwaveOverlaps } from '../src/core/memeMotion';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const ep = parseEpisodeText(fs.readFileSync('public/episodes/ep016-oi-vs-shake.yaml', 'utf8'));
async function play(seed: number, audio = false) {
  const battle = new Battle(ep, seed);
  const events: unknown[] = [];
  const snapshots: unknown[] = [];
  const starts = new Map<string, number>();
  let completedClips = 0;
  let deathAt: number | null = null;
  let endAt = 0;
  let misses = 0, recoveries = 0;
  const landings = new Map<object, [number, number]>();
  const host = audio ? await ScriptHost.create(fs.readFileSync('public/scripts/cat-meme.lua', 'utf8'), bindHooks(() => battle.st, { sfxVol: 1 })) : null;
  battle.onEvent = (event) => {
    if (event.type === 'meme_skill') starts.set(event.unit, event.t);
    if (event.type === 'attack') {
      const f = ep.fighters.find((fighter) => fighter.id === event.attacker)!;
      assert.equal(event.dmg, f.memeSkill!.damage);
      assert(event.t - starts.get(event.attacker)! >= f.memeSkill!.effect!.launchTimes[0] - 1 / 60, '弹丸不能在发射前结算伤害');
      assert.equal(deathAt, null, '分出胜负后的片段只有演出，不能继续扣血');
    }
    if (event.type === 'death') deathAt = event.t;
    if (event.type === 'phase' && event.name === 'end') endAt = event.t;
    events.push(event);
    void host?.dispatch(event);
  };
  while (!battle.done) {
    const previous = battle.st.units.map((u) => u.meme.elapsed);
    battle.step();
    assert(battle.st.units.filter(u => u.meme.elapsed !== null).length <= 1, '双方音视频不能重叠');
    for (const pr of battle.st.projectiles) {
      if (pr.meme?.kind !== 'mines' || !pr.meme.launched) continue;
      const point: [number, number] = [pr.tx, pr.ty];
      if (landings.has(pr)) assert.deepEqual(point, landings.get(pr), '投出后落点不得追踪');
      else landings.set(pr, point);
    }
    misses += battle.st.popups.filter((p) => p.text === '落空' && p.life === p.maxLife).length;
    for (const [i, u] of battle.st.units.entries()) {
      if (previous[i] !== null && u.meme.elapsed === null && u.alive && battle.st.phase === 'fight') recoveries++;
      if (previous[i] !== null && u.meme.elapsed === null) {
        const elapsed = battle.st.t - starts.get(u.def.id)!;
        assert(elapsed >= u.def.memeSkill!.duration - 1 / 60 - 1e-8, '选定的台词动作片段不能提前停止');
        assert(elapsed <= u.def.memeSkill!.duration + 1 / 60 + 1e-8, '单次技能演出不能超出选定片段');
        completedClips++;
      }
      snapshots.push([u.x, u.y, u.hp, u.meme.elapsed, u.meme.casts]);
    }
  }
  assert(landings.size > 0);
  return { events, snapshots, hp: battle.st.units.map((u) => u.hp), winner: battle.st.winner, misses, recoveries, sfx: battle.st.sfx, completedClips, endAt, deathAt };
}
const actual = await play(16001);
const other = await play(2, true);
assert.deepEqual(other.events, actual.events, '演出脚本与 seed 不改变技能事件');
assert.deepEqual(other.snapshots, actual.snapshots, '演出不改变逐帧轨迹和伤害');
assert(actual.recoveries > 0 && actual.misses > 0);
assert.equal(actual.winner, 1);
assert.deepEqual(actual.hp, [0, 120]);
assert(actual.endAt + ep.endDuration! + 0.25 < 45, '整期含开场、完整原声、结尾及混音尾部必须小于 45 秒');
assert(actual.endAt - actual.deathAt! <= 5 + 1 / 60, '击倒后等待剩余技能片段不能超过 5 秒');
assert.equal(actual.completedClips, (actual.events as Array<{type: string}>).filter((e) => e.type === 'meme_skill').length);
assert.equal(other.sfx.filter((e) => e.name.startsWith('meme_')).length, (actual.events as Array<{type: string}>).filter((e) => e.type === 'meme_skill').length, '每次技能原声只触发一次');

for (const fighter of ep.fighters) {
  const skill = fighter.memeSkill!;
  const buffer = fs.readFileSync('public/sfx/meme-' + fighter.id + '.wav');
  const audio = parseWav(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  assert(Math.abs(audio.samples.length / audio.sampleRate - skill.duration) < 0.035);
}
console.log('EP16 v2: 固定伤害、跨 seed 轨迹、原声单次触发、完整片段、落空、错峰原声、锁定雷盘落点和45秒预算通过');

const wave = { sx: 0, sy: 0, meme: { kind: 'soundwave', radius: 22, angle: 0, spread: 70 } } as Parameters<typeof soundwaveOverlaps>[0];
assert(soundwaveOverlaps(wave, 300, 0, 75, 280, 292), '前方环带命中');
assert(!soundwaveOverlaps(wave, -300, 0, 75, 280, 292), '身后不命中');
assert(!soundwaveOverlaps(wave, 0, 300, 75, 280, 292), '扇形外不命中');
assert(!soundwaveOverlaps(wave, 100, 0, 20, 280, 292), '已经经过的内侧不命中');
const trap = new Battle(ep); trap.st.phase = 'fight'; trap.st.t = INTRO_DUR;
for (const u of trap.st.units) { u.vx = 0; u.vy = 0; u.meme.cooldown = 100; }
trap.st.units[1].x = 500; trap.st.units[1].y = 900;
trap.st.projectiles.push({ ownerUid: trap.st.units[0].uid, side: 0, weaponName: 'test', damage: 60, speed: 640, sx: 300, sy: 900, tx: 500, ty: 900, t: 0, totalTime: 0.45, arc: false, life: 8, meme: {kind:'mines', delay:0, launched:true, age:0, radius:100, warning:1,index:1} });
for(let i = 0; i < 86; i++) trap.step();
assert.equal(trap.st.units[1].hp,420,'飞行与预警期间不能扣血');
for(let i = 0; i < 20; i++) trap.step();
assert.equal(trap.st.units[1].hp,360,'爆炸重叠只结算一次60');
