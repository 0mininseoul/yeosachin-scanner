import re
import secrets
from collections.abc import Callable
from typing import Any, Protocol
from urllib.parse import urlsplit

from .durable import (
    DurableRecord,
    DurableStore,
    DurableStoreConflict,
    DurableStoreError,
    InMemoryDurableStore,
)
from .gate import AdmissionGate
from .safety import AccountSafetyCircuit


USERNAME_PATTERN = re.compile(r'^[a-z0-9._]{1,30}$')
POST_SHORTCODE_PATTERN = re.compile(r'^[A-Za-z0-9_-]+$')


class InstagramRateLimitedError(RuntimeError):
    pass


class InstagramChallengeError(RuntimeError):
    pass


class InstagramAuthenticationError(RuntimeError):
    pass


class IdempotencyPendingError(RuntimeError):
    pass


class IdempotencyConflictError(RuntimeError):
    pass


def normalize_post_urls(post_urls: list[str]) -> list[str]:
    if not isinstance(post_urls, list) or not 1 <= len(post_urls) <= 10:
        raise ValueError('invalid post URLs')

    normalized: list[str] = []
    for raw in post_urls:
        if not isinstance(raw, str):
            raise ValueError('invalid post URL')
        try:
            parsed = urlsplit(raw)
        except ValueError as error:
            raise ValueError('invalid post URL') from error
        parts = [part for part in parsed.path.split('/') if part]
        host = (parsed.hostname or '').lower()
        if (
            parsed.scheme != 'https'
            or host not in {'instagram.com', 'www.instagram.com'}
            or parsed.username is not None
            or parsed.password is not None
            or len(parts) != 2
            or parts[0] not in {'p', 'reel', 'reels'}
            or not POST_SHORTCODE_PATTERN.fullmatch(parts[1])
        ):
            raise ValueError('invalid post URL')
        kind = 'p' if parts[0] == 'p' else 'reel'
        normalized.append(f'https://www.instagram.com/{kind}/{parts[1]}/')

    if len(set(normalized)) != len(normalized):
        raise ValueError('duplicate post URL')
    return normalized


def validate_interaction_limit(limit_per_post: int, maximum: int) -> int:
    if (
        not isinstance(limit_per_post, int)
        or isinstance(limit_per_post, bool)
        or not 1 <= limit_per_post <= maximum
    ):
        raise ValueError('invalid interaction limit')
    return limit_per_post


class InstagramGateway(Protocol):
    def relationship(self, side: str, username: str, limit: int) -> list[dict[str, Any]]: ...
    def likers(self, post_urls: list[str], limit_per_post: int) -> list[dict[str, Any]]: ...
    def comments(self, post_urls: list[str], limit_per_post: int) -> list[dict[str, Any]]: ...


class InstagramAuthService:
    def __init__(
        self,
        gateway: InstagramGateway,
        gate: AdmissionGate,
        safety: AccountSafetyCircuit,
        ledger_store: DurableStore | None = None,
        run_id: Callable[[], str] = lambda: secrets.token_hex(16),
    ):
        self._gateway = gateway
        self._gate = gate
        self._safety = safety
        self._ledger_store = ledger_store or InMemoryDurableStore()
        self._run_id = run_id

    def _operation_key(self, operation_key: str) -> str:
        return f'operations/{operation_key}'

    def _existing_response(self, operation_key: str, input_hash: str) -> dict[str, Any] | None:
        record = self._ledger_store.read(self._operation_key(operation_key))
        if record is None:
            return None
        if record.value.get('inputHash') != input_hash:
            raise IdempotencyConflictError('operation key was reused with different input')
        if record.value.get('state') == 'completed':
            response = record.value.get('response')
            if isinstance(response, dict):
                return response
        # Pending also covers an interrupted/malformed completion. Retrying it could
        # duplicate the upstream Instagram mutation/read side effect.
        raise IdempotencyPendingError('operation outcome is ambiguous')

    def _reserve(self, operation_key: str, input_hash: str) -> DurableRecord | dict[str, Any]:
        key = self._operation_key(operation_key)
        reservation = self._ledger_store.create_if_absent(key, {
            'state': 'pending',
            'inputHash': input_hash,
        })
        if reservation is not None:
            return reservation
        cached = self._existing_response(operation_key, input_hash)
        if cached is not None:
            return cached
        raise IdempotencyPendingError('operation outcome is ambiguous')

    def _complete(self, reservation: DurableRecord, response: dict[str, Any]) -> None:
        try:
            self._ledger_store.replace(reservation, {
                'state': 'completed',
                'inputHash': reservation.value['inputHash'],
                'response': response,
            })
        except (DurableStoreConflict, DurableStoreError) as error:
            raise IdempotencyPendingError('operation outcome is ambiguous') from error

    async def _run(
        self,
        operation: Callable[[], list[dict[str, Any]]],
        operation_key: str,
        input_hash: str,
    ) -> dict[str, Any]:
        cached = self._existing_response(operation_key, input_hash)
        if cached is not None:
            return cached
        self._safety.assert_available()

        def guarded_operation() -> dict[str, Any]:
            self._safety.assert_available()
            reservation = self._reserve(operation_key, input_hash)
            if isinstance(reservation, dict):
                return reservation
            try:
                items = operation()
            except InstagramRateLimitedError:
                self._safety.record_rate_limit()
                # The HTTP contract must reflect the configured/remaining durable
                # cooldown, not a hard-coded default.
                error = InstagramRateLimitedError()
                error.retry_after_seconds = self._safety.rate_limit_retry_after_seconds()
                raise error
            except InstagramChallengeError:
                self._safety.record_challenge()
                raise
            except InstagramAuthenticationError:
                self._safety.record_authentication_failure()
                raise
            response = {
                'schemaVersion': 1,
                'runId': self._run_id(),
                'accountSlot': 'primary',
                'items': items,
            }
            self._complete(reservation, response)
            return response

        return await self._gate.run(guarded_operation)

    async def relationship(
        self, side: str, username: str, limit: int, operation_key: str, input_hash: str
    ) -> dict[str, Any]:
        normalized = username.strip().removeprefix('@').lower()
        if side not in {'followers', 'following'}:
            raise ValueError('invalid relationship side')
        if not USERNAME_PATTERN.fullmatch(normalized):
            raise ValueError('invalid username')
        if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1_200:
            raise ValueError('invalid relationship limit')
        return await self._run(
            lambda: self._gateway.relationship(side, normalized, limit), operation_key, input_hash
        )

    async def likers(
        self, post_urls: list[str], limit_per_post: int, operation_key: str, input_hash: str
    ) -> dict[str, Any]:
        normalized_post_urls = normalize_post_urls(post_urls)
        validated_limit = validate_interaction_limit(limit_per_post, 150)
        return await self._run(
            lambda: self._gateway.likers(normalized_post_urls, validated_limit), operation_key, input_hash
        )

    async def comments(
        self, post_urls: list[str], limit_per_post: int, operation_key: str, input_hash: str
    ) -> dict[str, Any]:
        normalized_post_urls = normalize_post_urls(post_urls)
        validated_limit = validate_interaction_limit(limit_per_post, 15)
        return await self._run(
            lambda: self._gateway.comments(normalized_post_urls, validated_limit), operation_key, input_hash
        )
