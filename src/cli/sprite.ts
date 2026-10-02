/**
 * 角色立绘管线：
 *   npm run sprite -- "保安大爷，中年微胖，蓝色制服，手持警棍" public/sprites/guard.png
 *     → 火山方舟 Seedream 生成（透明背景）→ 自动归一化（裁边/方图/512px）
 *   npm run sprite:norm -- 任意图.png public/sprites/guard.png [--bg auto]
 *     → 手动模式：把你用任何工具（网页版即梦/GPT/截图）生成的图归一化
 *
 * 生图凭据：.aksk 里加「方舟」段（火山方舟控制台 → API Key 管理）：
 *   方舟
 *   <ARK_API_KEY>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** 统一风格模板：贴纸/厚描边/纯绿底（后期抠图稳定） */
const STYLE_TEMPLATE =
  'Q版贴纸风格全身立绘，{DESC}，居中构图，单角色，纯绿色背景（#00FF00），'
  + '粗深色描边，色彩鲜艳明快，简洁细节（缩小后依然可辨认），无文字，无阴影投射在背景上';

function readArkKey(): string | null {
  const p = path.resolve(process.cwd(), '.aksk');
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const marker = lines.findIndex((l) => l.includes('方舟'));
  return marker !== -1 && lines[marker + 1] ? lines[marker + 1] : null;
}

async function generate(desc: string, out: string, model: string): Promise<void> {
  const key = readArkKey();
  if (!key) {
    throw new Error('没有找到方舟 API Key：在 .aksk 里加「方舟」段（控制台 → 火山方舟 → API Key 管理），或用手动模式 npm run sprite:norm');
  }
  const prompt = STYLE_TEMPLATE.replace('{DESC}', desc);
  console.log(`生成（${model}，绿底+抠图流程）：${prompt.slice(0, 60)}…`);
  // AgentPlan 专属端点（旧 /api/v3 不认 AgentPlan key）
  const res = await fetch('https://ark.cn-beijing.volces.com/api/plan/v3/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size: '2K', response_format: 'url', watermark: false, stream: false }),
    signal: AbortSignal.timeout(120_000),
  });
  const json = (await res.json()) as { data?: Array<{ b64_json?: string; url?: string }>; error?: { message?: string } };
  const item = json.data?.[0];
  if (!item) throw new Error(`生图失败：${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`);
  const tmp = path.join(projectRoot, 'exports', 'sprite-raw.png');
  if (item.b64_json) {
    fs.writeFileSync(tmp, Buffer.from(item.b64_json, 'base64'));
  } else if (item.url) {
    const r = await fetch(item.url);
    fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
  } else {
    throw new Error('生图响应里没有图片');
  }
  console.log(`原图：${tmp}`);
  await normalize(tmp, out, 'auto');
}

