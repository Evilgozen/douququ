/** 素材加载：按剧本收集 sprite 路径，浏览器与 Node 双端各自实现。 */
import type { Episode } from '../core/types';
import type { Assets } from './draw';
import { memeFramePath } from './memeFrames';

export function collectSpritePaths(ep: Episode): string[] {
  const paths = new Set<string>();
  for (const f of ep.fighters) {
    if (f.sprite) paths.add(f.sprite);
    if (f.memeSkill) for (let i = 0; i < f.memeSkill.frameCount; i++) paths.add(memeFramePath(f.memeSkill, i));
    if (f.memeSkill?.effect?.sprite) paths.add(f.memeSkill.effect.sprite);
    if (f.stateSprites?.bike) paths.add(f.stateSprites.bike);
    if (f.stateSprites?.stun) paths.add(f.stateSprites.stun);
    if (f.stateSprites?.block) paths.add(f.stateSprites.block);
    if (f.stateSprites?.berserk) paths.add(f.stateSprites.berserk);
    if (f.kickSprite) paths.add(f.kickSprite);
    for (const it of f.takeout?.items ?? []) if (it.sprite) paths.add(it.sprite);
  }
  for (const tw of ep.twists ?? []) {
    const ef = tw.effect;
    if (ef?.type === 'reinforce' && ef.fighter.sprite) paths.add(ef.fighter.sprite);
  }
  return [...paths];
}

/** 白色剪影像：贴图 → source-in 填白，只剩角色形状的纯白版（受击闪白专用） */
function makeWhiteSilhouette(img: unknown, w: number, h: number, mkCanvas: (w2: number, h2: number) => unknown): unknown {
  const c = mkCanvas(w, h) as { getContext: (id: '2d') => CanvasRenderingContext2D } & CanvasImageSource;
  const c2d = c.getContext('2d');
  c2d.drawImage(img as CanvasImageSource, 0, 0, w, h);
  c2d.globalCompositeOperation = 'source-in';
  c2d.fillStyle = '#ffffff';
  c2d.fillRect(0, 0, w, h);
  return c;
}

/** 浏览器：public/ 下的文件直接以 /path 访问 */
export async function loadSpritesBrowser(paths: string[]): Promise<Assets> {
  const assets: Assets = new Map();
  await Promise.all(
    paths.map(
      (p) =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = () => {
            const mk = (w2: number, h2: number) => {
              const c = document.createElement('canvas');
              c.width = w2;
              c.height = h2;
              return c;
            };
            assets.set(p, { img, w: img.naturalWidth, h: img.naturalHeight, white: makeWhiteSilhouette(img, img.naturalWidth, img.naturalHeight, mk) });
            resolve();
          };
          img.onerror = () => {
            console.warn(`[assets] 加载失败，使用简笔占位：${p}`);
            resolve();
          };
          img.src = '/' + p;
        }),
    ),
  );
  return assets;
}

/** Node CLI：public/ 下的文件从磁盘读 */
export async function loadSpritesNode(paths: string[], publicDir: string): Promise<Assets> {
  const assets: Assets = new Map();
  if (paths.length === 0) return assets;
  // Keep Node-only native modules out of Vite's browser dependency graph. The
  // variable module IDs plus @vite-ignore defer resolution to the Node runtime.
  const canvasModule = '@napi-rs/canvas';
  const pathModule = 'node:path';
  const fsModule = 'node:fs';
  const { loadImage, createCanvas } = await import(/* @vite-ignore */ canvasModule);
  const path = await import(/* @vite-ignore */ pathModule);
  const fs = await import(/* @vite-ignore */ fsModule);
  await Promise.all(
    paths.map(async (p) => {
      const full = path.join(publicDir, p);
      try {
        if (!fs.existsSync(full)) throw new Error('not found');
        const img = await loadImage(full);
        const mk = (w2: number, h2: number) => createCanvas(w2, h2);
        assets.set(p, { img, w: img.width, h: img.height, white: makeWhiteSilhouette(img, img.width, img.height, mk) });
      } catch {
        console.warn(`[assets] 加载失败，使用简笔占位：${full}`);
      }
    }),
  );
  return assets;
}
