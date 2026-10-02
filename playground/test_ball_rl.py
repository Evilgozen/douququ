import unittest

from ball_rl import BallGame, greedy_route, train


class BallRLTests(unittest.TestCase):
    def test_wall_collision_keeps_position(self) -> None:
        env = BallGame()
        env.position = (2, 2)
        result = env.step(3)  # right, into the wall at (2, 3)
        self.assertEqual(result.state, (2, 2))
        self.assertEqual(result.reward, -3.0)
        self.assertFalse(result.done)

    def test_goal_reward_finishes_episode(self) -> None:
        env = BallGame()
        env.position = (1, 6)
        result = env.step(3)
        self.assertEqual(result.state, env.goal)
        self.assertEqual(result.reward, 10.0)
        self.assertTrue(result.done)

    def test_training_learns_route(self) -> None:
        env = BallGame()
        q_table, _, _ = train(env, episodes=2_000, seed=7)
        route = greedy_route(env, q_table)
        self.assertEqual(route[0], env.start)
        self.assertEqual(route[-1], env.goal)
        self.assertLessEqual(len(route) - 1, 20)


if __name__ == "__main__":
    unittest.main()
