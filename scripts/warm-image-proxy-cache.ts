/**
 * Pre-warms the generic image-proxy R2 cache (option 2) with profile images
 * whose Instagram CDN signature has not expired yet.
 *
 * The production proxy only consults this cache on the generic
 * (`/api/image-proxy?token=...`) path, keyed by
 * `imageProxyCacheKey(canonicalizeImageProxyUrl(rawUrl))`. This script walks the
 * same three URL sources the result/share routes feed into
 * `createImageProxyPath` - the target profile image in
 * `analysis_requests.step_data.targetProfileImage`, every
 * `analysis_results.suspect_profile_image`, and every
 * `private_accounts.profile_image` - canonicalizes each one exactly as the token
 * issuer does, downloads the still-live (HTTP 200) bytes through the same
 * `downloadSecureImage` call the proxy makes, and stores them with
 * `writeImageProxyCacheObject`. Expired signatures (HTTP 403) are skipped.
 *
 * Idempotent: a key already present in R2 is neither refetched nor rewritten,
 * so a re-run only fills gaps. Read-only against Postgres; the only write is the
 * cache object itself.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/warm-image-proxy-cache.ts [flags]
 *
 *   --since=<ISO date>   also include completed requests created at/after this
 *                        instant (default: 30 days ago)
 *   --request-id=<uuid>  restrict to one request (repeatable)
 *   --sample=<n>         probe only the first n unique images (liveness survey)
 *   --concurrency=<n>    parallel downloads (default 4)
 *   --pace-ms=<n>        jittered pause before each origin fetch (default 200)
 *   --dry-run            collect and probe liveness, never write to R2
 */
import { setTimeout as delay } from 'node:timers/promises';
import { lookup } from 'node:dns/promises';
import { S3Client } from '@aws-sdk/client-s3';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { canonicalizeImageProxyUrl } from '@/lib/services/media/image-proxy-token';
import {
    imageProxyCacheKey,
    readImageProxyCacheObject,
    writeImageProxyCacheObject,
} from '@/lib/services/media/image-proxy-cache';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    SecureImageFetchError,
    type ResolvedAddress,
} from '@/lib/services/media/secure-image-fetch';
import { targetProfileImageFromStepData } from '@/lib/services/analysis/result-interactions';
import { loadResultImageR2Config } from '@/lib/services/media/r2-result-image-store';

/** Mirrors the proxy's own generic-path download budget, with a longer
 * per-image timeout because a warming run has no request deadline. */
const MAX_BYTES = 3 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8';
const DOWNLOAD_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: IMAGE_ACCEPT,
    Referer: 'https://www.instagram.com/',
};
/**
 * Instagram's regional CDN edges publish AAAA records that this operator
 * network cannot reach, which surfaces as `network_failure` on roughly 80% of
 * hosts even when the signature is still valid. Warming only needs the bytes,
 * so the resolver hands `downloadSecureImage` the IPv4 addresses when the host
 * has any - the production proxy keeps its default dual-stack resolution
 * untouched, since this override lives in the script, not the library.
 */
async function preferIpv4(hostname: string): Promise<ResolvedAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    const ipv4 = addresses.filter((address) => address.family === 4);
    return ipv4.length > 0 ? ipv4 : addresses;
}

