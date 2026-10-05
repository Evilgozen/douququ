/** 从用户原始 MP4 生成透明动作帧、静态首帧、同起点 WAV；只改演出素材。 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createCanvas } from '@napi-rs/canvas';
const require = createRequire(import.meta.url);
const ffmpeg = require('@ffmpeg-installer/ffmpeg').path as string;
const fps = 15;
const specs = [
  { id: 'amigatito', file: '阿米嘎蒂朵猫猫.mp4', start: 0, duration: 5, playbackRate: 1, crop: 'crop=360:540:180:240', w: 240, h: 360 },
  { id: 'jiujiu', file: '九九成稀罕物.mp4', start: 0, duration: 5, playbackRate: 1.2, crop: 'crop=576:576:0:254,crop=320:300:120:130', w: 320, h: 300 },
];
for (const s of specs) {
  const input = path.resolve('assets/cat-meme/raw', s.file);
  const out = path.resolve('public/memes', s.id);
  fs.mkdirSync(out, { recursive: true });
  const result = spawnSync(ffmpeg, ['-v', 'error', '-ss', String(s.start), '-i', input, '-t', String(s.duration), '-vf', `${s.crop},setpts=(PTS-STARTPTS)/${s.playbackRate},fps=${fps}:round=up,scale=${s.w}:${s.h}`, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.toString());
  const frameSize = s.w * s.h * 4;
  const count = Math.floor(result.stdout.length / frameSize);
  if (count < Math.floor(s.duration * fps)) throw new Error(`${s.id} 帧数不足：${count}`);
  // 只移除当前素材目录内超出新片段的旧生成帧，保留源视频及其他素材。
  for (const filename of fs.readdirSync(out)) {
    if (/^\d{3}\.png$/.test(filename) && Number(filename.slice(0, 3)) >= count) {
      const obsolete = path.resolve(out, filename);
      if (path.dirname(obsolete) !== out) throw new Error('帧路径超出素材目录');
      fs.unlinkSync(obsolete);
    }
  }
  const canvas = createCanvas(s.w, s.h), ctx = canvas.getContext('2d');
  let idleSaved = false;
  let leadingHeldFrames = 0;
  for (let f = 0; f < count; f++) {
    const image = ctx.createImageData(s.w, s.h);
    image.data.set(result.stdout.subarray(f * frameSize, (f + 1) * frameSize));
    for (let p = 0; p < image.data.length; p += 4) {
      const d = image.data;
      const green = Math.min(d[p + 1] - d[p], d[p + 1] - d[p + 2]);
      if (green > 30) d[p + 3] = 0;
      else if (green > 15) d[p + 3] = Math.round(255 * (30 - green) / 15);
    }
    ctx.putImageData(image, 0, 0);
    fs.writeFileSync(path.join(out, `${String(f).padStart(3, '0')}.png`), canvas.toBuffer('image/png'));
    if (!idleSaved && image.data.some((alpha, i) => i % 4 === 3 && alpha > 128)) {
      const firstVisible = canvas.toBuffer('image/png');
      fs.writeFileSync(path.join(out, 'idle.png'), firstVisible);
      // 保留视频与语音时间轴：开头绿幕空帧用首个可见姿势保持，不能跳帧提前动作。
      for (let leading = 0; leading < f; leading++) fs.writeFileSync(path.join(out, `${String(leading).padStart(3, '0')}.png`), firstVisible);
      leadingHeldFrames = f;
      idleSaved = true;
    }
  }
  if (!idleSaved) throw new Error(`${s.id} 没有可见角色帧`);
  const audio = spawnSync(ffmpeg, ['-v', 'error', '-y', '-ss', String(s.start), '-i', input, '-t', String(s.duration), '-af', `atempo=${s.playbackRate}`, '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', path.resolve('public/sfx', `meme-${s.id}.wav`)]);
  if (audio.status !== 0) throw new Error(audio.stderr.toString());
  fs.writeFileSync(path.join(out, 'source.json'), JSON.stringify({ source: s.file, start: s.start, duration: s.duration, playbackRate: s.playbackRate, sourceDuration: s.duration * s.playbackRate, fps, frameCount: count, crop: s.crop, leadingHeldFrames }, null, 2));
  console.log(`${s.id}: ${count} 透明帧 + 同步原声`);
}
const indexPath = 'public/sfx/index.json';
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
for (const s of specs) index[`meme_${s.id}`] = `meme-${s.id}.wav`;
fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');
