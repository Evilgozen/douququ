/** 剧本 YAML → Episode：解析、校验、补默认值。浏览器与 Node CLI 共用。 */
import { load as loadYaml } from 'js-yaml';
import type { CaptionDef, Episode, FighterDef, SkillDef, TwistDef } from './types';

function reqStr(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`剧本字段 ${field} 缺失或不是字符串`);
  return v.trim();
}

function reqPos(v: unknown, field: string): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !isFinite(n) || n <= 0) throw new Error(`剧本字段 ${field} 必须是正数`);
  return n;
}

function optNum(v: unknown, def: number): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && isFinite(n) ? n : def;
}

function normSkills(raw: unknown, who: string): SkillDef[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${who}.skills 必须是数组`);
  return raw.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return {
      name: reqStr(o.name, `${who}.skills[${i}].name`),
      every: reqPos(o.every, `${who}.skills[${i}].every`),
      multiplier: Math.max(1, optNum(o.multiplier, 1)),
      healPct: o.healPct !== undefined ? optNum(o.healPct, 0) : undefined,
      shieldPct: o.shieldPct !== undefined ? optNum(o.shieldPct, 0) : undefined,
    };
  });
}

function normFighter(raw: unknown, i: number): FighterDef {
  const o = (raw ?? {}) as Record<string, unknown>;
  const who = `fighters[${i}]`;
  if (o.hp === undefined || o.atk === undefined) throw new Error(`${who} 缺少 hp 或 atk`);
  const behavior = (() => {
    if (o.behavior === undefined) return undefined;
    const b = String(o.behavior).trim();
    if (b !== 'chase' && b !== 'random' && b !== 'flee') {
      throw new Error(`${who}.behavior 必须是 chase / random / flee（manual 仅供 RL 程序注入）`);
    }
    return b as 'chase' | 'random' | 'flee';
  })();
  return {
    id: reqStr(o.id ?? o.name, `${who}.id`),
    name: reqStr(o.name, `${who}.name`),
    behavior,
    sprite: typeof o.sprite === 'string' ? o.sprite : undefined,
    memeSkill: (() => {
      const m = o.memeSkill as Record<string, unknown> | undefined;
      if (!m) return undefined;
      const trigger = reqStr(m.trigger, `${who}.memeSkill.trigger`);
      if (trigger !== 'timer' && trigger !== 'collision') throw new Error(`${who}.memeSkill.trigger 必须是 timer/collision`);
      const duration = reqPos(m.duration, `${who}.memeSkill.duration`);
      const hitAt = optNum(m.hitAt, 0);
      const initialCooldown = optNum(m.initialCooldown, 0);
      const frameCount = reqPos(m.frameCount, `${who}.memeSkill.frameCount`);
      const fps = reqPos(m.fps, `${who}.memeSkill.fps`);
      if (hitAt < 0 || hitAt >= duration || initialCooldown < 0 || !Number.isInteger(frameCount) || frameCount / fps + 0.001 < duration) throw new Error(`${who}.memeSkill：命中时刻须在片段内，冷却非负，帧数为整数且覆盖时长`);
      const effect = (() => {
        const e = m.effect as Record<string, unknown> | undefined;
        if (!e) return undefined;
        const kind = reqStr(e.kind, `${who}.memeSkill.effect.kind`);
        if (kind !== 'eggs' && kind !== 'clones') throw new Error('meme effect 必须是 eggs/clones');
        const launchTimes = Array.isArray(e.launchTimes) ? e.launchTimes.map(Number) : [];
        if (launchTimes.length !== 2 || launchTimes.some((t) => !Number.isFinite(t) || t < 0 || t >= duration) || launchTimes[0] > launchTimes[1] || (kind === 'clones' && launchTimes[0] === launchTimes[1])) throw new Error('发射时间须在动作内；双蛋可同时发射，分身须依次发射');
        const sprite = typeof e.sprite === 'string' ? e.sprite : undefined;
        if (kind === 'eggs' && !sprite) throw new Error('eggs 需要弹丸 sprite');
        if (e.cloneGrowth !== undefined && (typeof e.cloneGrowth !== 'boolean' || kind !== 'clones')) throw new Error('cloneGrowth 仅可用于分身，且必须为布尔值');
        return { kind: kind as 'eggs' | 'clones', sprite, launchTimes, speed: reqPos(e.speed, `${who}.memeSkill.effect.speed`), cloneGrowth: e.cloneGrowth === true };
      })();
      return { name: reqStr(m.name, `${who}.memeSkill.name`), trigger, every: reqPos(m.every, `${who}.memeSkill.every`), initialCooldown, duration, hitAt, damage: reqPos(m.damage, `${who}.memeSkill.damage`), range: reqPos(m.range, `${who}.memeSkill.range`), framePrefix: reqStr(m.framePrefix, `${who}.memeSkill.framePrefix`), frameCount, fps, sound: reqStr(m.sound, `${who}.memeSkill.sound`), effect };
    })(),
    stateSprites: (() => {
      const s = o.stateSprites as Record<string, unknown> | undefined;
      if (!s) return undefined;
      const pick = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      const bike = pick(s.bike);
      const stun = pick(s.stun);
      const block = pick(s.block);
      const berserk = pick(s.berserk);
      return bike || stun || block || berserk ? { bike, stun, block, berserk } : undefined;
    })(),
    color: typeof o.color === 'string' ? o.color : undefined,
    hp: reqPos(o.hp, `${who}.hp`),
    atk: optNum(o.atk, 0),
    defense: Math.max(0, optNum(o.defense, 0)),
    trainTrail: (() => {
      const t = o.trainTrail as Record<string, unknown> | undefined;
      if (!t) return undefined;
      return { every: reqPos(t.every, `${who}.trainTrail.every`), duration: reqPos(t.duration, `${who}.trainTrail.duration`), damage: reqPos(t.damage, `${who}.trainTrail.damage`), cars: Math.max(1, Math.floor(optNum(t.cars, 5))), carGap: reqPos(t.carGap ?? 52, `${who}.trainTrail.carGap`), speedMultiplier: reqPos(t.speedMultiplier ?? 1, `${who}.trainTrail.speedMultiplier`), referenceCars: Math.max(1, Math.floor(optNum(t.referenceCars, optNum(t.cars, 5)))), fadeSeconds: reqPos(t.fadeSeconds ?? 2, `${who}.trainTrail.fadeSeconds`) };
    })(),
    dashStrike: (() => {
      const d = o.dashStrike as Record<string, unknown> | undefined;
      if (!d) return undefined;
      return { every: reqPos(d.every, `${who}.dashStrike.every`), charge: reqPos(d.charge, `${who}.dashStrike.charge`), duration: reqPos(d.duration, `${who}.dashStrike.duration`), damage: reqPos(d.damage, `${who}.dashStrike.damage`) };
    })(),
    speedEcho: (() => {
      const e = o.speedEcho as Record<string, unknown> | undefined;
      if (!e) return undefined;
      return { every: reqPos(e.every, `${who}.speedEcho.every`), initialCooldown: reqPos(e.initialCooldown ?? 2.5, `${who}.speedEcho.initialCooldown`), active: reqPos(e.active, `${who}.speedEcho.active`), speedMultiplier: reqPos(e.speedMultiplier, `${who}.speedEcho.speedMultiplier`), echoEvery: reqPos(e.echoEvery, `${who}.speedEcho.echoEvery`), releaseEvery: reqPos(e.releaseEvery ?? 0.18, `${who}.speedEcho.releaseEvery`), hitRadius: reqPos(e.hitRadius ?? 82, `${who}.speedEcho.hitRadius`), damage: reqPos(e.damage, `${who}.speedEcho.damage`), maxEchoes: Math.max(1, Math.floor(optNum(e.maxEchoes, 4))) };
    })(),
    atkInterval: optNum(o.atkInterval, 1),
    speed: optNum(o.speed, 140),
    range: optNum(o.range, 130),
    combo: Array.isArray(o.combo) ? o.combo.map((c) => optNum(c, 1)) : undefined,
    radius: o.radius !== undefined ? Math.max(30, optNum(o.radius, 64)) : undefined,
    weapon: (() => {
      const w = o.weapon as Record<string, unknown> | undefined;
      if (!w) return undefined;
      const kind = reqStr(w.kind, `${who}.weapon.kind`);
      if (kind !== 'melee' && kind !== 'projectile') throw new Error(`${who}.weapon.kind 必须是 melee 或 projectile`);
      return {
        name: reqStr(w.name, `${who}.weapon.name`),
        kind,
        damage: optNum(w.damage, 0),
        every: reqPos(w.every, `${who}.weapon.every`),
        speed: w.speed !== undefined ? optNum(w.speed, 400) : undefined,
        arc: Boolean(w.arc),
        mult: optNum(w.mult, 1),
        knockback: w.knockback !== undefined ? Math.max(0, optNum(w.knockback, 1)) : undefined,
        reachMult: w.reachMult !== undefined ? Math.max(0.5, optNum(w.reachMult, 1.7)) : undefined,
      };
    })(),
    kickFx: Boolean(o.kickFx),
    kickSprite: typeof o.kickSprite === 'string' && o.kickSprite.trim() ? o.kickSprite.trim() : undefined,
    gasTrail: (() => {
      const g = o.gasTrail as Record<string, unknown> | undefined;
      if (!g) return undefined;
      return {
        every: reqPos(g.every, `${who}.gasTrail.every`),
        radius: Math.max(30, optNum(g.radius, 100)),
        dur: reqPos(g.dur, `${who}.gasTrail.dur`),
        damage: optNum(g.damage, 10),
        tick: g.tick !== undefined ? Math.max(0.1, optNum(g.tick, 0.5)) : undefined,
      };
    })(),
    bikeRush: (() => {
      const b = o.bikeRush as Record<string, unknown> | undefined;
      if (!b) return undefined;
      return {
        every: reqPos(b.every, `${who}.bikeRush.every`),
        delay: b.delay !== undefined ? Math.max(0, optNum(b.delay, 3)) : undefined,
        speedMult: Math.max(1, optNum(b.speedMult, 1.8)),
        dur: reqPos(b.dur, `${who}.bikeRush.dur`),
        gasEvery: reqPos(b.gasEvery, `${who}.bikeRush.gasEvery`),
        crashDamage: optNum(b.crashDamage, 80),
        crashStun: Math.max(0, optNum(b.crashStun, 1)),
      };
    })(),
    takeout: (() => {
      const t = o.takeout as Record<string, unknown> | undefined;
      if (!t) return undefined;
      const items = Array.isArray(t.items)
        ? t.items.map((it, i) => {
            const io = (it ?? {}) as Record<string, unknown>;
            return {
              name: reqStr(io.name, `${who}.takeout.items[${i}].name`),
              damage: optNum(io.damage, 30),
              slowSec: io.slowSec !== undefined ? Math.max(0, optNum(io.slowSec, 0)) : undefined,
              slowMult: io.slowMult !== undefined ? Math.min(1, Math.max(0.1, optNum(io.slowMult, 0.75))) : undefined,
              sprite: typeof io.sprite === 'string' && io.sprite.trim() ? io.sprite.trim() : undefined,
            };
          })
        : [];
      if (items.length === 0) throw new Error(`${who}.takeout.items 不能为空`);
      return {
        every: reqPos(t.every, `${who}.takeout.every`),
        speed: t.speed !== undefined ? optNum(t.speed, 460) : undefined,
        items,
      };
    })(),
    skills: normSkills(o.skills, who),
  };
}

function normTwist(raw: unknown, i: number): TwistDef {
  const o = (raw ?? {}) as Record<string, unknown>;
  const who = `twists[${i}]`;
  const tr = (o.trigger ?? {}) as Record<string, unknown>;
  let trigger: TwistDef['trigger'];
  if (tr.hpBelowPct !== undefined) {
    trigger = { hpBelowPct: Math.min(1, Math.max(0, optNum(tr.hpBelowPct, 0.2))), fighter: typeof tr.fighter === 'string' ? tr.fighter : undefined };
  } else if (tr.timeAt !== undefined) {
    trigger = { timeAt: optNum(tr.timeAt, 0), fighter: typeof tr.fighter === 'string' ? tr.fighter : undefined };
  } else if (tr.fighterDead !== undefined) {
    trigger = { fighterDead: reqStr(tr.fighterDead, `${who}.trigger.fighterDead`) };
  } else {
    throw new Error(`${who}.trigger 必须包含 hpBelowPct / timeAt / fighterDead 之一`);
  }
  const ef = (o.effect ?? {}) as Record<string, unknown>;
  if (o.effect === undefined) {
    // 纯解说型反转：只出横幅/字幕
    return {
      trigger,
      once: o.once === undefined ? true : Boolean(o.once),
      banner: typeof o.banner === 'string' ? o.banner : undefined,
      caption: typeof o.caption === 'string' ? o.caption : undefined,
      slowmo: optNum(o.slowmo, 0),
    };
  }
  const type = reqStr(ef.type, `${who}.effect.type`);
  const known = ['berserk', 'revive', 'statMultiply', 'shield', 'heal', 'reinforce'];
  if (!known.includes(type)) throw new Error(`${who}.effect.type 未知：${type}（可用：${known.join(',')}）`);
  const effect = ef as unknown as TwistDef['effect'];
  if (type === 'reinforce' && !(ef as { fighter?: unknown }).fighter) {
    throw new Error(`${who}.effect.fighter 缺失（援军模板）`);
  }
  if (type === 'statMultiply' && ef.atkMultiplier === undefined) {
    throw new Error(`${who}.effect.atkMultiplier 缺失`);
  }
  return {
    trigger,
    effect,
    once: o.once === undefined ? true : Boolean(o.once),
    banner: typeof o.banner === 'string' ? o.banner : undefined,
    caption: typeof o.caption === 'string' ? o.caption : undefined,
    slowmo: optNum(o.slowmo, 0),
  };
}

export function parseEpisodeText(text: string, idFallback = 'episode'): Episode {
  let raw: unknown;
  try {
    raw = loadYaml(text);
  } catch (e) {
    throw new Error(`YAML 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== 'object') throw new Error('剧本内容为空');
  const o = raw as Record<string, unknown>;

  if (!Array.isArray(o.fighters) || o.fighters.length < 2) {
    throw new Error('剧本至少需要 2 名 fighters');
  }
  const fighters = o.fighters.map(normFighter);
  const combatRaw = o.combat as Record<string, unknown> | undefined;
  const combatMode = combatRaw?.mode ?? 'readable';
  if (combatMode !== 'arcade' && combatMode !== 'readable') throw new Error('combat.mode 必须是 readable 或 arcade');
  const movement = combatRaw?.movement ?? 'stationary';
  if (movement !== 'stationary' && movement !== 'bounce') throw new Error('combat.movement 必须是 stationary 或 bounce');
  if (combatMode === 'readable') {
    if (fighters.length !== 2) throw new Error('readable 模式只支持两名角色');
    for (const f of fighters) {
      if (!Number.isInteger(f.hp) || !Number.isInteger(f.atk) || !Number.isInteger(f.defense) || f.atk < 0 || (f.atkInterval ?? 0) <= 0) {
        throw new Error(`${f.name}：readable 模式要求 hp、atk、defense 为非负整数，atkInterval 为正数`);
      }
      if (f.weapon || f.skills?.length || f.takeout || f.gasTrail || f.bikeRush) {
        throw new Error(`${f.name}：readable 模式只允许普攻和固定连击；移除武器、技能、外卖、毒气及骑车机制`);
      }
      if (!f.combo || f.combo.length === 0) f.combo = [1];
      if (f.combo.some((v) => !Number.isFinite(v) || v < 0)) throw new Error(`${f.name}.combo 必须是非负固定倍率`);
      if (movement === 'stationary' && (f.trainTrail || f.dashStrike || f.speedEcho || f.memeSkill)) throw new Error(`${f.name}：动态技能需要 combat.movement: bounce`);
    }
  }
  if (movement === 'bounce' && combatMode !== 'readable') throw new Error('bounce 移动仅支持 readable 模式');
  if (fighters.some((f) => f.memeSkill) && (combatMode !== 'readable' || movement !== 'bounce' || !fighters.every((f) => f.memeSkill && !f.trainTrail && !f.dashStrike && !f.speedEcho))) throw new Error('memeSkill 需要两名 meme 角色的 readable/bounce 对战，不与列车、突刺、残影混用');
  if (movement === 'bounce') {
    const trainDuel = fighters.filter((f) => f.trainTrail).length === 1 && fighters.filter((f) => Boolean(f.dashStrike || f.speedEcho)).length === 1;
    const skillDuel = fighters.filter((f) => f.dashStrike).length === 1 && fighters.filter((f) => f.speedEcho).length === 1 && fighters.every((f) => !f.trainTrail);
    const memeDuel = fighters.every((f) => f.memeSkill && !f.trainTrail && !f.dashStrike && !f.speedEcho && f.atk === 0 && f.defense === 0 && Number.isInteger(f.memeSkill.damage));
    if ((!trainDuel && !skillDuel && !memeDuel) || fighters.some((f) => f.dashStrike && f.speedEcho)) throw new Error('bounce 剧本需要列车/突刺/残影对战，或两名关闭普攻与防御的 meme 技能角色');
  }
  const seen = new Set<string>();
  for (const f of fighters) {
    if (seen.has(f.id)) throw new Error(`fighter id 重复：${f.id}`);
    seen.add(f.id);
  }

  const twists = Array.isArray(o.twists) ? o.twists.map(normTwist) : [];
  const captions: CaptionDef[] = Array.isArray(o.captions)
    ? o.captions.map((c, i) => {
        const co = (c ?? {}) as Record<string, unknown>;
        return { t: optNum(co.t, 0), text: reqStr(co.text, `captions[${i}].text`), dur: optNum(co.dur, 3) };
      })
    : [];

  return {
    id: typeof o.id === 'string' && o.id.trim() ? o.id.trim() : idFallback,
    title: reqStr(o.title, 'title'),
    subtitle: typeof o.subtitle === 'string' ? o.subtitle : undefined,
    seed: Math.floor(optNum(o.seed, 42)),
    combat: { mode: combatMode, movement },
    fighters,
    twists,
    captions,
    timeLimit: o.timeLimit !== undefined ? optNum(o.timeLimit, 0) || undefined : undefined,
    endDuration: o.endDuration !== undefined ? reqPos(o.endDuration, 'endDuration') : undefined,
    suddenDeathAtkMultiplier: optNum(o.suddenDeathAtkMultiplier, 8),
    script: typeof o.script === 'string' && o.script.trim() ? o.script.trim() : 'default',
    audio: { volume: optNum((o.audio as Record<string, unknown> | undefined)?.volume, 1) },
    narration: (() => {
      const n = o.narration as Record<string, unknown> | undefined;
      if (!n) return undefined;
      return {
        provider: typeof n.provider === 'string' ? n.provider : undefined,
        voice: typeof n.voice === 'string' ? n.voice : undefined,
        model: typeof n.model === 'string' ? n.model : undefined,
        speed: n.speed !== undefined ? optNum(n.speed, 1.1) : undefined,
        pitch: n.pitch !== undefined ? optNum(n.pitch, 0) : undefined,
        vol: n.vol !== undefined ? optNum(n.vol, 1) : undefined,
        emotion: typeof n.emotion === 'string' ? n.emotion : undefined,
        volume: n.volume !== undefined ? optNum(n.volume, 1) : undefined,
      };
    })(),
    physics: (() => {
      const p = o.physics as Record<string, unknown> | undefined;
      if (!p) return undefined;
      return {
        restitution: p.restitution !== undefined ? Math.min(1, Math.max(0, optNum(p.restitution, 0.72))) : undefined,
        wallRestitution: p.wallRestitution !== undefined ? Math.min(1, Math.max(0, optNum(p.wallRestitution, 0.78))) : undefined,
        separationTime: p.separationTime !== undefined ? optNum(p.separationTime, 0.5) : undefined,
        separateAccel: p.separateAccel !== undefined ? optNum(p.separateAccel, 340) : undefined,
        initialSpeed: p.initialSpeed !== undefined ? optNum(p.initialSpeed, 300) : undefined,
        knockback: p.knockback !== undefined ? Math.max(0, optNum(p.knockback, 1)) : undefined,
      };
    })(),
    bgm: (() => {
      const b = o.bgm as Record<string, unknown> | undefined;
      if (b === undefined) return { file: 'bgm/chill-loop.wav', vol: 0.9, duckTo: 0.3 };
      return {
        file: typeof b.file === 'string' ? b.file : 'bgm/chill-loop.wav',
        vol: optNum(b.vol, 0.9),
        duckTo: Math.min(1, Math.max(0, optNum(b.duckTo, 0.3))),
      };
    })(),
    arena: (() => {
      const a = o.arena as Record<string, unknown> | undefined;
      if (!a) return undefined;
      const pt = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
      return {
        bumpers: Array.isArray(a.bumpers)
          ? a.bumpers.map((b) => {
              const p = pt(b);
              return { x: optNum(p.x, 540), y: optNum(p.y, 935), r: Math.max(20, optNum(p.r, 80)) };
            })
          : undefined,
        boostZones: Array.isArray(a.boostZones)
          ? a.boostZones.map((z) => {
              const p = pt(z);
              return { x: optNum(p.x, 110), y: optNum(p.y, 430), w: optNum(p.w, 180), h: optNum(p.h, 180) };
            })
          : undefined,
      };
    })(),
    publish: (() => {
      const p = o.publish as Record<string, unknown> | undefined;
      if (!p) return undefined;
      return {
        title: typeof p.title === 'string' ? p.title : undefined,
        shortTitle: typeof p.shortTitle === 'string' ? p.shortTitle : undefined,
        desc: typeof p.desc === 'string' ? p.desc : undefined,
        tags: Array.isArray(p.tags) ? p.tags.map(String) : undefined,
        tid: p.tid !== undefined ? Math.floor(optNum(p.tid, 138)) : undefined,
        coverAt: p.coverAt !== undefined ? optNum(p.coverAt, -1) : undefined,
        dtime: typeof p.dtime === 'string' ? p.dtime : undefined,
      };
    })(),
  };
}