/** Orders whose buyer still holds a deliverable result page. */
const ACTIVE_ORDER_STATUSES = ['completed', 'paid', 'analysis_in_progress'] as const;
const DEFAULT_SINCE_DAYS = 30;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_500, 5_000] as const;
/** Transient reasons worth one more attempt; a 403/404 is final. */
const RETRYABLE_REASONS = new Set(['network_failure', 'timeout', 'rate_limited', 'upstream_unavailable']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHUNK_SIZE = 100;
const PAGE_SIZE = 1_000;

type ImageOrigin = 'target' | 'female' | 'private';

interface CollectedImage {
    canonicalUrl: string;
    cacheKey: string;
    origins: Set<ImageOrigin>;
    requestIds: Set<string>;
}

interface Options {
    since: Date;
    requestIds: readonly string[];
    sample: number | null;
    concurrency: number;
    paceMs: number;
    dryRun: boolean;
}

interface Counters {
    cached: number;
    alreadyCached: number;
    expired: number;
    missing: number;
    rateLimited: number;
    failed: number;
    unusableUrl: number;
}

function parseOptions(argv: readonly string[]): Options {
    let since = new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1_000);
    const requestIds: string[] = [];
    let sample: number | null = null;
    let concurrency = 4;
    let paceMs = 200;
    let dryRun = false;

    for (const argument of argv) {
        const separatorIndex = argument.indexOf('=');
        const flag = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
        const rawValue = separatorIndex === -1 ? undefined : argument.slice(separatorIndex + 1);
        switch (flag) {
            case '--since': {
                const parsed = new Date(String(rawValue));
                if (Number.isNaN(parsed.getTime())) {
                    throw new Error(`--since must be an ISO instant: ${rawValue}`);
                }
                since = parsed;
                break;
            }
            case '--request-id': {
                const value = String(rawValue).toLowerCase();
                if (!UUID_PATTERN.test(value)) {
                    throw new Error(`--request-id must be a UUID: ${rawValue}`);
                }
                requestIds.push(value);
                break;
            }
            case '--sample': {
                const value = Number(rawValue);
                if (!Number.isSafeInteger(value) || value <= 0) {
                    throw new Error(`--sample must be a positive integer: ${rawValue}`);
                }
                sample = value;
                break;
            }
            case '--concurrency': {
                const value = Number(rawValue);
                if (!Number.isSafeInteger(value) || value <= 0 || value > 32) {
                    throw new Error(`--concurrency must be 1..32: ${rawValue}`);
                }
                concurrency = value;
                break;
            }
            case '--pace-ms': {
                const value = Number(rawValue);
                if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
                    throw new Error(`--pace-ms must be 0..10000: ${rawValue}`);
                }
                paceMs = value;
                break;
            }
            case '--dry-run':
                dryRun = true;
                break;
            default:
                throw new Error(`Unknown flag: ${flag}`);
        }
    }

    return { since, requestIds, sample, concurrency, paceMs, dryRun };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}

/**
 * PostgREST caps an unbounded select at its configured max rows and reports no
 * error when it truncates, so every row scan here pages explicitly until a page
 * comes back short.
 */
async function selectAllPages<Row>(
    build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>
): Promise<Row[]> {
    const rows: Row[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
        const page = await build(from, from + PAGE_SIZE - 1);
        if (page.error) throw page.error;
        const data = page.data ?? [];
        rows.push(...data);
        if (data.length < PAGE_SIZE) return rows;
    }
}

/**
 * The request ids whose result pages a viewer can still open: every result
 * attached to a non-refunded order, plus everything completed recently (the
 * concierge batch publishes results that are not always order-linked yet).
 */
async function resolveTargetRequestIds(options: Options): Promise<string[]> {
    if (options.requestIds.length > 0) return [...new Set(options.requestIds)];

    const ids = new Set<string>();

    const orders = await selectAllPages<{ result_request_id: string | null }>(
        (from, to) => supabaseAdmin
            .from('earlybird_orders')
            .select('result_request_id')
            .in('status', ACTIVE_ORDER_STATUSES)
            .not('result_request_id', 'is', null)
            .order('result_request_id', { ascending: true })
            .range(from, to)
    );
    for (const order of orders) {
        if (typeof order.result_request_id === 'string') {
            ids.add(order.result_request_id.toLowerCase());
        }
    }
    const orderLinked = ids.size;

    const recent = await selectAllPages<{ id: string }>((from, to) => supabaseAdmin
        .from('analysis_requests')
        .select('id')
        .eq('status', 'completed')
        .gte('created_at', options.since.toISOString())
        .order('id', { ascending: true })
        .range(from, to));
    for (const request of recent) {
        if (typeof request.id === 'string') ids.add(request.id.toLowerCase());
    }

    console.log(
        `[scope] active-order results: ${orderLinked}`
        + `, completed since ${options.since.toISOString()}: ${recent.length}`
        + `, union: ${ids.size}`
    );
    return [...ids];
}

