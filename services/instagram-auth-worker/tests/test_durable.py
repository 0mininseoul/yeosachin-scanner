import unittest

from app.durable import DurableStoreError, InMemoryDurableStore
from app.gate import AdmissionGate
from app.safety import AccountSafetyCircuit
from app.service import (
    IdempotencyPendingError,
    InstagramAuthService,
    InstagramChallengeError,
    InstagramRateLimitedError,
)


class CountingGateway:
    def __init__(self):
        self.calls = 0
        self.rate_limited = False

    def relationship(self, side, username, limit):
        self.calls += 1
        if self.rate_limited:
            raise InstagramRateLimitedError()
        return [{'username': username}]

    def likers(self, post_urls, limit_per_post):
        return []

    def comments(self, post_urls, limit_per_post):
        return []


class DurableWorkerTest(unittest.IsolatedAsyncioTestCase):
    def make_service(self, gateway, store, cooldown=123, clock=None):
        return InstagramAuthService(
            gateway=gateway,
            gate=AdmissionGate(max_in_flight=5, queue_timeout_seconds=1),
            safety=AccountSafetyCircuit(
                rate_limit_cooldown_seconds=cooldown,
                store=store,
                now=clock or (lambda: 1_000.0),
            ),
            ledger_store=store,
            run_id=lambda: '0123456789abcdef0123456789abcdef',
        )

    async def test_completed_operation_replays_the_exact_cached_response(self):
        store = InMemoryDurableStore()
        gateway = CountingGateway()
        service = self.make_service(gateway, store)
        first = await service.relationship(
            'followers', 'target.user', 1, 'operation-one', 'a' * 64,
        )
        replay = await service.relationship(
            'followers', 'target.user', 1, 'operation-one', 'a' * 64,
        )

        self.assertEqual(replay, first)
        self.assertEqual(gateway.calls, 1)

    async def test_pending_reservation_fails_closed_without_a_gateway_call(self):
        store = InMemoryDurableStore()
        self.assertIsNotNone(store.create_if_absent('operations/operation-one', {
            'state': 'pending', 'inputHash': 'a' * 64,
        }))
        gateway = CountingGateway()

        with self.assertRaises(IdempotencyPendingError):
            await self.make_service(gateway, store).relationship(
                'followers', 'target.user', 1, 'operation-one', 'a' * 64,
            )
        self.assertEqual(gateway.calls, 0)

    async def test_completion_write_failure_becomes_ambiguous_without_a_retry_call(self):
        class CompletionFailureStore(InMemoryDurableStore):
            def replace(self, record, value):
                raise DurableStoreError('simulated completion outage')

        store = CompletionFailureStore()
        gateway = CountingGateway()
        service = self.make_service(gateway, store)
        with self.assertRaises(IdempotencyPendingError):
            await service.relationship(
                'followers', 'target.user', 1, 'operation-one', 'a' * 64,
            )
        with self.assertRaises(IdempotencyPendingError):
            await service.relationship(
                'followers', 'target.user', 1, 'operation-one', 'a' * 64,
            )
        self.assertEqual(gateway.calls, 1)

    async def test_rate_limit_circuit_is_durable_across_service_instances(self):
        store = InMemoryDurableStore()
        gateway = CountingGateway()
        gateway.rate_limited = True
        first = self.make_service(gateway, store, cooldown=123)
        with self.assertRaises(InstagramRateLimitedError) as caught_rate_limit:
            await first.relationship(
                'followers', 'target.user', 1, 'operation-one', 'a' * 64,
            )
        self.assertEqual(caught_rate_limit.exception.retry_after_seconds, 123)

        with self.assertRaises(Exception) as caught:
            await self.make_service(gateway, store, cooldown=123).relationship(
                'followers', 'target.user', 1, 'operation-two', 'b' * 64,
            )
        self.assertEqual(caught.exception.code, 'instagram_rate_limited')
        self.assertEqual(caught.exception.retry_after_seconds, 123)
        self.assertEqual(gateway.calls, 1)

    async def test_challenge_quarantine_is_durable_across_service_instances(self):
        store = InMemoryDurableStore()
        gateway = CountingGateway()

        class ChallengeGateway(CountingGateway):
            def relationship(self, side, username, limit):
                self.calls += 1
                raise InstagramChallengeError()

        challenged = ChallengeGateway()
        with self.assertRaises(InstagramChallengeError):
            await self.make_service(challenged, store).relationship(
                'followers', 'target.user', 1, 'operation-one', 'a' * 64,
            )
        with self.assertRaises(Exception) as caught:
            await self.make_service(gateway, store).relationship(
                'followers', 'target.user', 1, 'operation-two', 'b' * 64,
            )
        self.assertEqual(caught.exception.code, 'instagram_challenge')
        self.assertEqual(gateway.calls, 0)
