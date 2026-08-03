import unittest

from app.gate import AdmissionGate
from app.safety import AccountSafetyCircuit
from app.service import (
    InstagramAuthService,
    InstagramChallengeError,
    InstagramRateLimitedError,
)


class FakeGateway:
    def __init__(self):
        self.relationship_error = None

    def relationship(self, side, username, limit):
        if self.relationship_error:
            raise self.relationship_error
        return [{
            'username': 'one.user',
            'fullName': 'One User',
            'profilePicUrl': 'https://cdn.example/avatar.jpg',
            'isPrivate': False,
            'isVerified': False,
        }]

    def likers(self, post_urls, limit_per_post):
        return []

    def comments(self, post_urls, limit_per_post):
        return []


class InstagramAuthServiceTest(unittest.IsolatedAsyncioTestCase):
    def service(self, gateway):
        return InstagramAuthService(
            gateway=gateway,
            gate=AdmissionGate(max_in_flight=5, queue_timeout_seconds=1),
            safety=AccountSafetyCircuit(rate_limit_cooldown_seconds=900),
            run_id=lambda: '0123456789abcdef0123456789abcdef',
        )

    async def test_returns_versioned_items_without_session_state(self):
        response = await self.service(FakeGateway()).relationship(
            'followers', 'target.user', 1200
        )
        self.assertEqual(response, {
            'schemaVersion': 1,
            'runId': '0123456789abcdef0123456789abcdef',
            'accountSlot': 'primary',
            'items': [{
                'username': 'one.user',
                'fullName': 'One User',
                'profilePicUrl': 'https://cdn.example/avatar.jpg',
                'isPrivate': False,
                'isVerified': False,
            }],
        })

    async def test_rate_limit_and_challenge_open_the_circuit_before_another_call(self):
        for error_type, expected_code in [
            (InstagramRateLimitedError, 'instagram_rate_limited'),
            (InstagramChallengeError, 'instagram_challenge'),
        ]:
            gateway = FakeGateway()
            gateway.relationship_error = error_type()
            service = self.service(gateway)

            with self.assertRaises(error_type):
                await service.relationship('followers', 'target.user', 1)
            gateway.relationship_error = None
            with self.assertRaises(Exception) as caught:
                await service.relationship('followers', 'target.user', 1)
            self.assertEqual(caught.exception.code, expected_code)

    async def test_rejects_non_instagram_post_urls_before_calling_the_gateway(self):
        with self.assertRaises(ValueError):
            await self.service(FakeGateway()).likers([
                'https://example.test/p/not-an-instagram-post/',
            ], 1)


if __name__ == '__main__':
    unittest.main()