/** 抠底（边界泛洪取色）+ 裁剪到内容 + 方图补透明 + 缩放 512 */
async function normalize(input: string, out: string, bg: string): Promise<void> {
  const img = await loadImage(path.resolve(input));
  const size = 1024;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, size, size);
  const imageData = ctx.getImageData(0, 0, size, size);
  const d = imageData.data;

  // 背景色 = 四角 20px 区域均值
  const corners = [[0, 0], [size - 20, 0], [0, size - 20], [size - 20, size - 20]];
  let br = 0, bgc = 0, bb = 0, n = 0;
  for (const [cx, cy] of corners) {
    for (let y = cy; y < cy + 20; y++) {
      for (let x = cx; x < cx + 20; x++) {
        const i = (y * size + x) * 4;
        br += d[i]; bgc += d[i + 1]; bb += d[i + 2]; n++;
      }
    }
  }
  br /= n; bgc /= n; bb /= n;
  if (bg !== 'auto') [br, bgc, bb] = bg === 'green' ? [0, 255, 0] : [255, 255, 255];

  // 已透明底的图（RGBA 带 alpha）直接跳过抠图：泛洪只比 RGB 会把透明区(常为纯黑RGB)连到深色描边误伤
  let alphaBorder = 0;
  const borderN = 4 * size;
  for (let x = 0; x < size; x++) {
    if (d[x * 4 + 3] === 0) alphaBorder++;
    if (d[((size - 1) * size + x) * 4 + 3] === 0) alphaBorder++;
  }
  for (let y = 0; y < size; y++) {
    if (d[(y * size) * 4 + 3] === 0) alphaBorder++;
    if (d[(y * size + size - 1) * 4 + 3] === 0) alphaBorder++;
  }
  if (alphaBorder / borderN > 0.5) {
    console.log('背景取样：跳过（检测到透明底，直接按 alpha 裁剪）');
  } else {
    console.log(`背景取样：rgb(${br.toFixed(0)},${bgc.toFixed(0)},${bb.toFixed(0)})`);
    // 边界泛洪：与背景色相近的连通区域 → 透明（容差渐进，防误伤主体）
    const visited = new Uint8Array(size * size);
    const queue: number[] = [];
    for (let x = 0; x < size; x++) { queue.push(x, (size - 1) * size + x); }
    for (let y = 0; y < size; y++) { queue.push(y * size, y * size + size - 1); }
    const tol2 = 55 * 55;
    while (queue.length > 0) {
      const p = queue.pop() as number;
      if (visited[p]) continue;
      visited[p] = 1;
      const i = p * 4;
      const dr = d[i] - br, dg = d[i + 1] - bgc, db = d[i + 2] - bb;
      if (dr * dr + dg * dg + db * db > tol2) continue;
      d[i + 3] = 0;
      const x = p % size, y = (p / size) | 0;
      if (x > 0) queue.push(p - 1);
      if (x < size - 1) queue.push(p + 1);
      if (y > 0) queue.push(p - size);
      if (y < size - 1) queue.push(p + size);
    }
  }
  // 去绿溢出：泛洪容差够不到的边缘反锯齿残留（角色色×纯绿底的混合像素）。
  // 本管线背景固定纯绿，主体不会是"绿远高于红蓝"的配色，所以强绿主导即判定为残边
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const over = d[i + 1] - Math.max(d[i], d[i + 2]);
    if (over > 60) {
      d[i + 3] = 0;                                   // 残边主体：直接抠掉
    } else if (over > 25) {
      d[i + 1] = Math.max(d[i], d[i + 2]);            // 轻度溢出：把绿压回主体色
    }
  }
  // 关键：把改了 alpha 的像素写回画布，否则后续 drawImage 用的还是原图
  ctx.putImageData(imageData, 0, 0);

  // 内容包围盒
  let minX = size, minY = size, maxX = 0, maxY = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (d[(y * size + x) * 4 + 3] > 24) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (minX > maxX) throw new Error('抠图后没有内容——背景容差可能不匹配，试试对比更强的背景色');
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  const side = Math.max(bw, bh);

  // 方图补透明 → 缩放 512
  const outCanvas = createCanvas(512, 512);
  const octx = outCanvas.getContext('2d');
  const scale = 512 / side;
  octx.imageSmoothingEnabled = true;
  octx.drawImage(canvas, minX, minY, bw, bh, (512 - bw * scale) / 2, (512 - bh * scale) / 2, bw * scale, bh * scale);

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(path.resolve(out), outCanvas.toBuffer('image/png'));
  console.log(`立绘已归一化：${path.resolve(out)}（512x512，透明底）`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const norm = argv[0] === '--norm';
  const args = argv.filter((a) => !a.startsWith('--'));
  if (norm) {
    const [input, out] = args;
    if (!input || !out) { console.error('用法：npm run sprite:norm -- <input.png> <output.png> [--bg auto|green|white]'); process.exit(1); }
    const bgFlag = argv.includes('--bg') ? argv[argv.indexOf('--bg') + 1] : 'auto';
    await normalize(input, out, bgFlag);
    return;
  }
  const [desc, out] = args;
  if (!desc || !out) {
    console.error('用法：npm run sprite -- "<角色描述>" <output.png> [--model doubao-seedream-5.0-pro|doubao-seedream-5.0-lite]');
    process.exit(1);
  }
  const mi = argv.indexOf('--model');
  const model = mi !== -1 ? argv[mi + 1] : 'doubao-seedream-5.0-pro';
  await generate(desc, out, model);
}

main().catch((e) => {
  console.error('立绘管线失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
