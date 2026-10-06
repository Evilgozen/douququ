import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
function option(name) {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`缺少 ${name}`);
  return args[i + 1];
}
const root = path.resolve(option('--project'));
const require = createRequire(path.join(root, 'package.json'));
const { load } = require('js-yaml');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const episode = load(fs.readFileSync(path.resolve(root, option('--episode')), 'utf8'));
let failures = 0, checked = 0;
const publicRoot = path.join(root, 'public');
const issues = [];
for (const fighter of episode.fighters ?? []) {
  const skill = fighter.memeSkill;
  if (!skill) continue;
  if (!Number.isInteger(skill.frameCount) || skill.frameCount <= 0 || !(skill.fps > 0) || !(skill.duration > 0)) {
    issues.push({ fighter: fighter.id, issue: '非法帧数、fps 或时长' }); failures++; continue;
  }
  if (skill.frameCount / skill.fps + 0.001 < skill.duration) {
    issues.push({ fighter: fighter.id, issue: '帧数不足以覆盖技能时长' }); failures++;
  }
  let dimensions;
  for (let i = 0; i < skill.frameCount; i++) {
    const filename = path.resolve(publicRoot, `${skill.framePrefix}${String(i).padStart(3, '0')}.png`);
    const relative = path.relative(publicRoot, filename);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('动作帧路径越出 public');
    if (!fs.existsSync(filename)) {
      issues.push({ fighter: fighter.id, frame: i, issue: '文件缺失' }); failures++; continue;
    }
    const image = await loadImage(filename);
    const size = `${image.width}x${image.height}`;
    if (dimensions && dimensions !== size) { issues.push({ fighter: fighter.id, frame: i, issue: '帧尺寸不一致' }); failures++; }
    dimensions ??= size;
    const canvas = createCanvas(image.width, image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, image.width, image.height).data;
    let visible = 0;
    for (let p = 3; p < pixels.length; p += 4) if (pixels[p] > 128) visible++;
    // 极少可见像素也需要人工确认，避免仅凭一个杂点判定角色存在。
    if (visible < Math.max(64, image.width * image.height * 0.001)) {
      issues.push({ fighter: fighter.id, frame: i, outputTime: +(i / skill.fps).toFixed(3), visiblePixels: visible, issue: visible === 0 ? '全透明空帧' : '几乎不可见，需复核' }); failures++;
    }
    checked++;
  }
}
if (checked === 0) throw new Error('没有可检查的 meme 动作帧');
console.log(JSON.stringify({ episode: episode.id, checked, failures, issues }, null, 2));
if (failures) process.exitCode = 1;
