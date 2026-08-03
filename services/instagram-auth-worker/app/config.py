import base64
import binascii
import json
import os
from dataclasses import dataclass
from typing import Any, Mapping


def _bounded_integer(
    env: Mapping[str, str], key: str, default: int, minimum: int, maximum: int
) -> int:
    raw = env.get(key)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise ValueError(f'{key} must be an integer') from error
    if not minimum <= value <= maximum or str(value) != raw:
        raise ValueError(f'{key} is outside the allowed range')
    return value


def _contains_password(value: Any) -> bool:
    if isinstance(value, dict):
        return any(
            'password' in str(key).lower() or _contains_password(child)
            for key, child in value.items()
        )
    if isinstance(value, list):
        return any(_contains_password(child) for child in value)
    return False


def _session_settings(encoded: str | None) -> dict[str, Any]:
    if not encoded or len(encoded) > 131_072:
        raise ValueError('IG_SESSION_SETTINGS_BASE64 is required and bounded')
    try:
        raw = base64.b64decode(encoded, validate=True)
        parsed = json.loads(raw)
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ValueError('IG_SESSION_SETTINGS_BASE64 is invalid') from error
    if (
        not isinstance(parsed, dict)
        or _contains_password(parsed)
        or not isinstance(parsed.get('authorization_data'), dict)
        or not isinstance(parsed.get('device_settings'), dict)
        or not isinstance(parsed['authorization_data'].get('sessionid'), str)
        or not parsed['authorization_data']['sessionid']
    ):
        raise ValueError('IG_SESSION_SETTINGS_BASE64 lacks safe persisted session settings')
    return parsed


@dataclass(frozen=True)
class WorkerConfig:
    session_settings: dict[str, Any]
    max_in_flight: int
    queue_timeout_seconds: int
    rate_limit_cooldown_seconds: int
    local_bearer_token: str | None

    @classmethod
    def from_env(cls, source: Mapping[str, str] | None = None) -> 'WorkerConfig':
        env = source if source is not None else os.environ
        token = env.get('WORKER_LOCAL_BEARER_TOKEN')
        if token is not None and not 32 <= len(token) <= 512:
            raise ValueError('WORKER_LOCAL_BEARER_TOKEN must contain 32 to 512 characters')
        return cls(
            session_settings=_session_settings(env.get('IG_SESSION_SETTINGS_BASE64')),
            max_in_flight=_bounded_integer(env, 'IG_MAX_IN_FLIGHT', 5, 1, 5),
            queue_timeout_seconds=_bounded_integer(
                env, 'IG_QUEUE_TIMEOUT_SECONDS', 240, 1, 300
            ),
            rate_limit_cooldown_seconds=_bounded_integer(
                env, 'IG_RATE_LIMIT_COOLDOWN_SECONDS', 900, 60, 86_400
            ),
            local_bearer_token=token,
        )
