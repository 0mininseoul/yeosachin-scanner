import { getTransportConfig, buildRequest, type TransportConfig } from './transport';
import {
    createRequestStartGate,
    type RequestStartGate,
} from './rate-limit';
import { isInstagramUsername } from '../../username';

export const IG_APP_ID = '936619743392459';
export const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export interface WebProfileRuntimeConfig {
    timeoutMs: number;
    retries: number;
    retryBaseDelayMs: number;
    minIntervalMs: number;
    circuitCooldownMs: number;
    schemaFailureThreshold: number;
    transientFailureThreshold: number;
    maxRetryAfterMs: number;
}

interface FetchOptions {
    onRequest?(): void;
}

type FailureKind = 'auth' | 'circuit' | 'http' | 'rate_limit' | 'schema' | 'timeout' | 'transport';

class WebProfileRequestError extends Error {
    constructor(
        message: string,
        readonly kind: FailureKind,
        readonly retryable: boolean,
        readonly retryAfterMs?: number
    ) {
        super(message);
        this.name = 'WebProfileRequestError';
    }
}

export interface WebProfileCircuitBreaker {
    assertAvailable(allowProbe: boolean): void;
    recordSuccess(): void;
    recordFailure(error: WebProfileRequestError, config: WebProfileRuntimeConfig): void;
}

interface WebProfileFetcherDeps {
    env?: Record<string, string | undefined>;
    fetchFn?: typeof fetch;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    gate?: RequestStartGate;
    circuit?: WebProfileCircuitBreaker;
}

function integerSetting(
    env: Record<string, string | undefined>,
    key: string,
    fallback: number,
    min: number,
    max: number
): number {
    const raw = env[key];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new Error(`SCRAPING_CONFIG_ERROR: ${key}는 ${min}~${max} 범위의 정수여야 합니다.`);
    }
    return value;
}

export function getWebProfileConfig(
    env: Record<string, string | undefined> = process.env
): WebProfileRuntimeConfig {
    return {
        timeoutMs: integerSetting(env, 'SELFHOSTED_PROFILE_TIMEOUT_MS', 8_000, 250, 60_000),
        retries: integerSetting(env, 'SELFHOSTED_PROFILE_RETRIES', 1, 0, 3),
        retryBaseDelayMs: integerSetting(
            env,
            'SELFHOSTED_PROFILE_RETRY_BASE_DELAY_MS',
            750,
            0,
            30_000
        ),
        minIntervalMs: integerSetting(
            env,
            'SELFHOSTED_PROFILE_MIN_INTERVAL_MS',
            300,
            0,
            60_000
        ),
        circuitCooldownMs: integerSetting(
            env,
            'SELFHOSTED_PROFILE_CIRCUIT_COOLDOWN_MS',
            60_000,
            1_000,
            600_000
        ),
        schemaFailureThreshold: integerSetting(
            env,
            'SELFHOSTED_PROFILE_SCHEMA_FAILURE_THRESHOLD',
            2,
            1,
            10
        ),
        transientFailureThreshold: integerSetting(
            env,
            'SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD',
            3,
            1,
            10
        ),
        maxRetryAfterMs: integerSetting(
            env,
            'SELFHOSTED_PROFILE_MAX_RETRY_AFTER_MS',
            60_000,
            0,
            300_000
        ),
    };
}

