import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Battle, ARENA, INTRO_DUR } from '../src/core/sim';
import { parseEpisodeText } from '../src/core/loader';
import { ScriptHost, bindHooks } from '../src/script/luaHost';
import { memeFrameAt } from '../src/render/memeFrames';
import { mixSfxFloat, parseWav } from '../src/audio/mixer';
import { memeProjectilePosition } from '../src/core/memeMotion';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const ep = parseEpisodeText(fs.readFileSync('public/episodes/ep015-cat-meme.yaml', 'utf8'));
async function play(seed: number, audio = false) {
  const battle = new Battle(ep, seed);
  const events: unknown[] = [];
  const snapshots: unknown[] = [];
  const starts = new Map<string, number>();
  let completedClips = 0;
  let deathAt: number | null = null;
  let endAt = 0;
  let misses = 0, recoveries = 0;
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
  return { events, snapshots, hp: battle.st.units.map((u) => u.hp), winner: battle.st.winner, misses, recoveries, sfx: battle.st.sfx, completedClips, endAt, deathAt };
}
const actual = await play(15001);
const other = await play(2, true);
assert.deepEqual(other.events, actual.events, '演出脚本与 seed 不改变技能事件');
assert.deepEqual(other.snapshots, actual.snapshots, '演出不改变逐帧轨迹和伤害');
assert(actual.recoveries > 0 && actual.misses > 0);
assert.equal(actual.winner, 1);
assert.deepEqual(actual.hp, [0, 70]);
assert(actual.endAt + ep.endDuration! + 0.25 < 45, '整期含开场、完整原声、结尾及混音尾部必须小于 45 秒');
assert(actual.endAt - actual.deathAt! <= 5 + 1 / 60, '击倒后等待剩余技能片段不能超过 5 秒');
assert.equal(actual.completedClips, (actual.events as Array<{type: string}>).filter((e) => e.type === 'meme_skill').length);
assert.equal(other.sfx.filter((e) => e.name.startsWith('meme_')).length, (actual.events as Array<{type: string}>).filter((e) => e.type === 'meme_skill').length, '每次技能原声只触发一次');
const automatic = new Battle(ep);
automatic.st.phase = 'fight'; automatic.st.t = INTRO_DUR;
automatic.st.units[1].meme.cooldown = 100;
automatic.st.units[0].x = ARENA.left + 200; automatic.st.units[0].y = 900;
automatic.st.units[1].x = ARENA.right - 200; automatic.st.units[1].y = 900;
for (const u of automatic.st.units) { u.vx = 0; u.vy = 0; }
automatic.step();
assert.equal(automatic.st.units[0].meme.elapsed, null, '冷却未结束不能释放');
for (let count = 1; count <= 4; count++) {
  automatic.st.units[0].meme.elapsed = null;
  automatic.st.units[0].meme.cooldown = 0;
  automatic.st.projectiles = [];
  automatic.step();
  assert.notEqual(automatic.st.units[0].meme.elapsed, null, '无需接触即可释放');
  assert.equal(automatic.st.units[0].meme.casts, count);
  const clones = automatic.st.projectiles.filter((p) => p.meme?.kind === 'clones');
  assert.equal(clones.length, count, '分身从 1 开始，每轮增加 1 个');
  assert(clones.every((p) => Math.hypot(p.sx - automatic.st.units[0].x, p.sy - automatic.st.units[0].y) > 60), '伴舞分身不能藏在本体后面');
  assert(clones.every((p, i) => i === 0 || p.meme!.delay > clones[i - 1].meme!.delay), '同轮分身依次冲撞');
  assert.equal(automatic.st.units[1].hp, 420, '动作开始不提前扣血');
}
assert.equal(new Battle(ep).st.units[0].meme.casts, 0, '重开须重置成长次数');
assert.equal(memeFrameAt(ep.fighters[0].memeSkill!, 0), 'memes/amigatito/000.png');
assert.equal(memeFrameAt(ep.fighters[0].memeSkill!, 0.2), 'memes/amigatito/003.png');
for (const fighter of ep.fighters) {
  const skill = fighter.memeSkill!;
  assert.equal(skill.duration, 5, '两个角色单次技能均为 5 秒');
  const source = JSON.parse(fs.readFileSync(`public/memes/${fighter.id}/source.json`, 'utf8'));
  assert.equal(source.playbackRate, fighter.id === 'jiujiu' ? 1.2 : 1);
  assert.equal(source.sourceDuration, skill.duration * source.playbackRate, '音画统一使用相同倍速与源片段');
  const audioFile = skill.sound === 'meme_amigatito' ? 'public/sfx/meme-amigatito.wav' : 'public/sfx/meme-jiujiu.wav';
  const buffer = fs.readFileSync(audioFile);
  const audio = parseWav(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
  assert(Math.abs(audio.samples.length / audio.sampleRate - skill.duration) < 0.035, '裁切后的原声与动作必须同长');
  assert(fs.existsSync('public/' + memeFrameAt(skill, skill.duration - 1 / skill.fps)), '最后一帧必须存在');
  const canvas = createCanvas(320, 360), ctx = canvas.getContext('2d');
  for (let i = 0; i <= source.leadingHeldFrames; i++) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(await loadImage(`public/${skill.framePrefix}${String(i).padStart(3, '0')}.png`), 0, 0);
    assert(ctx.getImageData(0, 0, canvas.width, canvas.height).data.some((v, p) => p % 4 === 3 && v > 128), '技能开头不能使用全透明空帧');
  }
}
const egg = { sx:300,sy:900,tx:600,ty:900,t:0.5,meme:{kind:'eggs'} } as Parameters<typeof memeProjectilePosition>[0];
assert.deepEqual(memeProjectilePosition(egg), { x:450,y:760 }, '绘制与实体命中共用抛物线位置');
const volley = new Battle(ep);
volley.st.phase = 'fight'; volley.st.t = INTRO_DUR;
volley.st.units[0].meme.cooldown = 100;
volley.st.units[1].meme.cooldown = 0;
volley.st.units[0].x = 350; volley.st.units[0].y = 550;
volley.st.units[1].x = 650; volley.st.units[1].y = 1250;
for (const u of volley.st.units) { u.vx = 0; u.vy = 0; }
for (let i = 0; i < 90; i++) volley.step();
const pair = volley.st.projectiles.filter((p) => p.meme?.kind === 'eggs');
assert.equal(pair.length, 2, '一次技能生成两枚蛋');
assert(pair.every((p) => p.meme!.launched), '双蛋同时发射');
assert.equal(pair[0].t, pair[1].t, '双蛋飞行进度一致');
for (const t of [0, 0.25, 0.5, 1]) {
  const a = memeProjectilePosition(pair[0], t), b = memeProjectilePosition(pair[1], t);
  assert(Math.abs(Math.hypot(a.x - b.x, a.y - b.y) - 152) < 1e-8, '双蛋全程保持并排间距');
}
const trimmed = mixSfxFloat([{name:'test',t:0,vol:1,rate:1,durationSec:0.1}], new Map([['test',{sampleRate:100,samples:new Float32Array(100).fill(0.5)}]]), 1, 1, 100);
assert.equal(trimmed[9], 0.5); assert.equal(trimmed[10], 0, '取消演出后原声必须截断');
console.log('meme 定时释放、逐轮分身成长、开头可见帧、并排双蛋、固定伤害及跨 seed 一致检查通过');
