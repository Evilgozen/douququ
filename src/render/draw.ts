/**
 * 渲染层：纯函数 drawFrame(ctx, state, assets)。
 * 同构：浏览器 Canvas2D 与 @napi-rs/canvas 均可用（无 DOM 依赖，素材通过 assets 注入）。
 */
import { ARENA, BALL_R, END_DUR, H, INTRO_DUR, SIDE_COLORS, W, type BattleState, type Unit } from '../core/sim';
import { drawBeams, drawGases, drawMechanisms, drawParticles, drawProjectiles, drawShocks, drawStar } from './fx';
import { fmt, fmtMult } from '../core/bignum';
import { pointOnTrack, type TrackPoint } from '../core/trainDemo';

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

function mixWhite(hex: string, k: number): string {
  const [r, g, b] = hexToRgb(hex);
  const m = (c: number) => Math.round(c + (255 - c) * k);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

export interface SpriteEntry {
  img: unknown; // HTMLImageElement | napi-rs Image，drawImage 两者皆收
  w: number;
  h: number;
  /** 白色剪影像（受击闪白用：只亮角色像素，无边框后 fillRect 会把透明角涂成白框） */
  white?: unknown;
}
export type Assets = Map<string, SpriteEntry>;

type Ctx = CanvasRenderingContext2D;

const FONT_STACK = '"Noto Sans CJK SC","Noto Sans CJK JP","WenQuanYi Micro Hei","PingFang SC","Microsoft YaHei",sans-serif';
const font = (size: number, weight: '' | 'bold' = 'bold') => `${weight ? weight + ' ' : ''}${size}px ${FONT_STACK}`;

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

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function strokeFillText(ctx: Ctx, text: string, x: number, y: number, strokeW: number, fill: string, stroke = 'rgba(6,8,16,0.92)'): void {
  ctx.lineWidth = strokeW;
  ctx.strokeStyle = stroke;
  ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

function wrapText(ctx: Ctx, text: string, maxW: number): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ctx.measureText(cur + ch).width > maxW && cur) {
      lines.push(cur);
      cur = ch;
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

export function drawFrame(ctx: Ctx, st: BattleState, assets: Assets): void {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  drawCamera(ctx, st, () => {
    drawArena(ctx, st);
    drawRailCombat(ctx, st);
    if (st.rail?.echo?.activeT) {
      ctx.fillStyle = 'rgba(16, 53, 73, 0.28)';
      ctx.fillRect(ARENA.left, ARENA.top, ARENA.right - ARENA.left, ARENA.bottom - ARENA.top);
    }
    drawMechanisms(ctx, st);
    drawGases(ctx, st);
    drawShocks(ctx, st);
    drawBeams(ctx, st);
    drawUnitsAll(ctx, st, assets);
    drawParticles(ctx, st);
    drawProjectiles(ctx, st, assets);
    drawPopups(ctx, st);
  });

  if (st.phase !== 'intro') {
    drawTitle(ctx, st);
    drawFeed(ctx, st);
  }
  if (st.phase === 'fight' && st.rail?.echo?.activeT) {
    ctx.save(); ctx.font = font(42); ctx.fillStyle = '#67e8f9';
    strokeFillText(ctx, `时间冻结  ${st.rail.echo.activeT.toFixed(1)}s`, W / 2, 380, 8, '#67e8f9');
    ctx.restore();
  }
  if (st.phase === 'fight' || st.phase === 'end') drawHud(ctx, st);
  drawBanners(ctx, st);
  drawSubtitles(ctx, st);
  if (st.phase === 'intro') drawIntro(ctx, st);
  if (st.phase === 'end') drawEnd(ctx, st);

  if (st.flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${(st.flash * 0.55).toFixed(3)})`;
    ctx.fillRect(0, 0, W, H);
  }
  drawVignette(ctx);
  ctx.restore();
}

function drawRailCombat(ctx: Ctx, st: BattleState): void {
  const rail = st.rail;
  if (!rail || st.phase === 'intro') return;
  const drawPath = (points: TrackPoint[], alpha: number) => {
    if (points.length < 2) return;
    ctx.save(); ctx.globalAlpha = alpha; ctx.lineCap = 'round';
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]; const b = points[i];
      const dx = b.x - a.x; const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const ox = -dy / len * 15; const oy = dx / len * 15;
      ctx.strokeStyle = '#a88b60'; ctx.lineWidth = 5;
      for (const side of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(a.x + ox * side, a.y + oy * side);
        ctx.lineTo(b.x + ox * side, b.y + oy * side); ctx.stroke();
      }
      if (i % 2 === 0) {
        ctx.strokeStyle = '#6f583d'; ctx.lineWidth = 7;
        ctx.beginPath(); ctx.moveTo(b.x - ox * 1.3, b.y - oy * 1.3);
        ctx.lineTo(b.x + ox * 1.3, b.y + oy * 1.3); ctx.stroke();
      }
    }
    ctx.restore();
  };
  if (rail.pass) drawPath(rail.pass.points, 0.9);
  if (rail.fading) drawPath(rail.fading.points, 0.9 * rail.fading.remaining / rail.fading.total);
  drawPath(rail.points, 0.55);
  const pass = rail.pass;
  if (pass) {
    const length = pass.points[pass.points.length - 1].s;
    const tail = (pass.cars - 1) * pass.carGap + 40;
    const head = -40 + (length + tail + 40) * (pass.elapsed / pass.duration);
    for (let i = pass.cars - 1; i >= 0; i--) {
      const car = pointOnTrack(pass.points, head - i * pass.carGap);
      if (!car) continue;
      ctx.save(); ctx.translate(car.x, car.y); ctx.rotate(Math.atan2(car.ny, car.nx));
      ctx.fillStyle = i === 0 ? '#facc15' : '#d4a96d';
      ctx.strokeStyle = '#332112'; ctx.lineWidth = 4;
      rr(ctx, -25, -18, 50, 36, 5); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#423223'; ctx.fillRect(-14, -11, 19, 22);
      if (i === 0) { ctx.fillStyle = '#fff7d6'; ctx.fillRect(17, -10, 5, 20); }
      ctx.restore();
    }
  }
  const assassin = st.units.find((u) => u.def.dashStrike);
  const conductor = st.units.find((u) => u.def.trainTrail) ?? st.units.find((u) => u !== assassin);
  if (st.phase === 'fight' && rail.dash.phase === 'charging' && assassin && conductor) {
    ctx.save(); ctx.setLineDash([15, 14]); ctx.strokeStyle = '#c4b5fd'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(assassin.x, assassin.y); ctx.lineTo(conductor.x, conductor.y); ctx.stroke();
    ctx.restore();
  }
}

function drawCamera(ctx: Ctx, st: BattleState, cb: () => void): void {
  ctx.save();
  const s = st.shake;
  const sx = Math.sin(st.t * 97.3) * s + Math.sin(st.t * 41.7) * s * 0.6;
  const sy = Math.cos(st.t * 83.1) * s;
  ctx.translate(W / 2 + sx, H / 2 + sy);
  ctx.scale(st.zoom, st.zoom);
  ctx.translate(-st.zoomX, -st.zoomY);
  cb();
  ctx.restore();
}

function drawArena(ctx: Ctx, st: BattleState): void {
  const { left, right, top, bottom } = ARENA;
  rr(ctx, left - 52, top - 52, right - left + 104, bottom - top + 104, 42);
  ctx.fillStyle = '#060608';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#232329';
  ctx.stroke();

  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = '#565c6b';
  ctx.lineWidth = 2;
  for (let x = left; x <= right; x += (right - left) / 8) {
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
  }
  for (let y = top; y <= bottom; y += (bottom - top) / 9) {
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 0.12;
  ctx.beginPath();
  ctx.arc((left + right) / 2, (top + bottom) / 2, 150, 0, Math.PI * 2);
  ctx.stroke();
  ctx.font = font(52);
  ctx.fillStyle = '#171a21';
  ctx.fillText('斗 蛐 蛐', (left + right) / 2, (top + bottom) / 2);
  ctx.restore();
}

function drawUnitsAll(ctx: Ctx, st: BattleState, assets: Assets): void {
  const speedster = st.units.find((u) => u.def.speedEcho);
  const echoes = st.rail?.echo?.images;
  const sprite = speedster?.def.sprite ? assets.get(speedster.def.sprite) : undefined;
  if (speedster && echoes && sprite?.img) {
    const scale = Math.max((speedster.r * 2) / sprite.w, (speedster.r * 2) / sprite.h);
    const w = sprite.w * scale; const h = sprite.h * scale;
    if (echoes.length > 1) {
      ctx.save(); ctx.setLineDash([10, 12]); ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(103,232,249,0.5)';
      ctx.beginPath(); ctx.moveTo(echoes[0].x, echoes[0].y);
      for (const e of echoes.slice(1)) ctx.lineTo(e.x, e.y);
      ctx.lineTo(speedster.x, speedster.y); ctx.stroke(); ctx.restore();
    }
    for (const e of echoes) {
      ctx.save(); ctx.translate(e.x, e.y);
      ctx.globalAlpha = 0.48;
      ctx.shadowColor = '#22d3ee'; ctx.shadowBlur = 28;
      ctx.drawImage(sprite.img as CanvasImageSource, -w / 2, -h / 2, w, h);
      ctx.shadowBlur = 0; ctx.globalAlpha = 0.9;
      ctx.fillStyle = 'rgba(34,211,238,0.12)';
      ctx.beginPath(); ctx.arc(0, 0, speedster.def.speedEcho!.hitRadius, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#67e8f9'; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(0, 0, speedster.def.speedEcho!.hitRadius, 0, Math.PI * 2); ctx.stroke();
      ctx.font = font(26); ctx.fillStyle = '#ffffff';
      strokeFillText(ctx, String(e.order), 0, -speedster.r - 35, 6, '#ffffff');
      ctx.restore();
    }
  }
  const sorted = [...st.units].sort((a, b) => {
    if (a.alive !== b.alive) return a.alive ? 1 : -1; // 阵亡的垫底
    return a.y - b.y;
  });
  for (const u of sorted) drawUnit(ctx, st, u, assets);
}

function drawUnit(ctx: Ctx, st: BattleState, u: Unit, assets: Assets): void {
  // 影子
  if (u.alive) {
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = '#04060c';
    ctx.beginPath();
    ctx.ellipse(u.x, u.y + u.r + 12, u.r * 0.92, 13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 状态立绘选择：摔倒 > 格挡瞬间 > 骑车 > 狂化 > 常态
  const stunPath = u.stunT > 0 ? u.def.stateSprites?.stun : undefined;
  const blockPath = u.blockT > 0 ? u.def.stateSprites?.block : undefined;
  const bikePath = u.bikeT > 0 ? u.def.stateSprites?.bike : undefined;
  const berserkPath = u.props.berserk > 0 ? u.def.stateSprites?.berserk : undefined;
  const activePath = [stunPath, blockPath, bikePath, berserkPath, u.def.sprite].find((p) => p && assets.has(p)) ?? u.def.sprite;
  const spr = activePath ? assets.get(activePath) : undefined;
  ctx.save();
  ctx.translate(u.x, u.y);
  if (!u.alive) {
    ctx.globalAlpha = 0.3;
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, Math.sin(u.walkPhase) * 4);
    // 被踹飞空中翻滚（速度衰减后 spinA 指数回正）
    if (u.spinA !== 0) ctx.rotate(u.spinA);
    // 摔倒眩晕：左右晃动（有专用摔倒立绘时不转——立绘本身就是倒地姿势）
    if (u.stunT > 0 && !stunPath) ctx.rotate(Math.sin(st.t * 18) * 0.12);
  }

  // 骑车冲刺：脚下画小单车 + 身后速度线（有专用骑车立绘时只画速度线——立绘自带车）
  if (u.alive && u.bikeT > 0 && !bikePath) drawBike(ctx, st, u);
  if (u.alive && u.bikeT > 0 && bikePath) drawSpeedLines(ctx, st, u);

  if (spr && spr.img) {
    // 无边框直出：整张贴图按长边缩放到 2r（不再裁剪进球形、不描边；碰撞体积仍是 u.r 的球）
    const scale = Math.max((u.r * 2) / spr.w, (u.r * 2) / spr.h);
    const w = spr.w * scale;
    const h = spr.h * scale;
    ctx.drawImage(spr.img as CanvasImageSource, -w / 2, -h / 2, w, h);
    if (u.hitFlash > 0) {
      // 受击闪白：优先白色剪影（贴着角色像素），无剪影退回柔和圆闪
      if (spr.white) {
        ctx.globalAlpha = Math.min(0.8, u.hitFlash * 5);
        ctx.drawImage(spr.white as CanvasImageSource, -w / 2, -h / 2, w, h);
      } else {
        ctx.globalAlpha = Math.min(0.5, u.hitFlash * 3);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, u.r * 1.05, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  } else {
    drawBody(ctx, u);
  }

  // 大脚踹击：脚先迅速放大再前伸踹出（kickFx 角色；有专属素材用素材，脚尖朝右画）
  if (u.def.kickFx && u.punchT > 0 && u.alive) {
    const footPath = u.def.kickSprite;
    drawKickFoot(ctx, u, footPath && assets.has(footPath) ? assets.get(footPath) : undefined);
  }
  // 摔倒眩晕：头顶三颗星星转圈
  if (u.stunT > 0 && u.alive) {
    for (let i = 0; i < 3; i++) {
      const a = st.t * 5 + (i * Math.PI * 2) / 3;
      drawStar(ctx, Math.cos(a) * u.r * 0.66, -u.r - 34 + Math.sin(a) * 9, 15, 6, '#ffd32a');
    }
  }
  ctx.restore();

  // 结算阶段隐藏头顶信息，避免与结算卡数字矛盾
  if (u.alive && st.phase !== 'end') drawOverlays(ctx, st, u);
}

function drawBody(ctx: Ctx, u: Unit): void {
  const r = u.r;
  ctx.save();

  // 拳头（出拳时沿攻击方向伸出）
  const ext = u.punchT > 0 ? easeOutCubic(1 - u.punchT / 0.22) * 42 : 0;
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#12172b';
  for (const side of [-1, 1] as const) {
    const isFront = (side === u.facing) && ext > 4;
    const off = side === u.facing ? ext : 0;
    const ang = isFront ? u.punchAngle : side === u.facing ? u.punchAngle : (side < 0 ? Math.PI : 0);
    const ax = Math.cos(ang) * (r * 1.02 + off);
    const ay = Math.sin(ang) * (r * 1.02 + off);
    ctx.beginPath();
    ctx.arc(ax, ay, isFront ? 17 : 14, 0, Math.PI * 2);
    ctx.fillStyle = mixWhite(u.color, 0.15);
    ctx.fill();
    ctx.stroke();
  }

  // 球体（径向渐变 + 深描边）
  const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.15, 0, 0, r * 1.05);
  g.addColorStop(0, mixWhite(u.color, 0.45));
  g.addColorStop(1, u.color);
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#12172b';
  ctx.stroke();

  // 内嵌名字（自动缩字号塞进球体）
  ctx.font = font(38);
  let fs = 38;
  while (fs > 20 && ctx.measureText(u.name).width > r * 1.45) {
    fs -= 2;
    ctx.font = font(fs);
  }
  strokeFillText(ctx, u.name, 0, 0, Math.max(5, fs * 0.18), '#ffffff');

  if (u.hitFlash > 0) {
    ctx.globalAlpha = Math.min(0.75, u.hitFlash * 5);
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 骑行速度线（状态立绘自带单车时用，速度感补充；方向 = 速度反方向） */
function drawSpeedLines(ctx: Ctx, st: BattleState, u: Unit): void {
  const spd = Math.hypot(u.vx, u.vy);
  if (spd < 260) return;
  const k = Math.min(1, (spd - 260) / 460);
  const nx = -u.vx / spd;
  const ny = -u.vy / spd;
  ctx.save();
  ctx.strokeStyle = `rgba(255,255,255,${(0.22 + 0.25 * k).toFixed(2)})`;
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (const [o, len] of [[-0.3, 0.8], [0, 1], [0.3, 0.8]] as const) {
    const ox = -ny * o * u.r;
    const oy = nx * o * u.r;
    ctx.beginPath();
    ctx.moveTo(ox + nx * (u.r * 1.05), oy + ny * (u.r * 1.05));
    ctx.lineTo(ox + nx * (u.r * 1.05 + 42 * len * (0.6 + k)), oy + ny * (u.r * 1.05 + 42 * len * (0.6 + k)));
    ctx.stroke();
  }
  ctx.restore();
}

/** 小单车：两个轮子 + 黄色车架 + 车把，身后速度线（bikeRush 骑行期间） */
function drawBike(ctx: Ctx, st: BattleState, u: Unit): void {
  ctx.save();
  ctx.rotate(u.facing * 0.05);
  const y = u.r * 0.78;
  const wx = u.r * 0.6;
  // 身后速度线
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  for (const k of [-0.16, 0, 0.16]) {
    ctx.beginPath();
    ctx.moveTo(-u.facing * (u.r + 12), y + k * u.r);
    ctx.lineTo(-u.facing * (u.r + 50), y + k * u.r);
    ctx.stroke();
  }
  // 车轮 + 随行走相位旋转的辐条
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(s * wx, y, u.r * 0.32, 0, Math.PI * 2);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#2b2f3a';
    ctx.stroke();
    ctx.save();
    ctx.translate(s * wx, y);
    ctx.rotate(u.walkPhase * 0.8 * s);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#8ea0c0';
    for (let i = 0; i < 3; i++) {
      const a = (i * Math.PI) / 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * u.r * 0.26, Math.sin(a) * u.r * 0.26);
      ctx.lineTo(-Math.cos(a) * u.r * 0.26, -Math.sin(a) * u.r * 0.26);
      ctx.stroke();
    }
    ctx.restore();
  }
  // 车架 + 车把 + 铃铛
  ctx.strokeStyle = '#ffd32a';
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-wx, y);
  ctx.lineTo(0, y - u.r * 0.32);
  ctx.lineTo(wx, y);
  ctx.moveTo(0, y - u.r * 0.32);
  ctx.lineTo(0, y - u.r * 0.04);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(wx, y);
  ctx.lineTo(wx + u.facing * 7, y - u.r * 0.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(u.facing * 10, y - u.r * 0.36, 5, 0, Math.PI * 2);
  ctx.fillStyle = '#ff6b81';
  ctx.fill();
  // 车铃叮的粒子感（确定性闪烁）
  if (Math.sin(st.t * 9) > 0.6) {
    ctx.beginPath();
    ctx.arc(u.facing * 10, y - u.r * 0.52, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd32a';
    ctx.fill();
  }
  ctx.restore();
}

/** 大脚踹击演出：脚掌在出招前半段迅速放大（grow），后半段沿出招角前伸（ext）；素材优先 */
function drawKickFoot(ctx: Ctx, u: Unit, footSpr?: SpriteEntry): void {
  const p = 1 - u.punchT / 0.55;
  const grow = 1 + 1.6 * Math.min(1, p * 1.8);
  const ext = easeOutCubic(p) * u.r * 1.2;
  const ang = u.punchAngle;
  ctx.save();
  ctx.translate(Math.cos(ang) * (u.r * 0.5 + ext), Math.sin(ang) * (u.r * 0.5 + ext));
  ctx.rotate(ang);
  if (footSpr && footSpr.img) {
    const s = (u.r * 1.15 * grow) / Math.max(footSpr.w, footSpr.h);
    const w = footSpr.w * s;
    const h = footSpr.h * s;
    ctx.drawImage(footSpr.img as CanvasImageSource, -w / 2, -h / 2, w, h);
    ctx.restore();
    return;
  }
  ctx.scale(grow, grow);
  // 脚掌
  ctx.beginPath();
  ctx.ellipse(0, 0, 44, 30, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#ffd9b8';
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = '#12172b';
  ctx.stroke();
  // 三根脚趾
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.arc(32, i * 14, 9, 0, Math.PI * 2);
    ctx.fillStyle = '#ffe9d6';
    ctx.fill();
    ctx.stroke();
  }
  // 袜口
  ctx.beginPath();
  ctx.ellipse(-32, 0, 10, 24, 0, 0, Math.PI * 2);
  ctx.fillStyle = '#7dd3fc';
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawOverlays(ctx: Ctx, st: BattleState, u: Unit): void {
  ctx.save();
  ctx.translate(u.x, u.y);

  // 立绘角色：名字放球下方，不挡脸
  if (u.def.sprite) {
    ctx.font = font(26);
    strokeFillText(ctx, u.name, 0, u.r + 26, 6, '#dbe4f5');
  }

  ctx.restore();
}

function drawPopups(ctx: Ctx, st: BattleState): void {
  for (const p of st.popups) {
    const age = p.maxLife - p.life;
    const pop = easeOutBack(Math.min(1, age / 0.16));
    const alpha = p.life < 0.25 ? p.life / 0.25 : 1;
    const rise = (1 - p.life / p.maxLife) * (p.kind === 'skill' ? 44 : 64);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x, p.y - rise);
    ctx.scale(pop, pop);
    if (p.kind === 'skill') {
      ctx.font = font(p.size);
      strokeFillText(ctx, p.text, 0, 0, 7, p.color);
    } else {
      ctx.font = font(p.size);
      strokeFillText(ctx, p.text, 0, 0, Math.max(6, p.size * 0.16), p.color);
      if (p.mult >= 1.6) {
        const mtxt = fmtMult(p.mult);
        ctx.font = font(p.size * 0.5);
        const mw = ctx.measureText(mtxt).width;
        ctx.fillStyle = '#ff6b81';
        rr(ctx, p.size * 0.42, -p.size * 0.72, mw + 18, p.size * 0.62, 10);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.fillText(mtxt, p.size * 0.42 + mw / 2 + 9, -p.size * 0.41);
      }
    }
    ctx.restore();
  }
}

function drawTitle(ctx: Ctx, st: BattleState): void {
  ctx.save();
  ctx.font = font(46);
  strokeFillText(ctx, st.ep.title, W / 2, 118, 8, '#ffffff');
  if (st.ep.subtitle) {
    ctx.font = font(28, '');
    ctx.fillStyle = '#8ea0c0';
    ctx.fillText(st.ep.subtitle, W / 2, 168);
  }
  ctx.restore();
}

function drawFeed(ctx: Ctx, st: BattleState): void {
  ctx.save();
  ctx.font = font(26);
  let i = 0;
  for (const f of st.feed) {
    ctx.globalAlpha = Math.min(1, f.life);
    strokeFillText(ctx, f.text, W / 2, 234 + i * 42, 6, '#cbd5e1');
    i++;
  }
  ctx.restore();
}

function drawHud(ctx: Ctx, st: BattleState): void {
  const y0 = st.ep.combat?.mode === 'readable' ? 1530 : 1596;
  const bw = 440;
  ctx.save();
  for (const side of [0, 1] as const) {
    const us = st.units.filter((u) => u.side === side);
    const hp = us.reduce((s, u) => s + Math.max(0, u.hp), 0);
    const disp = us.reduce((s, u) => s + Math.max(0, u.dispHp), 0);
    const max = us.reduce((s, u) => s + u.maxHp, 0);
    const shield = us.reduce((s, u) => s + (u.alive ? u.shield : 0), 0);
    const x = side === 0 ? 64 : W - 64 - bw;
    const color = us[0]?.color ?? SIDE_COLORS[side];
    const label = us[0]?.name ?? '' + (us.length > 1 ? ` 等${us.length}人` : '');

    ctx.font = font(30);
    ctx.textAlign = side === 0 ? 'left' : 'right';
    ctx.fillStyle = '#e7edf8';
    ctx.fillText(label, side === 0 ? x + 4 : x + bw - 4, y0 - 24);

    ctx.textAlign = 'center';
    rr(ctx, x, y0, bw, 38, 19);
    ctx.fillStyle = '#0a0a0d';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#232329';
    ctx.stroke();
    if (max > 0) {
      // 白色伤害缓冲条（dispHp → hp 之间的部分）
      const dPct = Math.max(0, disp) / max;
      const hPct = Math.max(0, hp) / max;
      if (dPct > hPct) {
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        rr(ctx, x + 4 + (bw - 8) * hPct, y0 + 4, Math.max(0, (bw - 8) * (dPct - hPct)), 30, 12);
        ctx.fill();
      }
      if (hPct > 0) {
        ctx.fillStyle = color;
        rr(ctx, x + 4, y0 + 4, Math.max(10, (bw - 8) * hPct), 30, 12);
        ctx.fill();
      }
    }
    if (shield > 0 && max > 0) {
      const sp = Math.min(1, shield / max);
      ctx.fillStyle = '#93c5fd';
      rr(ctx, x, y0 + 44, bw * sp, 6, 3);
      ctx.fill();
    }
    if (st.ep.combat?.mode === 'readable' && us[0]) {
      const u = us[0];
      if (st.rail) {
        const rail = st.rail;
        const conductor = Boolean(u.def.trainTrail);
        const echoSkill = u.def.speedEcho;
        const label1 = conductor ? `列车撞击 ${u.def.trainTrail!.damage} · ${u.def.trainTrail!.cars ?? 5}节车厢 × ${u.def.trainTrail!.speedMultiplier ?? 1}倍速`
          : echoSkill ? `残影重叠 ${echoSkill.damage} × ${echoSkill.maxEchoes} · 停时穿透` : u.def.dashStrike ? `蓄力突刺 ${u.def.dashStrike.damage} · 蓄力${u.def.dashStrike.charge}s` : '';
        const label2 = conductor
          ? rail.pass ? `列车行驶 ${Math.max(0, rail.pass.duration - rail.pass.elapsed).toFixed(1)}s`
            : rail.fading ? `旧轨消失 ${Math.max(0, rail.fading.remaining).toFixed(1)}s · 暂停铺轨`
              : `铺轨中 · 发车 ${Math.max(0, rail.nextTrainT).toFixed(1)}s`
          : echoSkill && rail.echo ? rail.echo.activeT > 0 ? `停时 ${rail.echo.activeT.toFixed(1)}s · 残影 ${rail.echo.spawned}/${echoSkill.maxEchoes}` : rail.echo.images.length > 0 ? `依次结算 ${rail.echo.released}/${rail.echo.spawned}` : `斯安威斯坦 CD ${Math.max(0, rail.echo.cooldown).toFixed(1)}s`
            : rail.dash.phase === 'charging' ? `蓄力 ${Math.max(0, rail.dash.timer).toFixed(1)}s`
            : rail.dash.phase === 'dashing' ? '突刺中' : `技能 CD ${Math.max(0, rail.dash.cooldown).toFixed(1)}s`;
        const charge = conductor ? rail.pass ? rail.pass.elapsed / rail.pass.duration : rail.fading ? 1 - rail.fading.remaining / rail.fading.total : 1 - rail.nextTrainT / u.def.trainTrail!.every
          : echoSkill && rail.echo ? rail.echo.activeT > 0 ? rail.echo.activeT / echoSkill.active : rail.echo.images.length > 0 ? rail.echo.released / rail.echo.spawned : 1 - rail.echo.cooldown / echoSkill.every
            : rail.dash.phase === 'charging' ? 1 - rail.dash.timer / u.def.dashStrike!.charge
            : rail.dash.phase === 'dashing' ? 1 : 1 - rail.dash.cooldown / u.def.dashStrike!.every;
        ctx.textAlign = side === 0 ? 'left' : 'right'; ctx.font = font(22); ctx.fillStyle = '#e7edf8';
        ctx.fillText(label1, side === 0 ? x : x + bw, y0 + 78);
        ctx.fillText(label2, side === 0 ? x : x + bw, y0 + 110);
        ctx.fillStyle = '#202938'; rr(ctx, x, y0 + 122, bw, 12, 6); ctx.fill();
        ctx.fillStyle = color; rr(ctx, x, y0 + 122, bw * Math.max(0, Math.min(1, charge)), 12, 6); ctx.fill();
        if (conductor && rail.combo.count >= 2 && st.fightT - rail.combo.lastTrainHitT < 1.6) {
          ctx.font = font(25); ctx.fillStyle = '#facc15';
          ctx.fillText(`列车·墙体连撞 ×${rail.combo.count}`, x, y0 + 162);
        }
      } else {
      const attackNo = u.fighter.comboIndex + 1;
      const comboLength = u.fighter.combo.length;
      const target = st.units.find((other) => other.side !== side);
      const nextMult = u.fighter.combo[u.fighter.comboIndex % comboLength];
      const nextDamage = Math.max(0, Math.round(u.def.atk * u.fighter.effAtkMult * nextMult) - (target?.def.defense ?? 0));
      const charge = u.alive ? Math.max(0, Math.min(1, 1 - u.atkTimer / u.atkInterval)) : 0;
      ctx.textAlign = side === 0 ? 'left' : 'right';
      ctx.font = font(22);
      ctx.fillStyle = '#e7edf8';
      ctx.fillText(`攻${u.def.atk} 防${u.def.defense ?? 0} · 第${attackNo}击${nextMult > 1 ? ' 重击' : ''}`, side === 0 ? x : x + bw, y0 + 78);
      ctx.fillText(`下击${nextDamage} · ${Math.max(0, u.atkTimer / u.fighter.effIntervalMult).toFixed(1)}s${comboLength > 1 ? ` · ${comboLength}击循环` : ''}`, side === 0 ? x : x + bw, y0 + 110);
      ctx.fillStyle = '#202938';
      rr(ctx, x, y0 + 122, bw, 12, 6);
      ctx.fill();
      ctx.fillStyle = color;
      rr(ctx, x, y0 + 122, bw * charge, 12, 6);
      ctx.fill();
      const status = [shield > 0 ? `护盾 ${fmt(shield)}` : '', ...u.fighter.buffs.map((b) => `${b.label}${b.remainingTime >= 0 ? ` ${b.remainingTime.toFixed(0)}s` : ''}`)].filter(Boolean).join(' · ');
      if (status) {
        ctx.font = font(21);
        ctx.fillStyle = '#fbbf24';
        ctx.fillText(status, side === 0 ? x : x + bw, y0 - 64);
      }
      }
    }
    ctx.font = font(22);
    ctx.fillStyle = '#ffffff';
    strokeFillText(ctx, `${fmt(Math.max(0, hp))} / ${fmt(max)}`, x + bw / 2, y0 + 20, 5, '#ffffff');
  }
  ctx.font = font(30);
  ctx.fillStyle = '#4d5261';
  ctx.fillText('VS', W / 2, y0 + 20);
  ctx.restore();
}

function drawBanners(ctx: Ctx, st: BattleState): void {
  ctx.save();
  let i = 0;
  for (const b of st.banners) {
    const age = b.maxLife - b.life;
    const pop = easeOutBack(Math.min(1, age / 0.24));
    const alpha = b.life < 0.35 ? b.life / 0.35 : 1;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(W / 2, 750 + i * 130);
    ctx.rotate(-0.03);
    ctx.scale(pop, pop);
    ctx.font = font(92);
    strokeFillText(ctx, b.text, 0, 0, 16, b.color);
    ctx.restore();
    i++;
  }
  ctx.restore();
}

function drawSubtitles(ctx: Ctx, st: BattleState): void {
  const active = st.captions.filter((c) => st.t >= c.t && st.t < c.t + c.dur);
  const cur = active[active.length - 1];
  if (!cur) return;
  ctx.save();
  ctx.font = font(42);
  const lines = wrapText(ctx, cur.text, 930);
  let y = 1746 - (lines.length - 1) * 56;
  for (const line of lines) {
    strokeFillText(ctx, line, W / 2, y, 9, cur.gold ? '#ffd32a' : '#ffffff');
    y += 56;
  }
  ctx.restore();
}

function drawIntro(ctx: Ctx, st: BattleState): void {
  const p = st.introT;
  ctx.save();

  ctx.font = font(62);
  strokeFillText(ctx, st.ep.title, W / 2, 300, 10, '#ffd32a');
  if (st.ep.subtitle) {
    ctx.font = font(32, '');
    ctx.fillStyle = '#8ea0c0';
    ctx.fillText(st.ep.subtitle, W / 2, 366);
  }

  // 双方名字滑入
  const slide = easeOutCubic(Math.min(1, p / 0.75));
  const f0 = st.units.find((u) => u.side === 0);
  const f1 = st.units.find((u) => u.side === 1);
  ctx.font = font(64);
  if (f0) {
    ctx.textAlign = 'right';
    strokeFillText(ctx, f0.name, -160 + slide * 560, 940, 12, f0.color);
  }
  if (f1) {
    ctx.textAlign = 'left';
    strokeFillText(ctx, f1.name, 1240 - slide * 560, 940, 12, f1.color);
  }
  ctx.textAlign = 'center';

  // VS
  if (p < 2.2) {
    const vsA = p < 1.9 ? 1 : 1 - (p - 1.9) / 0.3;
    const vsPop = easeOutBack(Math.min(1, Math.max(0, (p - 0.55) / 0.3)));
    ctx.save();
    ctx.globalAlpha = Math.max(0, vsA);
    ctx.translate(W / 2, 940);
    ctx.scale(vsPop, vsPop);
    ctx.font = font(150);
    strokeFillText(ctx, 'VS', 0, 0, 20, '#ffffff');
    ctx.restore();
  }

  // 历史交手战绩（roster 档案里双方都有记录时显示）
  if (f0 && f1 && st.roster && p > 0.75) {
    const r0 = st.roster[f0.def.id];
    const h = r0?.h2h?.[f1.def.id];
    if (h && h.w + h.l > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, (p - 0.75) / 0.4);
      ctx.font = font(36);
      strokeFillText(ctx, `历史交手  ${h.w} : ${h.l}`, W / 2, 1075, 8, '#8ea0c0');
      ctx.restore();
    }
  }

  // 3-2-1-GO
  const segs: Array<[number, string, number]> = [
    [2.2, '3', 170],
    [2.85, '2', 170],
    [3.5, '1', 170],
    [4.15, 'GO!', 210],
  ];
  for (const [start, label, size] of segs) {
    if (p >= start && p < start + 0.65) {
      const pop = easeOutBack(Math.min(1, (p - start) / 0.18));
      ctx.save();
      ctx.translate(W / 2, 950);
      ctx.scale(pop, pop);
      ctx.font = font(size);
      strokeFillText(ctx, label, 0, 0, 18, label === 'GO!' ? '#ffd32a' : '#ffffff');
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawEnd(ctx: Ctx, st: BattleState): void {
  const t = st.endT;
  const w = st.winner ?? -1;
  ctx.save();
  ctx.fillStyle = `rgba(4,6,12,${Math.min(0.62, t * 1.6).toFixed(3)})`;
  ctx.fillRect(0, 0, W, H);

  // 胜者头顶皇冠星
  for (const u of st.units) {
  }

  const appear = easeOutBack(Math.min(1, t / 0.35));
  ctx.save();
  ctx.translate(W / 2, 700);
  ctx.scale(appear, appear);
  ctx.font = font(58);
  strokeFillText(ctx, '胜 者', 0, 0, 10, '#ffd32a');
  ctx.restore();

  const winnerName = w === -1 ? '平局' : st.units.find((u) => u.side === w && u.alive)?.name ?? (w === 0 ? '红方' : '蓝方');
  ctx.save();
  ctx.translate(W / 2, 850);
  ctx.scale(appear, appear);
  ctx.font = font(116);
  strokeFillText(ctx, winnerName, 0, 0, 18, w >= 0 ? st.units.find((u) => u.side === w)?.color ?? '#fff' : '#ffffff');
  ctx.restore();

  const mvp = [...st.units].sort((a, b) => b.totalDamage - a.totalDamage)[0];
  const best = [...st.units].sort((a, b) => b.biggestHit - a.biggestHit)[0];
  ctx.font = font(38);
  const lines = [
    `战斗时长 ${st.fightT.toFixed(1)} 秒`,
    best ? `最高单次伤害 ${fmt(best.biggestHit)}（${fmtMult(best.biggestMult)}）` : '',
    mvp ? `全场输出王：${mvp.name}（${fmt(mvp.totalDamage)}）` : '',
  ].filter(Boolean) as string[];
  // 胜者生涯战绩（有档案时）
  const winUnit = st.units.find((u) => u.side === w && u.alive);
  const winRec = winUnit ? st.roster?.[winUnit.def.id] : undefined;
  if (winRec && winRec.wins + winRec.losses > 0) {
    lines.push(`${winUnit!.name} 生涯 ${winRec.wins}胜${winRec.losses}败`);
  }
  // 统计块底板：漂移的胜者球可能落在文字下方，垫一块半透明板保证可读
  const blockH = lines.length * 66 + 36;
  rr(ctx, W / 2 - 380, 1030 - 44, 760, blockH, 24);
  ctx.fillStyle = 'rgba(4,6,12,0.72)';
  ctx.fill();
  let y = 1030;
  for (const line of lines) {
    strokeFillText(ctx, line, W / 2, y, 8, '#dbe4f5');
    y += 66;
  }

  if (st.ep.endDuration) {
    const remaining = Math.max(0, 1 - t / st.ep.endDuration);
    ctx.fillStyle = 'rgba(34,211,238,0.75)';
    rr(ctx, W / 2 - 220, 1280, 440 * remaining, 8, 4);
    ctx.fill();
  }

  // 皇冠星最后画：保证不被统计面板遮住
  for (const u of st.units) {
    if (u.alive && u.side === w) drawStar(ctx, u.x, u.y - (u.r + 34), 26, 11, '#ffd32a');
  }

  ctx.font = font(40);
  ctx.globalAlpha = Math.min(1, Math.max(0, (t - 0.8) / 0.6));
  ctx.fillStyle = '#c3cfe9';
  ctx.fillText('关注我，下期斗更狠', W / 2, 1840);
  ctx.restore();
}

function drawVignette(ctx: Ctx): void {
  const g = ctx.createRadialGradient(W / 2, H / 2, 620, W / 2, H / 2, 1250);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.45)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}
