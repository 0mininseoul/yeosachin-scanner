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
    def test_maps_a_public_profile_and_newest_posts_without_provider_payloads(self):
        class ProfileClient(FakeClient):
            def user_info_by_username(self, username):
                self.profile_username = username
                return SimpleNamespace(
                    pk='123', username=username, full_name='Target User',
                    biography='A short bio', profile_pic_url='https://cdn.example/avatar.jpg',
                    follower_count=12, following_count=3, media_count=1,
                    is_private=False, is_verified=True,
                )

            def user_medias(self, user_id, amount):
                self.profile_media_args = (user_id, amount)
                return [SimpleNamespace(
                    pk='post-1', code='Abc123', taken_at=datetime(2026, 8, 3, tzinfo=timezone.utc),
                    media_type=8, product_type=None, caption_text='Caption',
                    image_versions2=SimpleNamespace(candidates=[SimpleNamespace(
                        url='https://cdn.example/image.jpg',
                    )]),
                    thumbnail_url='https://cdn.example/thumb.jpg', video_url=None,
                    like_count=7, comment_count=2, usertags=[],
                    resources=[
                        SimpleNamespace(pk='child-1', media_type=1,
                                        thumbnail_url='https://cdn.example/child.jpg', video_url=None,
                                        usertags=[]),
                    ],
                )]

        client = ProfileClient()
        self.assertEqual(InstagrapiGateway(client).profile('target.user', 10), {
            'username': 'target.user',
            'fullName': 'Target User',
            'bio': 'A short bio',
            'profilePicUrl': 'https://cdn.example/avatar.jpg',
            'followersCount': 12,
            'followingCount': 3,
            'postsCount': 1,
            'isPrivate': False,
            'isVerified': True,
            'latestPosts': [{
                'id': 'post-1', 'shortCode': 'Abc123', 'caption': 'Caption',
                'imageUrl': 'https://cdn.example/image.jpg',
                'thumbnailUrl': 'https://cdn.example/thumb.jpg', 'type': 'carousel',
                'mediaItems': [{
                    'id': 'child-1', 'type': 'image',
                    'thumbnailUrl': 'https://cdn.example/child.jpg',
                }],
                'declaredMediaCount': 1, 'childrenComplete': True,
                'likesCount': 7, 'commentsCount': 2,
                'timestamp': '2026-08-03T00:00:00+00:00',
                'taggedUsers': [], 'mentionedUsers': [],
            }],
        })
        self.assertEqual(client.profile_username, 'target.user')
        self.assertEqual(client.profile_media_args, ('123', 10))

    def test_private_profile_returns_its_summary_without_requesting_media(self):
        class PrivateProfileClient(FakeClient):
            def user_info_by_username(self, username):
                return SimpleNamespace(
                    pk='123', username=username, full_name='', biography='', profile_pic_url='',
                    follower_count=12, following_count=3, media_count=9,
                    is_private=True, is_verified=False,
                )

            def user_medias(self, user_id, amount):
                raise AssertionError('private profile media must not be requested')

        result = InstagrapiGateway(PrivateProfileClient()).profile('target.user', 10)
        self.assertTrue(result['isPrivate'])
        self.assertNotIn('latestPosts', result)

    def test_zero_media_limit_returns_public_summary_without_requesting_media(self):
        class SummaryOnlyClient(FakeClient):
            def user_info_by_username(self, username):
                return SimpleNamespace(
                    pk='123', username=username, full_name='', biography='', profile_pic_url='',
                    follower_count=12, following_count=3, media_count=9,
                    is_private=False, is_verified=False,
                )

            def user_medias(self, user_id, amount):
                raise AssertionError('summary-only profile must not request media')

        self.assertEqual(InstagrapiGateway(SummaryOnlyClient()).profile('target.user', 0), {
            'username': 'target.user', 'followersCount': 12, 'followingCount': 3,
            'postsCount': 9, 'isPrivate': False, 'isVerified': False,
            'latestPosts': [],
        })

    def test_profile_maps_hidden_post_counts_to_zero_with_explicit_flags(self):
        class HiddenCountClient(FakeClient):
            def user_info_by_username(self, username):
                return SimpleNamespace(
                    pk='123', username=username, full_name='', biography='', profile_pic_url='',
                    follower_count=12, following_count=3, media_count=1,
                    is_private=False, is_verified=False,
                )

            def user_medias(self, user_id, amount):
                return [SimpleNamespace(
                    pk='post-1', code='Abc123', taken_at=datetime(2026, 8, 3, tzinfo=timezone.utc),
                    media_type=1, product_type=None, caption_text='',
                    image_versions2=SimpleNamespace(candidates=[SimpleNamespace(
                        url='https://cdn.example/image.jpg',
                    )]),
                    thumbnail_url=None, video_url=None,
                    like_count=7, comment_count=2, like_and_view_counts_disabled=True,
                    usertags=[], resources=[],
                )]

        [post] = InstagrapiGateway(HiddenCountClient()).profile(
            'target.user', 1,
        )['latestPosts']
        self.assertEqual(post['likesCount'], 0)
        self.assertEqual(post['commentsCount'], 0)
        self.assertTrue(post['likesCountHidden'])
        self.assertTrue(post['commentsCountHidden'])

    def test_profile_marks_none_post_counts_as_hidden(self):
        class NoneCountClient(FakeClient):
            def user_info_by_username(self, username):
                return SimpleNamespace(
                    pk='123', username=username, full_name='', biography='', profile_pic_url='',
                    follower_count=12, following_count=3, media_count=1,
                    is_private=False, is_verified=False,
                )

            def user_medias(self, user_id, amount):
                return [SimpleNamespace(
                    pk='post-1', code='Abc123', taken_at=datetime(2026, 8, 3, tzinfo=timezone.utc),
                    media_type=1, product_type=None, caption_text='',
                    image_versions2=SimpleNamespace(candidates=[SimpleNamespace(
                        url='https://cdn.example/image.jpg',
                    )]),
                    thumbnail_url=None, video_url=None,
                    like_count=None, comment_count=None, like_and_view_counts_disabled=False,
                    usertags=[], resources=[],
                )]

        [post] = InstagrapiGateway(NoneCountClient()).profile('target.user', 1)['latestPosts']
        self.assertEqual(post['likesCount'], 0)
        self.assertEqual(post['commentsCount'], 0)
        self.assertTrue(post['likesCountHidden'])
        self.assertTrue(post['commentsCountHidden'])

    def test_profile_uses_checkpoint_count_and_full_name_bounds(self):
        class BoundClient(FakeClient):
            def user_info_by_username(self, username):
                return SimpleNamespace(
                    pk='123', username=username, full_name='A' * 151, biography='', profile_pic_url='',
                    follower_count=2_000_000_000, following_count=0, media_count=0,
                    is_private=False, is_verified=False,
                )

            def user_medias(self, user_id, amount):
                return []

        profile = InstagrapiGateway(BoundClient()).profile('target.user', 1)
        self.assertEqual(profile['fullName'], 'A' * 150)

        class TooLargeCountClient(BoundClient):
            def user_info_by_username(self, username):
                profile = super().user_info_by_username(username)
                profile.follower_count = 2_000_000_001
                return profile

        with self.assertRaises(WorkerSchemaError):
            InstagrapiGateway(TooLargeCountClient()).profile('target.user', 1)

    def test_public_profile_with_posts_fails_closed_when_media_is_unusable(self):
        class EmptyMediaClient(FakeClient):
            def user_info_by_username(self, username):
                return SimpleNamespace(
                    pk='123', username=username, full_name='', biography='', profile_pic_url='',
                    follower_count=12, following_count=3, media_count=1,
                    is_private=False, is_verified=False,
                )

            def user_medias(self, user_id, amount):
                return []

        with self.assertRaises(WorkerSchemaError):
            InstagrapiGateway(EmptyMediaClient()).profile('target.user', 10)

    def test_profile_batch_preserves_each_known_not_found_username(self):
        UserNotFound = type('UserNotFound', (RuntimeError,), {})

        class BatchClient(FakeClient):
            def user_info_by_username(self, username):
                if username == 'missing.user':
                    raise UserNotFound()
                return SimpleNamespace(
                    pk='123', username=username, full_name='', biography='', profile_pic_url='',
                    follower_count=0, following_count=0, media_count=0,
                    is_private=False, is_verified=False,
                )

            def user_medias(self, user_id, amount):
                return []

        self.assertEqual(InstagrapiGateway(BatchClient()).profiles(
            ['target.user', 'missing.user'], 1,
        ), [
            {'username': 'target.user', 'status': 'available', 'profile': {
                'username': 'target.user', 'followersCount': 0, 'followingCount': 0,
                'postsCount': 0, 'isPrivate': False, 'isVerified': False,
                'latestPosts': [],
            }},
            {'username': 'missing.user', 'status': 'not_found'},
        ])

    def test_single_profile_maps_known_user_not_found_to_no_profile(self):
        UserNotFound = type('UserNotFound', (RuntimeError,), {})

        class MissingProfileClient(FakeClient):
            def user_info_by_username(self, username):
                raise UserNotFound()

        self.assertIsNone(
            InstagrapiGateway(MissingProfileClient()).profile('missing.user', 0)
        )

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
