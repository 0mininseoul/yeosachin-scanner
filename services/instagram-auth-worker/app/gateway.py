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
NOT_FOUND_EXCEPTIONS = {
    'UserNotFound',
    'UserNotFoundError',
    'UsernameNotFound',
}
USERNAME_PATTERN = re.compile(r'^[a-z0-9._]{1,30}$')
POST_SHORTCODE_PATTERN = re.compile(r'^[A-Za-z0-9_-]{1,64}$')
MAX_URL_LENGTH = 2_048
MAX_FULL_NAME_LENGTH = 150
MAX_BIO_LENGTH = 2_000
MAX_CAPTION_LENGTH = 2_200
MAX_IDENTIFIER_LENGTH = 255
# Instagram carousels support up to twenty children.  Keep this aligned with
# the downstream profile/media policy; a twenty-slide carousel is a valid
# post, not a malformed provider response.
MAX_MEDIA_CHILDREN = 20
MAX_COUNT = 2_000_000_000


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


def _bounded_identifier(value: Any, field: str, maximum: int = MAX_IDENTIFIER_LENGTH) -> str:
    result = _identifier(value, field)
    if len(result) > maximum:
        raise _schema_error(field)
    return result


def _bounded_optional_string(value: Any, field: str, maximum: int) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _schema_error(field)
    result = value.strip()
    if not result:
        return None
    utf16_units = 0
    bounded: list[str] = []
    for character in result:
        character_units = 2 if ord(character) > 0xFFFF else 1
        if utf16_units + character_units > maximum:
            break
        bounded.append(character)
        utf16_units += character_units
    return ''.join(bounded)


