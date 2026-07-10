import { describe, expect, it } from 'vitest';
import type { InstagramPost } from '@/lib/types/instagram';
import { instagramPostUrl, selectRecentInteractionPosts } from './interaction-posts';

function post(id: string, shortCode: string, timestamp: string, type: InstagramPost['type'] = 'image'):
InstagramPost {
    return {
        id,
        shortCode,
        timestamp,
        type,
        likesCount: 0,
        commentsCount: 0,
        taggedUsers: [],
        mentionedUsers: [],
    };
}

describe('selectRecentInteractionPosts', () => {
    it('sorts by publication time and prevents old pinned posts from taking a recent slot', () => {
        const selected = selectRecentInteractionPosts([
            post('old-pinned', 'OLD_code', '2024-01-01T00:00:00Z'),
            post('new', 'NEW_code', '1760000000'),
            post('middle', 'MID_code', '2025-01-01T00:00:00Z'),
        ], 2);

        expect(selected.map(item => item.id)).toEqual(['new', 'middle']);
    });

    it('deduplicates shortcodes and drops malformed post identifiers', () => {
        const selected = selectRecentInteractionPosts([
            post('a', 'Valid_1', '2'),
            post('b', 'valid_1', '3'),
            post('', 'Valid_2', '4'),
            post('c', 'bad!', '5'),
        ], 6);

        expect(selected.map(item => item.id)).toEqual(['a']);
    });
});

describe('instagramPostUrl', () => {
    it('builds canonical post and reel URLs', () => {
        expect(instagramPostUrl(post('a', 'Post_123', '1')))
            .toBe('https://www.instagram.com/p/Post_123/');
        expect(instagramPostUrl(post('b', 'Reel_123', '1', 'reel')))
            .toBe('https://www.instagram.com/reel/Reel_123/');
    });
});
