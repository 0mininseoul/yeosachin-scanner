/**
 * Re-images the four G3 concierge targets only.
 *
 * The script is deliberately count-only unless --execute is supplied.  The
 * count pass probes the exact stored URLs from the result rows and reports
 * only HTTP 403 URLs which are not already present in the generic R2 cache.
 * The execute pass re-scrapes each affected Instagram account once, downloads
 * its fresh profile image, and writes those bytes under the cache key derived
 * from the stored (expired) URL.  It never changes Postgres rows or publishes
 * a result.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/warm-reimage-g3.ts
 *   npx tsx --env-file=.env.local scripts/warm-reimage-g3.ts --execute
 *
 * Optional flags:
 *   --execute              perform Apify re-scrapes and R2 writes
 *   --concurrency=<n>      origin/cache probe concurrency (default 4)
 *   --pace-ms=<n>          jittered pause before origin probes (default 200)
 *   --since=<ISO instant>  fallback request lookback when no order is linked
 */
import { setTimeout as delay } from 'node:timers/promises';
import { lookup } from 'node:dns/promises';
import { ApifyClient } from 'apify-client';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    canonicalizeImageProxyUrl,
    createImageProxyPath,
    verifyImageProxyToken,
} from '@/lib/services/media/image-proxy-token';
import {
    imageProxyCacheKey,
    readImageProxyCacheObject,
    writeImageProxyCacheObject,
} from '@/lib/services/media/image-proxy-cache';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    requestPinnedHttpsImage,
    SecureImageFetchError,
    type ResolvedAddress,
    type SecureImageRequest,
} from '@/lib/services/media/secure-image-fetch';
import { targetProfileImageFromStepData } from '@/lib/services/analysis/result-interactions';
import { loadResultImageR2Config } from '@/lib/services/media/r2-result-image-store';
import { makeApifyProvider } from '@/lib/services/instagram/providers/apify';
import type {
    ApifyCredentialSlot,
    ProviderCallContext,
    ScraperProvider,
} from '@/lib/services/instagram/providers/types';

