## 目标
我想要实现的是学习RL玩游戏的过程，你不是 ML 初学者，也不是为了转行做 RL researcher；你需要的是一条“每周打一个 Boss、遇到问题再补理论”的娱乐型路线。

## 第一关：让小球走到终点

这是一个不依赖第三方库的 Q-learning Hello World。小球 `●` 从左下方出发，绕开墙 `█`，到达星星 `★`。

```bash
python3 ball_rl.py
```

程序会训练 2,000 个 episode，然后播放学到的路线。如果当前终端不适合播放动画，可以运行：

```bash
python3 ball_rl.py --no-animation
python3 -m unittest -v
```

### 这一关对应的 RL 概念

| 代码中的东西 | RL 概念 |
|---|---|
| 小球的坐标 `(row, col)` | 状态 state |
| 上、下、左、右 | 动作 action |
| 到终点 `+10`、每步 `-0.1`、撞墙 `-3` | 奖励 reward |
| `Q[state][action]` | 对某状态下各动作长期价值的估计 |
| 训练前期随机乱走、后期选择高价值动作 | epsilon-greedy 探索 |

最值得亲手实验的三个参数是 `train()` 中的 `learning_rate`、`discount`，以及 epsilon 的衰减速度。先分别改动它们，观察最后 100 局的平均步数和奖励如何变化。

### 代码阅读顺序

1. `BallGame.reset()` / `BallGame.step()`：游戏规则，也就是环境。
2. `train()`：智能体与环境反复互动，并更新 Q 表。
3. `choose_action()`：探索与利用之间的选择。
4. `greedy_route()`：停止探索，只使用训练结果通关。

通关标准：你能不看资料解释 Q-learning 更新式中的“当前奖励”和“未来价值”各自在影响什么。