function addImage(
    images: Map<string, CollectedImage>,
    counters: Counters,
    rawUrl: unknown,
    origin: ImageOrigin,
    requestId: string
): void {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return;
    let canonicalUrl: string;
    try {
        canonicalUrl = canonicalizeImageProxyUrl(rawUrl);
    } catch {
        counters.unusableUrl += 1;
        return;
    }
    const cacheKey = imageProxyCacheKey(canonicalUrl);
    if (!cacheKey) {
        counters.unusableUrl += 1;
        return;
    }
    const existing = images.get(cacheKey);
    if (existing) {
        existing.origins.add(origin);
        existing.requestIds.add(requestId);
        return;
    }
    images.set(cacheKey, {
        canonicalUrl,
        cacheKey,
        origins: new Set([origin]),
        requestIds: new Set([requestId]),
    });
}

async function collectImages(
    requestIds: readonly string[],
    counters: Counters
): Promise<CollectedImage[]> {
    const images = new Map<string, CollectedImage>();

    let rowsScanned = 0;
    for (const slice of chunk(requestIds, CHUNK_SIZE)) {
        const requests = await selectAllPages<{ id: string; step_data: unknown }>(
            (from, to) => supabaseAdmin
                .from('analysis_requests')
                .select('id, step_data')
                .in('id', slice)
                .order('id', { ascending: true })
                .range(from, to)
        );
        for (const request of requests) {
            addImage(
                images,
                counters,
                targetProfileImageFromStepData(request.step_data),
                'target',
                String(request.id)
            );
        }

        const results = await selectAllPages<{
            request_id: string;
            suspect_instagram_id: string;
            suspect_profile_image: string | null;
        }>((from, to) => supabaseAdmin
            .from('analysis_results')
            .select('request_id, suspect_instagram_id, suspect_profile_image')
            .in('request_id', slice)
            .not('suspect_profile_image', 'is', null)
            .order('request_id', { ascending: true })
            .order('suspect_instagram_id', { ascending: true })
            .range(from, to));
        for (const result of results) {
            addImage(
                images,
                counters,
                result.suspect_profile_image,
                'female',
                String(result.request_id)
            );
        }

        const privateAccounts = await selectAllPages<{
            request_id: string;
            instagram_id: string;
            profile_image: string | null;
        }>((from, to) => supabaseAdmin
            .from('private_accounts')
            .select('request_id, instagram_id, profile_image')
            .in('request_id', slice)
            .not('profile_image', 'is', null)
            .order('request_id', { ascending: true })
            .order('instagram_id', { ascending: true })
            .range(from, to));
        for (const account of privateAccounts) {
            addImage(
                images,
                counters,
                account.profile_image,
                'private',
                String(account.request_id)
            );
        }
        rowsScanned += requests.length + results.length + privateAccounts.length;
    }
    console.log(`[collect] scanned rows: ${rowsScanned}`);

    return [...images.values()];
}

type WarmOutcome =
    | 'cached'
    | 'alreadyCached'
    | 'expired'
    | 'missing'
    | 'rateLimited'
    | 'failed';

let cacheClient: S3Client | undefined;

function cacheDependencies() {
    return cacheClient ? { client: cacheClient } : {};
}

const failureReasons = new Map<string, number>();

function recordFailureReason(reason: string): void {
    failureReasons.set(reason, (failureReasons.get(reason) ?? 0) + 1);
}

async function readCache(cacheKey: string): Promise<boolean> {
    return await readImageProxyCacheObject(
        cacheKey,
        process.env,
        cacheDependencies()
    ) !== null;
}