const TARGETS = [
    'zusnxc',
    'minjunkil',
    'dlwnsgud_04',
    'heesung1202',
] as const;
const TARGET_SET = new Set<string>(TARGETS);
const PAGE_SIZE = 1_000;
const CHUNK_SIZE = 100;
const MAX_BYTES = 3 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8';
const DOWNLOAD_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: IMAGE_ACCEPT,
    Referer: 'https://www.instagram.com/',
};
const DEFAULT_SINCE_DAYS = 90;
const PROFILE_MAX_CHARGE_USD = 0.003;
const PROFILE_ESTIMATED_CHARGE_USD = 0.0026;
const RETRYABLE_APIFY_ERRORS = new Set([
    'SCRAPING_PROVIDER_QUOTA_ERROR',
    'SCRAPING_PROVIDER_START_REJECTED_ERROR',
]);
const ACTIVE_ORDER_STATUSES = ['completed', 'paid', 'analysis_in_progress'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/i;
const APIFY_SLOT: ApifyCredentialSlot = 'tenth';

type ImageOrigin = 'target' | 'female' | 'private';
type ProbeOutcome =
    | 'alreadyCached'
    | 'live'
    | 'expired403'
    | 'missing'
    | 'rateLimited'
    | 'rejected'
    | 'failed';
type CacheOutcome = 'cached' | 'alreadyCached' | 'failed';

interface Options {
    execute: boolean;
    concurrency: number;
    paceMs: number;
    since: Date;
}

interface RequestScope {
    id: string;
    targetUsername: string;
}

interface ImageRef {
    target: string;
    requestId: string;
    origin: ImageOrigin;
    accountUsername: string;
    canonicalUrl: string;
    cacheKey: string;
}

interface ImageEntry {
    canonicalUrl: string;
    cacheKey: string;
    refs: ImageRef[];
}

interface TargetSummary {
    requestIds: Set<string>;
    sourceKeys: Set<string>;
    expiredKeys: Set<string>;
    expiredAccounts: Set<string>;
    cachedKeys: Set<string>;
    liveKeys: Set<string>;
    missingKeys: Set<string>;
    rejectedKeys: Set<string>;
    failedKeys: Set<string>;
    cacheSucceededKeys: Set<string>;
    cacheAlreadyKeys: Set<string>;
    cacheFailedKeys: Set<string>;
    scrapeSucceededAccounts: Set<string>;
    scrapeFailedAccounts: Map<string, string>;
}

interface ProbeRecord {
    outcome: ProbeOutcome;
    httpStatus: number | null;
}

interface AccountResult {
    username: string;
    status: 'success' | 'failed';
    reason?: string;
    bytes?: Buffer;
    contentType?: string;
}

interface ApifySlotClient {
    slot: ApifyCredentialSlot;
    env: Record<string, string | undefined>;
    client: ApifyClient;
    provider: ScraperProvider;
}

const targetSummaries = new Map<string, TargetSummary>();
let cacheClient: import('@aws-sdk/client-s3').S3Client | undefined;

function summaryFor(target: string): TargetSummary {
    const existing = targetSummaries.get(target);
    if (existing) return existing;
    const summary: TargetSummary = {
        requestIds: new Set(),
        sourceKeys: new Set(),
        expiredKeys: new Set(),
        expiredAccounts: new Set(),
        cachedKeys: new Set(),
        liveKeys: new Set(),
        missingKeys: new Set(),
        rejectedKeys: new Set(),
        failedKeys: new Set(),
        cacheSucceededKeys: new Set(),
        cacheAlreadyKeys: new Set(),
        cacheFailedKeys: new Set(),
        scrapeSucceededAccounts: new Set(),
        scrapeFailedAccounts: new Map(),
    };
    targetSummaries.set(target, summary);
    return summary;
}

for (const target of TARGETS) summaryFor(target);

function parseOptions(argv: readonly string[]): Options {
    let execute = false;
    let concurrency = 4;
    let paceMs = 200;
    let since = new Date(Date.now() - DEFAULT_SINCE_DAYS * 24 * 60 * 60 * 1_000);

    for (const argument of argv) {
        const separator = argument.indexOf('=');
        const flag = separator === -1 ? argument : argument.slice(0, separator);
        const value = separator === -1 ? undefined : argument.slice(separator + 1);
        switch (flag) {
            case '--execute':
                execute = true;
                break;
            case '--concurrency': {
                const parsed = Number(value);
                if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 16) {
                    throw new Error('--concurrency must be an integer from 1 to 16');
                }
                concurrency = parsed;
                break;
            }
            case '--pace-ms': {
                const parsed = Number(value);
                if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
                    throw new Error('--pace-ms must be an integer from 0 to 10000');
                }
                paceMs = parsed;
                break;
            }
            case '--since': {
                const parsed = new Date(String(value));
                if (Number.isNaN(parsed.getTime())) {
                    throw new Error('--since must be an ISO instant');
                }
                since = parsed;
                break;
            }
            default:
                throw new Error(`Unknown flag: ${flag}`);
        }
    }
    return { execute, concurrency, paceMs, since };
}

function chunk<T>(values: readonly T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
        chunks.push(values.slice(index, index + size));
    }
    return chunks;
}

async function selectAllPages<Row>(
    build: (from: number, to: number) => PromiseLike<{ data: Row[] | null; error: unknown }>,
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

function normalizeUsername(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim().replace(/^@/, '').toLowerCase();
    return USERNAME_PATTERN.test(value) ? value : null;
}

function safeErrorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    const match = message.match(/^([A-Z][A-Z0-9_]{2,80})/);
    return match?.[1] ?? 'UNCLASSIFIED_ERROR';
}

