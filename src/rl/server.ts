/**
 * RL 环境 HTTP 桥：让 Python（Gymnasium / stable-baselines3）直接训练 TS 引擎。
 *   npm run rl:serve -- public/episodes/ep002-guard-vs-intern.yaml --id intern --port 8021
 *
 * 协议（JSON，见 scripts/rl_gym_client.py）：
 *   GET  /info                 → { actionSpace, observationSpace, metadata, controlledId }
 *   POST /reset  { "seed": 42 } → { obs, info }
 *   POST /step   { "action": [ax, ay, fire] } → { obs, reward, terminated, truncated, info }
 *
 * 单环境实例（一个进程 = 一个 env）；要并行就开多个端口。
 */
import http from 'node:http';
import fs from 'node:fs';
import { parseEpisodeText } from '../core/loader';
import { BattleEnv } from './env';

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const yamlPath = process.argv.find((a) => a.endsWith('.yaml') || a.endsWith('.yml'));
  if (!yamlPath) {
    console.error('用法: npm run rl:serve -- <episode.yaml> [--id <fighterId>] [--port 8021] [--frame-skip 6] [--no-auto-attack]');
    process.exit(1);
  }
  const ep = parseEpisodeText(fs.readFileSync(yamlPath, 'utf8'), 'rl');
  const controlledId = argValue('--id') ?? ep.fighters[0].id;
  const port = Number(argValue('--port') ?? 8021);
  const frameSkip = Number(argValue('--frame-skip') ?? 6);
  const autoAttack = !process.argv.includes('--no-auto-attack');
  const env = new BattleEnv(ep, { controlledId, frameSkip, autoAttack });

  const readBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve, reject) => {
      let buf = '';
      req.on('data', (c) => {
        buf += c;
        if (buf.length > 65536) reject(new Error('body 过大'));
      });
      req.on('end', () => resolve(buf ? JSON.parse(buf) : {}));
      req.on('error', reject);
    });

  const server = http.createServer(async (req, res) => {
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/info') {
        send(200, {
          actionSpace: env.actionSpace,
          observationSpace: env.observationSpace,
          metadata: env.metadata,
          controlledId,
          episodeId: ep.id,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/reset') {
        const body = await readBody(req);
        const { obs, info } = env.reset(body.seed !== undefined ? Number(body.seed) : undefined);
        send(200, { obs, info });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/step') {
        const body = await readBody(req);
        if (!Array.isArray(body.action)) throw new Error('body.action 必须是数组');
        send(200, env.step(body.action));
        return;
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(400, { error: e instanceof Error ? e.message : String(e) });
    }
  });

  server.listen(port, () => {
    console.log(`RL 环境已就绪: http://127.0.0.1:${port}`);
    console.log(`  剧本=${ep.id} 被控=${controlledId} frameSkip=${frameSkip} autoAttack=${autoAttack}`);
    console.log(`  Python 侧: python3 scripts/rl_gym_client.py --url http://127.0.0.1:${port}`);
  });
}

main();