async function warmOne(
    image: CollectedImage,
    dryRun: boolean,
    paceMs: number
): Promise<WarmOutcome> {
    if (await readCache(image.cacheKey)) return 'alreadyCached';

    // Meta's CDN starts resetting connections when a single IP bursts through
    // hundreds of profile images, which the first run hit as a wall of
    // `network_failure`. A jittered pause keeps the warm slow enough to finish.
    if (paceMs > 0) await delay(paceMs + Math.floor(Math.random() * paceMs));

    let download: Awaited<ReturnType<typeof downloadSecureImage>> | undefined;
    let lastReason = 'unexpected_error';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        try {
            download = await downloadSecureImage(image.canonicalUrl, {
                allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
                maxBytes: MAX_BYTES,
                timeoutMs: DOWNLOAD_TIMEOUT_MS,
                headers: DOWNLOAD_HEADERS,
                resolveHostname: preferIpv4,
            });
            break;
        } catch (error) {
            if (!(error instanceof SecureImageFetchError)) {
                recordFailureReason('unexpected_error');
                return 'failed';
            }
            lastReason = error.reason;
            if (error.reason === 'source_rejected') {
                recordFailureReason(error.reason);
                return 'expired';
            }
            if (error.reason === 'source_missing') {
                recordFailureReason(error.reason);
                return 'missing';
            }
            if (!RETRYABLE_REASONS.has(error.reason) || attempt === MAX_ATTEMPTS - 1) break;
            await delay(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
        }
    }
    if (!download) {
        recordFailureReason(lastReason);
        return lastReason === 'rate_limited' ? 'rateLimited' : 'failed';
    }

    if (dryRun) return 'cached';

    // writeImageProxyCacheObject swallows every failure by contract, so the
    // object is read back through the same path the proxy uses before this run
    // reports the key as warmed.
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        await writeImageProxyCacheObject(
            image.cacheKey,
            download.bytes,
            download.contentType,
            process.env,
            cacheDependencies()
        );
        if (await readCache(image.cacheKey)) return 'cached';
        if (attempt < MAX_ATTEMPTS - 1) {
            await delay(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
        }
    }
    recordFailureReason('r2_write_not_readable');
    return 'failed';
}

async function runPool(
    images: readonly CollectedImage[],
    options: Options,
    counters: Counters
): Promise<void> {
    let nextIndex = 0;
    let completed = 0;
    const total = images.length;

    const worker = async (): Promise<void> => {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= total) return;
            const image = images[index];
            const outcome = await warmOne(image, options.dryRun, options.paceMs);
            counters[outcome] += 1;
            completed += 1;
            if (completed % 100 === 0 || completed === total) {
                console.log(
                    `[progress] ${completed}/${total}`
                    + ` cached=${counters.cached}`
                    + ` alreadyCached=${counters.alreadyCached}`
                    + ` expired=${counters.expired}`
                    + ` missing=${counters.missing}`
                    + ` rateLimited=${counters.rateLimited}`
                    + ` failed=${counters.failed}`
                );
            }
        }
    };

    await Promise.all(
        Array.from({ length: Math.min(options.concurrency, total) }, worker)
    );
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    const config = loadResultImageR2Config();
    // image-proxy-cache builds a fresh S3Client per call when none is injected.
    // That is right for a serverless request but leaks thousands of keep-alive
    // sockets across a batch this size, which is what broke the first run's R2
    // writes, so every call here shares one client through the documented
    // dependency seam - same commands, same bucket, same key scheme.
    cacheClient = new S3Client({
        endpoint: config.endpoint,
        region: 'auto',
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });
    console.log(
        `[r2] bucket=${config.bucket} endpoint=${config.endpoint}`
        + ` dryRun=${options.dryRun} concurrency=${options.concurrency}`
        + ` paceMs=${options.paceMs}`
    );

    const counters: Counters = {
        cached: 0,
        alreadyCached: 0,
        expired: 0,
        missing: 0,
        rateLimited: 0,
        failed: 0,
        unusableUrl: 0,
    };

    const requestIds = await resolveTargetRequestIds(options);
    const collected = await collectImages(requestIds, counters);
    const byOrigin = { target: 0, female: 0, private: 0 };
    for (const image of collected) {
        for (const origin of image.origins) byOrigin[origin] += 1;
    }
    console.log(
        `[collect] requests=${requestIds.length}`
        + ` uniqueImages=${collected.length}`
        + ` (target=${byOrigin.target} female=${byOrigin.female} private=${byOrigin.private})`
        + ` unusableUrl=${counters.unusableUrl}`
    );

    const images = options.sample === null
        ? collected
        : collected.slice(0, options.sample);
    if (options.sample !== null) {
        console.log(`[sample] probing first ${images.length} of ${collected.length}`);
    }

    await runPool(images, options, counters);

    console.log('[summary] ' + JSON.stringify({
        requests: requestIds.length,
        uniqueImages: collected.length,
        attempted: images.length,
        cached: counters.cached,
        alreadyCached: counters.alreadyCached,
        expired: counters.expired,
        missing: counters.missing,
        rateLimited: counters.rateLimited,
        failed: counters.failed,
        unusableUrl: counters.unusableUrl,
        failureReasons: Object.fromEntries(failureReasons),
        dryRun: options.dryRun,
    }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
