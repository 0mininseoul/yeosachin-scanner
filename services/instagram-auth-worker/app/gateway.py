from datetime import datetime, timezone
import re
from typing import Any
from urllib.parse import urlsplit

from .service import (
    InstagramAuthenticationError,
    InstagramChallengeError,
    InstagramRateLimitedError,
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


def _user_row(value: Any) -> dict[str, Any]:
    username = str(_value(value, 'username', '')).strip().lower()
    if not USERNAME_PATTERN.fullmatch(username):
        raise RuntimeError('upstream user identity is invalid')
    row = {
        'username': username,
        'isPrivate': bool(_value(value, 'is_private', False)),
        'isVerified': bool(_value(value, 'is_verified', False)),
    }
    full_name = str(_value(value, 'full_name', '') or '').strip()
    profile_pic_url = str(_value(value, 'profile_pic_url', '') or '').strip()
    if full_name:
        row['fullName'] = full_name
    if profile_pic_url:
        parsed = urlsplit(profile_pic_url)
        if parsed.scheme != 'https' or not parsed.hostname:
            raise RuntimeError('upstream profile image URL is invalid')
        row['profilePicUrl'] = profile_pic_url
    return row


def _timestamp(value: Any) -> str:
    if not isinstance(value, datetime):
        raise ValueError('comment timestamp is missing')
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _bounded_comment_text(value: Any) -> str:
    raw = str(value or '').strip()
    if not raw:
        raise RuntimeError('upstream comment text is invalid')
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
        except Exception as error:
            translated = _translate(error)
            if translated is error:
                raise
            raise translated from error

    def relationship(self, side: str, username: str, limit: int) -> list[dict[str, Any]]:
        def collect():
            user_id = self._client.user_id_from_username(username)
            method = self._client.user_followers if side == 'followers' \
                else self._client.user_following
            users = method(user_id, amount=limit)
            values = users.values() if isinstance(users, dict) else users
            return [_user_row(value) for value in list(values)[:limit]]

        return self._call(collect)

    def likers(self, post_urls: list[str], limit_per_post: int) -> list[dict[str, Any]]:
        def collect():
            raw: list[tuple[str, int, Any]] = []
            for post_url in post_urls:
                media_pk = self._client.media_pk_from_url(post_url)
                values = list(self._client.media_likers(media_pk))[:limit_per_post]
                raw.extend((post_url, len(values), value) for value in values)
            result = []
            for post_url, returned_count, value in raw:
                user = _user_row(value)
                profile_pic_url = user.get('profilePicUrl')
                if not profile_pic_url:
                    raise RuntimeError('upstream liker profile image is missing')
                result.append({
                    'postUrl': post_url,
                    'id': str(_value(value, 'pk', '')),
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
                comments = self._client.media_comments(media_pk, amount=limit_per_post)
                for value in comments[:limit_per_post]:
                    owner = _user_row(_value(value, 'user'))
                    row = {
                        'postUrl': post_url,
                        'id': str(_value(value, 'pk', '')),
                        'text': _bounded_comment_text(_value(value, 'text')),
                        'ownerUsername': owner['username'],
                        'timestamp': _timestamp(_value(value, 'created_at_utc')),
                    }
                    if owner.get('profilePicUrl'):
                        row['ownerProfilePicUrl'] = owner['profilePicUrl']
                    likes_count = _value(value, 'like_count')
                    if isinstance(likes_count, int) and likes_count >= 0:
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
