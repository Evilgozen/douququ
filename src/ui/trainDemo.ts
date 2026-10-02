import { createTrainDemo, DEMO_DT, DEMO_H, DEMO_W, stepTrainDemo, trainCars, type DemoBall, type TrackPoint, type TrainDemoState } from '../core/trainDemo';

const canvas = document.querySelector<HTMLCanvasElement>('#stage')!;
const ctx = canvas.getContext('2d')!;
const speedInput = document.querySelector<HTMLInputElement>('#speed')!;
const speedValue = document.querySelector<HTMLSpanElement>('#speedValue')!;
const status = document.querySelector<HTMLDivElement>('#status')!;
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
let state = createTrainDemo();
let paused = false;
let lastTime = performance.now();
let accumulator = 0;

speedInput.addEventListener('input', () => { speedValue.textContent = speedInput.value; });
document.querySelector<HTMLButtonElement>('#restart')!.addEventListener('click', () => {
  state = createTrainDemo(Number(speedInput.value));
  accumulator = 0;
  paused = false;
  pauseButton.textContent = '暂停';
});
pauseButton.addEventListener('click', () => {
  paused = !paused;
  pauseButton.textContent = paused ? '继续' : '暂停';
});

function drawTrack(track: TrackPoint[]): void {
  if (track.length < 2) return;
  ctx.lineCap = 'round';
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1]; const b = track[i];
    const dx = b.x - a.x; const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ox = -dy / len * 9; const oy = dx / len * 9;
    ctx.strokeStyle = '#937853'; ctx.lineWidth = 3;
    for (const side of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(a.x + ox * side, a.y + oy * side);
      ctx.lineTo(b.x + ox * side, b.y + oy * side); ctx.stroke();
    }
    if (i % 2 === 0) {
      ctx.strokeStyle = '#69553d'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(b.x - ox * 1.35, b.y - oy * 1.35);
      ctx.lineTo(b.x + ox * 1.35, b.y + oy * 1.35); ctx.stroke();
    }
  }
}

function drawBall(ball: DemoBall, name: string, color: string): void {
  ctx.save();
  ctx.shadowColor = color; ctx.shadowBlur = 18;
  ctx.fillStyle = color;
  ctx.beginPath(); ctx.arc(ball.x, ball.y, 18, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(String(Math.ceil(ball.hp)), ball.x, ball.y + 4);
  ctx.font = 'bold 16px sans-serif';
  ctx.fillText(name, ball.x, ball.y - 28);
  ctx.restore();
}

function drawTrain(st: TrainDemoState): void {
  const cars = trainCars(st);
  for (let i = cars.length - 1; i >= 0; i--) {
    const car = cars[i];
    ctx.save();
    ctx.translate(car.x, car.y);
    ctx.rotate(Math.atan2(car.ny, car.nx));
    ctx.fillStyle = i === 0 ? '#ffe0a0' : '#caa76f';
    ctx.strokeStyle = '#402d1f'; ctx.lineWidth = 3;
    ctx.fillRect(-13, -10, 26, 20); ctx.strokeRect(-13, -10, 26, 20);
    ctx.fillStyle = '#5d4933'; ctx.fillRect(-8, -6, 9, 12);
    if (i === 0) { ctx.fillStyle = '#f8f0d3'; ctx.fillRect(7, -5, 4, 10); }
    ctx.restore();
  }
}

function render(st: TrainDemoState): void {
  ctx.fillStyle = '#0d111c'; ctx.fillRect(0, 0, DEMO_W, DEMO_H);
  ctx.strokeStyle = '#344056'; ctx.lineWidth = 2;
  ctx.strokeRect(36, 36, DEMO_W - 72, DEMO_H - 72);
  drawTrack(st.track);
  drawTrain(st);
  drawBall(st.conductor, '列车长', '#ef5960');
  drawBall(st.vampire, '吸血鬼', '#9b74f2');
  ctx.fillStyle = '#dbe5f7'; ctx.textAlign = 'left'; ctx.font = 'bold 15px sans-serif';
  ctx.fillText(`时间 ${st.t.toFixed(1)}s     铁轨 ${st.track.length} 点     列车命中 ${st.hits} 次`, 47, 25);
  status.innerHTML = `列车长 HP：${Math.ceil(st.conductor.hp)}<br>吸血鬼 HP：${Math.ceil(st.vampire.hp)}<br>列车命中：${st.hits} 次`;
}

function frame(now: number): void {
  const elapsed = Math.min(0.1, (now - lastTime) / 1000);
  lastTime = now;
  if (!paused) {
    accumulator += elapsed;
    while (accumulator >= DEMO_DT) {
      stepTrainDemo(state);
      accumulator -= DEMO_DT;
    }
  }
  render(state);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