async function resolveRequestIds(since: Date): Promise<Map<string, RequestScope[]>> {
    const byTarget = new Map<string, Map<string, RequestScope>>();
    for (const target of TARGETS) byTarget.set(target, new Map());

    const addRequest = (targetRaw: unknown, requestId: unknown): void => {
        const target = normalizeUsername(targetRaw);
        if (!target || !TARGET_SET.has(target) || typeof requestId !== 'string') return;
        const id = requestId.toLowerCase();
        if (!UUID_PATTERN.test(id)) return;
        const bucket = byTarget.get(target);
        if (!bucket) return;
        bucket.set(id, { id, targetUsername: target });
    };

    // Look up active order rows by target. This also covers targets outside the
    // immutable cohort manifest, whose service-role table is intentionally not
    // directly readable in production.
    const directOrders = await selectAllPages<{
        target_instagram_id: string;
        result_request_id: string | null;
        status: string;
    }>((from, to) => supabaseAdmin
        .from('earlybird_orders')
        .select('target_instagram_id,result_request_id,status')
        .in('target_instagram_id', [...TARGETS])
        .in('status', [...ACTIVE_ORDER_STATUSES])
        .not('result_request_id', 'is', null)
        .range(from, to));
    for (const order of directOrders) {
        addRequest(order.target_instagram_id, order.result_request_id);
    }

    // If an order row is absent, use a recent completed request as a narrowly
    // scoped read-only fallback so an outside-cohort result is not missed.
    const missingTargets = TARGETS.filter(target => (byTarget.get(target)?.size ?? 0) === 0);
    const fallbackRequests = await selectAllPages<{
        id: string;
        target_instagram_id: string;
    }>(missingTargets.length === 0
        ? async () => ({ data: [], error: null })
        : (from, to) => supabaseAdmin
            .from('analysis_requests')
            .select('id,target_instagram_id')
            .in('target_instagram_id', missingTargets)
            .eq('status', 'completed')
            .gte('created_at', since.toISOString())
            .order('created_at', { ascending: false })
            .range(from, to));
    for (const request of fallbackRequests) addRequest(request.target_instagram_id, request.id);

    const result = new Map<string, RequestScope[]>();
    for (const target of TARGETS) {
        const scopes = [...(byTarget.get(target)?.values() ?? [])];
        result.set(target, scopes);
        for (const scope of scopes) summaryFor(target).requestIds.add(scope.id);
    }
    console.log(`[scope] ${TARGETS.map(target => `${target}=${result.get(target)?.length ?? 0}`).join(' ')}`);
    return result;
}

function addImageRef(
    entries: Map<string, ImageEntry>,
    target: string,
    requestId: string,
    origin: ImageOrigin,
    accountRaw: unknown,
    rawUrl: unknown,
): void {
    const accountUsername = normalizeUsername(accountRaw);
    if (typeof rawUrl !== 'string' || rawUrl.length === 0 || !accountUsername) return;
    let canonicalUrl: string;
    try {
        canonicalUrl = canonicalizeImageProxyUrl(rawUrl);
    } catch {
        return;
    }
    const cacheKey = imageProxyCacheKey(canonicalUrl);
    if (!cacheKey) return;
    const existing = entries.get(cacheKey);
    const ref: ImageRef = {
        target,
        requestId,
        origin,
        accountUsername,
        canonicalUrl,
        cacheKey,
    };
    if (existing) {
        if (!existing.refs.some(item => (
            item.target === target
            && item.requestId === requestId
            && item.origin === origin
            && item.accountUsername === accountUsername
        ))) existing.refs.push(ref);
        return;
    }
    entries.set(cacheKey, { canonicalUrl, cacheKey, refs: [ref] });
}

async function collectImages(
    scopesByTarget: Map<string, RequestScope[]>,
): Promise<ImageEntry[]> {
    const entries = new Map<string, ImageEntry>();
    const allRequestIds = [...new Set(
        [...scopesByTarget.values()].flat().map(scope => scope.id),
    )];
    const targetByRequestId = new Map(
        [...scopesByTarget.values()].flat().map(scope => [scope.id, scope.targetUsername]),
    );

    for (const slice of chunk(allRequestIds, CHUNK_SIZE)) {
        const requests = await selectAllPages<{
            id: string;
            target_instagram_id: string;
            step_data: unknown;
        }>(slice.length === 0
            ? async () => ({ data: [], error: null })
            : (from, to) => supabaseAdmin
                .from('analysis_requests')
                .select('id,target_instagram_id,step_data')
                .in('id', slice)
                .range(from, to));
        for (const request of requests) {
            const target = targetByRequestId.get(request.id.toLowerCase());
            if (!target) continue;
            addImageRef(
                entries,
                target,
                request.id,
                'target',
                request.target_instagram_id,
                targetProfileImageFromStepData(request.step_data),
            );
        }

        const results = await selectAllPages<{
            request_id: string;
            suspect_instagram_id: string;
            suspect_profile_image: string | null;
        }>(slice.length === 0
            ? async () => ({ data: [], error: null })
            : (from, to) => supabaseAdmin
                .from('analysis_results')
                .select('request_id,suspect_instagram_id,suspect_profile_image')
                .in('request_id', slice)
                .not('suspect_profile_image', 'is', null)
                .order('request_id', { ascending: true })
                .order('suspect_instagram_id', { ascending: true })
                .range(from, to));
        for (const result of results) {
            const target = targetByRequestId.get(result.request_id.toLowerCase());
            if (!target) continue;
            addImageRef(
                entries,
                target,
                result.request_id,
                'female',
                result.suspect_instagram_id,
                result.suspect_profile_image,
            );
        }

        const privateAccounts = await selectAllPages<{
            request_id: string;
            instagram_id: string;
            profile_image: string | null;
        }>(slice.length === 0
            ? async () => ({ data: [], error: null })
            : (from, to) => supabaseAdmin
                .from('private_accounts')
                .select('request_id,instagram_id,profile_image')
                .in('request_id', slice)
                .not('profile_image', 'is', null)
                .order('request_id', { ascending: true })
                .order('instagram_id', { ascending: true })
                .range(from, to));
        for (const account of privateAccounts) {
            const target = targetByRequestId.get(account.request_id.toLowerCase());
            if (!target) continue;
            addImageRef(
                entries,
                target,
                account.request_id,
                'private',
                account.instagram_id,
                account.profile_image,
            );
        }
    }

    for (const entry of entries.values()) {
        for (const ref of entry.refs) summaryFor(ref.target).sourceKeys.add(entry.cacheKey);
    }
    console.log(`[collect] uniqueKeys=${entries.size}`);
    return [...entries.values()];
}

