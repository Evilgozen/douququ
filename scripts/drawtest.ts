import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Battle } from '../src/core/sim';
import { parseEpisodeText } from '../src/core/loader';
import { drawFrame } from '../src/render/draw';
const ep = parseEpisodeText(fs.readFileSync('public/episodes/ep002-guard-vs-intern.yaml', 'utf8'), 'p');
const b = new Battle(ep);
const canvas = createCanvas(1080, 1920);
const ctx = canvas.getContext('2d');
let saved = 0;
while (!b.done && st().t < 12) {
  b.step();
  if (st().projectiles.length > 0 && st().projectiles[0].t > 0.4 && saved < 1) {
    drawFrame(ctx as unknown as CanvasRenderingContext2D, st(), new Map());
    fs.writeFileSync('/tmp/drawtest.png', canvas.toBuffer('image/png'));
    const p = st().projectiles[0];
    const px = p.sx + (p.tx - p.sx) * p.t;
    const py = p.sy + (p.ty - p.sy) * p.t;
    console.log(`saved frame, projectile at (${px.toFixed(0)},${py.toFixed(0)}) t=${p.t.toFixed(2)}`);
    saved++;
  }
}
function st() { return b.st; }
