import { createHash } from 'node:crypto';
import { z } from 'zod';
import { COMBINED_ANALYSIS_PROMPT } from '@/lib/constants/prompts';
import type { CombinedAnalysisResponse } from '@/lib/types/analysis';
import {
    COMBINED_ANALYSIS_SCHEMA_VERSION,
    combinedAnalysisResponseSchema,
} from './analysis-response-schemas';
import { getAnalysisImagePolicy, type AnalysisImagePolicy } from './image-preprocessing';
import { isVertexAICostOptimized, resolveVertexAIModel } from './gemini-cost';

export const COMBINED_PROFILE_SNAPSHOT_SCHEMA_VERSION = '2';
export const COMBINED_ANALYSIS_CACHE_TTL_DAYS = 30;
export const DEFAULT_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS = 12;
export const MIN_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS = 6;
export const MAX_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS = 24;
export const MAX_COMBINED_CACHE_BATCH_SIZE = 30;

const instagramUsername = z.string()
    .min(1)
    .max(30)
    .regex(/^[a-zA-Z0-9._]+$/);
const optionalHttpsUrl = z.string()
    .trim()
    .min(1)
    .max(8_192)
    .url()
    .refine((value) => new URL(value).protocol === 'https:', 'URL must use HTTPS')
    .optional();
const cachedRecentPostSchema = z.object({
    id: z.string().trim().min(1).max(100),
    shortCode: z.string().trim().regex(/^[A-Za-z0-9_-]{5,64}$/),
    caption: z.string().max(2_200).optional(),
    hashtags: z.array(z.string().max(100)).max(100),
    imageUrl: optionalHttpsUrl,
    type: z.enum(['image', 'video', 'carousel', 'reel']),
    likesCount: z.number().int().nonnegative(),
    commentsCount: z.number().int().nonnegative(),
    timestamp: z.string().max(64),
    taggedUsers: z.array(instagramUsername).max(100),
    mentionedUsers: z.array(instagramUsername).max(100),
}).strict();
const combinedProfileSnapshotAccountSchema = z.object({
    profile: z.object({
        username: instagramUsername,
        profilePicUrl: optionalHttpsUrl,
        fullName: z.string().max(200).optional(),
        bio: z.string().max(2_200).optional(),
        isPrivate: z.boolean(),
    }).strict(),
    recentPosts: z.array(cachedRecentPostSchema).max(50),
}).strict();
const combinedProfileSnapshotSchema = z.object({
    schemaVersion: z.literal(COMBINED_PROFILE_SNAPSHOT_SCHEMA_VERSION),
    capturedAt: z.string().datetime({ offset: true }),
    account: combinedProfileSnapshotAccountSchema,
}).strict();

const cacheEnvelopeSchema = z.object({
    version: z.string().min(1),
    result: combinedAnalysisResponseSchema,
    profileSnapshot: combinedProfileSnapshotSchema.optional(),
}).strict();

export type CombinedProfileSnapshotAccount = z.infer<typeof combinedProfileSnapshotAccountSchema>;
export type CombinedProfileSnapshot = z.infer<typeof combinedProfileSnapshotSchema>;
export type CombinedAnalysisCacheEntry = z.infer<typeof cacheEnvelopeSchema>;

export interface CreateCombinedProfileSnapshotInput {
    profile: {
        username: string;
        profilePicUrl?: string;
        fullName?: string;
        bio?: string;
        isPrivate: boolean;
    };
    recentPosts: Array<{
        id: string;
        shortCode: string;
        caption?: string;
        hashtags?: string[];
        imageUrl?: string;
        type: 'image' | 'video' | 'carousel' | 'reel';
        likesCount: number;
        commentsCount: number;
        timestamp: string;
        taggedUsers?: string[];
        mentionedUsers?: string[];
    }>;
}

interface CacheVersionOptions {
    costOptimized?: boolean;
    imagePolicy?: AnalysisImagePolicy;
    modelName?: string;
    promptTemplate?: string;
    schemaVersion?: string;
}

