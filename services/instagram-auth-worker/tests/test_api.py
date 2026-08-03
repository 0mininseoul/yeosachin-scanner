import unittest

from fastapi.testclient import TestClient

from app.gate import QueueFullError, QueueTimeoutError
from app.main import create_app
from app.safety import AccountQuarantinedError
from app.durable import AccountOperationLockedError
from app.service import (
    InstagramChallengeError,
    InstagramRateLimitedError,
    WorkerSchemaError,
)


class FakeService:
    def __init__(self, error=None):
        self.error = error

    async def relationship(self, side, username, limit, operation_key, input_hash):
        if self.error:
            raise self.error
        return {
            'schemaVersion': 1,
            'runId': '0123456789abcdef0123456789abcdef',
            'accountSlot': 'primary',
            'items': [],
        }

    async def likers(self, post_urls, limit_per_post, operation_key, input_hash):
        return await self.relationship('likers', 'unused', limit_per_post, operation_key, input_hash)

    async def comments(self, post_urls, limit_per_post, operation_key, input_hash):
        return await self.relationship('comments', 'unused', limit_per_post, operation_key, input_hash)

    async def profile(self, username, media_limit, operation_key, input_hash):
        if self.error:
            raise self.error
        return {
            'schemaVersion': 1,
            'runId': '0123456789abcdef0123456789abcdef',
            'accountSlot': 'primary',
            'items': [{
                'username': username,
                'followersCount': 12,
                'followingCount': 3,
                'postsCount': 1,
                'isPrivate': False,
                'isVerified': False,
                'latestPosts': [],
            }],
        }

    async def profiles(self, usernames, media_limit, operation_key, input_hash):
        return {
            'schemaVersion': 1,
            'runId': '0123456789abcdef0123456789abcdef',
            'accountSlot': 'primary',
            'items': [
                {'username': username, 'status': 'not_found'}
                for username in usernames
            ],
        }


VALID_OPERATION = {
    'operationKey': f"relationship-followers:{'a' * 64}",
    'inputHash': 'a' * 64,
}


class WorkerApiTest(unittest.TestCase):
    def test_local_bearer_mode_is_explicit_and_health_never_discloses_account_state(self):
        client = TestClient(create_app(FakeService(), local_bearer_token='x' * 32))
        self.assertEqual(client.get('/healthz').json(), {
            'schemaVersion': 1,
            'status': 'ok',
        })
        unauthorized = client.post('/v1/relationships/followers', json={
            'username': 'target.user',
            'limit': 1,
            **VALID_OPERATION,
        })
        self.assertEqual(unauthorized.status_code, 401)
        self.assertEqual(unauthorized.json(), {
            'schemaVersion': 1,
            'code': 'authentication_failed',
            'retryable': False,
        })

        authorized = client.post(
            '/v1/relationships/followers',
            headers={'authorization': f"Bearer {'x' * 32}"},
            json={'username': 'target.user', 'limit': 1, **VALID_OPERATION},
        )
        self.assertEqual(authorized.status_code, 200)

    def test_maps_queue_and_account_safety_errors_to_the_strict_node_contract(self):
        cases = [
            (QueueFullError(), 429, 'queue_full', True),
            (QueueTimeoutError(), 503, 'queue_timeout', True),
            (AccountQuarantinedError('instagram_rate_limited', 900), 423,
             'instagram_rate_limited', False),
            (InstagramRateLimitedError(), 429, 'instagram_rate_limited', True),
            (InstagramChallengeError(), 423, 'instagram_challenge', False),
            (AccountOperationLockedError(), 423, 'account_operation_locked', False),
            (WorkerSchemaError(), 502, 'worker_schema_error', False),
        ]
        for error, status, code, retryable in cases:
            with self.subTest(code=code, status=status):
                client = TestClient(create_app(FakeService(error)))
                response = client.post('/v1/relationships/following', json={
                    'username': 'target.user',
                    'limit': 1,
                    **VALID_OPERATION,
                })
                self.assertEqual(response.status_code, status)
                self.assertEqual(response.json()['code'], code)
                self.assertEqual(response.json()['retryable'], retryable)
                self.assertNotIn('detail', response.json())

    def test_replaces_framework_validation_details_with_a_sanitized_error(self):
        client = TestClient(create_app(FakeService()))
        response = client.post('/v1/relationships/followers', json={
            'username': 'INVALID USERNAME',
            'limit': 1,
            'sessionid': 'must-not-be-accepted',
            **VALID_OPERATION,
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {
            'schemaVersion': 1,
            'code': 'invalid_request',
            'retryable': False,
        })

    def test_sanitizes_unexpected_upstream_errors_to_the_worker_contract(self):
        client = TestClient(
            create_app(FakeService(RuntimeError('internal session detail'))),
            raise_server_exceptions=False,
        )
        response = client.post('/v1/relationships/followers', json={
            'username': 'target.user',
            'limit': 1,
            **VALID_OPERATION,
        })
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {
            'schemaVersion': 1,
            'code': 'upstream_error',
            'retryable': True,
        })

    def test_requires_stable_operation_key_and_sha256_input_hash(self):
        client = TestClient(create_app(FakeService()))
        response = client.post('/v1/relationships/followers', json={
            'username': 'target.user',
            'limit': 1,
            'operationKey': 'short',
            'inputHash': 'not-a-hash',
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {
            'schemaVersion': 1,
            'code': 'invalid_request',
            'retryable': False,
        })

    def test_profile_endpoint_requires_a_strict_single_target_contract(self):
        client = TestClient(create_app(FakeService()))
        response = client.post('/v1/profiles/profile', json={
            'username': 'target.user',
            'mediaLimit': 10,
            **VALID_OPERATION,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['items'][0]['username'], 'target.user')

        invalid = client.post('/v1/profiles/profile', json={
            'username': 'target.user',
            'mediaLimit': 11,
            'batchUsernames': ['other.user'],
            **VALID_OPERATION,
        })
        self.assertEqual(invalid.status_code, 400)
        self.assertEqual(invalid.json(), {
            'schemaVersion': 1,
            'code': 'invalid_request',
            'retryable': False,
        })

    def test_profile_endpoints_accept_zero_media_limit_for_summary_only_requests(self):
        client = TestClient(create_app(FakeService()))
        response = client.post('/v1/profiles/profile', json={
            'username': 'target.user',
            'mediaLimit': 0,
            **VALID_OPERATION,
        })
        self.assertEqual(response.status_code, 200)

        batch = client.post('/v1/profiles', json={
            'usernames': ['target.user'],
            'mediaLimit': 0,
            **VALID_OPERATION,
        })
        self.assertEqual(batch.status_code, 200)

    def test_profile_batch_returns_explicit_not_found_rows_and_rejects_duplicates(self):
        client = TestClient(create_app(FakeService()))
        response = client.post('/v1/profiles', json={
            'usernames': ['missing.user', 'other.user'],
            'mediaLimit': 1,
            **VALID_OPERATION,
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['items'], [
            {'username': 'missing.user', 'status': 'not_found'},
            {'username': 'other.user', 'status': 'not_found'},
        ])

        duplicate = client.post('/v1/profiles', json={
            'usernames': ['other.user', 'other.user'],
            'mediaLimit': 1,
            **VALID_OPERATION,
        })
        self.assertEqual(duplicate.status_code, 400)


if __name__ == '__main__':
    unittest.main()
