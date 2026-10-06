import type { Projectile } from './sim';

/** 绘制和碰撞使用同一条曲线，蛋不会在影子位置提前命中。 */
export function memeProjectilePosition(pr: Projectile, progress = pr.t): { x: number; y: number } {
  const t = Math.max(0, Math.min(1, progress));
  const lift = pr.meme?.kind === 'eggs' ? 140 * Math.sin(Math.PI * t) : 0;
  return { x: pr.sx + (pr.tx - pr.sx) * t, y: pr.sy + (pr.ty - pr.sy) * t - lift };
}

/** 绘制与命中共用有限扇形环带。 */
export function soundwaveOverlaps(pr: Projectile, x: number, y: number, radius: number, previous: number, current: number): boolean {
  const dx = x - pr.sx, dy = y - pr.sy, d = Math.hypot(dx, dy), m = pr.meme!;
  if (d + radius < previous - m.radius || d - radius > current + m.radius) return false;
  const angle = Math.atan2(dy, dx) - m.angle!;
  const delta = Math.abs(Math.atan2(Math.sin(angle), Math.cos(angle)));
  const padding = d > radius ? Math.asin(radius / d) : Math.PI;
  return delta <= m.spread! * Math.PI / 360 + padding;
}
