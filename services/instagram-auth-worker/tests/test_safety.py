import unittest

from app.safety import AccountQuarantinedError, AccountSafetyCircuit


class AccountSafetyCircuitTest(unittest.TestCase):
    def test_rate_limit_opens_a_timed_cooldown(self):
        clock = [100.0]
        circuit = AccountSafetyCircuit(
            rate_limit_cooldown_seconds=900,
            now=lambda: clock[0],
        )

        circuit.record_rate_limit()
        with self.assertRaises(AccountQuarantinedError) as caught:
            circuit.assert_available()
        self.assertEqual(caught.exception.code, 'instagram_rate_limited')
        self.assertEqual(caught.exception.retry_after_seconds, 900)

        clock[0] = 1_001.0
        circuit.assert_available()

    def test_challenge_quarantines_until_an_operator_restarts_with_a_valid_session(self):
        circuit = AccountSafetyCircuit(rate_limit_cooldown_seconds=900)
        circuit.record_challenge()

        with self.assertRaises(AccountQuarantinedError) as caught:
            circuit.assert_available()
        self.assertEqual(caught.exception.code, 'instagram_challenge')
        self.assertIsNone(caught.exception.retry_after_seconds)


if __name__ == '__main__':
    unittest.main()