async function preferIpv4(hostname: string): Promise<ResolvedAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    const ipv4 = addresses.filter(address => address.family === 4);
    return ipv4.length > 0 ? ipv4 : addresses;
}

function cacheDependencies() {
    return cacheClient ? { client: cacheClient } : {};
}

async function readCache(cacheKey: string): Promise<boolean> {
    return await readImageProxyCacheObject(
        cacheKey,
        process.env,
        cacheDependencies(),
    ) !== null;
}

async function probeEntry(entry: ImageEntry, paceMs: number): Promise<ProbeRecord> {
    if (await readCache(entry.cacheKey)) return { outcome: 'alreadyCached', httpStatus: null };
    if (paceMs > 0) await delay(paceMs + Math.floor(Math.random() * paceMs));

    let httpStatus: number | null = null;
    const requestImpl: SecureImageRequest = async (url, options, addresses) => {
        const response = await requestPinnedHttpsImage(url, options, addresses);
        httpStatus = response.status;
        return response;
    };
    try {
        await downloadSecureImage(entry.canonicalUrl, {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            maxBytes: MAX_BYTES,
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
            headers: DOWNLOAD_HEADERS,
            resolveHostname: preferIpv4,
            requestImpl,
        });
        return { outcome: 'live', httpStatus };
    } catch (error) {
        if (error instanceof SecureImageFetchError) {
            if (httpStatus === 403) return { outcome: 'expired403', httpStatus };
            if (error.reason === 'source_missing') return { outcome: 'missing', httpStatus };
            if (error.reason === 'rate_limited') return { outcome: 'rateLimited', httpStatus };
            if (error.reason === 'source_rejected') return { outcome: 'rejected', httpStatus };
        }
        return { outcome: 'failed', httpStatus };
    }
}

async function probeEntries(
    entries: readonly ImageEntry[],
    options: Options,
): Promise<Map<string, ProbeRecord>> {
    const results = new Map<string, ProbeRecord>();
    let nextIndex = 0;
    let completed = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = nextIndex++;
            if (index >= entries.length) return;
            const entry = entries[index];
            const result = await probeEntry(entry, options.paceMs);
            results.set(entry.cacheKey, result);
            completed++;
            if (completed % 25 === 0 || completed === entries.length) {
                console.log(`[probe] ${completed}/${entries.length}`);
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(options.concurrency, entries.length) }, worker),
    );
    return results;
}

function applyProbeSummaries(
    entries: readonly ImageEntry[],
    probes: Map<string, ProbeRecord>,
): ImageEntry[] {
    const expired: ImageEntry[] = [];
    for (const entry of entries) {
        const probe = probes.get(entry.cacheKey);
        if (!probe) continue;
        for (const ref of entry.refs) {
            const summary = summaryFor(ref.target);
            switch (probe.outcome) {
                case 'alreadyCached':
                    summary.cachedKeys.add(entry.cacheKey);
                    break;
                case 'live':
                    summary.liveKeys.add(entry.cacheKey);
                    break;
                case 'expired403':
                    summary.expiredKeys.add(entry.cacheKey);
                    summary.expiredAccounts.add(ref.accountUsername);
                    break;
                case 'missing':
                    summary.missingKeys.add(entry.cacheKey);
                    break;
                case 'rejected':
                    summary.rejectedKeys.add(entry.cacheKey);
                    break;
                case 'failed':
                case 'rateLimited':
                    summary.failedKeys.add(entry.cacheKey);
                    break;
            }
        }
        if (probe.outcome === 'expired403') expired.push(entry);
    }
    return expired;
}

