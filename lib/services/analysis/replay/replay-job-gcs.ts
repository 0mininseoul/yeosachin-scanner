import { createHash } from 'node:crypto';

export interface ReplayJobGcsClient {
    downloadBundle(): Promise<Buffer>;
    createClaim(raw: string): Promise<void>;
    createReport(raw: string): Promise<void>;
}

interface ReplayJobGcsDependencies {
    fetch?: typeof fetch;
    now?: () => number;
}

const SAFE_BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const SAFE_OBJECT = /^[a-z0-9][a-z0-9._/-]{0,190}$/;
const MAX_ENCRYPTED_BUNDLE_BYTES =
    Math.ceil(272 * 1024 * 1024 * 4 / 3) + 4_096;
const ADC_REFRESH_SKEW_MS = 60_000;
const UNSAFE_KEY = /(?:user_?name|full_?name|bio|caption|url|prompt|base64|raw|error|token|secret|request_?id|^handle$|^terminal$)/i;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i;

function unsafeJsonValue(value: unknown): boolean {
    if (typeof value === 'string') {
        return UUID.test(value)
            || /\bhttps?:\/\//i.test(value)
            || /\b(?:raw[-_ ]?error|token|secret|base64)\b/i.test(value);
    }
    if (Array.isArray(value)) return value.some(unsafeJsonValue);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) => (
        UNSAFE_KEY.test(key) || unsafeJsonValue(child)
    ));
}

function assertSafeJson(raw: string): void {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    if (
        !parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || unsafeJsonValue(parsed)
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
}

export function createReplayJobGcsClient(
    config: {
        bucket: string;
        bundleObject: string;
        bundleGeneration: string;
        bundleBytes: number;
        bundleSha256: string;
        claimObject: string;
        reportObject: string;
    },
    dependencies: ReplayJobGcsDependencies = {},
): ReplayJobGcsClient {
    if (
        !SAFE_BUCKET.test(config.bucket)
        || ![config.bundleObject, config.claimObject, config.reportObject]
            .every(value => SAFE_OBJECT.test(value) && !value.includes('..'))
        || new Set([
            config.bundleObject,
            config.claimObject,
            config.reportObject,
        ]).size !== 3
        || !/^[1-9][0-9]{0,19}$/.test(config.bundleGeneration)
        || !Number.isSafeInteger(config.bundleBytes)
        || config.bundleBytes < 1
        || config.bundleBytes > MAX_ENCRYPTED_BUNDLE_BYTES
        || !/^[a-f0-9]{64}$/.test(config.bundleSha256)
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_GCS_CONFIGURATION_INVALID');
    }
    const fetchImpl = dependencies.fetch ?? fetch;
    const now = dependencies.now ?? Date.now;
    let accessToken: {
        value: string;
        refreshAtMs: number;
    } | undefined;
    let tokenRequest: Promise<string> | undefined;
    const token = (): Promise<string> => {
        if (accessToken && now() < accessToken.refreshAtMs) {
            return Promise.resolve(accessToken.value);
        }
        tokenRequest ??= fetchImpl(
            'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
            { headers: { 'Metadata-Flavor': 'Google' } },
        ).then(async response => {
            if (!response.ok) {
                throw new Error('ANALYSIS_V2_REPLAY_JOB_ADC_UNAVAILABLE');
            }
            const value = await response.json() as {
                access_token?: unknown;
                token_type?: unknown;
                expires_in?: unknown;
            };
            if (
                typeof value.access_token !== 'string'
                || value.access_token.length < 20
                || value.token_type !== 'Bearer'
                || !Number.isInteger(value.expires_in)
                || (value.expires_in as number) < 1
                || (value.expires_in as number) > 86_400
            ) {
                throw new Error('ANALYSIS_V2_REPLAY_JOB_ADC_UNAVAILABLE');
            }
            accessToken = {
                value: value.access_token,
                refreshAtMs: now() + Math.max(
                    0,
                    (value.expires_in as number) * 1_000
                        - ADC_REFRESH_SKEW_MS,
                ),
            };
            return accessToken.value;
        }).finally(() => {
            tokenRequest = undefined;
        });
        return tokenRequest;
    };
    const authorization = async () => ({
        authorization: `Bearer ${await token()}`,
    });
    const create = async (
        object: string,
        raw: string,
        kind: 'CLAIM' | 'REPORT',
    ): Promise<void> => {
        assertSafeJson(raw);
        const url = new URL(
            `https://storage.googleapis.com/upload/storage/v1/b/${
                encodeURIComponent(config.bucket)
            }/o`,
        );
        url.searchParams.set('uploadType', 'media');
        url.searchParams.set('name', object);
        url.searchParams.set('ifGenerationMatch', '0');
        let response: Response;
        try {
            response = await fetchImpl(url, {
                method: 'POST',
                headers: {
                    ...await authorization(),
                    'content-type': 'application/json; charset=utf-8',
                },
                body: raw,
            });
        } catch {
            throw new Error(
                `ANALYSIS_V2_REPLAY_JOB_${kind}_CREATE_AMBIGUOUS`,
            );
        }
        if (kind === 'CLAIM' && response.status === 412) {
            throw new Error('ANALYSIS_V2_REPLAY_JOB_CLAIM_COLLISION');
        }
        if (!response.ok) {
            throw new Error(
                `ANALYSIS_V2_REPLAY_JOB_${kind}_CREATE_AMBIGUOUS`,
            );
        }
    };
    return Object.freeze({
        downloadBundle: async () => {
            const object = encodeURIComponent(config.bundleObject);
            const url = new URL(
                `https://storage.googleapis.com/download/storage/v1/b/${
                    encodeURIComponent(config.bucket)
                }/o/${object}`,
            );
            url.searchParams.set('alt', 'media');
            url.searchParams.set('generation', config.bundleGeneration);
            const response = await fetchImpl(url, {
                headers: await authorization(),
            });
            if (
                !response.ok
                || response.headers.get('x-goog-generation')
                    !== config.bundleGeneration
            ) {
                throw new Error('ANALYSIS_V2_REPLAY_JOB_BUNDLE_DOWNLOAD_FAILED');
            }
            const bytes = Buffer.from(await response.arrayBuffer());
            if (
                bytes.byteLength !== config.bundleBytes
                || createHash('sha256').update(bytes).digest('hex')
                    !== config.bundleSha256
            ) {
                throw new Error('ANALYSIS_V2_REPLAY_JOB_BUNDLE_INTEGRITY_FAILED');
            }
            return bytes;
        },
        createClaim: (raw: string) => create(
            config.claimObject,
            raw,
            'CLAIM',
        ),
        createReport: (raw: string) => create(
            config.reportObject,
            raw,
            'REPORT',
        ),
    });
}
