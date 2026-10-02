import {
  ACTIONS,
  GRID_COLS,
  GRID_GOAL,
  GRID_ROWS,
  GRID_START,
  GRID_WALLS,
  GridWorld,
  QLearningAgent,
} from '../rl/gridWorld';

const canvas = document.getElementById('rlStage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const trainBtn = document.getElementById('train') as HTMLButtonElement;
const demoBtn = document.getElementById('demo') as HTMLButtonElement;
const resetBtn = document.getElementById('reset') as HTMLButtonElement;
const episodeEl = document.getElementById('episode')!;
const epsilonEl = document.getElementById('epsilon')!;
const stepsEl = document.getElementById('steps')!;
const rewardEl = document.getElementById('reward')!;
const statusEl = document.getElementById('rlStatus')!;
const episodeTarget = document.getElementById('episodeTarget') as HTMLInputElement;

const env = new GridWorld();
const agent = new QLearningAgent();
const maxSteps = 160;
let episode = 0;
let episodeStep = 0;
let episodeReward = 0;
let epsilon = 1;
let running = false;
let demoPlaying = false;
let demoRoute: number[] = [];
let demoIndex = 0;
let demoNextAt = 0;
let trail: number[] = [env.state];
let lastFrame = performance.now();

function positionFromState(state: number): { row: number; col: number } {
  return { row: Math.floor(state / GRID_COLS), col: state % GRID_COLS };
}

function beginEpisode(): void {
  env.reset();
  episodeStep = 0;
  episodeReward = 0;
  trail = [env.state];
  const target = Math.max(1, Number(episodeTarget.value) || 2000);
  epsilon = Math.max(0.02, 1 - episode / (target * 0.8));
}

function trainingStep(): void {
  const state = env.state;
  const action = agent.choose(state, epsilon);
  const result = env.step(action);
  agent.learn(state, action, result.reward, result.state, result.done, {
    learningRate: 0.15,
    discount: 0.95,
    epsilon,
  });
  episodeStep++;
  episodeReward += result.reward;
  trail.push(result.state);

  if (result.done || episodeStep >= maxSteps) {
    episode++;
    if (episode >= Math.max(1, Number(episodeTarget.value) || 2000)) {
      running = false;
      trainBtn.textContent = '继续训练';
      statusEl.textContent = '训练完成，正在演示最优路线';
      startDemo();
    } else beginEpisode();
  }
}

function buildDemoRoute(): void {
  env.reset();
  demoRoute = [env.state];
  const seen = new Set<number>();
  for (let i = 0; i < 100; i++) {
    if (seen.has(env.state)) break;
    seen.add(env.state);
    const result = env.step(agent.bestAction(env.state));
    demoRoute.push(result.state);
    if (result.done) break;
  }
  env.reset();
}

function startDemo(): void {
  running = false;
  demoPlaying = false;
  trainBtn.textContent = '继续训练';
  buildDemoRoute();
  const last = demoRoute.at(-1);
  const goalState = GRID_GOAL.row * GRID_COLS + GRID_GOAL.col;
  if (last !== goalState) {
    statusEl.textContent = '策略还没学会，请先多训练几局';
    return;
  }
  demoIndex = 0;
  demoPlaying = true;
  trail = [demoRoute[0]];
  env.position = positionFromState(demoRoute[0]);
  demoNextAt = performance.now();
  statusEl.textContent = `演示：学到的路线共 ${demoRoute.length - 1} 步`;
}

function drawRoundedRect(x: number, y: number, w: number, h: number, radius: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
}

function draw(): void {
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, '#11182b');
  gradient.addColorStop(1, '#080b14');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  const padding = 45;
  const cell = Math.min((w - padding * 2) / GRID_COLS, (h - padding * 2) / GRID_ROWS);
  const boardW = cell * GRID_COLS;
  const boardH = cell * GRID_ROWS;
  const ox = (w - boardW) / 2;
  const oy = (h - boardH) / 2;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.55)';
  ctx.shadowBlur = 30;
  drawRoundedRect(ox - 12, oy - 12, boardW + 24, boardH + 24, 22);
  ctx.fillStyle = '#0d1220';
  ctx.fill();
  ctx.restore();

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const x = ox + col * cell;
      const y = oy + row * cell;
      const wall = GRID_WALLS.has(`${row},${col}`);
      ctx.fillStyle = wall ? '#293249' : (row + col) % 2 ? '#141c30' : '#182238';
      ctx.fillRect(x + 2, y + 2, cell - 4, cell - 4);
      if (wall) {
        ctx.strokeStyle = '#465270';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 8, y + 8, cell - 16, cell - 16);
      }
    }
  }

  if (trail.length > 1) {
    ctx.beginPath();
    for (let i = 0; i < trail.length; i++) {
      const p = positionFromState(trail[i]);
      const x = ox + (p.col + 0.5) * cell;
      const y = oy + (p.row + 0.5) * cell;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(69, 214, 255, .28)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  const goalX = ox + (GRID_GOAL.col + 0.5) * cell;
  const goalY = oy + (GRID_GOAL.row + 0.5) * cell;
  const pulse = 1 + Math.sin(performance.now() / 280) * 0.08;
  ctx.save();
  ctx.translate(goalX, goalY);
  ctx.scale(pulse, pulse);
  ctx.shadowColor = '#ffd24a';
  ctx.shadowBlur = 28;
  ctx.fillStyle = '#ffd24a';
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + i * Math.PI / 5;
    const radius = i % 2 === 0 ? cell * 0.28 : cell * 0.12;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const ballX = ox + (env.position.col + 0.5) * cell;
  const ballY = oy + (env.position.row + 0.5) * cell;
  const ballGradient = ctx.createRadialGradient(ballX - cell * 0.1, ballY - cell * 0.12, 2, ballX, ballY, cell * 0.3);
  ballGradient.addColorStop(0, '#ffffff');
  ballGradient.addColorStop(0.2, '#7ee8ff');
  ballGradient.addColorStop(1, '#1688dd');
  ctx.save();
  ctx.shadowColor = '#35cfff';
  ctx.shadowBlur = 25;
  ctx.fillStyle = ballGradient;
  ctx.beginPath();
  ctx.arc(ballX, ballY, cell * 0.27, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const startX = ox + (GRID_START.col + 0.5) * cell;
  const startY = oy + (GRID_START.row + 0.82) * cell;
  ctx.fillStyle = 'rgba(182,199,229,.7)';
  ctx.font = `${Math.max(13, cell * 0.15)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText('START', startX, startY);
}

function updateStats(): void {
  episodeEl.textContent = String(episode);
  epsilonEl.textContent = epsilon.toFixed(3);
  stepsEl.textContent = String(episodeStep);
  rewardEl.textContent = episodeReward.toFixed(1);
}

function frame(now: number): void {
  const elapsed = now - lastFrame;
  lastFrame = now;
  if (running) {
    const batches = elapsed > 0 ? 80 : 1;
    for (let i = 0; i < batches && running; i++) trainingStep();
  } else if (demoPlaying && demoIndex < demoRoute.length - 1 && now >= demoNextAt) {
    demoIndex++;
    const state = demoRoute[demoIndex];
    env.position = positionFromState(state);
    trail.push(state);
    demoNextAt = now + 260;
    if (demoIndex === demoRoute.length - 1) {
      demoPlaying = false;
      statusEl.textContent = '到达目标！策略演示完成';
    }
  }
  updateStats();
  draw();
  requestAnimationFrame(frame);
}

trainBtn.addEventListener('click', () => {
  demoPlaying = false;
  demoRoute = [];
  running = !running;
  trainBtn.textContent = running ? '暂停训练' : '继续训练';
  statusEl.textContent = running ? '训练中：小球正在探索环境…' : '训练已暂停';
});

demoBtn.addEventListener('click', startDemo);
resetBtn.addEventListener('click', () => {
  running = false;
  demoPlaying = false;
  agent.clear();
  episode = 0;
  demoRoute = [];
  beginEpisode();
  trainBtn.textContent = '开始训练';
  statusEl.textContent = 'Q 表已清空，等待训练';
});

episodeTarget.addEventListener('change', () => {
  episodeTarget.value = String(Math.max(1, Math.floor(Number(episodeTarget.value) || 2000)));
});

beginEpisode();
requestAnimationFrame(frame);
