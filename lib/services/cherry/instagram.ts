import { z } from 'zod';
import { INSTAGRAM_USERNAME_PATTERN } from '@/lib/services/instagram/username';
import type { CherryDirection, CherryListAccount } from './detection';

/** Shapes of the two actors Cherry uses. Parsing keeps the stable account ID that other paths drop. */
export const CHERRY_RELATIONSHIP_USD_PER_ITEM = 0.0007;
const RELATIONSHIP_CHARGE_CEILING_PER_ITEM = 0.00085;
export const CHERRY_PROFILE_USD = 0.0026;
/** The actor rejects a smaller limit. */
export const CHERRY_LIST_MIN = 25;

const decimalId = z.union([z.string().regex(/^[1-9]\d{0,30}$/), z.number().int().positive().safe()])
    .transform(value => String(value));

const relationshipRow = z.object({
    username_scrape: z.string().trim().min(1),
    type: z.string().trim().min(1),
    id: decimalId,
    username: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
    full_name: z.string().nullish(),
    is_private: z.boolean(),
    is_verified: z.boolean(),
}).passthrough();

const httpsUrl = z.string().url().refine(value => value.startsWith('https://'));
const postRow = z.object({
    id: z.union([z.string(), z.number()]).transform(value => String(value)).optional(),
    shortCode: z.string().max(40).optional(),
    caption: z.string().nullish(),
    displayUrl: httpsUrl.nullish(),
    timestamp: z.string().nullish(),
    type: z.string().nullish(),
}).passthrough();

const profileRow = z.object({
    id: decimalId,
    username: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
    fullName: z.string().nullish(),
    biography: z.string().nullish(),
    followersCount: z.number().int().nonnegative(),
    followsCount: z.number().int().nonnegative(),
    postsCount: z.number().int().nonnegative(),
    private: z.boolean(),
    verified: z.boolean(),
    profilePicUrl: httpsUrl.nullish(),
    profilePicUrlHD: httpsUrl.nullish(),
    latestPosts: z.array(z.unknown()).nullish(),
}).passthrough();

const notFoundRow = z.object({ username: z.string().trim().min(1) }).passthrough().and(z.union([
    z.object({ statusCode: z.literal(404) }).passthrough(),
    z.object({ errorCode: z.enum(['NOT_FOUND', 'not_found']) }).passthrough(),
    z.object({ error: z.literal('not_found') }).passthrough(),
]));

export interface CherryPost {
    id: string;
    shortCode: string | null;
    caption: string;
    imageUrl: string | null;
    takenAt: string | null;
}

export interface CherryProfile {
    id: string;
    username: string;
    fullName: string | null;
    biography: string;
    followersCount: number;
    followingCount: number;
    postsCount: number;
    isPrivate: boolean;
    isVerified: boolean;
    profilePicUrl: string | null;
    posts: CherryPost[];
}

export function relationshipInput(username: string, direction: CherryDirection, limit: number) {
    return { Account: [username], resultsLimit: Math.max(CHERRY_LIST_MIN, limit),
        dataToScrape: direction === 'followers' ? 'Followers' : 'Followings' };
}

export function relationshipMaxCharge(limit: number): number {
    return Number((Math.max(CHERRY_LIST_MIN, limit) * RELATIONSHIP_CHARGE_CEILING_PER_ITEM).toFixed(6));
}

/** Keeps the provider order; a repeated account keeps its first position. */
export function parseRelationshipRows(
    rows: readonly unknown[], username: string, direction: CherryDirection,
): CherryListAccount[] {
    const expected = direction === 'followers' ? ['followers'] : ['following', 'followings'];
    const result = new Map<string, CherryListAccount>();
    for (const row of rows) {
        const parsed = relationshipRow.safeParse(row);
        if (!parsed.success) throw new Error('CHERRY_RELATIONSHIP_SCHEMA');
        if (parsed.data.username_scrape.toLowerCase() !== username.toLowerCase()
            || !expected.includes(parsed.data.type.toLowerCase())) throw new Error('CHERRY_RELATIONSHIP_MISMATCH');
        if (result.has(parsed.data.id)) continue;
        result.set(parsed.data.id, {
            id: parsed.data.id, username: parsed.data.username.toLowerCase(),
            fullName: parsed.data.full_name?.trim().slice(0, 120) || null,
            isPrivate: parsed.data.is_private, isVerified: parsed.data.is_verified,
        });
    }
    return [...result.values()];
}

function parsePost(value: unknown): CherryPost | null {
    const parsed = postRow.safeParse(value);
    if (!parsed.success) return null;
    const { data } = parsed;
    const id = data.id ?? data.shortCode;
    if (!id) return null;
    return { id, shortCode: data.shortCode ?? null, caption: (data.caption ?? '').slice(0, 600),
        imageUrl: data.displayUrl ?? null, takenAt: data.timestamp ?? null };
}

export type CherryProfileResult =
    | { status: 'found'; profile: CherryProfile }
    | { status: 'not_found' }
    | { status: 'unavailable' };

/** One result per requested username; a missing row is 'unavailable', never 'not found'. */
export function parseProfileRows(rows: readonly unknown[], usernames: readonly string[]): Map<string, CherryProfileResult> {
    const results = new Map<string, CherryProfileResult>(
        usernames.map(username => [username.toLowerCase(), { status: 'unavailable' } as const]),
    );
    for (const row of rows) {
        const found = profileRow.safeParse(row);
        if (found.success) {
            const { data } = found;
            const key = data.username.toLowerCase();
            if (!results.has(key)) continue;
            results.set(key, { status: 'found', profile: {
                id: data.id, username: key, fullName: data.fullName?.trim().slice(0, 120) || null,
                biography: (data.biography ?? '').slice(0, 500), followersCount: data.followersCount,
                followingCount: data.followsCount, postsCount: data.postsCount, isPrivate: data.private,
                isVerified: data.verified, profilePicUrl: data.profilePicUrlHD ?? data.profilePicUrl ?? null,
                posts: data.private ? [] : (data.latestPosts ?? []).map(parsePost)
                    .filter((post): post is CherryPost => post !== null).slice(0, 6),
            } });
            continue;
        }
        const missing = notFoundRow.safeParse(row);
        if (missing.success) {
            const key = missing.data.username.toLowerCase();
            if (results.has(key)) results.set(key, { status: 'not_found' });
        }
    }
    return results;
}

const reserved = new Set(['explore', 'reels', 'accounts', 'direct', 'stories', 'p', 'reel', 'tv', 'about', 'developer']);

/** Accepts an ID, an @ID, or a profile link. */
export function normalizeTargetUsername(input: string): string | null {
    let value = input.trim();
    if (/^(?:https?:\/\/)?(?:www\.)?instagram\.com\//i.test(value)) {
        try {
            value = new URL(/^https?:/i.test(value) ? value : `https://${value}`).pathname.split('/')[1] ?? '';
        } catch {
            return null;
        }
    }
    value = value.replace(/^@/, '').toLowerCase();
    return INSTAGRAM_USERNAME_PATTERN.test(value) && !reserved.has(value) ? value : null;
}
