import unittest
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

from pydantic import HttpUrl

from app.gateway import InstagrapiGateway, create_instagrapi_gateway
from app.service import InstagramRateLimitedError, WorkerSchemaError


def user(pk, username):
    return SimpleNamespace(
        pk=pk,
        username=username,
        full_name=f'{username} full',
        profile_pic_url='https://cdn.example/avatar.jpg',
        is_private=False,
        is_verified=False,
    )


class FakeClient:
    def user_id_from_username(self, username):
        self.resolved_username = username
        return '123'

    def user_followers(self, user_id, amount):
        self.relationship_args = ('followers', user_id, amount)
        return {'1': user(1, 'one.user'), '2': user(2, 'two.user')}

    def user_following(self, user_id, amount):
        self.relationship_args = ('following', user_id, amount)
        return {'2': user(2, 'two.user')}

    def media_pk_from_url(self, url):
        return url.rsplit('/', 2)[-2]

    def media_likers(self, media_pk):
        return [user(1, 'one.user')]

    def media_comments(self, media_pk, amount):
        return [SimpleNamespace(
            pk=99,
            text='hello',
            user=user(1, 'one.user'),
            created_at_utc=datetime(2026, 8, 3, tzinfo=timezone.utc),
            like_count=2,
        )]


class InstagrapiGatewayTest(unittest.TestCase):
    def test_configures_a_bounded_delay_between_private_api_requests(self):
        client = SimpleNamespace(delay_range=None, set_settings=lambda settings: None)
        module = SimpleNamespace(Client=lambda: client)

        with patch.dict(sys.modules, {'instagrapi': module}):
            create_instagrapi_gateway({'authorization_data': {}, 'device_settings': {}})

        self.assertEqual(client.delay_range, [1, 3])

    def test_maps_relationships_without_exposing_private_session_state(self):
        client = FakeClient()
        gateway = InstagrapiGateway(client)

        self.assertEqual(gateway.relationship('followers', 'target.user', 2), [
            {
                'username': 'one.user',
                'fullName': 'one.user full',
                'profilePicUrl': 'https://cdn.example/avatar.jpg',
                'isPrivate': False,
                'isVerified': False,
            },
            {
                'username': 'two.user',
                'fullName': 'two.user full',
                'profilePicUrl': 'https://cdn.example/avatar.jpg',
                'isPrivate': False,
                'isVerified': False,
            },
        ])
        self.assertEqual(client.relationship_args, ('followers', '123', 2))

    def test_accepts_instagrapi_pydantic_url(self):
        class UserShortLikeClient(FakeClient):
            def user_followers(self, user_id, amount):
                return {'1': SimpleNamespace(
                    pk=1,
                    username='one.user',
                    full_name='One User',
                    profile_pic_url=HttpUrl('https://cdn.example/avatar.jpg'),
                    is_private=False,
                    is_verified=False,
                )}

        self.assertEqual(
            InstagrapiGateway(UserShortLikeClient()).relationship(
                'followers', 'target.user', 1,
            ),
            [{
                'username': 'one.user',
                'fullName': 'One User',
                'profilePicUrl': 'https://cdn.example/avatar.jpg',
                'isPrivate': False,
                'isVerified': False,
            }],
        )

    def test_maps_likers_and_comments_to_the_existing_node_contract(self):
        gateway = InstagrapiGateway(FakeClient())
        post_url = 'https://www.instagram.com/p/Abc123/'

        self.assertEqual(gateway.likers([post_url], 150), [{
            'postUrl': post_url,
            'id': '1',
            'username': 'one.user',
            'fullName': 'one.user full',
            'profilePicUrl': 'https://cdn.example/avatar.jpg',
            'isPrivate': False,
            'isVerified': False,
            'totalLikes': 1,
        }])
        self.assertEqual(gateway.comments([post_url], 15), [{
            'postUrl': post_url,
            'id': '99',
            'text': 'hello',
            'ownerUsername': 'one.user',
            'ownerProfilePicUrl': 'https://cdn.example/avatar.jpg',
            'timestamp': '2026-08-03T00:00:00+00:00',
            'likesCount': 2,
        }])

    def test_uses_each_posts_returned_population_as_the_conservative_like_total(self):
        class TwoLikerClient(FakeClient):
            def media_likers(self, media_pk):
                return [user(1, 'one.user'), user(2, 'two.user')]

        rows = InstagrapiGateway(TwoLikerClient()).likers(
            ['https://www.instagram.com/p/Abc123/'],
            150,
        )

        self.assertEqual([row['totalLikes'] for row in rows], [2, 2])

    def test_maps_client_throttling_to_the_account_cooldown_signal(self):
        ClientThrottledError = type('ClientThrottledError', (RuntimeError,), {})

        class ThrottledClient(FakeClient):
            def user_id_from_username(self, username):
                raise ClientThrottledError()

        with self.assertRaises(InstagramRateLimitedError):
            InstagrapiGateway(ThrottledClient()).relationship(
                'followers', 'target.user', 2
            )

    def test_fails_closed_on_missing_liker_image_and_bounds_comment_text(self):
        class InvalidImageClient(FakeClient):
            def media_likers(self, media_pk):
                return [SimpleNamespace(
                    pk=1,
                    username='one.user',
                    full_name='One',
                    profile_pic_url='',
                    is_private=False,
                    is_verified=False,
                )]

        with self.assertRaises(WorkerSchemaError):
            InstagrapiGateway(InvalidImageClient()).likers(
                ['https://www.instagram.com/p/Abc123/'],
                150,
            )

        class LongCommentClient(FakeClient):
            def media_comments(self, media_pk, amount):
                return [SimpleNamespace(
                    pk=99,
                    text='한' * 1_001,
                    user=user(1, 'one.user'),
                    created_at_utc=datetime(2026, 8, 3, tzinfo=timezone.utc),
                    like_count=0,
                )]

        [comment] = InstagrapiGateway(LongCommentClient()).comments(
            ['https://www.instagram.com/p/Abc123/'],
            15,
        )
        self.assertLessEqual(len(comment['text'].encode('utf-16-le')) // 2, 1_000)

    def test_malformed_gateway_records_raise_the_worker_schema_error(self):
        post_url = 'https://www.instagram.com/p/Abc123/'

        cases = []

        class InvalidUsernameClient(FakeClient):
            def user_followers(self, user_id, amount):
                return {'1': user(1, 'invalid username')}
        cases.append(lambda: InstagrapiGateway(InvalidUsernameClient()).relationship(
            'followers', 'target.user', 1,
        ))

        class InvalidImageClient(FakeClient):
            def user_followers(self, user_id, amount):
                row = user(1, 'one.user')
                row.profile_pic_url = 'http://cdn.example/avatar.jpg'
                return {'1': row}
        cases.append(lambda: InstagrapiGateway(InvalidImageClient()).relationship(
            'followers', 'target.user', 1,
        ))

        class InvalidCommentClient(FakeClient):
            def media_comments(self, media_pk, amount):
                return [SimpleNamespace(
                    pk=99,
                    text='hello',
                    user=user(1, 'one.user'),
                    created_at_utc='not-a-datetime',
                    like_count=2,
                )]
        cases.append(lambda: InstagrapiGateway(InvalidCommentClient()).comments([post_url], 1))

        for malformed_call in cases:
            with self.subTest(malformed_call=malformed_call):
                with self.assertRaises(WorkerSchemaError):
                    malformed_call()


if __name__ == '__main__':
    unittest.main()