def _https_url(value: Any, field: str, required: bool = False) -> str | None:
    if value is None or value == '':
        if required:
            raise _schema_error(field)
        return None
    if not isinstance(value, (str, AnyUrl)):
        raise _schema_error(field)
    result = str(value).strip()
    if not result:
        if required:
            raise _schema_error(field)
        return None
    if len(result) > MAX_URL_LENGTH:
        raise _schema_error(field)
    try:
        parsed = urlsplit(result)
    except ValueError as error:
        raise _schema_error(field) from error
    if (
        parsed.scheme != 'https'
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise _schema_error(field)
    return result


def _nonnegative_count(value: Any, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= MAX_COUNT:
        raise _schema_error(field)
    return value


def _post_count(value: Any, field: str, counts_hidden: bool) -> tuple[int, bool]:
    if value is None:
        return 0, True
    count = _nonnegative_count(value, field)
    return (0, True) if counts_hidden else (count, False)


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


def _timestamp(value: Any, field: str = 'timestamp') -> str:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise _schema_error(field)
    try:
        if value.utcoffset() is None:
            raise _schema_error(field)
    except (TypeError, ValueError) as error:
        raise _schema_error(field) from error
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
            users = _collection(method(user_id, amount=limit), 'relationship users')

            # Instagrapi's private-mobile followers endpoint can terminate a
            # paginated response early even when the account's declared count
            # is larger. The private GraphQL helper uses the same authenticated
            # session and cursor family, so use it only to top up an incomplete
            # mobile result. The downstream completeness gate still remains the
            # final authority; never pad or accept missing rows here.
            if side == 'followers' and len(users) < limit:
                private_graphql = getattr(
                    self._client, 'user_followers_private_gql', None
                )
                if callable(private_graphql):
                    users.extend(_collection(
                        private_graphql(user_id, amount=limit),
                        'private GraphQL relationship users',
                    ))

            unique_users: list[Any] = []
            seen_ids: set[str] = set()
            for value in users:
                identifier = _identifier(_value(value, 'pk'), 'user id')
                if identifier in seen_ids:
                    continue
                seen_ids.add(identifier)
                unique_users.append(value)
                if len(unique_users) >= limit:
                    break
            return [_user_row(value) for value in unique_users]

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

    @staticmethod
    def _media_type(value: Any, field: str, product_type: Any = None) -> str:
        if isinstance(value, bool) or not isinstance(value, int):
            raise _schema_error(field)
        if product_type is not None and not isinstance(product_type, str):
            raise _schema_error('media product type')
        if value == 1:
            return 'image'
        if value == 2:
            return 'reel' if (product_type or '').lower() in {'clips', 'reels'} else 'video'
        if value == 8:
            return 'carousel'
        raise _schema_error(field)

    @staticmethod
    def _image_url(value: Any) -> str | None:
        images = _value(value, 'image_versions2')
        if images is None:
            return None
        candidates = _value(images, 'candidates')
        if not isinstance(candidates, (list, tuple)):
            raise _schema_error('media image candidates')
        if not candidates:
            return None
        return _https_url(_value(candidates[0], 'url'), 'media image URL', required=True)

    @staticmethod
    def _tagged_usernames(value: Any) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, (list, tuple)):
            raise _schema_error('media user tags')
        usernames: list[str] = []
        for tag in value:
            username = _required_string(_value(_value(tag, 'user'), 'username'), 'tagged username').lower()
            if not USERNAME_PATTERN.fullmatch(username):
                raise _schema_error('tagged username')
            usernames.append(username)
        return list(dict.fromkeys(usernames))

    @staticmethod
    def _mentioned_usernames(caption: str | None) -> list[str]:
        if not caption:
            return []
        return list(dict.fromkeys(
            match.group(1).lower()
            for match in re.finditer(r'(?<![A-Za-z0-9._])@([A-Za-z0-9._]{1,30})', caption)
            if USERNAME_PATTERN.fullmatch(match.group(1).lower())
        ))

    def _media_item(self, value: Any) -> dict[str, Any]:
        kind = self._media_type(_value(value, 'media_type'), 'carousel media type')
        if kind == 'carousel':
            raise _schema_error('nested carousel media type')
        thumbnail_url = _https_url(_value(value, 'thumbnail_url'), 'carousel thumbnail URL')
        video_url = _https_url(_value(value, 'video_url'), 'carousel video URL')
        if thumbnail_url is None and video_url is None:
            raise _schema_error('carousel display URL')
        row: dict[str, Any] = {
            'id': _bounded_identifier(_value(value, 'pk'), 'carousel media id'),
            'type': kind,
        }
        if thumbnail_url is not None:
            row['thumbnailUrl'] = thumbnail_url
        if video_url is not None:
            row['videoUrl'] = video_url
        return row

    def _post_row(self, value: Any) -> dict[str, Any]:
        kind = self._media_type(
            _value(value, 'media_type'), 'media type', _value(value, 'product_type'),
        )
        caption = _bounded_optional_string(_value(value, 'caption_text'), 'media caption', MAX_CAPTION_LENGTH)
        image_url = self._image_url(value)
        thumbnail_url = _https_url(_value(value, 'thumbnail_url'), 'media thumbnail URL')
        video_url = _https_url(_value(value, 'video_url'), 'media video URL')
        counts_disabled = _value(value, 'like_and_view_counts_disabled', False)
        if not isinstance(counts_disabled, bool):
            raise _schema_error('media count visibility')
        likes_count, likes_count_hidden = _post_count(
            _value(value, 'like_count'), 'media like count', counts_disabled,
        )
        comments_count, comments_count_hidden = _post_count(
            _value(value, 'comment_count'), 'media comment count', counts_disabled,
        )
        row: dict[str, Any] = {
            'id': _bounded_identifier(_value(value, 'pk'), 'media id'),
            'shortCode': _bounded_identifier(_value(value, 'code'), 'media shortcode', 64),
            'type': kind,
            'likesCount': likes_count,
            'commentsCount': comments_count,
            'timestamp': _timestamp(_value(value, 'taken_at'), 'media timestamp'),
            'taggedUsers': self._tagged_usernames(_value(value, 'usertags')),
            'mentionedUsers': self._mentioned_usernames(caption),
        }
        if not POST_SHORTCODE_PATTERN.fullmatch(row['shortCode']):
            raise _schema_error('media shortcode')
        if caption is not None:
            row['caption'] = caption
        if likes_count_hidden:
            row['likesCountHidden'] = True
        if comments_count_hidden:
            row['commentsCountHidden'] = True
        if image_url is not None:
            row['imageUrl'] = image_url
        if thumbnail_url is not None:
            row['thumbnailUrl'] = thumbnail_url
        if video_url is not None:
            row['videoUrl'] = video_url
        if kind == 'carousel':
            resources = _collection(_value(value, 'resources'), 'carousel resources')
            if not 1 <= len(resources) <= MAX_MEDIA_CHILDREN:
                raise _schema_error('carousel resources')
            row['mediaItems'] = [self._media_item(resource) for resource in resources]
            row['declaredMediaCount'] = len(resources)
            row['childrenComplete'] = True
            if image_url is None and thumbnail_url is None and video_url is None:
                first_child = row['mediaItems'][0]
                for field in ('thumbnailUrl', 'videoUrl'):
                    if field in first_child:
                        row['thumbnailUrl'] = first_child[field]
                        break
        if not any(field in row for field in ('imageUrl', 'thumbnailUrl', 'videoUrl')):
            raise _schema_error('media display URL')
        return row

    def _profile_row(self, value: Any, requested_username: str, media_limit: int) -> dict[str, Any]:
        username = _required_string(_value(value, 'username'), 'profile username').lower()
        if not USERNAME_PATTERN.fullmatch(username) or username != requested_username:
            raise _schema_error('profile username')
        is_private = _value(value, 'is_private')
        is_verified = _value(value, 'is_verified')
        if not isinstance(is_private, bool) or not isinstance(is_verified, bool):
            raise _schema_error('profile flags')
        user_id = _bounded_identifier(_value(value, 'pk'), 'profile user id')
        row: dict[str, Any] = {
            'username': username,
            'followersCount': _nonnegative_count(_value(value, 'follower_count'), 'profile follower count'),
            'followingCount': _nonnegative_count(_value(value, 'following_count'), 'profile following count'),
            'postsCount': _nonnegative_count(_value(value, 'media_count'), 'profile media count'),
            'isPrivate': is_private,
            'isVerified': is_verified,
        }
        full_name = _bounded_optional_string(_value(value, 'full_name'), 'profile full name', MAX_FULL_NAME_LENGTH)
        bio = _bounded_optional_string(_value(value, 'biography'), 'profile biography', MAX_BIO_LENGTH)
        profile_pic_url = _https_url(_value(value, 'profile_pic_url'), 'profile image URL')
        if full_name is not None:
            row['fullName'] = full_name
        if bio is not None:
            row['bio'] = bio
        if profile_pic_url is not None:
            row['profilePicUrl'] = profile_pic_url
        if is_private:
            return row
        if media_limit == 0:
            row['latestPosts'] = []
            return row
        media = _collection(self._client.user_medias(user_id, amount=media_limit), 'profile media')[:media_limit]
        if row['postsCount'] > 0 and not media:
            raise _schema_error('profile media')
        row['latestPosts'] = [self._post_row(item) for item in media]
        return row

    def profile(self, username: str, media_limit: int) -> dict[str, Any] | None:
        def collect():
            try:
                return self._profile_row(
                    self._client.user_info_by_username(username), username, media_limit,
                )
            except Exception as error:
                if type(error).__name__ in NOT_FOUND_EXCEPTIONS:
                    return None
                raise

        return self._call(collect)

    def profiles(self, usernames: list[str], media_limit: int) -> list[dict[str, Any]]:
        def collect():
            result: list[dict[str, Any]] = []
            for username in usernames:
                try:
                    profile = self._profile_row(
                        self._client.user_info_by_username(username), username, media_limit,
                    )
                except Exception as error:
                    if type(error).__name__ in NOT_FOUND_EXCEPTIONS:
                        result.append({'username': username, 'status': 'not_found'})
                        continue
                    if isinstance(error, WorkerSchemaError):
                        # A malformed provider object is scoped to this candidate. Keep
                        # the failure explicit so callers can apply their per-username
                        # retry/coverage policy without fabricating profile evidence.
                        result.append({
                            'username': username,
                            'status': 'failed',
                            'failureCategory': 'schema',
                        })
                        continue
                    raise
                result.append({'username': username, 'status': 'available', 'profile': profile})
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
