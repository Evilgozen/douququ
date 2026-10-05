/**
 * 解说配音生成命令：
 *   npm run tts -- episodes/ep001.yaml           → 合成全部解说词 → public/tts/<id>/
 *   npm run tts -- episodes/ep001.yaml --force   → 忽略缓存重新合成（会重新计费）
 *
 * 流程：跑一遍确定性对局，收集全部字幕（含反转触发的动态字幕）作为解说词，
 * 逐行调 MiniMax T2A 合成 wav（同文案+同音色命中缓存不重复计费），
 * 写出 manifest（行文本 / 模拟时间轴时刻 / 音频时长），渲染时混音与字幕自动对齐。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Battle } from '../core/sim';
import { parseEpisodeText } from '../core/loader';
import { synthesize, voiceKey, DEFAULT_VOICE, type TtsVoiceCfg } from '../tts/minimax';
import { synthesizeVolc } from '../tts/volc';
import { synthesizeVolcV3, VOLC_V3_RESOURCE, VOLC_V3_VOICE, type WordTimestamp } from '../tts/volcV3';
import { parseWav } from '../audio/mixer';
import type { Episode } from '../core/types';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC_DIR = path.join(projectRoot, 'public');

interface NarrationLine {
  hash: string;
  file: string;
  /** 模拟时间轴时刻（秒） */
  t: number;
  /** 音频时长（秒） */
  dur: number;
  text: string;
  gold: boolean;
  /** 该行音量（金色行 > 1，混音时应用） */
  vol: number;
  words?: WordTimestamp[];
}

interface NarrationManifest {
  ep: string;
  voice: TtsVoiceCfg;
  lines: NarrationLine[];
}

function voiceCfgOf(ep: Episode, provider: string): TtsVoiceCfg {
  const n = ep.narration ?? {};
  return {
    ...DEFAULT_VOICE,
    ...n,
    model: provider === 'volc-v3' ? VOLC_V3_RESOURCE : provider === 'volc' ? 'volc-tts' : (n.model ?? DEFAULT_VOICE.model),
    voice: n.voice ?? (provider === 'volc-v3' ? VOLC_V3_VOICE : provider === 'volc' ? 'BV002_streaming' : DEFAULT_VOICE.voice),
  };
}

async function synthesizeLine(provider: string, text: string, cfg: TtsVoiceCfg): Promise<{ wav: Buffer; durMs: number; words?: WordTimestamp[] }> {
  if (provider === 'volc-v3') return synthesizeVolcV3(text, cfg);
  if (provider === 'volc') {
    const r = await synthesizeVolc(text, {
      voice: cfg.voice,
      speed: cfg.speed,
      vol: cfg.vol,
      cluster: 'volcano_tts',
    });
    const audio = parseWav(r.wav.buffer.slice(r.wav.byteOffset, r.wav.byteOffset + r.wav.byteLength) as ArrayBuffer);
    const durMs = Math.round(audio.samples.length / audio.sampleRate * 1000);
    return { wav: r.wav, durMs };
  }
  return synthesize(text, cfg);
}

/** 情绪化：金色反转行比普通行更快更响（MiniMax 再叠 excited 情绪） */
function cfgForLine(provider: string, base: TtsVoiceCfg, gold: boolean): TtsVoiceCfg {
  if (!gold) return base;
  return {
    ...base,
    speed: Math.min(1.4, base.speed * 1.18),
    vol: Math.min(2, base.vol + 0.25),
    ...(provider === 'minimax' ? { emotion: base.emotion ?? 'excited' } : {}),
  };
}

function collectLines(ep: Episode): Array<{ t: number; text: string; gold: boolean }> {
  const b = new Battle(ep);
  const seen = new Set<string>();
  const lines: Array<{ t: number; text: string; gold: boolean }> = [];
  // 结算会清空字幕，所以每步之后立即捕获新出现的行
  while (!b.done && b.st.t < 600) {
    b.step();
    for (const c of b.st.captions) {
      if (seen.has(c.text)) continue;
      seen.add(c.text);
      lines.push({ t: c.t, text: c.text, gold: c.gold });
    }
  }
  lines.sort((a, z) => a.t - z.t);
  return lines;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const explicitProvider = argv.includes('--volc') ? 'volc' : (argv.find((a) => a.startsWith('--provider='))?.split('=')[1] ?? null);
  let provider = explicitProvider ?? 'minimax';
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('用法：npm run tts -- <episode.yaml> [--force] [--volc | --provider=minimax|volc|volc-v3]');
    process.exit(1);
  }
  const ep = parseEpisodeText(fs.readFileSync(path.resolve(file), 'utf8'), path.basename(file).replace(/\.ya?ml$/i, ''));
  if (!explicitProvider && ep.narration?.provider) {
    provider = ep.narration.provider; // 剧本指定优先于默认
  }
  if (!['volc', 'minimax', 'volc-v3'].includes(provider)) throw new Error(`不支持的 TTS provider：${provider}`);
  const cfg = voiceCfgOf(ep, provider);
  const outDir = path.join(PUBLIC_DIR, 'tts', ep.id);
  fs.mkdirSync(outDir, { recursive: true });

  const lines = collectLines(ep);
  console.log(`解说词共 ${lines.length} 行（provider=${provider}，音色 ${cfg.voice}，speed ${cfg.speed}）`);

  const manifest: NarrationManifest = { ep: ep.id, voice: cfg, lines: [] };
  let cacheHit = 0;
  let spent = 0;
  for (const line of lines) {
    const lineCfg = cfgForLine(provider, cfg, line.gold);
    const hash = createHash('sha1').update(`${provider}|${voiceKey(lineCfg)}|${line.text}`).digest('hex').slice(0, 16);
    const fileName = `${hash}.wav`;
    const filePath = path.join(outDir, fileName);
    let dur = 0;
    let words: WordTimestamp[] | undefined;
    if (!force && fs.existsSync(filePath)) {
      // 旧缓存的 durMs 可能按错误的固定采样率计算；从 WAV 本身重新读取，不重复调用 TTS。
      const wav = fs.readFileSync(filePath);
      const audio = parseWav(wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer);
      dur = audio.samples.length / audio.sampleRate;
      const metaPath = filePath.replace(/\.wav$/, '.json');
      if (fs.existsSync(metaPath)) words = JSON.parse(fs.readFileSync(metaPath, 'utf8')).words;
      cacheHit++;
    } else {
      process.stdout.write(`合成${line.gold ? '（亢奋）' : ''}：「${line.text}」… `);
      const r = await synthesizeLine(provider, line.text, lineCfg);
      fs.writeFileSync(filePath, r.wav);
      fs.writeFileSync(filePath.replace(/\.wav$/, '.json'), JSON.stringify({ durMs: r.durMs, text: line.text, words: r.words }));
      dur = r.durMs / 1000;
      words = r.words;
      spent += line.text.length;
      console.log(`${dur.toFixed(1)}s`);
    }
    manifest.lines.push({ hash, file: fileName, t: line.t, dur, text: line.text, gold: line.gold, vol: lineCfg.vol, ...(words ? { words } : {}) });
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\n完成：${manifest.lines.length} 行（缓存命中 ${cacheHit}，本次合成计费约 ${spent} 字符）`);
  console.log(`清单：${path.join(PUBLIC_DIR, 'tts', ep.id, 'manifest.json')}`);
  console.log('直接 npm run render 即可出带配音的成片（字幕时长会自动对齐配音）。');
}

main().catch((e) => {
  console.error('\nTTS 失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
