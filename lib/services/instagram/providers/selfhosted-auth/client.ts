import { GoogleAuth } from 'google-auth-library';
import { z } from 'zod';
import type {
    ApifyPostComment,
    ApifyPostLiker,
} from '../apify-interactions';
import type { InstagramFollower } from '@/lib/types/instagram';

const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;
const RUN_ID_PATTERN = /^[A-Za-z0-9]{8,64}$/;
const OPERATION_KEY_PATTERN = /^[a-z][a-z0-9-]{1,63}:[a-f0-9]{64}$/;
const INPUT_HASH_PATTERN = /^[a-f0-9]{64}$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const followerSchema = z.object({
    username: z.string().regex(USERNAME_PATTERN),
    fullName: z.string().max(200).optional(),
    profilePicUrl: z.string().url().startsWith('https://').optional(),
    isPrivate: z.boolean(),
    isVerified: z.boolean(),
}).strict();

const likerSchema = z.object({
    postUrl: z.string().url(),
    id: z.string().min(1).max(255),
    username: z.string().regex(USERNAME_PATTERN),
    fullName: z.string().max(200).optional(),
    profilePicUrl: z.string().url().startsWith('https://'),
    isPrivate: z.boolean(),
    isVerified: z.boolean(),
    totalLikes: z.number().int().nonnegative(),
}).strict();

const commentSchema = z.object({
    postUrl: z.string().url(),
    commentUrl: z.string().url().optional(),
    parentCommentUrl: z.string().url().optional(),
    id: z.string().min(1).max(255),
    text: z.string().min(1).max(1_000),
    ownerUsername: z.string().regex(USERNAME_PATTERN),
    ownerProfilePicUrl: z.string().url().startsWith('https://').optional(),
    timestamp: z.string().datetime({ offset: true }),
    likesCount: z.number().int().nonnegative().optional(),
}).strict();
const relationshipItemsSchema = z.array(followerSchema).max(1_200);
const likerItemsSchema = z.array(likerSchema).max(1_500);
const commentItemsSchema = z.array(commentSchema).max(150);

function responseSchema<T extends z.ZodType>(item: T, maximumItems: number) {
    return z.object({
        schemaVersion: z.literal(1),
        runId: z.string().regex(RUN_ID_PATTERN),
        accountSlot: z.literal('primary'),
        items: z.array(item).max(maximumItems),
    }).strict();
}

const relationshipResponseSchema = responseSchema(followerSchema, 1_200);
const likerResponseSchema = responseSchema(likerSchema, 1_500);
const commentResponseSchema = responseSchema(commentSchema, 150);
const errorSchema = z.object({
    schemaVersion: z.literal(1),
    code: z.enum([
        'account_quarantined',
        'authentication_failed',
        'invalid_request',
        'instagram_challenge',
        'instagram_rate_limited',
        'durable_state_unavailable',
        'idempotency_key_reused',
        'idempotency_pending',
        'queue_full',
        'queue_timeout',
        'upstream_error',
    ]),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
}).strict();

function parseCachedItems<T>(schema: z.ZodType<T[]>, raw: unknown): T[] {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
        throw new SelfHostedAuthWorkerError('invalid_response', false, null);
    }
    return parsed.data;
}

export function parseSelfHostedAuthRelationshipItems(raw: unknown): InstagramFollower[] {
    return parseCachedItems(relationshipItemsSchema, raw);
}

export function parseSelfHostedAuthLikerItems(raw: unknown): ApifyPostLiker[] {
    return parseCachedItems(likerItemsSchema, raw);
}

export function parseSelfHostedAuthCommentItems(raw: unknown): ApifyPostComment[] {
    return parseCachedItems(commentItemsSchema, raw);
}

export type SelfHostedAuthWorkerErrorCode =
    | z.infer<typeof errorSchema>['code']
    | 'invalid_response'
    | 'request_timeout'
    | 'transport_error'
    | 'request_cancelled';