function tokenFor(slot: ApifyCredentialSlot): string | null {
    if (slot !== APIFY_SLOT) return null;
    const token = process.env[`APIFY_${slot.toUpperCase()}_API_TOKEN`]?.trim();
    return token || null;
}

function providerEnv(slot: ApifyCredentialSlot, token: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
        APIFY_API_TOKEN: token,
        APIFY_API_TOKEN_SLOT: 'primary',
        APIFY_PRIMARY_API_TOKEN: token,
        APIFY_ACTOR_CONCURRENCY: '1',
    };
    // Keep provider tuning knobs, but never copy any other credential into the
    // environment handed to the provider factory. The only Apify token in
    // this process is the operator-approved TENTH token.
    for (const key of [
        'APIFY_PROFILE_TIMEOUT_SECS',
        'APIFY_DATASET_READ_RETRIES',
        'APIFY_DATASET_RETRY_BASE_DELAY_MS',
        'APIFY_PROFILE_ESTIMATED_COST_PER_RESULT_USD',
        'APIFY_PROFILE_MAX_ESTIMATED_COST_USD_PER_OPERATION',
    ]) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return env;
}

function buildApifyClients(): ApifySlotClient[] {
    const clients: ApifySlotClient[] = [];
    const token = tokenFor(APIFY_SLOT);
    if (!token) throw new Error('APIFY_TENTH_API_TOKEN is not configured');
    const env = providerEnv(APIFY_SLOT, token);
    const client = new ApifyClient({ token, maxRetries: 0 });
    clients.push({
        slot: APIFY_SLOT,
        env,
        client,
        // Explicitly construct the client with APIFY_TENTH_API_TOKEN. There is
        // intentionally no fallback or secondary client in this group script.
        provider: makeApifyProvider({
            env,
            client,
        }),
    });
    console.log('[apify] configuredSlots=tenth only');
    return clients;
}

function providerContext(slot: ApifyCredentialSlot): ProviderCallContext {
    return {
        credentialSlot: slot,
        // getProfileSummary enforces its fixed $0.0026 billing ceiling; the
        // separate $0.003 value is only the conservative quota reservation.
        maxChargeUsd: PROFILE_ESTIMATED_CHARGE_USD,
        invocationWaitLimitSecs: 240,
        ...(slot === 'octonary' ? { allowConciergeBatchOctonary: true as const } : {}),
        ...(slot === 'nonary' ? { allowConciergeBatchNonary: true as const } : {}),
        recordUsage: () => undefined,
    };
}

function isRetryableApifyError(error: unknown): boolean {
    const code = safeErrorCode(error);
    return RETRYABLE_APIFY_ERRORS.has(code);
}

interface TenthQuota {
    remainingUsd: number;
    allowedAccounts: number;
}

async function readTenthQuota(
    client: ApifyClient,
    requestedAccounts: number,
): Promise<TenthQuota> {
    // A profile-summary run has a fixed operator ceiling of $0.003. Use that
    // ceiling for the quota gate so a run cannot start after a false-positive
    // estimate leaves the TENTH account short.
    const limits = await client.user().limits();
    const maxMonthlyUsageUsd = limits?.limits.maxMonthlyUsageUsd;
    const monthlyUsageUsd = limits?.current.monthlyUsageUsd;
    if (
        typeof maxMonthlyUsageUsd !== 'number'
        || !Number.isFinite(maxMonthlyUsageUsd)
        || typeof monthlyUsageUsd !== 'number'
        || !Number.isFinite(monthlyUsageUsd)
    ) {
        throw new Error('APIFY_TENTH_QUOTA_UNAVAILABLE');
    }
    const remainingUsd = Math.max(0, maxMonthlyUsageUsd - monthlyUsageUsd);
    const allowedAccounts = Math.min(
        requestedAccounts,
        Math.floor((remainingUsd + Number.EPSILON) / PROFILE_MAX_CHARGE_USD),
    );
    console.log(
        `[apify] tenthQuota remainingUsd=${remainingUsd.toFixed(6)}`
        + ` requestedAccounts=${requestedAccounts}`
        + ` allowedAccounts=${allowedAccounts}`
    );
    return { remainingUsd, allowedAccounts };
}

