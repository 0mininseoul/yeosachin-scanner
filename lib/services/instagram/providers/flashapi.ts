import { z } from 'zod';
import type { InstagramFollower } from '@/lib/types/instagram';
import type {
    ProviderCallContext,
    ScraperProvider,
} from './types';
import { INSTAGRAM_USERNAME_PATTERN, isInstagramUsername } from '../username';

const FLASHAPI_HOST = 'flashapi1.p.rapidapi.com';
const USER_ID_PATH = '/ig/user_id/';
const RELATIONSHIP_PATH = {
    followers: '/ig/followers/',
    following: '/ig/following/',
} as const;
const MAX_RELATIONSHIP_LIMIT = 500_000;

export type FlashRelationshipKind = keyof typeof RELATIONSHIP_PATH;

export interface FlashApiRuntimeConfig {
    key: string;
    host: string;
    baseUrl: string;
    timeoutMs: number;
    retries: number;
    retryBaseDelayMs: number;
    minIntervalMs: number;
    maxPages: number;
    userIdCacheTtlMs: number;
    estimatedCostPerRequestUsd: number;
    minimumUniqueRatio: number;
    maxRequestsPerOperation: number;
    maxEstimatedCostUsdPerOperation: number;
    rateLimitRemainingReserve: number;
    quotaStateTtlMs: number;
}

export interface FlashApiRateLimiter {
    schedule<T>(task: () => Promise<T>, minIntervalMs: number): Promise<T>;
}

interface FlashApiClientDeps {
    config?: FlashApiRuntimeConfig | (() => FlashApiRuntimeConfig);
    fetchFn?: typeof fetch;
    limiter?: FlashApiRateLimiter;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

export interface FlashApiClient {
    resolveUserId(
        usernameOrId: string,
        context?: ProviderCallContext,
        budget?: FlashOperationBudget
    ): Promise<string>;
    getRelationshipByUserId(
        userId: string,
        kind: FlashRelationshipKind,
        limit: number,
        context?: ProviderCallContext,
        budget?: FlashOperationBudget
    ): Promise<InstagramFollower[]>;
}

export interface FlashOperationBudget {
    requestCount: number;
    estimatedCostUsd: number;
    observedRemaining?: number;
}

const decimalIdSchema = z.union([
    z.string().regex(/^[1-9]\d*$/),
    z.number().int().positive().safe(),
]);

const flashUserSchema = z.object({
    id: decimalIdSchema.optional(),
    id_user: decimalIdSchema.optional(),
    username: z.string().trim().regex(INSTAGRAM_USERNAME_PATTERN),
    full_name: z.string().nullable().optional(),
    profile_pic_url: z.string().min(1).nullable().optional(),
    is_private: z.boolean(),
    is_verified: z.boolean(),
}).passthrough();

const relationshipEnvelopeSchema = z.object({
    users: z.array(flashUserSchema),
    next_max_id: z.string().min(1).nullable().optional(),
    has_more: z.boolean().optional(),
    status: z.enum(['ok', 'success']).optional(),
}).passthrough();

interface ParsedRelationshipPage {
    users: InstagramFollower[];
    nextMaxId?: string;
    hasMore?: boolean;
}

interface FlashClientQuotaState {
    remaining: number;
    expiresAt: number;
}

class FlashApiRequestError extends Error {
    constructor(
        message: string,
        readonly retryable: boolean,
        readonly retryAfterMs?: number
    ) {
        super(message);
        this.name = 'FlashApiRequestError';
    }
}

function numberFromEnv(
    env: Record<string, string | undefined>,
    key: string,
    fallback: number,
    min: number,
    max: number
): number {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        throw new Error(`SCRAPING_CONFIG_ERROR: ${key}는 ${min}~${max} 범위의 숫자여야 합니다.`);
    }
    return parsed;
}

function integerFromEnv(
    env: Record<string, string | undefined>,
    key: string,
    fallback: number,
    min: number,
    max: number
): number {
    const value = numberFromEnv(env, key, fallback, min, max);
    if (!Number.isInteger(value)) {
        throw new Error(`SCRAPING_CONFIG_ERROR: ${key}는 정수여야 합니다.`);
    }
    return value;
}

