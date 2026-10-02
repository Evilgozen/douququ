#!/usr/bin/env python3
"""电子斗蛐蛐 Gymnasium 客户端：连接 `npm run rl:serve` 起的 HTTP 桥做训练/评估。

前置：
  cd douququ && npm run rl:serve -- public/episodes/ep002-guard-vs-intern.yaml --id intern --port 8021

用法：
  python3 scripts/rl_gym_client.py --url http://127.0.0.1:8021 --episodes 3

依赖：HTTP 走标准库 urllib（无需 requests）；装了 gymnasium 就是货真价实的 gym.Env，
可以直接喂给 stable_baselines3：

  import gymnasium as gym
  from scripts.rl_gym_client import DouququEnv
  from stable_baselines3 import PPO
  env = DouququEnv("http://127.0.0.1:8021")
  model = PPO("MlpPolicy", env, n_steps=2048, verbose=1)
  model.learn(total_timesteps=500_000)
"""
import argparse
import json
import random
import urllib.request

try:
    import gymnasium as gym
    from gymnasium import spaces
    _HAS_GYM = True
except ImportError:  # 没装 gymnasium 也能跑 smoke 测试
    _HAS_GYM = False


class _HTTP:
    def __init__(self, base: str):
        self.base = base.rstrip("/")

    def get(self, path: str):
        with urllib.request.urlopen(f"{self.base}{path}", timeout=30) as r:
            return json.loads(r.read())

    def post(self, path: str, body: dict):
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            f"{self.base}{path}", data=data, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())


class DouququEnv(gym.Env if _HAS_GYM else object):  # type: ignore[misc,valid-type]
    """Gymnasium 环境：远程驱动 douququ 战斗引擎（确定性模拟）。

    动作空间  Box(-1, 1, (3,))  = [移动x, 移动y, 出招意图(>0 出手，autoAttack 模式忽略)]
    观测空间  Box(-1, 1, (22,)) = 见 douququ/src/rl/env.ts 的 OBS_KEYS
    """

    metadata = {"render_modes": []}

    def __init__(self, url: str = "http://127.0.0.1:8021"):
        self.http = _HTTP(url)
        info = self.http.get("/info")
        if _HAS_GYM:
            self.action_space = spaces.Box(
                low=info["actionSpace"]["low"][0],
                high=info["actionSpace"]["high"][0],
                shape=tuple(info["actionSpace"]["shape"]),
                dtype="float32",
            )
            self.observation_space = spaces.Box(
                low=info["observationSpace"]["low"][0],
                high=info["observationSpace"]["high"][0],
                shape=tuple(info["observationSpace"]["shape"]),
                dtype="float32",
            )
        else:
            self.action_space = info["actionSpace"]
            self.observation_space = info["observationSpace"]
        self.controlled_id = info.get("controlledId")
        self._last_info: dict = {}

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed) if _HAS_GYM else None
        body = {}
        if seed is not None:
            body["seed"] = int(seed)
        r = self.http.post("/reset", body)
        self._last_info = r["info"]
        obs = r["obs"]
        if _HAS_GYM:
            import numpy as np
            obs = np.asarray(obs, dtype="float32")
        return obs, r["info"]

    def step(self, action):
        r = self.http.post("/step", {"action": [float(a) for a in action]})
        self._last_info = r["info"]
        obs = r["obs"]
        if _HAS_GYM:
            import numpy as np
            obs = np.asarray(obs, dtype="float32")
        return obs, float(r["reward"]), bool(r["terminated"]), bool(r["truncated"]), r["info"]

    def close(self):
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8021")
    ap.add_argument("--episodes", type=int, default=3)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    env = DouququEnv(args.url)
    print(f"已连接 {args.url}；被控角色 = {env.controlled_id}")
    rng = random.Random(args.seed)
    wins = losses = timeouts = 0
    total_ret = 0.0
    for ep in range(args.episodes):
        obs, info = env.reset(seed=args.seed + ep * 101)
        done = False
        ret = 0.0
        while not done:
            a = [rng.uniform(-1, 1), rng.uniform(-1, 1), 1.0]
            obs, reward, term, trunc, info = env.step(a)
            ret += reward
            done = term or trunc
        if info.get("ownHp", 0) > 0 and info.get("enemyHp", 1) <= 0:
            wins += 1
        elif info.get("enemyHp", 1) > 0 and info.get("ownHp", 0) <= 0:
            losses += 1
        else:
            timeouts += 1
        total_ret += ret
        print(f"  第{ep + 1}局: 回报={ret:.1f} fightT={info.get('fightT', 0):.1f}s "
              f"ownHp={info.get('ownHp', 0):.0f} enemyHp={info.get('enemyHp', 0):.0f}")
    print(f"随机策略 {args.episodes} 局: {wins}胜 {losses}负 {timeouts}超时，平均回报 {total_ret / args.episodes:.2f}")


if __name__ == "__main__":
    main()
