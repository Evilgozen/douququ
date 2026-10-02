import fs from 'node:fs';
import { Battle } from '../src/core/sim';
import { parseEpisodeText } from '../src/core/loader';
const ep = parseEpisodeText(fs.readFileSync('public/episodes/ep002-guard-vs-intern.yaml', 'utf8'), 'p');
const b = new Battle(ep);
const st = b.st;
let logged = 0;
while (!b.done && st.t < 600) {
  b.step();
  if (st.projectiles.length > 0 && logged < 6) {
    const p = st.projectiles[0];
    const px = p.sx + (p.tx - p.sx) * p.t;
    const py = p.sy + (p.ty - p.sy) * p.t;
    console.log(`t=${st.t.toFixed(2)} n=${st.projectiles.length} pos=(${px.toFixed(0)},${py.toFixed(0)}) t=${p.t.toFixed(2)} dmg=${p.damage}`);
    logged++;
  }
}
console.log('结束');
