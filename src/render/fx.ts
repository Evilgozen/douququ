/** 特效绘制：粒子、光束、地图机关（弹板/加速带）。纯绘制，状态全部来自模拟层。 */
import { ARENA, type BattleState, type Particle } from '../core/sim';
import type { Assets } from './draw';
import { memeProjectilePosition } from '../core/memeMotion';
import { memeFrameAt } from './memeFrames';

type Ctx = CanvasRenderingContext2D;

export function drawBeams(ctx: Ctx, st: BattleState): void {
  for (const b of st.beams) {
    const a = b.life / b.maxLife;
    ctx.save();
    ctx.globalAlpha = a;
    ctx.shadowBlur = 22;
    ctx.shadowColor = b.color;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = b.width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.x1, b.y1);
    ctx.lineTo(b.x2, b.y2);
    ctx.stroke();
    // 白芯
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(2, b.width * 0.3);
    ctx.stroke();
    ctx.restore();
  }
}

export function drawParticles(ctx: Ctx, st: BattleState): void {
  for (const p of st.particles) {
    const a = Math.max(0, p.life / p.maxLife);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    if (p.kind === 'frag') {
      ctx.translate(p.x, p.y);
      ctx.rotate(p.x * 0.05);
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * (p.kind === 'spark' ? a : 1), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

export function drawMechanisms(ctx: Ctx, st: BattleState): void {
  // 弹板：脉冲发光圆环
  st.arena.bumpers.forEach((bp, i) => {
    const pulse = Math.sin(st.t * 6 + i * 1.7) * 4;
    ctx.save();
    ctx.shadowBlur = 24;
    ctx.shadowColor = '#4b6cc4';
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, bp.r + pulse, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,30,58,0.92)';
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#4b6cc4';
    ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(bp.x, bp.y, bp.r * 0.55, 0, Math.PI * 2);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(109,132,200,0.6)';
    ctx.stroke();
    ctx.restore();
  });

  // 加速带：半透明区块 + 向外的箭头
  st.arena.boosts.forEach((z) => {
    ctx.save();
    ctx.fillStyle = 'rgba(255,211,42,0.08)';
    ctx.strokeStyle = 'rgba(255,211,42,0.45)';
    ctx.lineWidth = 3;
    ctx.setLineDash([14, 10]);
    ctx.beginPath();
    ctx.rect(z.x, z.y, z.w, z.h);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    // 箭头：指向"场地中心 → 区块中心"的径向向外方向
    const cx = z.x + z.w / 2 - (ARENA.left + ARENA.right) / 2;
    const cy = z.y + z.h / 2 - (ARENA.top + ARENA.bottom) / 2;
    const ang = Math.atan2(cy, cx);
    ctx.translate(z.x + z.w / 2, z.y + z.h / 2);
    ctx.rotate(ang);
    ctx.fillStyle = 'rgba(255,211,42,0.75)';
    for (const off of [-26, 0, 26]) {
      ctx.beginPath();
      ctx.moveTo(off + 12, 0);
      ctx.lineTo(off - 4, -11);
      ctx.lineTo(off - 4, 11);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  });
}

export type { Particle };

/** 五角星（眩晕星星/胜者皇冠共用） */
export function drawStar(ctx: Ctx, cx: number, cy: number, R: number, r: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? R : r;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const x = cx + Math.cos(a) * rad;
    const y = cy + Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#7a5a00';
  ctx.stroke();
  ctx.restore();
}

/** 毒气云：三团叠加绿雾各自漂移（相位来自模拟时间，确定性重放一致） */
export function drawGases(ctx: Ctx, st: BattleState): void {
  for (let i = 0; i < st.gases.length; i++) {
    const g = st.gases[i];
    const fadeIn = Math.min(1, (g.maxLife - g.life) / 0.3);
    const fadeOut = Math.min(1, g.life / 0.5);
    const a = 0.32 * fadeIn * fadeOut;
    if (a <= 0.01) continue;
    for (let k = 0; k < 3; k++) {
      const ph = st.t * (0.5 + k * 0.23) + i * 1.9 + k * 2.1;
      const ox = Math.sin(ph) * g.r * 0.22;
      const oy = Math.cos(ph * 0.8) * g.r * 0.15 - k * g.r * 0.12;
      const rad = g.r * (0.85 - k * 0.16);
      const grad = ctx.createRadialGradient(g.x + ox, g.y + oy, rad * 0.15, g.x + ox, g.y + oy, rad);
      grad.addColorStop(0, `rgba(116, 235, 124, ${(a * 0.95).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(74, 222, 128, 0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(g.x + ox, g.y + oy, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** 冲击波：强击退命中瞬间的扩散圆环（半径随 life 推进、线宽收窄） */
export function drawShocks(ctx: Ctx, st: BattleState): void {
  for (const s of st.shocks) {
    const p = 1 - s.life / s.maxLife;
    const r = s.r + (s.maxR - s.r) * (1 - Math.pow(1 - p, 2));
    ctx.save();
    ctx.globalAlpha = (1 - p) * 0.9;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = Math.max(2, 14 * (1 - p));
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = (1 - p) * 0.4;
    ctx.lineWidth = Math.max(1, 6 * (1 - p));
    ctx.beginPath();
    ctx.arc(s.x, s.y, r * 0.72, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/** 飞行道具绘制：专属素材（火锅/奶茶）> 外卖袋 > 公文包；抛物线高度 + 地面影子 + 名字 */
export function drawProjectiles(ctx: Ctx, st: BattleState, assets?: Assets): void {
  for (const pr of st.projectiles) {
    if (pr.meme?.kind === 'soundwave' || pr.meme?.kind === 'mines') {
      const m = pr.meme;
      if (!m.launched) continue;
      ctx.save();
      ctx.beginPath(); ctx.rect(ARENA.left, ARENA.top, ARENA.right - ARENA.left, ARENA.bottom - ARENA.top); ctx.clip();
      if (m.kind === 'soundwave') {
        const r = Math.min(m.reach!, m.age! * pr.speed), a = m.spread! * Math.PI / 360;
        ctx.translate(pr.sx, pr.sy); ctx.rotate(m.angle!);
        ctx.beginPath(); ctx.arc(0, 0, r + m.radius, -a, a);
        ctx.arc(0, 0, Math.max(0, r - m.radius), a, -a, true); ctx.closePath();
        ctx.fillStyle = '#50dcff55'; ctx.fill();
        ctx.save(); ctx.clip();
        const sprite = pr.sprite ? assets?.get(pr.sprite) : undefined;
        if (sprite) {
          const scale = (r + m.radius) / (sprite.w * 0.42);
          ctx.drawImage(sprite.img as CanvasImageSource, -sprite.w * scale / 2, -sprite.h * scale / 2, sprite.w * scale, sprite.h * scale);
        }
        ctx.restore(); ctx.strokeStyle = '#8ef0ff'; ctx.lineWidth = 3; ctx.stroke();
      } else {
        const flying = m.age! < pr.totalTime;
        const blast = m.age! >= pr.totalTime + m.warning!;
        const point = flying ? memeProjectilePosition(pr) : { x: pr.tx, y: pr.ty };
        ctx.translate(point.x, point.y - (flying ? 90 * Math.sin(pr.t * Math.PI) : 0));
        if (!flying) {
          ctx.beginPath(); ctx.arc(0, 0, m.radius, 0, Math.PI * 2);
          ctx.fillStyle = blast ? '#ff8b2833' : '#ff8b281c'; ctx.fill();
          ctx.strokeStyle = blast ? '#fff0a1' : '#ffac45'; ctx.lineWidth = 3; ctx.stroke();
          if (!blast) {
            const left = Math.max(0, pr.totalTime + m.warning! - m.age!);
            ctx.beginPath(); ctx.arc(0, 0, m.radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left / m.warning!);
            ctx.strokeStyle = '#fff0a1'; ctx.lineWidth = 7; ctx.stroke();
            ctx.fillStyle = '#fff0a1'; ctx.font = 'bold 24px "Microsoft YaHei",sans-serif'; ctx.textAlign = 'center';
            ctx.fillText(left.toFixed(1) + 's', 0, -m.radius - 12);
          }
        }
        const sprite = assets?.get(blast ? m.blastSprite! : pr.sprite!);
        if (sprite) {
          const size = blast ? m.radius * 2.5 : flying ? 72 : 92;
          if (blast) ctx.globalAlpha = Math.max(0, 1 - (m.age! - pr.totalTime - m.warning!) / 0.35);
          ctx.drawImage(sprite.img as CanvasImageSource, -size / 2, -size / 2, size, size);
        }
      }
      ctx.restore(); continue;
    }
    if (pr.meme) {
      if (pr.meme.kind === 'eggs' && !pr.meme.launched) continue;
      const point = memeProjectilePosition(pr);
      const owner = st.units.find((u) => u.uid === pr.ownerUid);
      const frame = pr.meme.kind === 'clones' && owner?.def.memeSkill && owner.meme.elapsed !== null ? memeFrameAt(owner.def.memeSkill, owner.meme.elapsed) : pr.sprite;
      const sprite = frame ? assets?.get(frame) : undefined;
      if (!sprite) continue;
      ctx.save();
      ctx.translate(point.x, point.y + (pr.meme.launched ? 0 : Math.sin(st.t * 9) * 8));
      ctx.globalAlpha = pr.meme.kind === 'clones' ? 0.7 : 1;
      ctx.shadowBlur = 24; ctx.shadowColor = pr.meme.kind === 'clones' ? '#ffb347' : '#ffd67a';
      if (pr.meme.kind === 'eggs') ctx.rotate(pr.t * Math.PI * 4);
      const size = pr.meme.kind === 'eggs' ? 145 : 190;
      const scale = size / Math.max(sprite.w, sprite.h);
      ctx.drawImage(sprite.img as CanvasImageSource, -sprite.w * scale / 2, -sprite.h * scale / 2, sprite.w * scale, sprite.h * scale);
      ctx.restore();
      continue;
    }
    const x = pr.sx + (pr.tx - pr.sx) * pr.t;
    const yGround = pr.sy + (pr.ty - pr.sy) * pr.t;
    const dist = Math.hypot(pr.tx - pr.sx, pr.ty - pr.sy) || 1;
    const h = pr.arc ? Math.min(170, dist * 0.3) * 4 * pr.t * (1 - pr.t) : 0;
    const y = yGround - h;
    // 地面影子
    ctx.save();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#04060c';
    ctx.beginPath();
    ctx.ellipse(x, yGround + 8, 16, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(x, y);
    const sprEntry = pr.sprite && assets?.has(pr.sprite) ? assets.get(pr.sprite) : undefined;
    if (sprEntry && sprEntry.img) {
      // 专属素材：火锅/奶茶等整图飞出（尺寸约 110px，小袋鼠一圈），空中轻微摆动
      const s = 110 / Math.max(sprEntry.w, sprEntry.h);
      const w = sprEntry.w * s;
      const h2 = sprEntry.h * s;
      ctx.rotate(Math.sin(pr.t * Math.PI * 6) * 0.14);
      ctx.drawImage(sprEntry.img as CanvasImageSource, -w / 2, -h2 / 2, w, h2);
    } else if (pr.label) {
      // 外卖袋：袋子 + 提手 + 空中飘名字（外卖轮盘专用）
      const color = pr.color ?? '#ffd32a';
      ctx.rotate(Math.sin(pr.t * Math.PI * 6) * 0.14);
      ctx.shadowBlur = 14;
      ctx.shadowColor = color;
      rr(ctx, -23, -19, 46, 40, 8);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#f8fafc';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -19, 10, Math.PI, 0);
      ctx.stroke();
      ctx.font = 'bold 24px "Noto Sans CJK SC","WenQuanYi Micro Hei","PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 6;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(6,8,16,0.92)';
      ctx.strokeText(pr.label, 0, -40);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(pr.label, 0, -40);
    } else {
      // 公文包本体（加大 + 白色外圈提对比度）
      ctx.rotate(pr.t * Math.PI * 4);
      ctx.shadowBlur = 16;
      ctx.shadowColor = 'rgba(255, 211, 66, 0.8)';
      rr(ctx, -22, -16, 44, 32, 6);
      ctx.fillStyle = '#a86e36';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 4;
      ctx.strokeStyle = '#f8fafc';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-8, -16);
      ctx.lineTo(-8, -24);
      ctx.lineTo(8, -24);
      ctx.lineTo(8, -16);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function rr(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}