async function scrapeFreshAccount(
    username: string,
    clients: readonly ApifySlotClient[],
): Promise<AccountResult> {
    let lastReason = 'NO_SLOT';
    for (const client of clients) {
        try {
            const profile = await client.provider.getProfileSummary?.(
                username,
                providerContext(client.slot),
            );
            if (!profile) return { username, status: 'failed', reason: 'NOT_FOUND' };
            const freshUrl = profile.profilePicUrlHD || profile.profilePicUrl;
            if (!freshUrl) return { username, status: 'failed', reason: 'NO_PROFILE_IMAGE' };
            const download = await downloadSecureImage(freshUrl, {
                allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
                maxBytes: MAX_BYTES,
                timeoutMs: DOWNLOAD_TIMEOUT_MS,
                headers: DOWNLOAD_HEADERS,
                resolveHostname: preferIpv4,
            });
            if (download.bytes.byteLength === 0) {
                return { username, status: 'failed', reason: 'EMPTY_PROFILE_IMAGE' };
            }
            return {
                username,
                status: 'success',
                bytes: download.bytes,
                contentType: download.contentType,
            };
        } catch (error) {
            lastReason = safeErrorCode(error);
            if (!isRetryableApifyError(error)) break;
        }
    }
    return { username, status: 'failed', reason: lastReason };
}

async function writeEntry(
    entry: ImageEntry,
    accountResults: Map<string, AccountResult>,
): Promise<CacheOutcome> {
    const usernames = [...new Set(entry.refs.map(ref => ref.accountUsername))];
    // A few historical rows can point at the same CDN pathname (and therefore
    // the same stable cache key) while carrying different account identities.
    // The key is the unit served by the proxy, so any successful fresh profile
    // image is sufficient to repair that key; only fail when every associated
    // account failed to produce a fresh image.
    const account = usernames
        .map(username => accountResults.get(username))
        .find(result => result?.status === 'success');
    if (!account || account.status !== 'success' || !account.bytes || !account.contentType) {
        return 'failed';
    }
    if (await readCache(entry.cacheKey)) return 'alreadyCached';
    await writeImageProxyCacheObject(
        entry.cacheKey,
        account.bytes,
        account.contentType,
        process.env,
        cacheDependencies(),
    );
    return await readCache(entry.cacheKey) ? 'cached' : 'failed';
}

async function executeReimage(
    expiredEntries: readonly ImageEntry[],
): Promise<void> {
    if (expiredEntries.length === 0) return;
    const clients = buildApifyClients();
    const usernames = [...new Set(expiredEntries.flatMap(entry => entry.refs.map(ref => ref.accountUsername)))].sort();
    const quota = await readTenthQuota(clients[0].client, usernames.length);
    const allowedUsernames = new Set(usernames.slice(0, quota.allowedAccounts));
    const skippedForQuota = usernames.slice(quota.allowedAccounts);
    const accountResults = new Map<string, AccountResult>();
    for (const username of skippedForQuota) {
        accountResults.set(username, {
            username,
            status: 'failed',
            reason: 'TENTH_QUOTA_INSUFFICIENT',
        });
    }
    let accountIndex = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = accountIndex++;
            if (index >= usernames.length - skippedForQuota.length) return;
            const username = usernames[index];
            if (!allowedUsernames.has(username)) continue;
            const result = await scrapeFreshAccount(username, clients);
            accountResults.set(username, result);
            console.log(`[apify] account=${username} status=${result.status}${result.reason ? ` reason=${result.reason}` : ''}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(2, usernames.length) }, worker));

    for (const [username, result] of accountResults) {
        for (const target of TARGETS) {
            const summary = summaryFor(target);
            if (!summary.expiredAccounts.has(username)) continue;
            if (result.status === 'success') summary.scrapeSucceededAccounts.add(username);
            else summary.scrapeFailedAccounts.set(username, result.reason ?? 'FAILED');
        }
    }

    for (const entry of expiredEntries) {
        const outcome = await writeEntry(entry, accountResults);
        for (const ref of entry.refs) {
            const summary = summaryFor(ref.target);
            if (outcome === 'cached') summary.cacheSucceededKeys.add(entry.cacheKey);
            else if (outcome === 'alreadyCached') summary.cacheAlreadyKeys.add(entry.cacheKey);
            else summary.cacheFailedKeys.add(entry.cacheKey);
        }
    }
}

async function verifySampleKeyConsistency(
    entries: readonly ImageEntry[],
    keys: readonly string[],
): Promise<{ checked: number; passed: number; failed: number }> {
    const entriesByKey = new Map(entries.map(entry => [entry.cacheKey, entry]));
    const sample = [...new Set(keys)].slice(0, 5);
    let passed = 0;
    for (const key of sample) {
        const entry = entriesByKey.get(key);
        if (!entry) continue;
        const path = createImageProxyPath(entry.canonicalUrl);
        if (!path) continue;
        const query = new URL(`https://proxy.invalid${path}`).searchParams;
        const canonicalUrl = verifyImageProxyToken(
            query.get('token') ?? '',
            query.get('expires') ?? '',
        );
        if (
            canonicalUrl
            && imageProxyCacheKey(canonicalUrl) === key
            && await readCache(key)
        ) {
            passed++;
        }
    }
    const failed = sample.length - passed;
    console.log(`[verify] sampleKeys=${sample.length} keyMatchAndReadBack=${passed} failed=${failed}`);
    return { checked: sample.length, passed, failed };
}