export class SelfHostedAuthWorkerError extends Error {
    constructor(
        readonly code: SelfHostedAuthWorkerErrorCode,
        readonly retryable: boolean,
        readonly status: number | null,
        readonly retryAfterSeconds?: number
    ) {
        super(`SELFHOSTED_AUTH_WORKER_ERROR: ${code}`);
        this.name = 'SelfHostedAuthWorkerError';
    }
}

const FALLBACK_ELIGIBLE_WORKER_CODES = new Set<SelfHostedAuthWorkerErrorCode>([
    'transport_error',
    'request_timeout',
    'queue_full',
    'queue_timeout',
    'upstream_error',
    'instagram_rate_limited',
    'instagram_challenge',
    'authentication_failed',
    'account_quarantined',
]);

/** Only worker availability/account-state failures may enter the paid fallback path. */
export function isSelfHostedAuthFallbackEligible(error: unknown): boolean {
    return error instanceof SelfHostedAuthWorkerError
        && FALLBACK_ELIGIBLE_WORKER_CODES.has(error.code);
}

export type SelfHostedAuthWorkerConfig = {
    enabled: true;
    audience: string;
    baseUrl: string;
    timeoutMs: number;
} & (
    | { authMode: 'oidc'; bearerToken?: never }
    | { authMode: 'bearer'; bearerToken: string }
);

function boundedTimeout(raw: string | undefined): number {
    if (raw === undefined) return 240_000;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: SELFHOSTED_AUTH_WORKER_TIMEOUT_MS must be an integer from 1000 to 300000.'
        );
    }
    return value;
}

function workerUrl(raw: string | undefined, allowLocalHttp: boolean): URL {
    if (!raw) {
        throw new Error('SCRAPING_CONFIG_ERROR: SELFHOSTED_AUTH_WORKER_URL is required.');
    }
    let value: URL;
    try {
        value = new URL(raw);
    } catch {
        throw new Error('SCRAPING_CONFIG_ERROR: SELFHOSTED_AUTH_WORKER_URL is invalid.');
    }
    if (
        value.username
        || value.password
        || value.search
        || value.hash
        || (value.pathname !== '' && value.pathname !== '/')
        || (value.protocol !== 'https:'
            && !(allowLocalHttp && value.protocol === 'http:' && LOCAL_HOSTS.has(value.hostname)))
    ) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: SELFHOSTED_AUTH_WORKER_URL must be a private HTTPS origin.'
        );
    }
    return value;
}

export function getSelfHostedAuthWorkerConfig(
    env: Record<string, string | undefined> = process.env
): SelfHostedAuthWorkerConfig {
    if (env.SELFHOSTED_AUTH_ENABLED !== 'true') {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: SELFHOSTED_AUTH_ENABLED must be true.'
        );
    }
    const authMode = env.SELFHOSTED_AUTH_WORKER_AUTH_MODE ?? 'oidc';
    if (authMode !== 'oidc' && authMode !== 'bearer') {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: SELFHOSTED_AUTH_WORKER_AUTH_MODE must be oidc or bearer.'
        );
    }
    if (authMode === 'bearer' && env.NODE_ENV === 'production') {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: bearer authentication is limited to local development.'
        );
    }
    const url = workerUrl(
        env.SELFHOSTED_AUTH_WORKER_URL,
        env.NODE_ENV !== 'production' && authMode === 'bearer'
    );
    const baseUrl = url.origin;
    const audience = env.SELFHOSTED_AUTH_WORKER_OIDC_AUDIENCE?.trim()
        || (authMode === 'oidc' ? baseUrl : 'https://local-bearer.invalid');
    if (authMode === 'oidc' && !audience.startsWith('https://')) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: SELFHOSTED_AUTH_WORKER_OIDC_AUDIENCE must use HTTPS.'
        );
    }
    const common = {
        enabled: true as const,
        audience,
        baseUrl,
        timeoutMs: boundedTimeout(env.SELFHOSTED_AUTH_WORKER_TIMEOUT_MS),
    };
    if (authMode === 'oidc') return { ...common, authMode };
    const bearerToken = env.SELFHOSTED_AUTH_WORKER_BEARER_TOKEN;
    if (!bearerToken || bearerToken.length < 32 || bearerToken.length > 512) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: SELFHOSTED_AUTH_WORKER_BEARER_TOKEN must contain 32 to 512 characters.'
        );
    }
    return { ...common, authMode, bearerToken };
}

