/**
 * 逐帧遥测：与渲染完全同路径（挂同一份 Lua 演出脚本、同 seed、同步长）跑 ep007，
 * 每 0.1s 导出双角色状态，并记录骑车/踹击/摔倒事件窗口。
 *   npx tsx scripts/telemetry.ts [episode.yaml]
 * 输出：exports/telemetry.json + 控制台事件摘要（帧↔视频对齐用）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEpisodeText } from '../src/core/loader';
import { Battle, LOGIC_DT, type BattleState } from '../src/core/sim';
import { ScriptHost, bindHooks } from '../src/script/luaHost';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const yamlPath = process.argv[2] ?? path.join(projectRoot, 'public/episodes/ep007-naiwa-vs-kangaroo.yaml');
const ep = parseEpisodeText(fs.readFileSync(yamlPath, 'utf8'), 'ep');

// 与 render.ts loadScriptCode 相同：public/scripts/<script>.lua
function loadScriptCode(): string | null {
  const p = path.join(projectRoot, 'public/scripts', `${ep.script ?? 'default'}.lua`);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

interface Row {
  t: number; // 全局秒（含 4.4s 开场）
  fightT: number;
  naiwa: { x: number; y: number; v: number; bike: number; stun: number };
  roo: { x: number; y: number; v: number; stun: number };
  dist: number;
  gas: number;
}

async function main(): Promise<void> {
  const b = new Battle(ep);
  const st: BattleState = b.st;
  let host: ScriptHost | null = null;
  try {
    host = await ScriptHost.create(loadScriptCode() ?? '', bindHooks(() => st, { sfxVol: 1 }));
    b.onEvent = (ev) => void host?.dispatch(ev);
  } catch {
    /* 无脚本也能跑 */
  }

  const rows: Row[] = [];
  const events: Array<{ t: number; kind: string; note: string }> = [];
  let acc = 0;
  const roo = () => st.units.find((u) => u.def.id === 'kangaroo')!;
  const nai = () => st.units.find((u) => u.def.id === 'naiwa')!;

  let prevRooVx = 0;
  let prevRooVy = 0;
  while (!b.done && st.t < 600) {
    const before = { vx: roo().vx, vy: roo().vy, hp: roo().hp };
    const naiwaBikeBefore = nai().bikeT;
    const naiwaStunBefore = nai().stunT;
    b.step();
    acc += LOGIC_DT;
    // 事件检测（从 st.events 由 onEvent 消费掉了，直接做差分检测）
    const roo2 = roo();
    const dvx = roo2.vx - before.vx;
    const dvy = roo2.vy - before.vy;
    if (Math.hypot(dvx, dvy) > 450) {
      // 袋鼠速度瞬变 = 大脚踹击飞（定向设定速度）或强弹板
      events.push({
        t: Number(st.t.toFixed(2)),
        kind: 'kick?',
        note: `袋鼠速度 ${Math.hypot(before.vx, before.vy) | 0}→${Math.hypot(roo2.vx, roo2.vy) | 0}px/s hp ${before.hp | 0}→${roo2.hp | 0}`,
      });
    }
    if (naiwaBikeBefore <= 0 && nai().bikeT > 0) events.push({ t: Number(st.t.toFixed(2)), kind: 'bike-start', note: `奶娃上车` });
    if (naiwaBikeBefore > 0 && nai().bikeT <= 0) {
      events.push({ t: Number(st.t.toFixed(2)), kind: 'bike-crash', note: `摔倒于(${nai().x | 0},${nai().y | 0}) 袋鼠距${Math.hypot(roo2.x - nai().x, roo2.y - nai().y) | 0}px` });
    }
    if (naiwaStunBefore <= 0 && nai().stunT > 0 && nai().bikeT <= 0) events.push({ t: Number(st.t.toFixed(2)), kind: 'stun', note: '' });
    if (acc >= 0.1) {
      acc = 0;
      const n = nai();
      const r = roo();
      rows.push({
        t: Number(st.t.toFixed(2)),
        fightT: Number(st.fightT.toFixed(2)),
        naiwa: { x: n.x | 0, y: n.y | 0, v: Math.hypot(n.vx, n.vy) | 0, bike: Number(n.bikeT.toFixed(2)), stun: Number(n.stunT.toFixed(2)) },
        roo: { x: r.x | 0, y: r.y | 0, v: Math.hypot(r.vx, r.vy) | 0, stun: Number(r.stunT.toFixed(2)) },
        dist: Math.hypot(r.x - n.x, r.y - n.y) | 0,
        gas: st.gases.length,
      });
    }
    prevRooVx = roo2.vx;
    prevRooVy = roo2.vy;
  }
  events.push({ t: Number(st.t.toFixed(2)), kind: 'end', note: `winner=${st.winner} fightT=${st.fightT.toFixed(1)}` });

  fs.writeFileSync(path.join(projectRoot, 'exports/telemetry.json'), JSON.stringify({ rows, events }, null, 1));
  console.log('=== 事件窗口（全局秒；视频时间≈全局+慢放拉伸，每段 slowmo 约 +0.8s）===');
  for (const e of events) console.log(`  t=${e.t}s [${e.kind}] ${e.note}`);
  // 骑车窗口的速度/距离画像
  let riding = false;
  for (const r of rows) {
    if (r.naiwa.bike > 0 && !riding) {
      riding = true;
      console.log(`  -- 骑车段开始 fightT=${r.fightT}`);
    }
    if (r.naiwa.bike > 0) {
      console.log(`     fightT=${r.fightT} 奶娃(${r.naiwa.x},${r.naiwa.y}) v=${r.naiwa.v} 袋鼠v=${r.roo.v} 距离=${r.dist} 云数=${r.gas}`);
    }
    if (r.naiwa.bike <= 0 && riding) {
      riding = false;
      console.log(`  -- 骑车段结束（摔倒）`);
    }
  }
}

main();
