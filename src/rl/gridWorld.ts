export type GridPosition = { row: number; col: number };

export interface GridStep {
  state: number;
  reward: number;
  done: boolean;
  hitWall: boolean;
}

export const GRID_ROWS = 7;
export const GRID_COLS = 9;
export const GRID_START: GridPosition = { row: 5, col: 1 };
export const GRID_GOAL: GridPosition = { row: 1, col: 7 };
export const GRID_WALLS = new Set([
  '1,3', '2,3', '3,3', '3,4', '3,5', '4,5', '5,5',
]);

export const ACTIONS = [
  { row: -1, col: 0, label: '上' },
  { row: 1, col: 0, label: '下' },
  { row: 0, col: -1, label: '左' },
  { row: 0, col: 1, label: '右' },
] as const;

export class GridWorld {
  position: GridPosition = { ...GRID_START };

  reset(): number {
    this.position = { ...GRID_START };
    return this.state;
  }

  get state(): number {
    return this.position.row * GRID_COLS + this.position.col;
  }

  step(action: number): GridStep {
    const move = ACTIONS[action] ?? ACTIONS[0];
    const next = {
      row: this.position.row + move.row,
      col: this.position.col + move.col,
    };
    const outside = next.row < 0 || next.row >= GRID_ROWS || next.col < 0 || next.col >= GRID_COLS;
    const hitWall = outside || GRID_WALLS.has(`${next.row},${next.col}`);
    if (!hitWall) this.position = next;

    const done = this.position.row === GRID_GOAL.row && this.position.col === GRID_GOAL.col;
    return {
      state: this.state,
      reward: done ? 10 : hitWall ? -3 : -0.1,
      done,
      hitWall,
    };
  }
}

export interface QLearningOptions {
  learningRate: number;
  discount: number;
  epsilon: number;
}

export class QLearningAgent {
  readonly q = Array.from({ length: GRID_ROWS * GRID_COLS }, () => new Float64Array(ACTIONS.length));

  choose(state: number, epsilon: number): number {
    if (Math.random() < epsilon) return Math.floor(Math.random() * ACTIONS.length);
    return this.bestAction(state, true);
  }

  bestAction(state: number, randomTies = false): number {
    const values = this.q[state];
    let best = -Infinity;
    let choices: number[] = [];
    for (let action = 0; action < values.length; action++) {
      if (values[action] > best) {
        best = values[action];
        choices = [action];
      } else if (values[action] === best) choices.push(action);
    }
    return randomTies ? choices[Math.floor(Math.random() * choices.length)] : choices[0];
  }

  learn(state: number, action: number, reward: number, nextState: number, done: boolean, options: QLearningOptions): void {
    const current = this.q[state][action];
    const future = done ? 0 : Math.max(...this.q[nextState]);
    const target = reward + options.discount * future;
    this.q[state][action] = current + options.learningRate * (target - current);
  }

  clear(): void {
    for (const row of this.q) row.fill(0);
  }
}