export function getFlashApiConfig(
    env: Record<string, string | undefined> = process.env
): FlashApiRuntimeConfig {
    const key = env.FLASHAPI_RAPIDAPI_KEY || env.RAPIDAPI_KEY;
    if (!key) {
        throw new Error(
            'SCRAPING_CONFIG_ERROR: FLASHAPI_RAPIDAPI_KEY(또는 RAPIDAPI_KEY)가 설정되지 않았습니다.'
        );
    }

    const rawHost = env.FLASHAPI_RAPIDAPI_HOST || FLASHAPI_HOST;
    const host = rawHost.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (host !== FLASHAPI_HOST) {
        throw new Error(`SCRAPING_CONFIG_ERROR: FlashAPI host는 ${FLASHAPI_HOST}여야 합니다.`);
    }

    return {
        key,
        host,
        baseUrl: `https://${host}`,
        timeoutMs: integerFromEnv(env, 'FLASHAPI_TIMEOUT_MS', 10_000, 250, 120_000),
        retries: integerFromEnv(env, 'FLASHAPI_RETRIES', 0, 0, 5),
        retryBaseDelayMs: integerFromEnv(env, 'FLASHAPI_RETRY_BASE_DELAY_MS', 500, 0, 30_000),
        minIntervalMs: integerFromEnv(env, 'FLASHAPI_MIN_INTERVAL_MS', 1_100, 0, 60_000),
        maxPages: integerFromEnv(env, 'FLASHAPI_MAX_PAGES', 200, 1, 10_000),
        userIdCacheTtlMs: integerFromEnv(
            env,
            'FLASHAPI_USER_ID_CACHE_TTL_MS',
            600_000,
            0,
            86_400_000
        ),
        estimatedCostPerRequestUsd: numberFromEnv(
            env,
            'FLASHAPI_ESTIMATED_COST_PER_REQUEST_USD',
            0.00099,
            0.00000001,
            100
        ),
        minimumUniqueRatio: numberFromEnv(env, 'FLASHAPI_MIN_UNIQUE_RATIO', 0.6, 0, 1),
        maxRequestsPerOperation: integerFromEnv(
            env,
            'FLASHAPI_MAX_REQUESTS_PER_OPERATION',
            210,
            1,
            10_000
        ),
        maxEstimatedCostUsdPerOperation: numberFromEnv(
            env,
            'FLASHAPI_MAX_ESTIMATED_COST_USD_PER_OPERATION',
            0.21,
            0.00000001,
            10_000
        ),
        rateLimitRemainingReserve: integerFromEnv(
            env,
            'FLASHAPI_RATE_LIMIT_REMAINING_RESERVE',
            5,
            0,
            1_000_000
        ),
        quotaStateTtlMs: integerFromEnv(
            env,
            'FLASHAPI_QUOTA_STATE_TTL_MS',
            86_400_000,
            1_000,
            2_678_400_000
        ),
    };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createFlashApiRateLimiter(
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = defaultSleep
): FlashApiRateLimiter {
    let tail: Promise<void> = Promise.resolve();
    let nextStartAt = 0;

    return {
        schedule<T>(task: () => Promise<T>, minIntervalMs: number): Promise<T> {
            const gate = tail.then(async () => {
                const delayMs = Math.max(0, nextStartAt - now());
                if (delayMs > 0) await sleep(delayMs);
                nextStartAt = now() + minIntervalMs;
            });
            tail = gate.then(() => undefined, () => undefined);
            return gate.then(task);
        },
    };
}

function toDecimalId(value: z.infer<typeof decimalIdSchema>): string {
    return typeof value === 'number' ? String(value) : value;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

/** The marketplace does not publish a response schema, so only four explicit ID locations are accepted. */
export function parseFlashApiUserId(payload: unknown): string {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('SCRAPING_SCHEMA_ERROR: FlashAPI user-id 응답이 객체가 아닙니다.');
    }

    const root = payload as Record<string, unknown>;
    const candidates: unknown[] = [];
    if (hasOwn(root, 'id')) candidates.push(root.id);
    if (hasOwn(root, 'id_user')) candidates.push(root.id_user);

    if (hasOwn(root, 'data')) {
        if (!root.data || typeof root.data !== 'object' || Array.isArray(root.data)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: FlashAPI user-id data 형식이 올바르지 않습니다.');
        }
        const data = root.data as Record<string, unknown>;
        if (hasOwn(data, 'id')) candidates.push(data.id);
        if (hasOwn(data, 'id_user')) candidates.push(data.id_user);
    }

    if (candidates.length === 0) {
        throw new Error('SCRAPING_SCHEMA_ERROR: FlashAPI user-id 응답에 유일한 id가 없습니다.');
    }
    const ids = new Set<string>();
    for (const candidate of candidates) {
        const parsed = decimalIdSchema.safeParse(candidate);
        if (!parsed.success) {
            throw new Error('SCRAPING_SCHEMA_ERROR: FlashAPI user-id가 10진수가 아닙니다.');
        }
        ids.add(toDecimalId(parsed.data));
    }
    if (ids.size !== 1) {
        throw new Error('SCRAPING_SCHEMA_ERROR: FlashAPI user-id 응답에 서로 다른 id가 있습니다.');
    }
    return [...ids][0];
}

export function parseFlashRelationshipPage(payload: unknown): ParsedRelationshipPage {
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        const root = payload as Record<string, unknown>;
        const nested = root.data;
        if (
            hasOwn(root, 'users') &&
            nested &&
            typeof nested === 'object' &&
            !Array.isArray(nested) &&
            hasOwn(nested as Record<string, unknown>, 'users')
        ) {
            throw new Error('SCRAPING_SCHEMA_ERROR: FlashAPI 목록 응답 엔벨로프가 중복됩니다.');
        }
    }
    let parsed = relationshipEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error(`SCRAPING_SCHEMA_ERROR: FlashAPI 목록 응답 형식 불일치. ${parsed.error.issues[0]?.message ?? ''}`);
        }
        const root = payload as Record<string, unknown>;
        if (!hasOwn(root, 'data')) {
            throw new Error(`SCRAPING_SCHEMA_ERROR: FlashAPI 목록 응답 형식 불일치. ${parsed.error.issues[0]?.message ?? ''}`);
        }
        parsed = relationshipEnvelopeSchema.safeParse(root.data);
        if (!parsed.success) {
            throw new Error(`SCRAPING_SCHEMA_ERROR: FlashAPI data.users 응답 형식 불일치. ${parsed.error.issues[0]?.message ?? ''}`);
        }
    }

    const envelope = parsed.data;
    if (envelope.has_more === true && !envelope.next_max_id) {
        throw new Error('SCRAPING_INCOMPLETE_ERROR: has_more=true이지만 next_max_id가 없습니다.');
    }
    if (envelope.has_more === false && envelope.next_max_id) {
        throw new Error('SCRAPING_SCHEMA_ERROR: has_more=false인 응답에 next_max_id가 포함되어 있습니다.');
    }

    return {
        users: envelope.users.map((user) => ({
            username: user.username,
            fullName: user.full_name ?? undefined,
            profilePicUrl: user.profile_pic_url ?? undefined,
            isPrivate: user.is_private,
            isVerified: user.is_verified,
        })),
        nextMaxId: envelope.next_max_id ?? undefined,
        hasMore: envelope.has_more,
    };
}