type WorkerResponse<T> = {
    schemaVersion: 1;
    runId: string;
    accountSlot: 'primary';
    items: T[];
};

export interface SelfHostedAuthWorkerClient {
    getRelationship(
        side: 'followers' | 'following',
        username: string,
        limit: number,
        options: SelfHostedAuthWorkerRequestOptions
    ): Promise<WorkerResponse<InstagramFollower>>;
    getPostLikers(
        postUrls: readonly string[],
        limitPerPost: number,
        options: SelfHostedAuthWorkerRequestOptions
    ): Promise<WorkerResponse<ApifyPostLiker>>;
    getPostComments(
        postUrls: readonly string[],
        limitPerPost: number,
        options: SelfHostedAuthWorkerRequestOptions
    ): Promise<WorkerResponse<ApifyPostComment>>;
}

export interface SelfHostedAuthWorkerRequestOptions {
    operationKey: string;
    inputHash: string;
    /** Cancels only this Node wait; the worker shields an already-started Instagram operation. */
    signal?: AbortSignal;
}

export interface SelfHostedAuthWorkerClientDependencies {
    config?: SelfHostedAuthWorkerConfig;
    env?: Record<string, string | undefined>;
    fetch?: typeof globalThis.fetch;
    getAuthorizationHeader?(audience: string): Promise<string>;
}

async function defaultAuthorizationHeader(audience: string): Promise<string> {
    const client = await new GoogleAuth().getIdTokenClient(audience);
    const headers = await client.getRequestHeaders();
    const authorization = headers.get('authorization');
    if (!authorization) {
        throw new SelfHostedAuthWorkerError('authentication_failed', false, null);
    }
    return authorization;
}

function validatedUsername(value: string): string {
    const normalized = value.trim().replace(/^@/, '').toLowerCase();
    if (!USERNAME_PATTERN.test(normalized)) {
        throw new Error('SCRAPING_CONFIG_ERROR: authenticated scraper username is invalid.');
    }
    return normalized;
}

function validatedLimit(value: number, maximum: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new Error(
            `SCRAPING_CONFIG_ERROR: authenticated scraper ${label} is out of range.`
        );
    }
    return value;
}

function validatedPostUrls(values: readonly string[]): string[] {
    if (values.length < 1 || values.length > 10) {
        throw new Error('SCRAPING_CONFIG_ERROR: authenticated scraper post URLs are invalid.');
    }
    const canonical = values.map(raw => {
        let url: URL;
        try {
            url = new URL(raw);
        } catch {
            throw new Error('SCRAPING_CONFIG_ERROR: authenticated scraper post URL is invalid.');
        }
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        const parts = url.pathname.split('/').filter(Boolean);
        if (
            url.protocol !== 'https:'
            || host !== 'instagram.com'
            || !['p', 'reel', 'reels'].includes(parts[0])
            || parts.length !== 2
            || !/^[A-Za-z0-9_-]+$/.test(parts[1])
        ) {
            throw new Error('SCRAPING_CONFIG_ERROR: authenticated scraper post URL is invalid.');
        }
        const kind = parts[0] === 'p' ? 'p' : 'reel';
        return `https://www.instagram.com/${kind}/${parts[1]}/`;
    });
    if (new Set(canonical).size !== canonical.length) {
        throw new Error('SCRAPING_CONFIG_ERROR: authenticated scraper post URLs are invalid.');
    }
    return canonical;
}

