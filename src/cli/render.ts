/**
 * 出片 CLI：
 *   npm run render -- episodes/ep001.yaml            → exports/ep001-seed42.mp4（含音效轨）
 *   npm run render -- episodes/ --all                → 渲染目录下 index.json 列出的全部剧本
 *   npm run render -- episodes/ep001.yaml --seed 7   → 覆盖 seed
 *   npm run render -- episodes/ep001.yaml --dry      → 只跑模拟打印战报（调数值用）
 *   npm run render -- episodes/ep001.yaml --mute     → 不混音效轨
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import { Battle, END_DUR, H, LOGIC_DT, W, type BattleState, type SfxEvent } from '../core/sim';
import { parseEpisodeText } from '../core/loader';
import { narrationMatches } from '../core/narration';
import { scoutSpectacle, type SpectacleResult } from '../core/spectacle';
import { collectSpritePaths, loadSpritesNode } from '../render/assets';
import { drawFrame, type Assets } from '../render/draw';
import { ScriptHost, bindHooks } from '../script/luaHost';
import { mixSfxFloat, mixClipsFloat, mixBgmFloat, encodeMix, parseWav, type MixedSfxEvent, type WavAudio, type NarrationClip } from '../audio/mixer';
import type { Episode } from '../core/types';

interface NarrationManifestLine {
  file: string;
  t: number;
  dur: number;
  text: string;
  gold: boolean;
  /** 该行音量（金色行 > 1），缺省 1 */
  vol?: number;
}

interface NarrationManifest {
  ep: string;
  lines: NarrationManifestLine[];
}

interface Args {
  inputs: string[];
  seed?: number;
  out?: string;
  dry: boolean;
  mute: boolean;
  fps: number;
  /** 渲染前先搜索多少个 seed，0 表示关闭。 */
  scout: number;
  scoutTop: number;
  scoutWinner: -1 | 0 | 1 | null;
  allowArcade: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { inputs: [], dry: false, mute: false, fps: 30, scout: 0, scoutTop: 5, scoutWinner: null, allowArcade: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry') args.dry = true;
    else if (a === '--allow-arcade') args.allowArcade = true;
    else if (a === '--mute') args.mute = true;
    else if (a === '--seed') args.seed = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--fps') args.fps = Number(argv[++i]);
    else if (a === '--scout') args.scout = Number(argv[++i]);
    else if (a === '--scout-top') args.scoutTop = Number(argv[++i]);
    else if (a === '--winner') {
      const v = String(argv[++i] ?? '').toLowerCase();
      if (v === 'red' || v === '0') args.scoutWinner = 0;
      else if (v === 'blue' || v === '1') args.scoutWinner = 1;
      else if (v === 'draw' || v === '-1') args.scoutWinner = -1;
      else if (v === 'any') args.scoutWinner = null;
      else throw new Error('--winner 必须是 red / blue / draw / any');
    }
    else args.inputs.push(a);
  }
  if (!Number.isFinite(args.scout) || args.scout < 0) throw new Error('--scout 必须是非负整数');
  if (!Number.isFinite(args.scoutTop) || args.scoutTop < 1) throw new Error('--scout-top 必须是正整数');
  if (args.inputs.length === 0) {
    console.error('用法：npm run render -- <episode.yaml | episodes目录> [--seed N] [--scout 500] [--winner red|blue|draw|any] [--scout-top 5] [--out file.mp4] [--fps 30] [--dry] [--mute]');
    process.exit(1);
  }
  return args;
}

function winnerLabel(r: SpectacleResult): string {
  return r.metrics.winner === 0 ? '红' : r.metrics.winner === 1 ? '蓝' : '平';
}