function printSummary(
    entries: readonly ImageEntry[],
    probes: Map<string, ProbeRecord>,
    expiredEntries: readonly ImageEntry[],
    options: Options,
): void {
    const expiredAccounts = new Set(expiredEntries.flatMap(entry => entry.refs.map(ref => ref.accountUsername)));
    const byTarget = Object.fromEntries(TARGETS.map(target => {
        const summary = summaryFor(target);
        return [target, {
            requests: summary.requestIds.size,
            sourceKeys: summary.sourceKeys.size,
            cached: summary.cachedKeys.size,
            live200: summary.liveKeys.size,
            expired403: summary.expiredKeys.size,
            expiredAccounts: summary.expiredAccounts.size,
            missing: summary.missingKeys.size,
            rejectedNon403: summary.rejectedKeys.size,
            probeFailed: summary.failedKeys.size,
            ...(options.execute ? {
                reimageSucceededAccounts: summary.scrapeSucceededAccounts.size,
                cacheWritten: summary.cacheSucceededKeys.size,
                cacheAlreadyPresent: summary.cacheAlreadyKeys.size,
                cacheFailed: summary.cacheFailedKeys.size,
                reimageFailedAccounts: Object.fromEntries(summary.scrapeFailedAccounts),
            } : {}),
        }];
    }));
    const probeCounts = Object.fromEntries(
        [...new Set([...probes.values()].map(value => value.outcome))]
            .map(outcome => [outcome, [...probes.values()].filter(value => value.outcome === outcome).length]),
    );
    console.log('[summary] ' + JSON.stringify({
        mode: options.execute ? 'execute' : 'count',
        entries: entries.length,
        expiredEntries: expiredEntries.length,
        uniqueExpiredAccounts: expiredAccounts.size,
        estimatedApifyMaxUsd: Number((expiredAccounts.size * PROFILE_MAX_CHARGE_USD).toFixed(6)),
        probeCounts,
        byTarget,
    }, null, 2));
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    const config = loadResultImageR2Config();
    const { S3Client } = await import('@aws-sdk/client-s3');
    cacheClient = new S3Client({
        endpoint: config.endpoint,
        region: 'auto',
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });

    const scopesByTarget = await resolveRequestIds(options.since);
    const entries = await collectImages(scopesByTarget);
    const probes = await probeEntries(entries, options);
    const expiredEntries = applyProbeSummaries(entries, probes);
    if (options.execute) await executeReimage(expiredEntries);
    const verifyKeys = options.execute
        ? TARGETS.flatMap(target => [...summaryFor(target).cacheSucceededKeys])
        : [];
    if (options.execute) await verifySampleKeyConsistency(entries, verifyKeys);
    printSummary(entries, probes, expiredEntries, options);
}

main().catch(error => {
    const message = error instanceof Error
        ? error.message
        : error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : 'warm-reimage-g3 failed';
    console.error(message);
    process.exit(1);
});