export function buildCombinedAnalysisCacheVersion(
    options: CacheVersionOptions = {}
): string {
    const costOptimized = options.costOptimized ?? isVertexAICostOptimized();
    const policy = options.imagePolicy ?? getAnalysisImagePolicy(costOptimized);
    const modelName = options.modelName
        ?? resolveVertexAIModel(process.env.VERTEX_AI_MODEL, costOptimized);
    const fingerprint = JSON.stringify({
        modelName,
        promptTemplate: options.promptTemplate ?? COMBINED_ANALYSIS_PROMPT,
        schemaVersion: options.schemaVersion ?? COMBINED_ANALYSIS_SCHEMA_VERSION,
        imagePolicy: policy,
    });
    return createHash('sha256').update(fingerprint).digest('hex');
}

export function createCombinedAnalysisCacheEntry(
    version: string,
    result: CombinedAnalysisResponse,
    profileSnapshot?: CombinedProfileSnapshot
): CombinedAnalysisCacheEntry {
    return cacheEnvelopeSchema.parse({ version, result, profileSnapshot });
}

export function parseCombinedAnalysisCacheEntry(
    value: unknown,
    expectedVersion: string
): CombinedAnalysisResponse | null {
    const parsed = cacheEnvelopeSchema.safeParse(value);
    if (!parsed.success || parsed.data.version !== expectedVersion) return null;
    return parsed.data.result;
}

export function createCombinedProfileSnapshot(
    input: CreateCombinedProfileSnapshotInput,
    capturedAt: string = new Date().toISOString()
): CombinedProfileSnapshot {
    return combinedProfileSnapshotSchema.parse(buildCombinedProfileSnapshotValue(input, capturedAt));
}

function buildCombinedProfileSnapshotValue(
    input: CreateCombinedProfileSnapshotInput,
    capturedAt: string
) {
    return {
        schemaVersion: COMBINED_PROFILE_SNAPSHOT_SCHEMA_VERSION,
        capturedAt,
        account: {
            profile: input.profile,
            recentPosts: input.recentPosts.map((post) => ({
                id: post.id,
                shortCode: post.shortCode,
                ...(post.caption ? { caption: post.caption } : {}),
                hashtags: post.hashtags ?? [],
                ...(post.imageUrl ? { imageUrl: post.imageUrl } : {}),
                type: post.type,
                likesCount: post.likesCount,
                commentsCount: post.commentsCount,
                timestamp: post.timestamp,
                taggedUsers: post.taggedUsers ?? [],
                mentionedUsers: post.mentionedUsers ?? [],
            })),
        },
    };
}

export function tryCreateCombinedProfileSnapshot(
    input: CreateCombinedProfileSnapshotInput,
    capturedAt: string = new Date().toISOString()
): CombinedProfileSnapshot | null {
    const parsed = combinedProfileSnapshotSchema.safeParse(
        buildCombinedProfileSnapshotValue(input, capturedAt)
    );
    return parsed.success ? parsed.data : null;
}

export function parseCombinedProfileSnapshot(
    value: unknown,
    expectedVersion: string,
    options: {
        nowMs?: number;
        ttlHours?: number;
    } = {}
): CombinedProfileSnapshotAccount | null {
    const parsed = cacheEnvelopeSchema.safeParse(value);
    if (!parsed.success || parsed.data.version !== expectedVersion) return null;

    const snapshot = parsed.data.profileSnapshot;
    if (!snapshot) return null;

    const ttlHours = options.ttlHours ?? getCombinedProfileSnapshotTtlHours();
    if (!Number.isInteger(ttlHours)
        || ttlHours < MIN_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS
        || ttlHours > MAX_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS) {
        return null;
    }

    const nowMs = options.nowMs ?? Date.now();
    const capturedAtMs = Date.parse(snapshot.capturedAt);
    const ageMs = nowMs - capturedAtMs;
    const maxFutureClockSkewMs = 5 * 60 * 1_000;
    if (!Number.isFinite(capturedAtMs)
        || ageMs > ttlHours * 60 * 60 * 1_000
        || ageMs < -maxFutureClockSkewMs) {
        return null;
    }

    return snapshot.account;
}

export function getCombinedProfileSnapshotTtlHours(
    rawValue: string | undefined = process.env.AI_PROFILE_SNAPSHOT_TTL_HOURS
): number {
    if (!rawValue?.trim()) return DEFAULT_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS;
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed)
        || parsed < MIN_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS
        || parsed > MAX_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS) {
        return DEFAULT_COMBINED_PROFILE_SNAPSHOT_TTL_HOURS;
    }
    return parsed;
}