function validateLimit(limit: number): void {
    if (!Number.isInteger(limit) || limit < 0 || limit > MAX_RELATIONSHIP_LIMIT) {
        throw new Error(
            `SCRAPING_CONFIG_ERROR: limit은 0~${MAX_RELATIONSHIP_LIMIT} 범위의 정수여야 합니다.`
        );
    }
}

function validateDecimalUserId(userId: string): void {
    if (!/^[1-9]\d*$/.test(userId)) {
        throw new Error('SCRAPING_CONFIG_ERROR: id_user는 10진수 문자열이어야 합니다.');
    }
}

function parseRetryAfter(response: Response, now: () => number): number | undefined {
    const raw = response.headers.get('retry-after');
    if (!raw) return undefined;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(0, at - now()) : undefined;
}

function parseRateLimitHeader(response: Response, name: string): number | undefined {
    const raw = response.headers.get(name);
    if (raw === null || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function quotaResetAt(
    response: Response,
    observedAt: number
): number | undefined {
    const raw = response.headers.get('x-ratelimit-requests-reset');
    if (raw !== null && raw.trim() !== '') {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 31 * 24 * 60 * 60) {
            return observedAt + seconds * 1_000;
        }
    }
    return undefined;
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

const sharedRateLimiter = createFlashApiRateLimiter();

function createOperationBudget(): FlashOperationBudget {
    return { requestCount: 0, estimatedCostUsd: 0 };
}

function reserveFlashRequest(
    budget: FlashOperationBudget,
    config: FlashApiRuntimeConfig,
    clientObservedRemaining: number | undefined
): void {
    if (budget.requestCount + 1 > config.maxRequestsPerOperation) {
        throw new FlashApiRequestError(
            'SCRAPING_BUDGET_ERROR: FlashAPI operation request ceiling reached.',
            false
        );
    }
    if (
        budget.estimatedCostUsd + config.estimatedCostPerRequestUsd >
        config.maxEstimatedCostUsdPerOperation + Number.EPSILON
    ) {
        throw new FlashApiRequestError(
            'SCRAPING_BUDGET_ERROR: FlashAPI operation cost ceiling reached.',
            false
        );
    }
    if (
        (budget.observedRemaining !== undefined &&
            budget.observedRemaining <= config.rateLimitRemainingReserve) ||
        (clientObservedRemaining !== undefined &&
            clientObservedRemaining <= config.rateLimitRemainingReserve)
    ) {
        throw new FlashApiRequestError(
            'SCRAPING_BUDGET_ERROR: FlashAPI remaining quota reserve reached.',
            false
        );
    }
    budget.requestCount++;
    budget.estimatedCostUsd += config.estimatedCostPerRequestUsd;
}

export function makeFlashApiClient(deps: FlashApiClientDeps = {}): FlashApiClient {
    const fetchFn = deps.fetchFn ?? fetch;
    const limiter = deps.limiter ?? sharedRateLimiter;
    const sleep = deps.sleep ?? defaultSleep;
    const now = deps.now ?? Date.now;
    const configured = deps.config;
    const readConfig: () => FlashApiRuntimeConfig = typeof configured === 'function'
        ? configured
        : () => configured ?? getFlashApiConfig();
    const idCache = new Map<string, { expiresAt: number; value?: string; pending?: Promise<string> }>();
    let clientQuotaState: FlashClientQuotaState | undefined;
    let quotaGeneration = 0;

    function activeQuotaRemaining(at: number): number | undefined {
        if (clientQuotaState && at >= clientQuotaState.expiresAt) {
            clientQuotaState = undefined;
            quotaGeneration++;
        }
        return clientQuotaState?.remaining;
    }

    async function requestJson(
        path: string,
        params: Record<string, string>,
        config: FlashApiRuntimeConfig,
        context: ProviderCallContext | undefined,
        budget: FlashOperationBudget
    ): Promise<unknown> {
        const url = new URL(path, config.baseUrl);
        for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

        let lastError: unknown;
        for (let attempt = 0; attempt <= config.retries; attempt++) {
            try {
                const { response, text, requestQuotaGeneration } = await limiter.schedule(async () => {
                    const requestStartedAt = now();
                    const observedRemaining = activeQuotaRemaining(requestStartedAt);
                    reserveFlashRequest(budget, config, observedRemaining);
                    if (clientQuotaState) clientQuotaState.remaining--;
                    const requestQuotaGeneration = quotaGeneration;
                    context?.recordUsage({
                        request_count: 1,
                        estimated_cost_usd: config.estimatedCostPerRequestUsd,
                    });
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
                    try {
                        const response = await fetchFn(url, {
                            method: 'GET',
                            headers: {
                                'x-rapidapi-key': config.key,
                                'x-rapidapi-host': config.host,
                                Accept: 'application/json',
                            },
                            signal: controller.signal,
                        });
                        const text = await response.text();
                        return { response, text, requestQuotaGeneration };
                    } finally {
                        clearTimeout(timer);
                    }
                }, config.minIntervalMs);

                const rateLimit = parseRateLimitHeader(response, 'x-ratelimit-requests-limit');
                const rateRemaining = parseRateLimitHeader(
                    response,
                    'x-ratelimit-requests-remaining'
                );
                if (rateLimit !== undefined || rateRemaining !== undefined) {
                    context?.recordUsage({
                        ...(rateLimit !== undefined
                            ? { rate_limit_limit: rateLimit }
                            : {}),
                        ...(rateRemaining !== undefined
                            ? { rate_limit_remaining: rateRemaining }
                            : {}),
                    });
                }
                if (rateRemaining !== undefined) {
                    budget.observedRemaining = budget.observedRemaining === undefined
                        ? rateRemaining
                        : Math.min(budget.observedRemaining, rateRemaining);
                    activeQuotaRemaining(now());
                    if (requestQuotaGeneration === quotaGeneration) {
                        const observedAt = now();
                        const resetAt = quotaResetAt(response, observedAt);
                        clientQuotaState = clientQuotaState
                            ? {
                                remaining: Math.min(clientQuotaState.remaining, rateRemaining),
                                expiresAt: resetAt === undefined
                                    ? clientQuotaState.expiresAt
                                    : Math.max(clientQuotaState.expiresAt, resetAt),
                            }
                            : {
                                remaining: rateRemaining,
                                expiresAt: resetAt ?? observedAt + config.quotaStateTtlMs,
                            };
                    }
                }

                if (!response.ok) {
                    throw new FlashApiRequestError(
                        `SCRAPING_PAID_REQUEST_ERROR: FlashAPI 요청 실패 (HTTP ${response.status}).`,
                        isRetryableStatus(response.status),
                        parseRetryAfter(response, now)
                    );
                }

                try {
                    return JSON.parse(text) as unknown;
                } catch {
                    throw new FlashApiRequestError(
                        'SCRAPING_SCHEMA_ERROR: FlashAPI가 유효한 JSON을 반환하지 않았습니다.',
                        false
                    );
                }
            } catch (error) {
                lastError = error;
                const requestError = error instanceof FlashApiRequestError ? error : null;
                const retryable = requestError?.retryable ?? true;
                if (!retryable || attempt >= config.retries) break;
                const backoffMs = config.retryBaseDelayMs * 2 ** attempt;
                await sleep(Math.max(backoffMs, requestError?.retryAfterMs ?? 0));
            }
        }

        if (lastError instanceof FlashApiRequestError) throw lastError;
        const timedOut = lastError instanceof Error && lastError.name === 'AbortError';
        throw new Error(
            timedOut
                ? 'SCRAPING_PAID_REQUEST_AMBIGUOUS_ERROR: FlashAPI 요청 시간이 초과되었습니다.'
                : 'SCRAPING_PAID_REQUEST_AMBIGUOUS_ERROR: FlashAPI transport request failed.'
        );
    }

    async function resolveUserId(
        usernameOrId: string,
        context?: ProviderCallContext,
        budget: FlashOperationBudget = createOperationBudget()
    ): Promise<string> {
        const raw = usernameOrId.trim();
        if (/^[1-9]\d*$/.test(raw)) return raw;

        const username = raw.replace(/^@/, '').toLowerCase();
        if (!isInstagramUsername(username)) {
            throw new Error('SCRAPING_CONFIG_ERROR: Instagram username 형식이 올바르지 않습니다.');
        }

        const config = readConfig();
        const cached = idCache.get(username);
        if (cached?.pending) return cached.pending;
        if (cached?.value && cached.expiresAt >= now()) return cached.value;

        const pending = requestJson(USER_ID_PATH, { user: username }, config, context, budget)
            .then(parseFlashApiUserId)
            .then((value) => {
                idCache.set(username, { value, expiresAt: now() + config.userIdCacheTtlMs });
                return value;
            })
            .catch((error) => {
                idCache.delete(username);
                throw error;
            });
        idCache.set(username, { pending, expiresAt: now() + config.userIdCacheTtlMs });
        if (idCache.size > 1_000) idCache.delete(idCache.keys().next().value as string);
        return pending;
    }

    async function getRelationshipByUserId(
        userId: string,
        kind: FlashRelationshipKind,
        limit: number,
        context?: ProviderCallContext,
        budget: FlashOperationBudget = createOperationBudget()
    ): Promise<InstagramFollower[]> {
        validateDecimalUserId(userId);
        validateLimit(limit);
        if (limit === 0) return [];

        const config = readConfig();
        const unique = new Map<string, InstagramFollower>();
        const seenCursors = new Set<string>();
        let rawResultCount = 0;
        let noProgressPages = 0;
        let cursor: string | undefined;

        try {
            for (let page = 0; page < config.maxPages; page++) {
                const params: Record<string, string> = { id_user: userId };
                if (cursor) params.next_max_id = cursor;
                const payload = await requestJson(
                    RELATIONSHIP_PATH[kind],
                    params,
                    config,
                    context,
                    budget
                );
                const parsed = parseFlashRelationshipPage(payload);
                if (parsed.users.length === 0 && parsed.nextMaxId) {
                    throw new Error('SCRAPING_INCOMPLETE_ERROR: 빈 FlashAPI 페이지에 next_max_id가 포함되어 있습니다.');
                }

                const uniqueBeforePage = unique.size;
                for (const user of parsed.users) {
                    rawResultCount++;
                    const key = user.username.toLowerCase();
                    if (!unique.has(key)) unique.set(key, user);
                }
                const uniqueRatio = rawResultCount > 0 ? unique.size / rawResultCount : 1;
                if (uniqueRatio < config.minimumUniqueRatio) {
                    throw new Error('SCRAPING_INCOMPLETE_ERROR: FlashAPI 결과의 중복 비율이 허용 범위를 초과했습니다.');
                }
                noProgressPages = unique.size === uniqueBeforePage ? noProgressPages + 1 : 0;
                if (noProgressPages >= 2) {
                    throw new Error('SCRAPING_INCOMPLETE_ERROR: FlashAPI 커서는 진행했지만 새 결과가 추가되지 않았습니다.');
                }
                if (unique.size >= limit) {
                    const result = [...unique.values()].slice(0, limit);
                    context?.recordUsage({ result_count: result.length });
                    return result;
                }

                const nextCursor = parsed.nextMaxId;
                if (!nextCursor) {
                    const result = [...unique.values()];
                    context?.recordUsage({ result_count: result.length });
                    return result;
                }
                if (seenCursors.has(nextCursor)) {
                    throw new Error('SCRAPING_INCOMPLETE_ERROR: FlashAPI next_max_id 커서가 반복되었습니다.');
                }
                seenCursors.add(nextCursor);
                cursor = nextCursor;
            }

            throw new Error(
                `SCRAPING_INCOMPLETE_ERROR: FlashAPI가 ${config.maxPages}페이지 내에 수집을 완료하지 못했습니다.`
            );
        } finally {
            context?.recordUsage({
                raw_result_count: rawResultCount,
                unique_result_count: unique.size,
            });
        }
    }

    return { resolveUserId, getRelationshipByUserId };
}

export function makeFlashApiProvider(client: FlashApiClient = makeFlashApiClient()): ScraperProvider {
    async function collect(
        username: string,
        limit: number,
        kind: FlashRelationshipKind,
        context?: ProviderCallContext
    ): Promise<InstagramFollower[]> {
        if (limit === 0) return [];
        const budget = createOperationBudget();
        const userId = await client.resolveUserId(username, context, budget);
        return client.getRelationshipByUserId(userId, kind, limit, context, budget);
    }

    return {
        name: 'flashapi',
        paid: true,
        getFollowers: (username, limit, context) => collect(username, limit, 'followers', context),
        getFollowing: (username, limit, context) => collect(username, limit, 'following', context),
    };
}

export const flashApiClient = makeFlashApiClient();
export const flashApiProvider = makeFlashApiProvider(flashApiClient);
