/**
 * 封面生成：从成片抽取一帧做竖屏封面
 *   npm run cover -- exports/ep001-xxx.mp4 [秒数]
 * 不给秒数则取全片 40% 处（通常是冲突最激烈的时段附近）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function ff(args: string[]): Promise<void> {
  const { path: ffmpegPath } = await import('@ffmpeg-installer/ffmpeg');
  await new Promise<void>((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
    p.on('error', reject);
  });
}

async function main(): Promise<void> {
  const video = process.argv[2];
  if (!video || !fs.existsSync(video)) {
    console.error('用法：npm run cover -- <video.mp4> [时刻秒]');
    process.exit(1);
  }
  const at = process.argv[3] ?? '-1';
  const id = path.basename(video).replace(/\.mp4$/i, '').replace(/-seed\d+$/, '');

  // -1 表示取"最大伤害瞬间"：懒得算就取 40%
  let atSec = Number(at);
  if (atSec < 0) {
    atSec = -1; // 用 ffmpeg 探时长再取 40%
    const { path: ffmpegPath } = await import('@ffmpeg-installer/ffmpeg');
    await new Promise<void>((resolve) => {
      const p = spawn(ffmpegPath, ['-i', video, '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', (d) => (err += String(d)));
      p.on('close', () => {
        const m = err.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
        if (m) atSec = (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 0.4;
        resolve();
      });
    });
  }

  const out = path.join(projectRoot, 'exports', `cover-${id}.jpg`);
  await ff(['-y', '-loglevel', 'error', '-ss', String(atSec), '-i', video, '-frames:v', '1', '-q:v', '2', out]);
  console.log(`封面：${out}（取自 ${atSec.toFixed(1)}s）`);
}

main().catch((e) => {
  console.error('封面生成失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
