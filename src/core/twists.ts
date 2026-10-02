/**
 * 反转系统：触发器（残血/定时/死亡）→ 效果（狂暴/复活/援军/倍率）+ 演出（慢放/闪白/横幅/金色字幕）。
 * 这是内容壁垒所在：随机引擎决定下限，反转剧本决定上限。
 */
import type { Battle, BattleState, Unit } from './sim';
import type { TwistDef, TwistEffect } from './types';

export function evalTwists(b: Battle): void {
  const st = b.st;
  const twists = st.ep.twists ?? [];
  for (let i = 0; i < twists.length; i++) {
    if (st.firedTwists[i]) continue;
    const tw = twists[i];
    const focus = matchTrigger(st, tw);
    if (focus !== null) fire(b, i, tw, focus);
  }
}

function matchTrigger(st: BattleState, tw: TwistDef): Unit | null {
  const tr = tw.trigger;
  if ('hpBelowPct' in tr) {
    const candidates = tr.fighter ? st.units.filter((u) => u.def.id === tr.fighter) : st.units;
    for (const u of candidates) {
      if (u.alive && u.hp / u.maxHp < tr.hpBelowPct) return u;
    }
    return null;
  }
  if ('timeAt' in tr) {
    if (st.fightT < tr.timeAt) return null;
    const f = (tr as { timeAt: number; fighter?: string }).fighter;
    if (f) return st.units.find((u) => u.alive && u.def.id === f) ?? null;
    return st.units.find((u) => u.alive) ?? null;
  }
  if ('fighterDead' in tr) {
    return st.units.find((u) => !u.alive && u.def.id === tr.fighterDead) ?? null;
  }
  return null;
}

function fire(b: Battle, i: number, tw: TwistDef, focus: Unit | null): void {
  const st = b.st;
  st.firedTwists[i] = true;
  if (tw.effect) applyEffect(b, tw.effect, focus, tw);
  if (tw.slowmo && tw.slowmo > 0) {
    st.slowmo = tw.slowmo;
    if (focus) {
      // 变焦中心：x 锁定居中，y 钳制在安全带（面板完整入画且不压 HUD）
      st.zoomX = 540;
      st.zoomY = Math.min(944, Math.max(926, focus.y));
    }
  }
  st.flash = Math.max(st.flash, 0.9);
  if (tw.banner) st.banners.push({ text: tw.banner, life: 2.2, maxLife: 2.2, color: '#ffd32a' });
  if (tw.caption) st.captions.push({ t: st.t, dur: 3.4, text: tw.caption, gold: true });
  // 纯解说型反转不进击杀播报，避免内部标签漏出
  if (tw.banner || tw.effect) st.feed.push({ text: `反转：${tw.banner ?? tw.effect?.type}`, life: 3.5 });
}

function applyEffect(b: Battle, e: TwistEffect, focus: Unit | null, tw?: TwistDef): void {
  const st = b.st;
  switch (e.type) {
    case 'berserk': {
      if (!focus) return;
      focus.props.berserk = 1;
      focus.fighter.addBuff({
        label: tw?.banner ?? '狂暴',
        atkMult: e.atkMultiplier ?? 1,
        intervalMult: e.intervalMultiplier ?? 1,
        speedMult: e.speedMultiplier ?? 1,
        remainingHits: e.durationHits ?? -1,
        remainingTime: e.durationSec ?? -1,
      });
      if (e.healPct) focus.hp = Math.min(focus.maxHp, focus.hp + focus.maxHp * e.healPct);
      if (e.shieldPct) focus.shield += focus.maxHp * e.shieldPct;
      popup(st, focus.x, focus.y - 205, '力量暴涨！', '#ffd32a', 44);
      break;
    }
    case 'revive': {
      if (!focus) return;
      const wasDead = !focus.alive;
      focus.alive = true;
      focus.hp = focus.maxHp * (e.hpPct ?? 1);
      focus.dispHp = focus.hp;
      focus.shield = e.shieldPct ? focus.maxHp * e.shieldPct : 0;
      focus.props.berserk = 1;
      focus.fighter.addBuff({
        label: tw?.banner ?? '觉醒',
        atkMult: e.atkMultiplier ?? 1,
        intervalMult: e.intervalMultiplier ?? 1,
        speedMult: e.speedMultiplier ?? 1,
        remainingHits: e.durationHits ?? -1,
        remainingTime: e.durationSec ?? -1,
      });
      if (wasDead) {
        popup(st, focus.x, focus.y - 205, '复活！', '#ffd32a', 52);
        st.feed.push({ text: `${focus.name} 站起来了！！`, life: 3.5 });
      }
      break;
    }
    case 'statMultiply': {
      const targets =
        e.targets === 'self' && focus
          ? [focus]
          : e.targets === 'enemy' && focus
            ? st.units.filter((u) => u.alive && u.side !== focus.side)
            : st.units.filter((u) => u.alive);
      for (const u of targets) {
        u.fighter.addBuff({
          label: '攻击强化',
          atkMult: e.atkMultiplier,
          intervalMult: 1,
          speedMult: 1,
          remainingHits: -1,
          remainingTime: -1,
        });
        popup(st, u.x, u.y - 205, `攻击 x${e.atkMultiplier}`, '#ff9f43', 38);
      }
      break;
    }
    case 'shield': {
      if (!focus) return;
      focus.shield += focus.maxHp * (e.hpPct ?? 0.5);
      popup(st, focus.x, focus.y - 205, `护盾 ${fmtShield(focus.shield)}`, '#a5b4fc', 36);
      break;
    }
    case 'heal': {
      if (!focus) return;
      const healed = Math.min(focus.maxHp - focus.hp, focus.maxHp * (e.hpPct ?? 0.5));
      focus.hp += healed;
      popup(st, focus.x, focus.y - 205, `+${fmtShield(healed)}`, '#4ade80', 38);
      break;
    }
    case 'reinforce': {
      const side = e.side ?? focus?.side ?? 0;
      const count = e.count ?? 1;
      for (let k = 0; k < count; k++) b.spawnUnit(e.fighter, side);
      break;
    }
  }
}

function fmtShield(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return `${Math.round(n)}`;
}

function popup(st: BattleState, x: number, y: number, text: string, color: string, size: number): void {
  st.popups.push({
    kind: 'up',
    x,
    y,
    text,
    mult: 1,
    life: 1.1,
    maxLife: 1.1,
    color,
    size,
  });
}
