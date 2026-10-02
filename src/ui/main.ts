/** 浏览器端：剧本选择 / 预览播放 / 倍速 / 音效试听 / 录制成片 */
import { Battle, LOGIC_DT } from '../core/sim';
import { parseEpisodeText } from '../core/loader';
import { narrationMatches } from '../core/narration';
import { collectSpritePaths, loadSpritesBrowser } from '../render/assets';
import { drawFrame, type Assets } from '../render/draw';
import { ScriptHost, bindHooks } from '../script/luaHost';
import { BrowserSfx } from '../audio/browserAudio';
import wasmUri from 'wasmoon/dist/glue.wasm?url';
import type { Episode } from '../core/types';
import { downloadBlob, recordCanvas } from './record';

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const epSelect = document.getElementById('epSelect') as HTMLSelectElement;
const seedInput = document.getElementById('seed') as HTMLInputElement;
const randSeedBtn = document.getElementById('randSeed') as HTMLButtonElement;
const btnPlay = document.getElementById('btnPlay') as HTMLButtonElement;
const btnRestart = document.getElementById('btnRestart') as HTMLButtonElement;
const btnRecord = document.getElementById('btnRecord') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;

interface ManifestItem {
  file: string;
  label: string;
}

let ep: Episode | null = null;
let battle: Battle | null = null;
let assets: Assets = new Map();
let host: ScriptHost | null = null;
const browserSfx = new BrowserSfx();
let narration: Array<{ t: number; buf: AudioBuffer }> = [];
let narrPtr = 0;
let playing = true;
let speed = 2;
let acc = 0;
let last = performance.now();
let recording = false;

const $ = (s: string) => document.querySelector(s)!;

async function loadEpisode(file: string): Promise<void> {
  statusEl.textContent = '加载剧本…';
  const res = await fetch(`/episodes/${encodeURIComponent(file)}`);
  if (!res.ok) throw new Error(`剧本加载失败：${file}`);
  const parsed = parseEpisodeText(await res.text(), file.replace(/\.ya?ml$/i, ''));
  applySeedInput(parsed);
  ep = parsed;
  assets = await loadSpritesBrowser(collectSpritePaths(ep));
  // 音效素材 + Lua 演出脚本
  try {
    const manifest = await (await fetch('/sfx/index.json')).json();
    await browserSfx.preload(manifest);
  } catch {
    /* 无音效素材时静默 */
  }
  try {
    rosterCache = await (await fetch('/leagues/roster.json')).json();
  } catch {
    rosterCache = null; // 无档案
  }
  try {
    const scriptRes = await fetch(`/scripts/${encodeURIComponent(ep.script ?? 'default')}.lua`);
    host = scriptRes.ok
      ? await ScriptHost.create(await scriptRes.text(), bindHooks(() => battle!.st, {
          sfxVol: ep.audio?.volume ?? 1,
          onLiveSfx: (n, v, r) => browserSfx.play(n, v, r),
        }), wasmUri)
      : null;
  } catch (e) {
    console.warn('[lua] 脚本加载失败：', e);
    host = null;
  }
  // 解说配音（npm run tts 生成后自动加载试听）
  narration = [];
  narrPtr = 0;
  try {
    const mRes = await fetch(`/tts/${encodeURIComponent(ep.id)}/manifest.json`);
    if (mRes.ok) {
      const manifest = (await mRes.json()) as { lines: Array<{ t: number; file: string; text: string }> };
      const lines = narrationMatches(ep, manifest.lines) ? [...manifest.lines].sort((a, b) => a.t - b.t) : [];
      for (const line of lines) {
        const ab = await (await fetch(`/tts/${encodeURIComponent(ep.id)}/${line.file}`)).arrayBuffer();
        const buf = await browserSfx.decode(ab);
        if (buf) narration.push({ t: line.t, buf });
      }
      if (narration.length > 0) statusEl.textContent = `已加载：${ep.title}（含 ${narration.length} 行配音）`;
    }
  } catch {
    /* 无配音时静默 */
  }
  restart();
  statusEl.textContent = statusEl.textContent?.startsWith('已加载') ? statusEl.textContent : `已加载：${ep.title}`;
}

