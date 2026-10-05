import type { Projectile } from './sim';

/** 绘制和碰撞使用同一条曲线，蛋不会在影子位置提前命中。 */
export function memeProjectilePosition(pr: Projectile, progress = pr.t): { x: number; y: number } {
  const t = Math.max(0, Math.min(1, progress));
  const lift = pr.meme?.kind === 'eggs' ? 140 * Math.sin(Math.PI * t) : 0;
  return { x: pr.sx + (pr.tx - pr.sx) * t, y: pr.sy + (pr.ty - pr.sy) * t - lift };
}