export function createWebProfileCircuitBreaker(
    now: () => number = Date.now
): WebProfileCircuitBreaker {
    let openUntil = 0;
    let schemaFailures = 0;
    let transientFailures = 0;

    return {
        assertAvailable(allowProbe: boolean): void {
            if (!allowProbe && openUntil > now()) {
                throw new WebProfileRequestError(
                    'SCRAPING_ERROR: selfhosted profile circuit is open.',
                    'circuit',
                    false
                );
            }
        },
        recordSuccess(): void {
            openUntil = 0;
            schemaFailures = 0;
            transientFailures = 0;
        },
        recordFailure(error, config): void {
            if (error.kind === 'rate_limit' || error.kind === 'auth') {
                openUntil = Math.max(
                    openUntil,
                    now() + Math.max(config.circuitCooldownMs, error.retryAfterMs ?? 0)
                );
                return;
            }
            if (error.kind === 'schema') {
                schemaFailures++;
                if (schemaFailures >= config.schemaFailureThreshold) {
                    openUntil = Math.max(openUntil, now() + config.circuitCooldownMs);
                }
                return;
            }
            if (
                error.kind === 'timeout' ||
                error.kind === 'transport' ||
                (error.kind === 'http' && error.retryable)
            ) {
                transientFailures++;
                if (transientFailures >= config.transientFailureThreshold) {
                    openUntil = Math.max(openUntil, now() + config.circuitCooldownMs);
                }
            }
        },
    };
}