function runScout(ep: Episode, count: number, topN: number, wantedWinner: -1 | 0 | 1 | null): SpectacleResult {
  const t0 = Date.now();
  const all = scoutSpectacle(ep, { count, startSeed: ep.seed });
  const ranked = wantedWinner === null ? all : all.filter((r) => r.metrics.winner === wantedWinner);
  if (ranked.length === 0) throw new Error(`试演 ${count} 局后没有找到目标胜方 ${wantedWinner === 0 ? '红方' : wantedWinner === 1 ? '蓝方' : '平局'}`);
  const shown = ranked.slice(0, Math.min(topN, ranked.length));
  const filter = wantedWinner === null ? '' : `，筛选${wantedWinner === 0 ? '红方' : wantedWinner === 1 ? '蓝方' : '平局'}胜`;
  console.log(`  试演：从 seed ${ep.seed} 起搜索 ${count} 局${filter}，前 ${shown.length} 名：`);
  console.log('  排名  seed       分数    胜方  战斗时长  领先交换  残血时长  空转时长  胜者余血');
  shown.forEach((r, i) => {
    const m = r.metrics;
    console.log(
      `  ${String(i + 1).padStart(2)}    ${String(r.seed).padEnd(9)} ${r.score.toFixed(1).padStart(6)}  ${winnerLabel(r).padStart(2)}    ${m.duration.toFixed(1).padStart(5)}s      ${String(m.leadChanges).padStart(2)}       ${m.lowHpSeconds.toFixed(1).padStart(5)}s    ${m.idleSeconds.toFixed(1).padStart(5)}s    ${(m.winnerHpPct * 100).toFixed(1).padStart(5)}%`,
    );
  });
  const best = ranked[0];
  console.log(`  自动采用 seed=${best.seed}（评分 ${best.score.toFixed(1)}，试演耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  return best;
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC_DIR = path.join(projectRoot, 'public');

async function resolveInputs(inputs: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const input of inputs) {
    const full = path.resolve(input);
    if (fs.statSync(full).isDirectory()) {
      const manifest = JSON.parse(fs.readFileSync(path.join(full, 'index.json'), 'utf8')) as Array<{ file: string }>;
      for (const item of manifest) out.push(path.join(full, item.file));
    } else {
      out.push(full);
    }
  }
  return out;
}

function loadEpisodeFile(file: string, seed?: number): Episode {
  const text = fs.readFileSync(file, 'utf8');
  const id = path.basename(file).replace(/\.ya?ml$/i, '');
  const ep = parseEpisodeText(text, id);
  if (seed !== undefined) ep.seed = seed;
  return ep;
}

function loadScriptCode(ep: Episode): string | null {
  const name = ep.script ?? 'default';
  const scriptPath = path.join(PUBLIC_DIR, 'scripts', `${name}.lua`);
  if (!fs.existsSync(scriptPath)) {
    if (name !== 'default') throw new Error(`演出脚本不存在：${scriptPath}`);
    return null;
  }
  return fs.readFileSync(scriptPath, 'utf8');
}

async function makeHost(code: string | null, getSt: () => BattleState, sfxVol: number): Promise<ScriptHost | null> {
  if (code === null) return null;
  return ScriptHost.create(code, bindHooks(getSt, { sfxVol }));
}

function battleDuration(b: Battle): number {
  return b.st.t;
}

async function dryRun(ep: Episode, code: string | null): Promise<void> {
  const b = new Battle(ep);
  const st = b.st;
  let host: ScriptHost | null = null;
  try {
    host = await makeHost(code, () => b.st, ep.audio?.volume ?? 1);
    b.onEvent = (ev) => void host?.dispatch(ev);
  } catch (e) {
    console.warn(`[lua] 脚本加载失败，忽略演出脚本：${e instanceof Error ? e.message : e}`);
  }
  const twists: Array<{ t: number; banner: string }> = [];
  let lastPhase = st.phase;
  while (!b.done && st.t < 600) {
    const prev = [...st.firedTwists];
    b.step();
    for (let i = 0; i < prev.length; i++) {
      if (!prev[i] && st.firedTwists[i]) {
        const tw = st.ep.twists?.[i];
        twists.push({ t: Number(st.fightT.toFixed(2)), banner: tw?.banner ?? tw?.effect?.type ?? '解说' });
      }
    }
    if (st.phase !== lastPhase) {
      console.log(`  [阶段] ${lastPhase} → ${st.phase}  (全局 ${st.t.toFixed(1)}s, 战斗 ${st.fightT.toFixed(1)}s)`);
      lastPhase = st.phase;
    }
  }
  console.log(`\n===== 战报：${ep.title}（seed=${ep.seed}）=====`);
  for (const tw of twists) console.log(`  [反转] 战斗 ${tw.t}s：${tw.banner}`);
  if (st.suddenDeathFired) console.log(`  [反转] 突然死亡 @ 战斗 ${ep.timeLimit}s`);
  console.log(`  胜者：${st.winner === -1 ? '平局' : st.winner === 0 ? '红方' : '蓝方'}`);
  for (const u of st.units) {
    const props = Object.entries(u.props).map(([k, v]) => `${k}=${v}`).join(',') || '-';
    const combo = u.fighter.combo.length > 0 ? `连击[${u.fighter.combo.join(',')}]` : '';
    const buffs = u.fighter.buffs
      .map((b) => {
        const dur = b.remainingHits >= 0 ? `${b.remainingHits}刀` : b.remainingTime >= 0 ? `${b.remainingTime.toFixed(0)}s` : '无限';
        return `${b.label} x${b.atkMult}(${dur})`;
      })
      .join(', ');
    console.log(
      `  ${u.side === 0 ? '[红]' : '[蓝]'} ${u.name}: hp ${Math.max(0, Math.round(u.hp))}/${u.maxHp} | 输出 ${Math.round(u.totalDamage)} | 最高单次 ${Math.round(u.biggestHit)} (x${u.biggestMult.toFixed(1)}) | 击倒 ${u.kills} | ${combo} ${buffs ? `增益(${buffs})` : ''} | 状态(${props})`,
    );
  }
  console.log(`  全局时长 ${st.t.toFixed(1)}s（成片约 ${(st.t).toFixed(0)}s + 慢放拉伸，含开场 4.4s + 结尾 ${ep.endDuration ?? END_DUR}s）`);
}

/** 模拟时间 → 视频时间（慢放期间两者偏差变大，按帧映射插值） */
function mapToVideoTime(sfx: SfxEvent[], timeMap: Array<{ s: number; v: number }>): MixedSfxEvent[] {
  const out: MixedSfxEvent[] = [];
  let p = 0;
  for (const e of sfx) {
    while (p < timeMap.length - 2 && timeMap[p + 1].s < e.t) p++;
    const a = timeMap[p];
    const b = timeMap[Math.min(p + 1, timeMap.length - 1)];
    const f = b.s > a.s ? (e.t - a.s) / (b.s - a.s) : 0;
    out.push({ name: e.name, t: a.v + f * (b.v - a.v), vol: e.vol, rate: e.rate });
  }
  return out;
}

async function loadSfxLib(names: string[]): Promise<Map<string, WavAudio>> {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, 'sfx', 'index.json'), 'utf8')) as Record<string, string>;
  const lib = new Map<string, WavAudio>();
  for (const name of new Set(names)) {
    const file = manifest[name];
    if (!file) {
      console.warn(`[mixer] sfx/index.json 里没有 "${name}"，跳过`);
      continue;
    }
    lib.set(name, parseWav(readFileBuffer(path.join(PUBLIC_DIR, 'sfx', file))));
  }
  return lib;
}

/** 安全读取（Buffer 可能来自内存池，必须按 byteOffset 切出 ArrayBuffer） */
function readFileBuffer(p: string): ArrayBuffer {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

function loadNarrationManifest(ep: Episode): NarrationManifest | null {
  const p = path.join(PUBLIC_DIR, 'tts', ep.id, 'manifest.json');
  if (!fs.existsSync(p)) return null;
  const m = JSON.parse(fs.readFileSync(p, 'utf8')) as NarrationManifest;
  if (m.ep !== ep.id || m.lines.length === 0) return null;
  if (!narrationMatches(ep, m.lines)) {
    console.warn(`[tts] ${ep.id} 的配音清单与当前剧本不符，跳过旧配音；更新配音后再渲染即可。`);
    return null;
  }
  // 已有 manifest 的时长也可能来自旧版固定采样率估算，以实际 WAV 为准。
  for (const line of m.lines) {
    const audio = parseWav(readFileBuffer(path.join(PUBLIC_DIR, 'tts', ep.id, line.file)));
    line.dur = audio.samples.length / audio.sampleRate;
  }
  return m;
}

/** 字幕时长对齐配音：有配音的行，字幕停留到语音说完（+0.6s 缓冲） */
function syncCaptions(st: BattleState, manifest: NarrationManifest): number {
  let n = 0;
  for (const line of manifest.lines) {
    const cap = st.captions.find((c) => c.text === line.text && Math.abs(c.t - line.t) < 1.5);
    if (cap) {
      cap.dur = line.dur + 0.6;
      n++;
    }
  }
  return n;
}

async function muxAudio(videoPath: string, wav: Uint8Array, out: string): Promise<void> {
  const { path: ffmpegPath } = await import('@ffmpeg-installer/ffmpeg');
  const tmpWav = out + '.tmp.wav';
  fs.writeFileSync(tmpWav, wav);
  await new Promise<void>((resolve, reject) => {
    const ff = spawn(ffmpegPath, ['-y', '-i', videoPath, '-i', tmpWav, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', out], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg mux 退出码 ${code}`))));
    ff.on('error', reject);
  });
  fs.rmSync(tmpWav, { force: true });
  fs.rmSync(videoPath, { force: true });
}