function applySeedInput(parsed: Episode): void {
  const v = Number(seedInput.value);
  if (Number.isFinite(v) && v > 0) parsed.seed = Math.floor(v);
  seedInput.value = String(parsed.seed);
}

function restart(): void {
  if (!ep) return;
  applySeedInput(ep);
  battle = new Battle(ep);
  battle.onEvent = (ev) => void host?.dispatch(ev);
  if (rosterCache) battle.st.roster = rosterCache;
  acc = 0;
  narrPtr = 0;
}

let rosterCache: Record<string, { name: string; wins: number; losses: number; h2h: Record<string, { w: number; l: number }> }> | null = null;

function frame(now: number): void {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (battle && playing) {
    acc += dtReal * speed;
    let guard = 0;
    while (acc >= LOGIC_DT && guard < 960) {
      battle.step();
      acc -= LOGIC_DT;
      guard++;
      if (battle.done) {
        acc = 0;
        break;
      }
    }
    // 配音调度：模拟时间越过的行立即播放（预览近似，成片由 CLI 精确混音）
    while (narrPtr < narration.length && battle.st.t >= narration[narrPtr].t) {
      const line = narration[narrPtr++];
      browserSfx.playBuffer(line.buf, ep?.narration?.volume ?? 1, 1);
    }
  }
  if (battle) drawFrame(ctx, battle.st, assets);
  else {
    ctx.fillStyle = '#0b0e1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  requestAnimationFrame(frame);
}

async function boot(): Promise<void> {
  const res = await fetch('/episodes/index.json');
  const manifest: ManifestItem[] = await res.json();
  for (const item of manifest) {
    const opt = document.createElement('option');
    opt.value = item.file;
    opt.textContent = item.label;
    epSelect.appendChild(opt);
  }
  epSelect.addEventListener('change', () => loadEpisode(epSelect.value).catch((e) => (statusEl.textContent = String(e))));
  await loadEpisode(epSelect.value);
  requestAnimationFrame((t) => {
    last = t;
    frame(t);
  });
}

btnPlay.addEventListener('click', () => {
  playing = !playing;
  btnPlay.textContent = playing ? '暂停' : '播放';
});
btnRestart.addEventListener('click', restart);
randSeedBtn.addEventListener('click', () => {
  seedInput.value = String(Math.floor(Math.random() * 1_000_000));
  restart();
});
seedInput.addEventListener('change', restart);

document.querySelectorAll<HTMLButtonElement>('.spd').forEach((b) => {
  b.addEventListener('click', () => {
    speed = Number(b.dataset.spd);
    document.querySelectorAll<HTMLButtonElement>('.spd').forEach((x) => x.classList.toggle('active', x === b));
  });
});

btnRecord.addEventListener('click', async () => {
  if (!ep || recording) return;
  recording = true;
  btnRecord.disabled = true;
  playing = true;
  btnPlay.textContent = '暂停';
  // 录制期间强制 1x 实时，保证音画节奏正确
  const prevSpeed = speed;
  speed = 1;
  restart();
  statusEl.textContent = '录制中（实时 1x）…';
  try {
    const result = await recordCanvas(
      canvas,
      () => battle?.done ?? false,
      (elapsed) => {
        statusEl.textContent = `录制中 ${elapsed.toFixed(0)}s…`;
      },
    );
    const name = `${ep.id}-seed${ep.seed}.${result.ext}`;
    downloadBlob(result.blob, name);
    statusEl.textContent = `已导出 ${name}；转 mp4：npm run transcode -- ${name}`;
  } catch (e) {
    statusEl.textContent = `录制失败：${e instanceof Error ? e.message : e}`;
  } finally {
    speed = prevSpeed;
    recording = false;
    btnRecord.disabled = false;
  }
});

boot().catch((e) => {
  statusEl.textContent = `启动失败：${e instanceof Error ? e.message : e}`;
  console.error(e);
});
