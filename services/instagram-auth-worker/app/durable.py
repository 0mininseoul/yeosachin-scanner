"""Small strongly-consistent record store for idempotency and account safety."""

import copy
import json
import threading
from dataclasses import dataclass
from typing import Any, Protocol


class DurableStoreError(RuntimeError):
    """The durable state could not be read or written safely."""


class DurableStoreConflict(DurableStoreError):
    pass


@dataclass(frozen=True)
class DurableRecord:
    key: str
    value: dict[str, Any]
    version: str


class DurableStore(Protocol):
    def read(self, key: str) -> DurableRecord | None: ...
    def create_if_absent(self, key: str, value: dict[str, Any]) -> DurableRecord | None: ...
    def replace(self, record: DurableRecord, value: dict[str, Any]) -> DurableRecord: ...


class InMemoryDurableStore:
    """Test/local-only store. Production must use GcsDurableStore."""

    def __init__(self):
        self._records: dict[str, tuple[dict[str, Any], int]] = {}
        self._lock = threading.Lock()

    @staticmethod
    def _record(key: str, value: dict[str, Any], version: int) -> DurableRecord:
        return DurableRecord(key, copy.deepcopy(value), str(version))

    def read(self, key: str) -> DurableRecord | None:
        with self._lock:
            found = self._records.get(key)
            return self._record(key, *found) if found is not None else None

    def create_if_absent(self, key: str, value: dict[str, Any]) -> DurableRecord | None:
        with self._lock:
            if key in self._records:
                return None
            self._records[key] = (copy.deepcopy(value), 1)
            return self._record(key, *self._records[key])

    def replace(self, record: DurableRecord, value: dict[str, Any]) -> DurableRecord:
        with self._lock:
            found = self._records.get(record.key)
            if found is None or str(found[1]) != record.version:
                raise DurableStoreConflict('record changed before replace')
            replacement = (copy.deepcopy(value), found[1] + 1)
            self._records[record.key] = replacement
            return self._record(record.key, *replacement)


class GcsDurableStore:
    """GCS-backed records using generation preconditions for atomic updates."""

    def __init__(self, bucket_name: str, prefix: str = 'instagram-auth-worker'):
        if not bucket_name or not prefix.strip('/'):
            raise ValueError('durable GCS bucket and prefix are required')
        try:
            from google.cloud import storage
        except ImportError as error:
            raise DurableStoreError('google-cloud-storage is required') from error
        self._bucket = storage.Client().bucket(bucket_name)
        self._prefix = prefix.strip('/')

    def _blob_name(self, key: str) -> str:
        return f'{self._prefix}/{key}.json'

    @staticmethod
    def _serialize(value: dict[str, Any]) -> str:
        return json.dumps(value, separators=(',', ':'), sort_keys=True)

    def read(self, key: str) -> DurableRecord | None:
        try:
            blob = self._bucket.get_blob(self._blob_name(key))
            if blob is None:
                return None
            raw = blob.download_as_bytes()
            if blob.generation is None:
                raise DurableStoreError('durable record lacks generation')
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise DurableStoreError('durable record is malformed')
            return DurableRecord(key, parsed, str(blob.generation))
        except DurableStoreError:
            raise
        except Exception as error:
            raise DurableStoreError('durable record read failed') from error

    def create_if_absent(self, key: str, value: dict[str, Any]) -> DurableRecord | None:
        try:
            blob = self._bucket.blob(self._blob_name(key))
            blob.upload_from_string(
                self._serialize(value),
                content_type='application/json',
                if_generation_match=0,
            )
            if blob.generation is None:
                blob.reload()
            return DurableRecord(key, copy.deepcopy(value), str(blob.generation))
        except Exception as error:
            if self._is_precondition_failed(error):
                return None
            raise DurableStoreError('durable record create failed') from error

    def replace(self, record: DurableRecord, value: dict[str, Any]) -> DurableRecord:
        try:
            blob = self._bucket.blob(self._blob_name(record.key))
            blob.upload_from_string(
                self._serialize(value),
                content_type='application/json',
                if_generation_match=int(record.version),
            )
            if blob.generation is None:
                blob.reload()
            return DurableRecord(record.key, copy.deepcopy(value), str(blob.generation))
        except Exception as error:
            if self._is_precondition_failed(error):
                raise DurableStoreConflict('record changed before replace') from error
            raise DurableStoreError('durable record replace failed') from error

    @staticmethod
    def _is_precondition_failed(error: Exception) -> bool:
        # Avoid importing cloud exceptions at module import time, so local unit tests
        # do not require cloud credentials or a GCS client.
        return error.__class__.__name__ == 'PreconditionFailed'
