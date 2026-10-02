"""A tiny, dependency-free reinforcement-learning game.

Train a ball to reach a target in a grid world with tabular Q-learning.
"""

from __future__ import annotations

import argparse
import random
import statistics
import time
from dataclasses import dataclass


Position = tuple[int, int]


@dataclass(frozen=True)
class StepResult:
    state: Position
    reward: float
    done: bool


class BallGame:
    """A minimal RL environment with a Gym-like reset/step interface."""

    ACTIONS: tuple[Position, ...] = ((-1, 0), (1, 0), (0, -1), (0, 1))
    ACTION_NAMES: tuple[str, ...] = ("up", "down", "left", "right")

    def __init__(self) -> None:
        self.height = 7
        self.width = 9
        self.start = (5, 1)
        self.goal = (1, 7)
        self.walls = {
            (1, 3),
            (2, 3),
            (3, 3),
            (3, 4),
            (3, 5),
            (4, 5),
            (5, 5),
        }
        self.position = self.start

    def reset(self) -> Position:
        self.position = self.start
        return self.position

    def step(self, action: int) -> StepResult:
        row_delta, col_delta = self.ACTIONS[action]
        candidate = (
            self.position[0] + row_delta,
            self.position[1] + col_delta,
        )

        hit_boundary = not (
            0 <= candidate[0] < self.height and 0 <= candidate[1] < self.width
        )
        if hit_boundary or candidate in self.walls:
            # Invalid moves leave the ball in place and teach it to avoid walls.
            reward = -3.0
        else:
            self.position = candidate
            reward = -0.1

        done = self.position == self.goal
        if done:
            reward = 10.0
        return StepResult(self.position, reward, done)

    def render(self) -> str:
        rows: list[str] = []
        for row in range(self.height):
            cells: list[str] = []
            for col in range(self.width):
                position = (row, col)
                if position == self.position:
                    cells.append("●")
                elif position == self.goal:
                    cells.append("★")
                elif position in self.walls:
                    cells.append("█")
                else:
                    cells.append("·")
            rows.append(" ".join(cells))
        return "\n".join(rows)


QTable = dict[Position, list[float]]


def choose_action(
    q_table: QTable,
    state: Position,
    epsilon: float,
    rng: random.Random,
) -> int:
    if rng.random() < epsilon:
        return rng.randrange(len(BallGame.ACTIONS))

    values = q_table.setdefault(state, [0.0] * len(BallGame.ACTIONS))
    best_value = max(values)
    best_actions = [i for i, value in enumerate(values) if value == best_value]
    return rng.choice(best_actions)


def train(
    env: BallGame,
    episodes: int,
    seed: int,
    learning_rate: float = 0.15,
    discount: float = 0.95,
    max_steps: int = 200,
) -> tuple[QTable, list[int], list[float]]:
    rng = random.Random(seed)
    q_table: QTable = {}
    steps_history: list[int] = []
    reward_history: list[float] = []

    for episode in range(episodes):
        state = env.reset()
        total_reward = 0.0
        # Exploration gradually falls from 1.0 to 0.02.
        epsilon = max(0.02, 1.0 - episode / (episodes * 0.8))

        for step_number in range(1, max_steps + 1):
            action = choose_action(q_table, state, epsilon, rng)
            result = env.step(action)

            current_values = q_table.setdefault(state, [0.0] * len(env.ACTIONS))
            next_values = q_table.setdefault(
                result.state, [0.0] * len(env.ACTIONS)
            )
            future_value = 0.0 if result.done else max(next_values)
            td_target = result.reward + discount * future_value
            current_values[action] += learning_rate * (
                td_target - current_values[action]
            )

            state = result.state
            total_reward += result.reward
            if result.done:
                break

        steps_history.append(step_number)
        reward_history.append(total_reward)

    return q_table, steps_history, reward_history


def greedy_route(
    env: BallGame, q_table: QTable, max_steps: int = 100
) -> list[Position]:
    state = env.reset()
    route = [state]
    for _ in range(max_steps):
        values = q_table.get(state, [0.0] * len(env.ACTIONS))
        action = max(range(len(values)), key=values.__getitem__)
        result = env.step(action)
        state = result.state
        route.append(state)
        if result.done:
            return route
    raise RuntimeError("The learned policy did not reach the goal. Try more episodes.")


def watch(env: BallGame, route: list[Position], delay: float) -> None:
    for index, position in enumerate(route):
        env.position = position
        print("\033[2J\033[H", end="")
        print(env.render())
        print(f"\nstep {index}/{len(route) - 1}")
        time.sleep(delay)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--episodes", type=int, default=2_000)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument(
        "--no-animation", action="store_true", help="print the route without delays"
    )
    args = parser.parse_args()

    if args.episodes <= 0:
        parser.error("--episodes must be greater than zero")

    env = BallGame()
    q_table, steps, rewards = train(env, args.episodes, args.seed)
    route = greedy_route(env, q_table)
    recent_count = min(100, len(steps))
    print(
        f"Training complete: {args.episodes} episodes | "
        f"last {recent_count} avg steps: "
        f"{statistics.mean(steps[-recent_count:]):.1f} | "
        f"avg reward: {statistics.mean(rewards[-recent_count:]):.2f}"
    )
    print(f"Greedy route length: {len(route) - 1} steps")

    if args.no_animation:
        env.position = env.goal
        print(env.render())
        print("Route:", " -> ".join(map(str, route)))
    else:
        input("Press Enter to watch the learned ball...")
        watch(env, route, delay=0.18)


if __name__ == "__main__":
    main()
