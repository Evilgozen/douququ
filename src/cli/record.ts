/**
 * 战绩档案：跑一遍确定性对局，把胜负写入 public/leagues/roster.json
 *   npm run record -- episodes/ep001.yaml
 * VS 卡会显示双方"历史交手 X:Y"，结算卡显示胜者生涯战绩。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Battle } from '../core/sim';
import { parseEpisodeText } from '../core/loader';
import type { RosterEntry } from '../core/sim';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROSTER_PATH = path.join(projectRoot, 'public', 'leagues', 'roster.json');

function loadRoster(): Record<string, RosterEntry> {
  if (!fs.existsSync(ROSTER_PATH)) return {};
  return JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8')) as Record<string, RosterEntry>;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error('用法：npm run record -- <episode.yaml>');
    process.exit(1);
  }
  const ep = parseEpisodeText(fs.readFileSync(path.resolve(file), 'utf8'), path.basename(file).replace(/\.ya?ml$/i, ''));
  const b = new Battle(ep);
  while (!b.done && b.st.t < 600) b.step();
  const st = b.st;
  const roster = loadRoster();

  const a = st.units[0];
  const c = st.units[1];
  for (const [u, opp] of [
    [a, c],
    [c, a],
  ] as const) {
    const won = st.winner === u.side;
    const e = (roster[u.def.id] ??= { name: u.name, wins: 0, losses: 0, h2h: {} });
    e.name = u.name;
    if (won) e.wins++;
    else e.losses++;
    const h = (e.h2h[opp.def.id] ??= { w: 0, l: 0 });
    if (won) h.w++;
    else h.l++;
  }

  fs.mkdirSync(path.dirname(ROSTER_PATH), { recursive: true });
  fs.writeFileSync(ROSTER_PATH, JSON.stringify(roster, null, 2));
  const nameOf = (id: string) => roster[id]?.name ?? id;
  console.log(
    `战绩已记录：${st.winner === 0 ? '红方' : st.winner === 1 ? '蓝方' : '平局'}胜 → ${nameOf(a.def.id)} ${roster[a.def.id].wins}胜${roster[a.def.id].losses}败 / ${nameOf(c.def.id)} ${roster[c.def.id].wins}胜${roster[c.def.id].losses}败`,
  );
  console.log(`档案：${ROSTER_PATH}`);
}

main();
