import assert from 'node:assert/strict';
import { createTrainDemo, DEMO_DT, pointOnTrack, stepTrainDemo } from '../src/core/trainDemo';

function play() {
  const st = createTrainDemo();
  for (let i = 0; i < 45 / DEMO_DT; i++) stepTrainDemo(st);
  return {
    hp: [st.conductor.hp, st.vampire.hp],
    hits: st.hits,
    points: st.track.length,
    train: pointOnTrack(st.track, st.trainS),
  };
}

const a = play();
assert.deepEqual(a, play(), '同样初始状态必须逐步重放一致');
assert(a.points > 100, '列车长应留下轨道');
assert(a.hits > 0, '列车应经过对手并命中');
assert(a.train, '列车头应位于轨道上');
console.log('列车轨迹与命中重放检查通过', { hits: a.hits, points: a.points });
