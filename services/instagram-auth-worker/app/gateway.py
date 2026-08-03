from datetime import datetime
import re
from typing import Any
from urllib.parse import urlsplit

from pydantic import AnyUrl

from .service import (
    InstagramAuthenticationError,
    InstagramChallengeError,
    InstagramRateLimitedError,
    WorkerSchemaError,
)


RATE_LIMIT_EXCEPTIONS = {
    'FeedbackRequired',
    'PleaseWaitFewMinutes',
    'RateLimitError',
    'SentryBlock',
    'ClientThrottledError',
}
CHALLENGE_EXCEPTIONS = {
    'ChallengeRequired',
    'ChallengeUnknownStep',
    'CheckpointRequired',
    'ConsentRequired',
}
AUTH_EXCEPTIONS = {
    'BadPassword',
    'LoginRequired',
    'TwoFactorRequired',
}
USERNAME_PATTERN = re.compile(r'^[a-z0-9._]{1,30}$')


def _translate(error: Exception) -> Exception:
    name = type(error).__name__
    if name in RATE_LIMIT_EXCEPTIONS:
        return InstagramRateLimitedError()
    if name in CHALLENGE_EXCEPTIONS:
        return InstagramChallengeError()
    if name in AUTH_EXCEPTIONS:
        return InstagramAuthenticationError()
    return error


def _value(value: Any, name: str, default: Any = None) -> Any:
    return getattr(value, name, default)


def _schema_error(field: str) -> WorkerSchemaError:
    return WorkerSchemaError(f'instagrapi returned invalid {field}')


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise _schema_error(field)
    result = value.strip()
    if not result:
        raise _schema_error(field)
    return result


def _identifier(value: Any, field: str) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        raise _schema_error(field)
    result = str(value).strip()
    if not result:
        raise _schema_error(field)
    return result


def _collection(value: Any, field: str) -> list[Any]:
    if isinstance(value, dict):
        return list(value.values())
    if isinstance(value, (list, tuple)):
        return list(value)
    raise _schema_error(field)


def _user_row(value: Any) -> dict[str, Any]:
    username = _required_string(_value(value, 'username'), 'username').lower()
    if not USERNAME_PATTERN.fullmatch(username):
        raise _schema_error('username')
    is_private = _value(value, 'is_private')
    is_verified = _value(value, 'is_verified')
    if not isinstance(is_private, bool) or not isinstance(is_verified, bool):
        raise _schema_error('user flags')
    row = {
        'username': username,
        'isPrivate': is_private,
        'isVerified': is_verified,
    }
    raw_full_name = _value(value, 'full_name', '')
    raw_profile_pic_url = _value(value, 'profile_pic_url', '')
    if raw_full_name is not None and not isinstance(raw_full_name, str):
        raise _schema_error('full name')
    if raw_profile_pic_url is not None and not isinstance(raw_profile_pic_url, (str, AnyUrl)):
        raise _schema_error('profile image URL')
    full_name = (raw_full_name or '').strip()
    profile_pic_url = str(raw_profile_pic_url).strip() if raw_profile_pic_url else ''
    if full_name:
        row['fullName'] = full_name
    if profile_pic_url:
        try:
            parsed = urlsplit(profile_pic_url)
        except ValueError as error:
            raise _schema_error('profile image URL') from error
        if parsed.scheme != 'https' or not parsed.hostname:
            raise _schema_error('profile image URL')
        row['profilePicUrl'] = profile_pic_url
    return row


def _timestamp(value: Any) -> str:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise _schema_error('comment timestamp')
    try:
        if value.utcoffset() is None:
            raise _schema_error('comment timestamp')
    except (TypeError, ValueError) as error:
        raise _schema_error('comment timestamp') from error
    return value.isoformat()


def _bounded_comment_text(value: Any) -> str:
    if not isinstance(value, str):
        raise _schema_error('comment text')
    raw = value.strip()
    if not raw:
        raise _schema_error('comment text')
    result: list[str] = []
    utf16_units = 0
    for character in raw:
        character_units = 2 if ord(character) > 0xFFFF else 1
        if utf16_units + character_units > 1_000:
            break
        result.append(character)
        utf16_units += character_units
    return ''.join(result)


class InstagrapiGateway:
    def __init__(self, client: Any):
        self._client = client

    def _call(self, operation):
        try:
            return operation()
        except WorkerSchemaError:
            raise
        except Exception as error:
            translated = _translate(error)
            if translated is error:
                raise
            raise translated from error

    def relationship(self, side: str, username: str, limit: int) -> list[dict[str, Any]]:
        def collect():
            user_id = self._client.user_id_from_username(username)
            _identifier(user_id, 'user id')
            method = self._client.user_followers if side == 'followers' \
                else self._client.user_following
            users = method(user_id, amount=limit)
            return [_user_row(value) for value in _collection(users, 'relationship users')[:limit]]

        return self._call(collect)

    def likers(self, post_urls: list[str], limit_per_post: int) -> list[dict[str, Any]]:
        def collect():
            raw: list[tuple[str, int, Any]] = []
            for post_url in post_urls:
                media_pk = self._client.media_pk_from_url(post_url)
                _identifier(media_pk, 'media id')
                values = _collection(self._client.media_likers(media_pk), 'likers')[:limit_per_post]
                raw.extend((post_url, len(values), value) for value in values)
            result = []
            for post_url, returned_count, value in raw:
                user = _user_row(value)
                profile_pic_url = user.get('profilePicUrl')
                if not profile_pic_url:
                    raise _schema_error('liker profile image URL')
                result.append({
                    'postUrl': post_url,
                    'id': _identifier(_value(value, 'pk'), 'liker id'),
                    **user,
                    'profilePicUrl': profile_pic_url,
                    # Instagrapi does not expose the declared post total with each user.
                    # Use the per-post returned population as a conservative lower bound.
                    'totalLikes': returned_count,
                })
            return result

        return self._call(collect)

    def comments(self, post_urls: list[str], limit_per_post: int) -> list[dict[str, Any]]:
        def collect():
            result = []
            for post_url in post_urls:
                media_pk = self._client.media_pk_from_url(post_url)
                _identifier(media_pk, 'media id')
                comments = _collection(
                    self._client.media_comments(media_pk, amount=limit_per_post), 'comments',
                )
                for value in comments[:limit_per_post]:
                    owner = _user_row(_value(value, 'user'))
                    row = {
                        'postUrl': post_url,
                        'id': _identifier(_value(value, 'pk'), 'comment id'),
                        'text': _bounded_comment_text(_value(value, 'text')),
                        'ownerUsername': owner['username'],
                        'timestamp': _timestamp(_value(value, 'created_at_utc')),
                    }
                    if owner.get('profilePicUrl'):
                        row['ownerProfilePicUrl'] = owner['profilePicUrl']
                    likes_count = _value(value, 'like_count')
                    if likes_count is not None:
                        if isinstance(likes_count, bool) or not isinstance(likes_count, int) or likes_count < 0:
                            raise _schema_error('comment like count')
                        row['likesCount'] = likes_count
                    result.append(row)
            return result

        return self._call(collect)


def create_instagrapi_gateway(session_settings: dict[str, Any]) -> InstagrapiGateway:
    from instagrapi import Client

    client = Client()
    client.set_settings(session_settings)
    # Instagrapi applies this randomized pause between private API requests.
    # Keep it fixed and bounded so a single logical collection does not burst pages.
    client.delay_range = [1, 3]
    return InstagrapiGateway(client)
