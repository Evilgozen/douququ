/** 第16期：从本地素材选 oi 猫与摇摇猫，统一裁切、抠像并保留原声。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
const require = createRequire(import.meta.url);
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path as string;
const sourceDir = 'images/猫meme/000.热门常用猫meme素材';
const fps = 15, duration = 5, w = 640, h = 360;
for (const [id, match] of [['oi', '】oi猫'], ['shake', '】摇摇猫']]) {
  const source = fs.readdirSync(sourceDir).find(f => f.includes(match))!;
  if (!source) throw new Error(`找不到 ${match}`);
  fs.mkdirSync('assets/cat-meme/raw', { recursive: true });
  const raw = path.resolve('assets/cat-meme/raw', source);
  if (!fs.existsSync(raw)) fs.copyFileSync(path.join(sourceDir, source), raw);
  const out = path.resolve('public/memes', id);
  fs.mkdirSync(out, { recursive: true });
  const result = spawnSync(ffmpeg, ['-v', 'error', '-ss', '0', '-i', raw, '-t', String(duration), '-vf', `setpts=PTS-STARTPTS,fps=${fps},scale=${w}:${h}`, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  const frameSize = w * h * 4, count = result.stdout.length / frameSize;
  if (count !== fps * duration) throw new Error(`帧数异常 ${count}`);
  let left = w, top = h, right = 0, bottom = 0;
  const frames = Array.from({ length: count }, (_, f) => {
    const data = new Uint8ClampedArray(result.stdout.subarray(f * frameSize, (f + 1) * frameSize));
    for (let p = 0; p < data.length; p += 4) {
      const green = Math.min(data[p + 1] - data[p], data[p + 1] - data[p + 2]);
      data[p + 3] = green > 30 ? 0 : green > 15 ? Math.round(255 * (30 - green) / 15) : 255;
      if (data[p + 3] > 128) {
        const x = (p / 4) % w, y = Math.floor(p / 4 / w);
        left = Math.min(left, x); right = Math.max(right, x);
        top = Math.min(top, y); bottom = Math.max(bottom, y);
      }
    }
    return data;
  });
  left = Math.max(0, left - 8); top = Math.max(0, top - 8);
  right = Math.min(w - 1, right + 8); bottom = Math.min(h - 1, bottom + 8);
  const cw = right - left + 1, ch = bottom - top + 1;
  const canvas = createCanvas(w, h), ctx = canvas.getContext('2d');
  const cropped = createCanvas(cw, ch), cropCtx = cropped.getContext('2d');
  let firstVisible: Buffer | null = null, leadingHeldFrames = 0;
  for (const [f, data] of frames.entries()) {
    const img = ctx.createImageData(w, h); img.data.set(data); ctx.putImageData(img, 0, 0);
    cropCtx.clearRect(0, 0, cw, ch); cropCtx.drawImage(canvas, left, top, cw, ch, 0, 0, cw, ch);
    const png = cropped.toBuffer('image/png');
    fs.writeFileSync(path.join(out, `${String(f).padStart(3, '0')}.png`), png);
    if (!firstVisible && data.some((v, i) => i % 4 === 3 && v > 128)) {
      firstVisible = png; leadingHeldFrames = f; fs.writeFileSync(path.join(out, 'idle.png'), png);
      for (let n = 0; n < f; n++) fs.writeFileSync(path.join(out, `${String(n).padStart(3, '0')}.png`), png);
    }
  }
  if (!firstVisible) throw new Error(`${id} 全透明`);
  const audio = spawnSync(ffmpeg, ['-v', 'error', '-y', '-ss', '0', '-i', raw, '-t', String(duration), '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', `public/sfx/meme-${id}.wav`]);
  if (audio.status !== 0) throw new Error(audio.stderr.toString());
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({ source, sourceLibrary: sourceDir, start: 0, duration, sourceDuration: duration, playbackRate: 1, fps, frameCount: count, crop: { left, top, width: cw, height: ch, workingWidth: w, workingHeight: h }, leadingHeldFrames }, null, 2));
  const index = JSON.parse(fs.readFileSync('public/sfx/index.json', 'utf8'));
  index[`meme_${id}`] = `meme-${id}.wav`;
  fs.writeFileSync('public/sfx/index.json', JSON.stringify(index, null, 2) + '\n');
  console.log(`${id}: ${count} 帧，${cw}x${ch}，原声 ${duration}s`);
}