function profileUrl(username: string): string {
    return `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
}

function parseRetryAfter(
    response: Response,
    now: () => number,
    maximumMs: number
): number | undefined {
    const raw = response.headers.get('retry-after');
    if (raw === null || raw.trim() === '') return undefined;
    const seconds = Number(raw);
    const delay = Number.isFinite(seconds) && seconds >= 0
        ? seconds * 1_000
        : Math.max(0, Date.parse(raw) - now());
    return Number.isFinite(delay) ? Math.min(delay, maximumMs) : undefined;
}

function responseError(
    response: Response,
    now: () => number,
    maximumRetryAfterMs: number
): WebProfileRequestError {
    const retryAfterMs = parseRetryAfter(response, now, maximumRetryAfterMs);
    if (response.status === 401 || response.status === 403) {
        return new WebProfileRequestError(
            `SCRAPING_ERROR: web_profile_info authorization failure (HTTP ${response.status}).`,
            'auth',
            false,
            retryAfterMs
        );
    }
    if (response.status === 429) {
        return new WebProfileRequestError(
            'SCRAPING_ERROR: web_profile_info rate limited (HTTP 429).',
            'rate_limit',
            true,
            retryAfterMs
        );
    }
    const retryable = response.status === 408 || response.status === 425 || response.status >= 500;
    return new WebProfileRequestError(
        `SCRAPING_ERROR: web_profile_info request failed (HTTP ${response.status}).`,
        'http',
        retryable,
        retryAfterMs
    );
}

function schemaError(message: string): WebProfileRequestError {
    return new WebProfileRequestError(message, 'schema', true);
}

function validOptionalUrl(value: unknown): boolean {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
        return false;
    }
}

function validateRawUser(user: Record<string, unknown>, expectedUsername: string): void {
    if (
        typeof user.username !== 'string' ||
        !isInstagramUsername(user.username) ||
        user.username.toLowerCase() !== expectedUsername.toLowerCase()
    ) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info username mismatch.');
    }
    for (const key of ['edge_followed_by', 'edge_follow', 'edge_owner_to_timeline_media']) {
        const edge = user[key];
        const count = edge && typeof edge === 'object' && !Array.isArray(edge)
            ? (edge as Record<string, unknown>).count
            : undefined;
        if (!Number.isSafeInteger(count) || (count as number) < 0) {
            throw schemaError(`SCRAPING_SCHEMA_ERROR: web_profile_info ${key}.count invalid.`);
        }
    }
    if (typeof user.is_private !== 'boolean' || typeof user.is_verified !== 'boolean') {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info privacy flags invalid.');
    }
    for (const key of ['external_url', 'profile_pic_url', 'profile_pic_url_hd']) {
        if (!validOptionalUrl(user[key])) {
            throw schemaError(`SCRAPING_SCHEMA_ERROR: web_profile_info ${key} invalid.`);
        }
    }
}

function parseUser(payload: unknown, expectedUsername: string): Record<string, unknown> | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info response is not an object.');
    }
    const root = payload as Record<string, unknown>;
    if (!root.data || typeof root.data !== 'object' || Array.isArray(root.data)) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info data is missing.');
    }
    const data = root.data as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(data, 'user')) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info user field is missing.');
    }
    if (data.user === null) return null;
    if (!data.user || typeof data.user !== 'object' || Array.isArray(data.user)) {
        throw schemaError('SCRAPING_SCHEMA_ERROR: web_profile_info user field is invalid.');
    }
    const user = data.user as Record<string, unknown>;
    validateRawUser(user, expectedUsername);
    return user;
}

export function makeWebProfileFetcher(deps: WebProfileFetcherDeps = {}) {
    const fetchFn = deps.fetchFn ?? fetch;
    const now = deps.now ?? Date.now;
    const wait = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const gate = deps.gate ?? createRequestStartGate(now, wait);
    const circuit = deps.circuit ?? createWebProfileCircuitBreaker(now);

    return async function fetchProfile(
        username: string,
        transport: TransportConfig = getTransportConfig(deps.env ?? process.env),
        options: FetchOptions = {}
    ): Promise<Record<string, unknown> | null> {
        if (!isInstagramUsername(username)) {
            throw new Error('SCRAPING_CONFIG_ERROR: Instagram username 형식이 올바르지 않습니다.');
        }
        const config = getWebProfileConfig(deps.env ?? process.env);
        const { url } = buildRequest(profileUrl(username), transport);
        let lastError: unknown;
        let allowCircuitProbe = false;

        for (let attempt = 0; attempt <= config.retries; attempt++) {
            try {
                circuit.assertAvailable(allowCircuitProbe);
                const result = await gate.schedule(async () => {
                    circuit.assertAvailable(allowCircuitProbe);
                    options.onRequest?.();
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
                    try {
                        const response = await fetchFn(url, {
                            headers: {
                                'x-ig-app-id': IG_APP_ID,
                                'User-Agent': USER_AGENT,
                                Accept: '*/*',
                                'X-Requested-With': 'XMLHttpRequest',
                                Referer: `https://www.instagram.com/${encodeURIComponent(username)}/`,
                            },
                            signal: controller.signal,
                        });
                        if (response.status === 404) return null;
                        if (!response.ok) {
                            throw responseError(response, now, config.maxRetryAfterMs);
                        }
                        let payload: unknown;
                        try {
                            payload = await response.json();
                        } catch (error) {
                            if (error instanceof Error && error.name === 'AbortError') throw error;
                            throw new WebProfileRequestError(
                                'SCRAPING_SCHEMA_ERROR: web_profile_info returned invalid JSON.',
                                'schema',
                                true
                            );
                        }
                        return parseUser(payload, username);
                    } finally {
                        clearTimeout(timer);
                    }
                }, config.minIntervalMs);
                circuit.recordSuccess();
                return result;
            } catch (error) {
                const classified = error instanceof WebProfileRequestError
                    ? error
                    : error instanceof Error && error.name === 'AbortError'
                      ? new WebProfileRequestError(
                          'SCRAPING_TIMEOUT_ERROR: web_profile_info request timed out.',
                          'timeout',
                          true
                      )
                      : new WebProfileRequestError(
                          'SCRAPING_ERROR: web_profile_info transport request failed.',
                          'transport',
                          true
                      );
                lastError = classified;
                circuit.recordFailure(classified, config);
                if (!classified.retryable || attempt >= config.retries) break;
                allowCircuitProbe = classified.kind === 'rate_limit' || classified.kind === 'schema';
                const backoffMs = config.retryBaseDelayMs * 2 ** attempt;
                await wait(Math.max(backoffMs, classified.retryAfterMs ?? 0));
            }
        }
        throw lastError;
    };
}

const sharedStartGate = createRequestStartGate();
const sharedCircuit = createWebProfileCircuitBreaker();
const defaultFetcher = makeWebProfileFetcher({ gate: sharedStartGate, circuit: sharedCircuit });

export async function fetchWebProfileUser(
    username: string,
    transport?: TransportConfig,
    options?: FetchOptions
): Promise<Record<string, unknown> | null> {
    return defaultFetcher(username, transport, options);
}
