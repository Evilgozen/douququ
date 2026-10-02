# 强化学习接口（RL）指南

把战斗引擎变成可训练环境：**Gymnasium 风格 API 原生跑在 TS 里（headless，快）**，
需要 Python 生态（stable-baselines3 / CleanRL）时通过 **HTTP JSON 桥**接入。

## 一、调研结论（2026-09）

| 方案 | 现状 | 结论 |
|---|---|---|
| [Gymnasium](https://gymnasium.farama.org)（Farama） | 事实标准：`reset(seed)→(obs,info)`、`step(action)→(obs,reward,terminated,truncated,info)` | API 照它做 |
| [PettingZoo](https://pettingzoo.farama.org) | 多智能体标准（AEC 循环模型），Python only | 自博弈阶段再考虑，见下文 |
| [RL.ts](https://github.com/stonet2000/rl-ts) / gym.js | TS 的 Gym 风格库，基于 TF.js，多年不维护 | 不依赖，仅参考接口形状 |
| BrowserGym 等 | 给浏览器任务用的 Gym 封装 | 与本场景无关 |

**选型理由**：JS 侧没有活跃的训练生态，主流训练器都在 Python；但引擎本身是
确定性固定步长模拟（同 seed 同动作序列逐帧一致），在 Node 里 headless 跑比实时
快几个数量级。所以：环境原生 TS（`src/rl/env.ts`）+ HTTP 桥（`src/rl/server.ts`）
+ Python Gymnasium 客户端（`scripts/rl_gym_client.py`）。比 BrowserGym 式"浏览器
里跑环境"轻得多，也比 wasm/嵌入 Python 简单可靠。

## 二、快速开始

### TS 原生（自博弈脚本、自定义训练循环）

```bash
npm run rl -- public/episodes/rl001-intern-kiting.yaml --id intern --episodes 30 --policy kite --check
```

- `rl001-intern-kiting.yaml` 是**训练专用剧本**（ep002 基础上实习生 1200 血调平衡）；
  ep002 本身是大爷优势局（视频叙事需要），拿它训练智能体永远学不会赢
- `--id intern`：被接管的 fighter（其余角色照剧本 `behavior` 行动，当 scripted 对手）
- `--policy random|kite|chase`：演示策略；实测梯度：贴脸 0% < 中距风筝 ~53% < 乱跑 ~93%
  （乱跑的混乱走位对"贴近就挨棍"的大爷反而是强基线——RL 的目标就是超过它）
- `--check`：确定性自检（同 seed 两局逐位一致才 PASS）
- 实测吞吐：headless ~20 万逻辑步/秒（比实时快 3000x+），PPO 预算内可以跑海量对局

### Python（stable-baselines3 训练）

```bash
# 终端1：起环境服务
npm run rl:serve -- public/episodes/ep002-guard-vs-intern.yaml --id intern --port 8021

# 终端2：smoke 测试（无需任何第三方依赖）
python3 scripts/rl_gym_client.py --url http://127.0.0.1:8021 --episodes 3
```

接入 SB3（装好 `gymnasium`、`stable-baselines3` 后）：

```python
from scripts.rl_gym_client import DouququEnv
from stable_baselines3 import PPO

env = DouququEnv("http://127.0.0.1:8021")
model = PPO("MlpPolicy", env, n_steps=2048, verbose=1)
model.learn(total_timesteps=500_000)
```

注意：HTTP 桥每步一个请求，本地 loopback 延迟 ~0.1-0.3ms，对 on-policy 算法
够用；要更大吞吐就在 TS 侧训练（自博弈）或开多个端口并行。

## 三、环境规格

### 动作空间 Box(-1,1,(3,))

| 维度 | 含义 |
|---|---|
| 0/1 | 移动意图向量 (x,y)，模长≤1 线性缩放转向力 |
| 2 | 出招意图：>0 出手（默认 `autoAttack=true` 自动出手，此维忽略；`--no-auto-attack` 打开手动） |

被控单位走 `behavior: manual` 通道（`Unit.cmd`），碰撞分离的物理仍然生效
（弹开、撞墙反弹），只有"追击 AI"被替换。

### 观测空间 Box(-1,1,(22,))

布局见 `src/rl/env.ts` 的 `OBS_KEYS`：自身（血量/位置/速度/攻击就绪/武器就绪/护盾）、
最近敌人（血量/相对位置/相对速度/距离/护盾）、最近 2 枚敌方飞行道具（相对位置/距离）、
归一化时间。全部归一化，敌我用相对坐标（平移不变性）。

### 回报（可在 EnvOptions.reward 配权重）

```
reward = 2.0 × (敌方有效血量掉的百分比)      # 打满一整条血 ≈ +2
       - 2.0 × (自己有效血量掉的百分比)
       + 10 / -10                            # 终胜 / 终负
       - 0.005 / 决策步                      # 时间惩罚，防拖延
```

有效血量 = hp + 护盾。伤害数值本身零随机（引擎设计），所以回报噪声只来自
物理走位——输赢可以干净地归因于策略。

### 终止与截断

- `terminated`：一方全灭（MDP 意义上的终局）
- `truncated`：`fightT ≥ maxFightSec`（默认 90s；`--max-fight-sec` 可调）

### 关键选项

| 选项 | 默认 | 说明 |
|---|---|---|
| `frameSkip` | 6 | 每个动作推进的逻辑步数（6 = 10Hz 决策，60 = 1Hz） |
| `autoAttack` | true | 出招全自动，动作空间退化为纯走位（风筝/贴脸博弈） |
| `maxFightSec` | 90 | 截断时长 |
| `seedBase` | 0 | reset 不带 seed 时的种子基准，逐局 +7919 递增 |

## 四、内容创作 × RL 的组合玩法

1. **练一个会走位的角色当"Boss"**：用 RL 训实习生风筝策略，导出成 scripted
   行为（录制动作序列或蒸馏成规则），进剧本打人类读者投稿的角色。
2. **AI 自博弈赛事企划**：两侧都 manual 接管，跑 PettingZoo 风格的循环对局，
   战报数据（伤害/走位热图）本身就是"电子斗蛐蛐"题材。
3. **数值平衡验证**：训练好的策略跑 1000 局，胜率应接近剧本意图（强弱差设计），
   偏差大 = 数值需要调。

## 五、已知边界

- 多敌人（援军 twists）时，obs 只含"最近敌人"，reward 按敌方总血量算——公平但不完全可观测。
- `twists`/突然死亡等演出反转在 RL 环境里照常触发（它们是模拟的一部分）。
- 自博弈（双方都 RL）当前需要两个 env 实例对拍或实现 PettingZoo AEC——待需要时再做。
