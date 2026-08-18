import { describe, expect, it } from 'vitest';
import {
    INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID,
    INSTAGRAM_DEFAULT_PROFILE_IMAGE_NORMALIZED_SHA256,
    isDefaultInstagramProfileImage,
    preferredInstagramProfileImageUrl,
} from './profile-image-evidence';

describe('Instagram profile image evidence', () => {
    it.each([
        ['jpeg-150', 'dst-jpg_e0_s150x150_tt6'],
        ['webp-150', 'dst-webp'],
        ['jpeg-hd', 'dst-jpg_tt6'],
    ])('recognizes the default avatar media id for the %s encoding', (_label, encoding) => {
        const url = `https://scontent.cdninstagram.com/v/t51.2885-19/${INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID}?stp=${encoding}`;
        expect(isDefaultInstagramProfileImage({ url })).toBe(true);
    });

    it('keeps normalized fingerprints for all observed default-avatar encodings', () => {
        expect(INSTAGRAM_DEFAULT_PROFILE_IMAGE_NORMALIZED_SHA256).toEqual(expect.arrayContaining([
            '7edcde60c739d5723a0ea6285e44e0d1bed4942b53aeaaeca9c60dc8a5bd10ef',
            'ddd024f05c503446782f8267e861c40cf4d878c6326a655c43df205cc0562a0f',
            '376147675d9b7307dfa755412a30297f6dcf94b08f306e536fd06e4c83c8c437',
        ]));
    });

    it.each([
        ['jpeg-150', '7edcde60c739d5723a0ea6285e44e0d1bed4942b53aeaaeca9c60dc8a5bd10ef'],
        ['webp-150', 'ddd024f05c503446782f8267e861c40cf4d878c6326a655c43df205cc0562a0f'],
        ['jpeg-320', '376147675d9b7307dfa755412a30297f6dcf94b08f306e536fd06e4c83c8c437'],
    ])('recognizes the normalized %s fingerprint independently of its URL', (_label, normalizedSha256) => {
        expect(isDefaultInstagramProfileImage({ normalizedSha256 })).toBe(true);
    });

    it('prefers HD while dropping anonymous avatar URLs', () => {
        expect(preferredInstagramProfileImageUrl({
            profilePicUrl: 'https://cdn.example/profile-150.jpg',
            profilePicUrlHD: 'https://cdn.example/profile-320.jpg',
        })).toBe('https://cdn.example/profile-320.jpg');
        expect(preferredInstagramProfileImageUrl({
            profilePicUrl: `https://cdn.example/${INSTAGRAM_DEFAULT_PROFILE_IMAGE_MEDIA_ID}`,
        })).toBeUndefined();
    });
});
