import math
import time
from collections.abc import Callable

from .durable import DurableStore, DurableStoreConflict, DurableStoreError, InMemoryDurableStore


class AccountQuarantinedError(RuntimeError):
    def __init__(self, code: str, retry_after_seconds: int | None):
        super().__init__(code)
        self.code = code
        self.retry_after_seconds = retry_after_seconds


class SafetyStateUnavailableError(RuntimeError):
    pass


class AccountSafetyCircuit:
    def __init__(
        self,
        rate_limit_cooldown_seconds: int,
        store: DurableStore | None = None,
        now: Callable[[], float] = time.time,
    ):
        if not 60 <= rate_limit_cooldown_seconds <= 86_400:
            raise ValueError('rate_limit_cooldown_seconds must be between 60 and 86400')
        self._cooldown_seconds = rate_limit_cooldown_seconds
        self._now = now
        self._store = store or InMemoryDurableStore()
        self._key = 'safety/account-primary'

    def assert_available(self) -> None:
        state = self._read_state()
        permanent_code = state.get('permanentCode')
        if permanent_code is not None:
            if permanent_code not in {'instagram_challenge', 'authentication_failed'}:
                raise SafetyStateUnavailableError('invalid permanent safety state')
            raise AccountQuarantinedError(permanent_code, None)
        cooldown_until = state.get('cooldownUntil', 0)
        if not isinstance(cooldown_until, (int, float)):
            raise SafetyStateUnavailableError('invalid cooldown safety state')
        remaining = cooldown_until - self._now()
        if remaining > 0:
            raise AccountQuarantinedError(
                'instagram_rate_limited',
                max(1, math.ceil(remaining)),
            )

    def record_rate_limit(self) -> None:
        self._update(lambda state: {
            **state,
            'cooldownUntil': max(
                state.get('cooldownUntil', 0), self._now() + self._cooldown_seconds,
            ),
        })

    def record_challenge(self) -> None:
        self._set_permanent('instagram_challenge')

    def record_authentication_failure(self) -> None:
        self._set_permanent('authentication_failed')

    def rate_limit_retry_after_seconds(self) -> int:
        try:
            self.assert_available()
        except AccountQuarantinedError as error:
            if error.code == 'instagram_rate_limited' and error.retry_after_seconds is not None:
                return error.retry_after_seconds
            raise SafetyStateUnavailableError('rate-limit state was not recorded') from error
        raise SafetyStateUnavailableError('rate-limit state was not recorded')

    def _set_permanent(self, code: str) -> None:
        self._update(lambda state: {**state, 'permanentCode': code})

    def _read_state(self) -> dict:
        try:
            record = self._store.read(self._key)
            return record.value if record is not None else {}
        except DurableStoreError as error:
            raise SafetyStateUnavailableError('unable to read durable safety state') from error

    def _update(self, mutate: Callable[[dict], dict]) -> None:
        for _ in range(5):
            try:
                record = self._store.read(self._key)
                state = record.value if record is not None else {}
                updated = mutate(state)
                if record is None:
                    if self._store.create_if_absent(self._key, updated) is not None:
                        return
                else:
                    self._store.replace(record, updated)
                    return
            except DurableStoreConflict:
                continue
            except DurableStoreError as error:
                raise SafetyStateUnavailableError('unable to write durable safety state') from error
        raise SafetyStateUnavailableError('unable to atomically update durable safety state')