function loadRoster(): Record<string, import('../core/sim').RosterEntry> | null {
  const p = path.join(PUBLIC_DIR, 'leagues', 'roster.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function renderVideo(ep: Episode, out: string, fps: number, assets: Assets, code: string | null, mute: boolean): Promise<void> {
  const { path: ffmpegPath } = await import('@ffmpeg-installer/ffmpeg');
  const b = new Battle(ep);
  const st = b.st;
  st.roster = loadRoster();
  let host: ScriptHost | null = null;
  try {
    host = await makeHost(code, () => st, ep.audio?.volume ?? 1);
    b.onEvent = (ev) => void host?.dispatch(ev);
  } catch (e) {
    console.warn(`[lua] 脚本加载失败，忽略演出脚本：${e instanceof Error ? e.message : e}`);
  }
  const stepsPerFrame = Math.max(1, Math.round((1 / fps) / LOGIC_DT));
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 解说配音：清单存在则混入，并把字幕时长对齐语音
  const ttsManifest = loadNarrationManifest(ep);
  if (ttsManifest) {
    const n = syncCaptions(st, ttsManifest);
    console.log(`  配音：${ttsManifest.lines.length} 行解说（对齐字幕 ${n} 行）`);
  } else if ((ep.narration?.voice ?? null) !== null || fs.existsSync(path.join(PUBLIC_DIR, 'tts', ep.id))) {
    console.log('  配音：未找到 tts 清单，先跑 npm run tts -- <yaml> 生成（本次输出无配音）');
  }

  const tmpVideo = out + '.v.mp4';
  const args = [
    '-y',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s', `${W}x${H}`,
    '-framerate', String(fps),
    '-i', '-',
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '19',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    tmpVideo,
  ];
  const ff = spawn(ffmpegPath, args, { stdio: ['pipe', 'inherit', 'inherit'] });

  const writeFrame = async (data: Uint8ClampedArray): Promise<void> => {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (!ff.stdin.write(buf)) {
      await new Promise<void>((resolve) => ff.stdin.once('drain', resolve));
    }
  };

  const timeMap: Array<{ s: number; v: number }> = [];
  let frameIdx = 0;
  const t0 = Date.now();
  while (!b.done && st.t < 600) {
    for (let s = 0; s < stepsPerFrame && !b.done; s++) b.step();
    drawFrame(ctx as unknown as CanvasRenderingContext2D, st, assets);
    const img = ctx.getImageData(0, 0, W, H);
    await writeFrame(img.data);
    timeMap.push({ s: st.t, v: frameIdx / fps });
    frameIdx++;
    if (frameIdx % (fps * 5) === 0) {
      const pct = ((st.t / Math.max(1, battleDuration(b))) * 100).toFixed(0);
      process.stdout.write(`\r渲染中 ${st.t.toFixed(0)}s / ~${battleDuration(b).toFixed(0)}s (${pct}%)  ${frameIdx} 帧`);
    }
  }
  ff.stdin.end();
  await new Promise<void>((resolve, reject) => {
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg 退出码 ${code}`))));
    ff.on('error', reject);
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  // 混音：模拟时间 → 视频时间（慢放期间两者有偏差）→ 音效层 + 配音层合成
  if (!mute && (st.sfx.length > 0 || ttsManifest)) {
    const mapped = mapToVideoTime(st.sfx, timeMap);
    const memeSounds = new Set(ep.fighters.filter((f) => f.memeSkill).map((f) => f.memeSkill!.sound));
    if (memeSounds.size && st.phase === 'end') {
      const endTime = mapToVideoTime([{ name: '', t: st.t - st.endT, vol: 1, rate: 1 }], timeMap)[0].t;
      for (const event of mapped) if (memeSounds.has(event.name)) event.durationSec = Math.max(0, endTime - event.t);
    }
    const sfxLayer = mixSfxFloat(mapped, await loadSfxLib(mapped.map((e) => e.name)), frameIdx / fps + 0.2, ep.audio?.volume ?? 1);
    const layers = [sfxLayer];
    // BGM 层：解说时间窗内自动压音量（时间窗按视频时间轴）
    const bgmFile = path.join(PUBLIC_DIR, ep.bgm?.file ?? 'bgm/chill-loop.wav');
    if (fs.existsSync(bgmFile) && (ep.bgm?.vol ?? 0.16) > 0) {
      const duckWindows = ttsManifest
        ? ttsManifest.lines.map((l) => ({
            t: mapToVideoTime([{ name: '', t: l.t, vol: 1, rate: 1 }], timeMap)[0].t,
            dur: l.dur,
          }))
        : [];
      layers.push(
        mixBgmFloat(
          { audio: parseWav(readFileBuffer(bgmFile)), vol: ep.bgm?.vol ?? 0.16, duckTo: ep.bgm?.duckTo ?? 0.35 },
          frameIdx / fps + 0.2,
          duckWindows,
        ),
      );
    }
    if (ttsManifest) {
      const clips: NarrationClip[] = ttsManifest.lines.map((l) => ({
        t: mapToVideoTime([{ name: '', t: l.t, vol: 1, rate: 1 }], timeMap)[0].t,
        audio: parseWav(readFileBuffer(path.join(PUBLIC_DIR, 'tts', ep.id, l.file))),
        vol: (l.vol ?? 1) * (ep.narration?.volume ?? 1),
      }));
      layers.push(mixClipsFloat(clips, frameIdx / fps + 0.2));
    }
    await muxAudio(tmpVideo, encodeMix(layers), out);
    console.log(`  音轨：${st.sfx.length} 个音效事件${ttsManifest ? ` + ${ttsManifest.lines.length} 行配音` : ''}，混音完成`);
  } else {
    fs.renameSync(tmpVideo, out);
  }
  const size = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log(`\n完成：${out}（${frameIdx} 帧，${(frameIdx / fps).toFixed(1)}s 成片，渲染耗时 ${secs}s，${size} MB）`);

  // 发布：自动出封面 + 打印一条可复制的投稿命令
  if (ep.publish) {
    const { path: ffmpegPath } = await import('@ffmpeg-installer/ffmpeg');
    const coverAt = ep.publish.coverAt ?? -1;
    const coverOut = path.join(projectRoot, 'exports', `cover-${path.basename(out, '.mp4')}.jpg`);
    await new Promise<void>((resolve, reject) => {
      const p = spawn(ffmpegPath, ['-y', '-loglevel', 'error', '-ss', String(coverAt), '-i', out, '-frames:v', '1', '-q:v', '2', coverOut], {
        stdio: 'ignore',
      });
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`封面生成失败 ${c}`))));
      p.on('error', reject);
    });
    const title = ep.publish.title ?? ep.title;
    const tags = (ep.publish.tags ?? ['电子斗蛐蛐', '斗蛐蛐', '搞笑']).join(',');
    const dtime = ep.publish.dtime ? ` --dtime "${ep.publish.dtime}"` : '';
    console.log(`封面：${coverOut}`);
    console.log(`\n投稿命令：`);
    console.log(`python3 scripts/publish_bili.py ${out} --title "${title}" --tags "${tags}" --tid ${ep.publish.tid ?? 138} --cover ${coverOut}${dtime}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const files = await resolveInputs(args.inputs);
  for (const file of files) {
    const ep = loadEpisodeFile(file, args.seed);
    console.log(`\n>>> ${path.basename(file)}：${ep.title}`);
    if (!args.dry && ep.combat?.mode !== 'readable' && !args.allowArcade) {
      throw new Error(`${ep.id} 是历史 arcade 剧本。正常出片只允许 readable；请重写成简明对战，或明确使用 --allow-arcade 渲染历史版本。`);
    }
    if (args.scout > 0) ep.seed = runScout(ep, Math.floor(args.scout), Math.floor(args.scoutTop), args.scoutWinner).seed;
    if (args.dry) {
      await dryRun(ep, loadScriptCode(ep));
      continue;
    }
    const assets = await loadSpritesNode(collectSpritePaths(ep), PUBLIC_DIR);
    const outDir = path.join(projectRoot, 'exports');
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.resolve(args.out ?? path.join(outDir, `${ep.id}-seed${ep.seed}.mp4`));
    const code = loadScriptCode(ep);
    await renderVideo(ep, out, args.fps, assets, code, args.mute);
  }
}

main().catch((e) => {
  console.error('\n出片失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
