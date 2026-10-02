/**
 * 视频号素材包：把成片 + 封面 + 元数据（短标题/描述/标签）组装到一个版本目录
 *   npm run pack -- episodes/ep001.yaml [--out output/V1]
 * 视频缺失时自动先渲染。视频号没有个人发布 API，这个目录用于手动上传（或交给
 * social-auto-upload 之类的浏览器自动化工具）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEpisodeText } from '../core/loader';
import type { Episode } from '../core/types';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXPORTS = path.join(projectRoot, 'exports');

function sh(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { cwd: projectRoot, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`);
}

function videoOf(ep: Episode): string {
  return path.join(EXPORTS, `${ep.id}-seed${ep.seed}.mp4`);
}

function coverOf(ep: Episode): string {
  return path.join(EXPORTS, `cover-${ep.id}-seed${ep.seed}.jpg`);
}

/** 视频号短标题：去【】、按冒号截断、最长 20 字 */
function deriveShortTitle(ep: Episode): string {
  if (ep.publish?.shortTitle) return ep.publish.shortTitle;
  const t = (ep.publish?.title ?? ep.title).replace(/[【】]/g, '');
  const head = t.split(/[：:｜|]/)[0].trim();
  return head.length > 20 ? head.slice(0, 20) : head;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let outDirName = 'output/V1';
  const fileArgs = [...argv];
  const oi = argv.indexOf('--out');
  if (oi !== -1) {
    outDirName = argv[oi + 1];
    fileArgs.splice(oi, 2);
  }
  const file = fileArgs[0];
  if (!file) {
    console.error('用法：npm run pack -- <episode.yaml> [--out output/V1]');
    process.exit(1);
  }
  const ep = parseEpisodeText(fs.readFileSync(path.resolve(file), 'utf8'), path.basename(file).replace(/\.ya?ml$/i, ''));
  let video = videoOf(ep);
  let cover = coverOf(ep);

  if (!fs.existsSync(video)) {
    console.log('成片不存在，先渲染…');
    sh('node_modules/.bin/tsx', ['src/cli/render.ts', path.resolve(file)]);
  }
  if (!fs.existsSync(video)) throw new Error(`渲染后仍未找到成片：${video}`);
  if (!fs.existsSync(cover)) {
    console.log('封面不存在，先生成…');
    sh('node_modules/.bin/tsx', ['src/cli/cover.ts', video, String(ep.publish?.coverAt ?? -1)]);
  }
  if (!fs.existsSync(cover)) throw new Error(`生成后仍未找到封面：${cover}`);

  const outDir = path.resolve(projectRoot, outDirName);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(video, path.join(outDir, `${ep.id}.mp4`));
  fs.copyFileSync(cover, path.join(outDir, 'cover.jpg'));

  const metadata = {
    // 视频号发布字段：短标题 ≤20 字、正文描述、话题标签
    shortTitle: deriveShortTitle(ep),
    title: ep.publish?.title ?? ep.title,
    desc: ep.publish?.desc ?? '',
    tags: ep.publish?.tags ?? ['电子斗蛐蛐', '斗蛐蛐', '搞笑'],
    cover: 'cover.jpg',
    video: `${ep.id}.mp4`,
    durationSec: null as number | null,
    platform: '视频号（手动发布：channels.weixin.qq.com）',
  };
  fs.writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2));

  console.log(`\n素材包：${outDir}`);
  console.log(`  ${ep.id}.mp4 / cover.jpg / metadata.json`);
  console.log(`  短标题：${metadata.shortTitle}`);
  console.log('  → 手动上传 channels.weixin.qq.com，或交给 social-auto-upload 之类的工具消费');
}

main().catch((e) => {
  console.error('打包失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
