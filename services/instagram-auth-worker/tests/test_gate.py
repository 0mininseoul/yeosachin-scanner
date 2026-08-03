import asyncio
import threading
import unittest

from app.gate import AdmissionGate, QueueFullError, QueueTimeoutError


class AdmissionGateTest(unittest.IsolatedAsyncioTestCase):
    async def test_admits_five_total_but_executes_exactly_one_operation_at_a_time(self):
        gate = AdmissionGate(max_in_flight=5, queue_timeout_seconds=1)
        release = asyncio.Event()
        started = []
        running = 0
        maximum_running = 0

        async def operation(index: int):
            nonlocal running, maximum_running
            running += 1
            maximum_running = max(maximum_running, running)
            started.append(index)
            await release.wait()
            running -= 1
            return index

        tasks = [
            asyncio.create_task(gate.run(lambda index=index: operation(index)))
            for index in range(5)
        ]
        for _ in range(20):
            if started:
                break
            await asyncio.sleep(0)
        self.assertEqual(gate.in_flight, 5)
        self.assertEqual(started, [0])

        with self.assertRaises(QueueFullError):
            await gate.run(lambda: operation(99))

        release.set()
        self.assertEqual(await asyncio.gather(*tasks), [0, 1, 2, 3, 4])
        self.assertEqual(maximum_running, 1)
        self.assertEqual(gate.in_flight, 0)

    async def test_times_out_while_waiting_without_leaking_capacity(self):
        gate = AdmissionGate(max_in_flight=2, queue_timeout_seconds=0.01)
        release = asyncio.Event()
        running = asyncio.create_task(gate.run(lambda: release.wait()))
        await asyncio.sleep(0)

        with self.assertRaises(QueueTimeoutError):
            await gate.run(lambda: asyncio.sleep(0))
        self.assertEqual(gate.in_flight, 1)

        release.set()
        await running
        self.assertEqual(gate.in_flight, 0)

    async def test_cancellation_waits_for_a_started_sync_operation_before_releasing_lock(self):
        gate = AdmissionGate(max_in_flight=2, queue_timeout_seconds=1)
        release = threading.Event()
        first_started = threading.Event()
        second_started = threading.Event()

        def first_operation():
            first_started.set()
            release.wait()
            return 'first'

        first = asyncio.create_task(gate.run(first_operation))
        await asyncio.to_thread(first_started.wait)
        first.cancel()
        await asyncio.sleep(0)
        first_finished_early = first.done()

        second = asyncio.create_task(gate.run(lambda: second_started.set()))
        await asyncio.sleep(0.01)
        second_started_early = second_started.is_set()

        release.set()
        with self.assertRaises(asyncio.CancelledError):
            await first
        await second
        self.assertFalse(first_finished_early)
        self.assertFalse(second_started_early)
        self.assertTrue(second_started.is_set())


if __name__ == '__main__':
    unittest.main()
