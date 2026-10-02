/** webm → mp4（浏览器录制结果的转码）：npm run transcode -- <file.webm> */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { path: ffmpegPath } = require('@ffmpeg-installer/ffmpeg');

const input = process.argv[2];
if (!input || !fs.existsSync(input)) {
  console.error('用法：npm run transcode -- <file.webm>');
  process.exit(1);
}
const out = input.replace(/\.\w+$/, '') + '.mp4';
console.log(`转码：${input} → ${out}`);
const ff = spawn(ffmpegPath, [
  '-y', '-i', input,
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  out,
], { stdio: 'inherit' });
ff.on('close', (code) => {
  if (code === 0) console.log(`完成：${out}`);
  else process.exit(code ?? 1);
});
