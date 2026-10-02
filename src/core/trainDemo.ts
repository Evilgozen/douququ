/** 独立小样：固定步长的小球弹跳、铺轨、列车沿弧长追踪与碰撞。无随机数。 */
export const DEMO_DT = 1 / 60;
export const DEMO_W = 720;
export const DEMO_H = 720;
const PAD = 36;
const BALL_R = 18;
const TRAIN_CARS = 5;
const CAR_GAP = 32;
const CAR_HALF_LENGTH = 13;
const CAR_HALF_WIDTH = 11;
const TRACK_STEP = 10;

export interface DemoBall {
  x: number; y: number; vx: number; vy: number;
  hp: number; hitCd: number;
}
export interface TrackPoint { x: number; y: number; s: number }
export interface TrainCar { x: number; y: number; nx: number; ny: number }
export interface TrainDemoState {
  t: number;
  conductor: DemoBall;
  vampire: DemoBall;
  track: TrackPoint[];
  trainS: number;
  trainHitCd: number;
  hits: number;
}

export function createTrainDemo(speed = 170): TrainDemoState {
  return {
    t: 0,
    conductor: { x: 230, y: 230, vx: speed * 0.78, vy: speed * 0.626, hp: 100, hitCd: 0 },
    vampire: { x: 490, y: 475, vx: -speed * 0.67, vy: speed * 0.742, hp: 100, hitCd: 0 },
    track: [{ x: 230, y: 230, s: 0 }],
    trainS: -170,
    trainHitCd: 0,
    hits: 0,
  };
}

function moveAndBounce(b: DemoBall, dt: number): void {
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  const min = PAD + BALL_R;
  const maxX = DEMO_W - min;
  const maxY = DEMO_H - min;
  if (b.x < min) { b.x = 2 * min - b.x; b.vx = Math.abs(b.vx); }
  if (b.x > maxX) { b.x = 2 * maxX - b.x; b.vx = -Math.abs(b.vx); }
  if (b.y < min) { b.y = 2 * min - b.y; b.vy = Math.abs(b.vy); }
  if (b.y > maxY) { b.y = 2 * maxY - b.y; b.vy = -Math.abs(b.vy); }
  b.hitCd = Math.max(0, b.hitCd - dt);
}

function collideBalls(a: DemoBall, b: DemoBall): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist >= 2 * BALL_R) return false;
  const nx = dist > 0 ? dx / dist : 1;
  const ny = dist > 0 ? dy / dist : 0;
  const overlap = (2 * BALL_R - dist) / 2;
  a.x -= nx * overlap; a.y -= ny * overlap;
  b.x += nx * overlap; b.y += ny * overlap;
  const relative = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (relative < 0) {
    // 等质量、完全弹性：只交换法线速度，切线速度保持。
    a.vx += relative * nx; a.vy += relative * ny;
    b.vx -= relative * nx; b.vy -= relative * ny;
  }
  return true;
}

function layTrack(track: TrackPoint[], x: number, y: number): void {
  let last = track[track.length - 1];
  let dx = x - last.x;
  let dy = y - last.y;
  let dist = Math.hypot(dx, dy);
  while (dist >= TRACK_STEP) {
    const px = last.x + dx / dist * TRACK_STEP;
    const py = last.y + dy / dist * TRACK_STEP;
    last = { x: px, y: py, s: last.s + TRACK_STEP };
    track.push(last);
    dx = x - px; dy = y - py; dist = Math.hypot(dx, dy);
  }
}

/** 按轨道累计弧长取点；车厢间距因此稳定，不受折线拐角影响。 */
export function pointOnTrack(track: TrackPoint[], s: number): TrainCar | null {
  if (s < 0 || track.length < 2 || s > track[track.length - 1].s) return null;
  let lo = 0; let hi = track.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (track[mid].s <= s) lo = mid; else hi = mid;
  }
  const a = track[lo]; const b = track[hi];
  const len = b.s - a.s;
  const f = len > 0 ? (s - a.s) / len : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, nx: (b.x - a.x) / len, ny: (b.y - a.y) / len };
}

export function trainCars(st: TrainDemoState): TrainCar[] {
  const cars: TrainCar[] = [];
  for (let i = 0; i < TRAIN_CARS; i++) {
    const car = pointOnTrack(st.track, st.trainS - i * CAR_GAP);
    if (car) cars.push(car);
  }
  return cars;
}

function carTouchesBall(car: TrainCar, ball: DemoBall): boolean {
  const dx = ball.x - car.x;
  const dy = ball.y - car.y;
  const along = Math.max(-CAR_HALF_LENGTH, Math.min(CAR_HALF_LENGTH, dx * car.nx + dy * car.ny));
  return Math.hypot(dx - along * car.nx, dy - along * car.ny) <= BALL_R + CAR_HALF_WIDTH;
}

export function stepTrainDemo(st: TrainDemoState, dt = DEMO_DT): void {
  if (st.conductor.hp <= 0 || st.vampire.hp <= 0) return;
  st.t += dt;
  moveAndBounce(st.conductor, dt);
  moveAndBounce(st.vampire, dt);
  if (collideBalls(st.conductor, st.vampire) && st.vampire.hitCd <= 0) {
    st.conductor.hp = Math.max(0, st.conductor.hp - 5);
    st.vampire.hp = Math.min(100, st.vampire.hp + 3);
    st.vampire.hitCd = 0.55;
  }
  layTrack(st.track, st.conductor.x, st.conductor.y);
  // 车头从轨道起点出发，速度恒定；铺轨不足时在当前末端等待。
  st.trainS = Math.min(st.track[st.track.length - 1].s - 20, st.trainS + 220 * dt);
  st.trainHitCd = Math.max(0, st.trainHitCd - dt);
  if (st.trainHitCd <= 0 && trainCars(st).some((car) => carTouchesBall(car, st.vampire))) {
    st.vampire.hp = Math.max(0, st.vampire.hp - 12);
    st.trainHitCd = 0.45;
    st.hits++;
  }
}
