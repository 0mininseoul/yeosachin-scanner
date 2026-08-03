import math
import time
from collections.abc import Callable


class AccountQuarantinedError(RuntimeError):
    def __init__(self, code: str, retry_after_seconds: int | None):
        super().__init__(code)
        self.code = code
        self.retry_after_seconds = retry_after_seconds


class AccountSafetyCircuit:
    def __init__(
        self,
        rate_limit_cooldown_seconds: int,
        now: Callable[[], float] = time.monotonic,
    ):
        if not 60 <= rate_limit_cooldown_seconds <= 86_400:
            raise ValueError('rate_limit_cooldown_seconds must be between 60 and 86400')
        self._cooldown_seconds = rate_limit_cooldown_seconds
        self._now = now
        self._cooldown_until = 0.0
        self._permanent_code: str | None = None

    def assert_available(self) -> None:
        if self._permanent_code is not None:
            raise AccountQuarantinedError(self._permanent_code, None)
        remaining = self._cooldown_until - self._now()
        if remaining > 0:
            raise AccountQuarantinedError(
                'instagram_rate_limited',
                max(1, math.ceil(remaining)),
            )

    def record_rate_limit(self) -> None:
        self._cooldown_until = max(
            self._cooldown_until,
            self._now() + self._cooldown_seconds,
        )

    def record_challenge(self) -> None:
        self._permanent_code = 'instagram_challenge'

    def record_authentication_failure(self) -> None:
        self._permanent_code = 'authentication_failed'
