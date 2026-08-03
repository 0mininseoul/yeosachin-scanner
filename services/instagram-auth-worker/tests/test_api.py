import unittest

from fastapi.testclient import TestClient

from app.gate import QueueFullError, QueueTimeoutError
from app.main import create_app
from app.safety import AccountQuarantinedError
from app.service import InstagramChallengeError, InstagramRateLimitedError


class FakeService:
    def __init__(self, error=None):
        self.error = error

    async def relationship(self, side, username, limit):
        if self.error:
            raise self.error
        return {
            'schemaVersion': 1,
            'runId': '0123456789abcdef0123456789abcdef',
            'accountSlot': 'primary',
            'items': [],
        }

    async def likers(self, post_urls, limit_per_post):
        return await self.relationship('likers', 'unused', limit_per_post)

    async def comments(self, post_urls, limit_per_post):
        return await self.relationship('comments', 'unused', limit_per_post)


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
            json={'username': 'target.user', 'limit': 1},
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
        ]
        for error, status, code, retryable in cases:
            with self.subTest(code=code, status=status):
                client = TestClient(create_app(FakeService(error)))
                response = client.post('/v1/relationships/following', json={
                    'username': 'target.user',
                    'limit': 1,
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
        })
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json(), {
            'schemaVersion': 1,
            'code': 'upstream_error',
            'retryable': True,
        })


if __name__ == '__main__':
    unittest.main()