function validatedRequestIdentity(
    options: SelfHostedAuthWorkerRequestOptions
): Pick<SelfHostedAuthWorkerRequestOptions, 'operationKey' | 'inputHash'> {
    if (
        !OPERATION_KEY_PATTERN.test(options.operationKey)
        || !INPUT_HASH_PATTERN.test(options.inputHash)
    ) {
        throw new Error('ANALYSIS_V2_SELFHOSTED_AUTH_IDENTITY_MISSING');
    }
    return { operationKey: options.operationKey, inputHash: options.inputHash };
}

export function createSelfHostedAuthWorkerClient(
    dependencies: SelfHostedAuthWorkerClientDependencies = {}
): SelfHostedAuthWorkerClient {
    const config = dependencies.config
        ?? getSelfHostedAuthWorkerConfig(dependencies.env ?? process.env);
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const oidcHeader = dependencies.getAuthorizationHeader ?? defaultAuthorizationHeader;

    const request = async <T>(
        pathname: string,
        body: Record<string, unknown>,
        schema: z.ZodType<WorkerResponse<T>>,
        options: SelfHostedAuthWorkerRequestOptions
    ): Promise<WorkerResponse<T>> => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
        const onCallerAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onCallerAbort, { once: true });
        try {
            if (options.signal?.aborted) {
                throw new SelfHostedAuthWorkerError('request_cancelled', false, null);
            }
            const authorization = config.authMode === 'bearer'
                ? `Bearer ${config.bearerToken}`
                : await oidcHeader(config.audience);
            if (options.signal?.aborted) {
                throw new SelfHostedAuthWorkerError('request_cancelled', false, null);
            }
            const response = await fetchImpl(`${config.baseUrl}${pathname}`, {
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    authorization,
                    'content-type': 'application/json',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            const raw: unknown = await response.json().catch(() => null);
            if (!response.ok) {
                const parsed = errorSchema.safeParse(raw);
                if (!parsed.success) {
                    throw new SelfHostedAuthWorkerError(
                        'invalid_response',
                        false,
                        response.status
                    );
                }
                throw new SelfHostedAuthWorkerError(
                    parsed.data.code,
                    parsed.data.retryable,
                    response.status,
                    parsed.data.retryAfterSeconds
                );
            }
            const parsed = schema.safeParse(raw);
            if (!parsed.success) {
                throw new SelfHostedAuthWorkerError('invalid_response', false, response.status);
            }
            return parsed.data;
        } catch (error) {
            if (error instanceof SelfHostedAuthWorkerError) throw error;
            if (options.signal?.aborted) {
                throw new SelfHostedAuthWorkerError('request_cancelled', false, null);
            }
            if (error instanceof Error && error.name === 'AbortError') {
                throw new SelfHostedAuthWorkerError('request_timeout', true, null);
            }
            throw new SelfHostedAuthWorkerError('transport_error', true, null);
        } finally {
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', onCallerAbort);
        }
    };

    return {
        getRelationship(side, username, limit, options) {
            const identity = validatedRequestIdentity(options);
            return request(
                `/v1/relationships/${side}`,
                {
                    ...identity,
                    username: validatedUsername(username),
                    limit: validatedLimit(limit, 1_200, 'limit'),
                },
                relationshipResponseSchema,
                options
            );
        },
        getPostLikers(postUrls, limitPerPost, options) {
            const identity = validatedRequestIdentity(options);
            return request(
                '/v1/interactions/likers',
                {
                    ...identity,
                    postUrls: validatedPostUrls(postUrls),
                    limitPerPost: validatedLimit(limitPerPost, 150, 'limitPerPost'),
                },
                likerResponseSchema,
                options
            );
        },
        getPostComments(postUrls, limitPerPost, options) {
            const identity = validatedRequestIdentity(options);
            return request(
                '/v1/interactions/comments',
                {
                    ...identity,
                    postUrls: validatedPostUrls(postUrls),
                    limitPerPost: validatedLimit(limitPerPost, 15, 'limitPerPost'),
                },
                commentResponseSchema,
                options
            );
        },
    };
}
