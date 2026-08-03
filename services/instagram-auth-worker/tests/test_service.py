import unittest

from app.gate import AdmissionGate
from app.safety import AccountSafetyCircuit
from app.service import (
    InstagramAuthService,
    InstagramChallengeError,
    InstagramRateLimitedError,
    WorkerSchemaError,
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

    def profile(self, username, media_limit):
        self.profile_args = (username, media_limit)
        return {
            'username': username,
            'followersCount': 12,
            'followingCount': 3,
            'postsCount': 0,
            'isPrivate': False,
            'isVerified': False,
            'latestPosts': [],
        }

    def profiles(self, usernames, media_limit):
        self.profiles_args = (usernames, media_limit)
        return [{'username': username, 'status': 'not_found'} for username in usernames]


class InstagramAuthServiceTest(unittest.IsolatedAsyncioTestCase):
    OPERATION_KEY = 'operation-key-001'
    INPUT_HASH = 'a' * 64
    def service(self, gateway):
        return InstagramAuthService(
            gateway=gateway,
            gate=AdmissionGate(max_in_flight=5, queue_timeout_seconds=1),
            safety=AccountSafetyCircuit(rate_limit_cooldown_seconds=900),
            run_id=lambda: '0123456789abcdef0123456789abcdef',
        )

    async def test_returns_versioned_items_without_session_state(self):
        response = await self.service(FakeGateway()).relationship(
            'followers', 'target.user', 1200, self.OPERATION_KEY, self.INPUT_HASH
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
                await service.relationship(
                    'followers', 'target.user', 1, 'operation-key-002', 'b' * 64
                )
            gateway.relationship_error = None
            with self.assertRaises(Exception) as caught:
                await service.relationship(
                    'followers', 'target.user', 1, self.OPERATION_KEY, self.INPUT_HASH
                )
            self.assertEqual(caught.exception.code, expected_code)

    async def test_rejects_non_instagram_post_urls_before_calling_the_gateway(self):
        with self.assertRaises(ValueError):
            await self.service(FakeGateway()).likers([
                'https://example.test/p/not-an-instagram-post/',
            ], 1, self.OPERATION_KEY, self.INPUT_HASH)

    async def test_profile_uses_the_durable_execution_path_with_a_bounded_media_limit(self):
        gateway = FakeGateway()
        response = await self.service(gateway).profile(
            'Target.User', 10, self.OPERATION_KEY, self.INPUT_HASH,
        )
        self.assertEqual(gateway.profile_args, ('target.user', 10))
        self.assertEqual(response['items'], [{
            'username': 'target.user',
            'followersCount': 12,
            'followingCount': 3,
            'postsCount': 0,
            'isPrivate': False,
            'isVerified': False,
            'latestPosts': [],
        }])
        with self.assertRaises(ValueError):
            await self.service(FakeGateway()).profile(
                'target.user', 11, 'operation-key-003', 'c' * 64,
            )

    async def test_profile_allows_zero_media_limit_for_summary_only_requests(self):
        gateway = FakeGateway()
        await self.service(gateway).profile(
            'target.user', 0, 'operation-key-003a', 'c' * 64,
        )
        self.assertEqual(gateway.profile_args, ('target.user', 0))

    async def test_profile_batch_normalizes_usernames_and_keeps_not_found_rows(self):
        gateway = FakeGateway()
        response = await self.service(gateway).profiles(
            ['Target.User', 'missing.user'], 1, 'operation-key-004', 'd' * 64,
        )
        self.assertEqual(gateway.profiles_args, (['target.user', 'missing.user'], 1))
        self.assertEqual(response['items'], [
            {'username': 'target.user', 'status': 'not_found'},
            {'username': 'missing.user', 'status': 'not_found'},
        ])
        with self.assertRaises(ValueError):
            await self.service(FakeGateway()).profiles(
                ['target.user', 'target.user'], 1, 'operation-key-005', 'e' * 64,
            )

    async def test_profile_response_over_the_durable_limit_fails_closed_before_caching(self):
        class OversizedGateway(FakeGateway):
            def profile(self, username, media_limit):
                return {'username': username, 'payload': 'x' * (4 * 1024 * 1024)}

        with self.assertRaises(WorkerSchemaError):
            await self.service(OversizedGateway()).profile(
                'target.user', 1, 'operation-key-006', 'f' * 64,
            )


if __name__ == '__main__':
    unittest.main()
