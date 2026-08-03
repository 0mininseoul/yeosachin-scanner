import asyncio
import inspect
from collections.abc import Awaitable, Callable
from typing import TypeVar


T = TypeVar('T')


class QueueFullError(RuntimeError):
    pass


class QueueTimeoutError(RuntimeError):
    pass


class AdmissionGate:
    """Admit a bounded number of requests while serializing account operations."""

    def __init__(self, max_in_flight: int = 5, queue_timeout_seconds: float = 240):
        if not 1 <= max_in_flight <= 5:
            raise ValueError('max_in_flight must be between 1 and 5')
        if not 0 < queue_timeout_seconds <= 300:
            raise ValueError('queue_timeout_seconds must be between 0 and 300')
        self._max_in_flight = max_in_flight
        self._queue_timeout_seconds = queue_timeout_seconds
        self._admission_lock = asyncio.Lock()
        self._operation_lock = asyncio.Lock()
        self._in_flight = 0

    @property
    def in_flight(self) -> int:
        return self._in_flight

    async def _admit(self) -> None:
        async with self._admission_lock:
            if self._in_flight >= self._max_in_flight:
                raise QueueFullError('authenticated scraper queue is full')
            self._in_flight += 1

    async def _release_admission(self) -> None:
        async with self._admission_lock:
            self._in_flight -= 1

    @staticmethod
    async def _invoke(operation: Callable[[], T | Awaitable[T]]) -> T:
        result = await asyncio.to_thread(operation)
        if inspect.isawaitable(result):
            return await result
        return result

    async def run(self, operation: Callable[[], T | Awaitable[T]]) -> T:
        await self._admit()
        acquired = False
        try:
            try:
                await asyncio.wait_for(
                    self._operation_lock.acquire(),
                    timeout=self._queue_timeout_seconds,
                )
                acquired = True
            except TimeoutError as error:
                raise QueueTimeoutError('authenticated scraper queue wait timed out') from error

            operation_task = asyncio.create_task(self._invoke(operation))
            try:
                return await asyncio.shield(operation_task)
            except asyncio.CancelledError:
                # A thread cannot be cancelled. Keep its account-operation lock until
                # it completes so a disconnected caller cannot create concurrent use
                # of the single authenticated account.
                try:
                    await asyncio.shield(operation_task)
                except BaseException:
                    pass
                raise
        finally:
            if acquired:
                self._operation_lock.release()
            await self._release_admission()
