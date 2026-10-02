/**
 * 生成"数字弹幕"素材：粉笔风格白色数字，透明底，黑板美学。
 * 用法：npx tsx scripts/make_number_sprites.ts 3 6 10 ... [--out public/sprites]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';

const argv = process.argv.slice(2);
const outFlag = argv.indexOf('--out');
const outDir = outFlag >= 0 ? argv[outFlag + 1] : 'public/sprites';
const nums = argv.filter((a, i) => a !== '--out' && !(outFlag >= 0 && i === outFlag + 1));

if (nums.length === 0) {
  console.error('用法：npx tsx scripts/make_number_sprites.ts 1 2 3 5 8 [--out public/sprites]');
  process.exit(1);
}

for (const n of nums) {
  const S = 512;
  const canvas = createCanvas(S, S);
  const ctx = canvas.getContext('2d');

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // 字号：一位数超大，位数越多越小，保证宽度不超画布
  const size = n.length === 1 ? 400 : n.length === 2 ? 300 : 220;
  ctx.font = `bold ${size}px sans-serif`;

  // 金色弹幕风：与白色伤害弹窗分色，观众能区分"飞来的数字"和"打出的伤害"
  ctx.shadowColor = 'rgba(251,191,36,0.9)';
  ctx.shadowBlur = 26;
  ctx.lineWidth = 22;
  ctx.strokeStyle = 'rgba(120,72,10,0.95)';
  ctx.strokeText(n, S / 2, S / 2 + size * 0.04);

  ctx.shadowBlur = 10;
  ctx.fillStyle = '#fde68a';
  ctx.fillText(n, S / 2, S / 2 + size * 0.04);
  ctx.shadowBlur = 0;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText(n, S / 2 - 2, S / 2 + size * 0.04 - 3);

  const out = path.resolve(outDir, `num-${n}.png`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, canvas.toBuffer('image/png'));
  console.log(`数字素材：${out}`);
}
