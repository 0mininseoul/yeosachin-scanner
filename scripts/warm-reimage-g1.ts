/**
 * Re-images the expired profile-image URLs belonging only to the G1 concierge
 * targets.  The persisted result rows are intentionally never updated: a
 * fresh image is written to the stable image-proxy cache key derived from the
 * URL that the result page already stores.
 *
 * The default mode is a read-only liveness survey.  Run that mode first and
 * report the expired URL/account counts before using --execute, which starts
 * paid Apify profile runs and writes the R2 cache.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/warm-reimage-g1.ts
 *   npx tsx --env-file=.env.local scripts/warm-reimage-g1.ts --execute
 */
import { setTimeout as delay } from 'node:timers/promises';
import { lookup } from 'node:dns/promises';
import { S3Client } from '@aws-sdk/client-s3';
import { ApifyClient } from 'apify-client';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { canonicalizeImageProxyUrl, createImageProxyPath, verifyImageProxyToken } from '@/lib/services/media/image-proxy-token';
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
import { makeApifyProvider } from '@/lib/services/instagram/providers/apify';
import type {
    ApifyCredentialSlot,
    ProviderCallContext,
    ScraperProvider,
} from '@/lib/services/instagram/providers/types';

const TARGET_USERNAMES = [
    'xaexeonx._.9',
    '666sox',
    'hyoowonni',
    'y_h.sun',
    '___dkfka',
] as const;

const TARGET_SET = new Set<string>(TARGET_USERNAMES);
const ACTIVE_ORDER_STATUSES = ['completed', 'paid', 'analysis_in_progress'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/i;
const MAX_BYTES = 3 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8';
const DOWNLOAD_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: IMAGE_ACCEPT,
    Referer: 'https://www.instagram.com/',
};
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_PACE_MS = 200;
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_500, 5_000] as const;
const PAGE_SIZE = 1_000;
const CHUNK_SIZE = 100;
const PROFILE_MAX_CHARGE_USD = 0.0026;
const PROFILE_EXECUTION_MAX_CHARGE_USD = 0.003;
const APPROVAL_ACCOUNT_THRESHOLD = 200;

type ImageOrigin = 'target' | 'female' | 'private';
type ProbeStatus = 'live' | 'expired' | 'missing' | 'rateLimited' | 'failed';
type CacheStatus = 'cached' | 'alreadyCached' | 'failed';
type SlotName =
    | 'primary'
    | 'secondary'
    | 'tertiary'
    | 'quaternary'
    | 'quinary'
    | 'senary'
    | 'septenary'
    | 'octonary'
    | 'nonary'
    | 'tenth';

interface Options {
    execute: boolean;
    concurrency: number;
    paceMs: number;
}

interface ImageRecord {
    canonicalUrl: string;
    cacheKey: string;
    origins: Set<ImageOrigin>;
    requestIds: Set<string>;
    targetUsernames: Set<string>;
    accounts: Set<string>;
    probeStatus?: ProbeStatus;
    cacheStatus?: CacheStatus;
    failureReason?: string;
}

interface RequestRow {
    id: string;
    target_instagram_id: string;
    step_data: unknown;
}

interface SlotClient {
    slot: SlotName;
    token: string;
    provider: ScraperProvider;
}

interface FreshImage {
    bytes: Buffer;
    contentType: string;
    account: string;
    slot: SlotName;
}

interface AccountFreshResult {
    status: 'success' | 'failed';
    image?: FreshImage;
    reason?: string;
}

interface SlotInspection {
    slot: SlotName;
    configured: boolean;
    quota: 'ok' | 'low' | 'unknown' | 'unavailable';
    capacityAccounts: number;
}

let cacheClient: S3Client | undefined;

function parseOptions(argv: readonly string[]): Options {
    let execute = false;
    let concurrency = DEFAULT_CONCURRENCY;
    let paceMs = DEFAULT_PACE_MS;

    for (const argument of argv) {
        const separatorIndex = argument.indexOf('=');
        const flag = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
        const rawValue = separatorIndex === -1 ? undefined : argument.slice(separatorIndex + 1);
        switch (flag) {
            case '--execute':
                execute = true;
                break;
            case '--concurrency': {
                const value = Number(rawValue);
                if (!Number.isSafeInteger(value) || value <= 0 || value > 16) {
                    throw new Error('--concurrency must be 1..16');
                }
                concurrency = value;
                break;
            }
            case '--pace-ms': {
                const value = Number(rawValue);
                if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
                    throw new Error('--pace-ms must be 0..10000');
                }
                paceMs = value;
                break;
            }
            default:
                throw new Error(`Unknown flag: ${flag}`);
        }
    }

    return { execute, concurrency, paceMs };
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

function normalizeUsername(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().replace(/^@/, '').toLowerCase();
    return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

function validRequestId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return UUID_PATTERN.test(normalized) ? normalized : null;
}

function redact(value: unknown): string {
    const message = value instanceof Error
        ? value.message
        : typeof value === 'object' && value !== null
            ? JSON.stringify(value)
            : String(value);
    return message
        .replace(/https?:\/\/[^\s"'<>]+/giu, '[URL]')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu, '[UUID]')
        .replace(/apify_api_[A-Za-z0-9]+/giu, '[APIFY_TOKEN]')
        .slice(0, 300);
}

async function preferIpv4(hostname: string): Promise<ResolvedAddress[]> {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    const ipv4 = addresses.filter((address) => address.family === 4);
    return ipv4.length > 0 ? ipv4 : addresses;
}

function cacheDependencies() {
    return cacheClient ? { client: cacheClient } : {};
}

async function readCache(cacheKey: string): Promise<boolean> {
    return await readImageProxyCacheObject(cacheKey, process.env, cacheDependencies()) !== null;
}

function httpStatusFromError(error: SecureImageFetchError): number | null {
    const match = /status\s+(\d{3})\b/i.exec(error.message);
    return match ? Number(match[1]) : null;
}

function addImage(
    images: Map<string, ImageRecord>,
    rawUrl: unknown,
    origin: ImageOrigin,
    requestId: string,
    targetUsernames: Iterable<string>,
    account: string | null,
): void {
    if (typeof rawUrl !== 'string' || rawUrl.length === 0) return;
    let canonicalUrl: string;
    try {
        canonicalUrl = canonicalizeImageProxyUrl(rawUrl);
    } catch {
        return;
    }
    const cacheKey = imageProxyCacheKey(canonicalUrl);
    if (!cacheKey) return;

    const existing = images.get(canonicalUrl);
    if (existing) {
        existing.origins.add(origin);
        existing.requestIds.add(requestId);
        for (const target of targetUsernames) existing.targetUsernames.add(target);
        if (account) existing.accounts.add(account);
        return;
    }
    images.set(canonicalUrl, {
        canonicalUrl,
        cacheKey,
        origins: new Set([origin]),
        requestIds: new Set([requestId]),
        targetUsernames: new Set(targetUsernames),
        accounts: account ? new Set([account]) : new Set(),
    });
}

async function resolveRequestScope(): Promise<{
    requestIds: string[];
    targetByRequest: Map<string, Set<string>>;
}> {
    const targetByRequest = new Map<string, Set<string>>();
    const addRequestTarget = (requestId: unknown, target: unknown): void => {
        const id = validRequestId(requestId);
        const username = normalizeUsername(target);
        if (!id || !username || !TARGET_SET.has(username)) return;
        const targets = targetByRequest.get(id) ?? new Set<string>();
        targets.add(username);
        targetByRequest.set(id, targets);
    };

    const orderRows = await selectAllPages<{
        target_instagram_id: string;
        result_request_id: string | null;
    }>((from, to) => supabaseAdmin
        .from('earlybird_orders')
        .select('target_instagram_id,result_request_id')
        .in('target_instagram_id', [...TARGET_USERNAMES])
        .in('status', ACTIVE_ORDER_STATUSES)
        .order('target_instagram_id', { ascending: true })
        .range(from, to));
    for (const row of orderRows) {
        addRequestTarget(row.result_request_id, row.target_instagram_id);
    }

    // Some concierge targets were never captured in the frozen cohort.  A
    // direct target lookup covers those rows without inventing request ids.
    const directRows = await selectAllPages<{
        id: string;
        target_instagram_id: string;
    }>((from, to) => supabaseAdmin
        .from('analysis_requests')
        .select('id,target_instagram_id')
        .in('target_instagram_id', [...TARGET_USERNAMES])
        .eq('status', 'completed')
        .order('id', { ascending: true })
        .range(from, to));
    for (const row of directRows) {
        addRequestTarget(row.id, row.target_instagram_id);
    }

    // The frozen cohort table is intentionally FORCE RLS with no direct
    // service-role table grant.  Read it only for targets still unresolved by
    // the order/direct-request paths; a denied fallback must not block the
    // deliverable rows that are already linked through those paths.
    const unresolvedTargets = TARGET_USERNAMES.filter(target => (
        ![...targetByRequest.values()].some(targets => targets.has(target))
    ));
    if (unresolvedTargets.length > 0) {
        try {
            const cohortRows = await selectAllPages<{
                target_username: string;
                original_result_request_id: string | null;
            }>((from, to) => supabaseAdmin
                .from('earlybird_concierge_batch_cohort_members')
                .select('target_username,original_result_request_id')
                .in('target_username', unresolvedTargets)
                .order('target_username', { ascending: true })
                .range(from, to));
            for (const row of cohortRows) {
                addRequestTarget(row.original_result_request_id, row.target_username);
            }
        } catch {
            console.log(`[scope] cohortFallback=unavailable unresolvedTargets=${unresolvedTargets.length}`);
        }
    }

    return {
        requestIds: [...targetByRequest.keys()].sort(),
        targetByRequest,
    };
}

async function collectImages(
    requestIds: readonly string[],
    targetByRequest: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<ImageRecord[]> {
    const images = new Map<string, ImageRecord>();
    let rowsScanned = 0;

    for (const slice of chunk(requestIds, CHUNK_SIZE)) {
        const requests = await selectAllPages<RequestRow>((from, to) => supabaseAdmin
            .from('analysis_requests')
            .select('id,target_instagram_id,step_data')
            .in('id', slice)
            .order('id', { ascending: true })
            .range(from, to));

        for (const request of requests) {
            const requestId = validRequestId(request.id);
            if (!requestId) continue;
            const targets = new Set(targetByRequest.get(requestId) ?? []);
            const requestTarget = normalizeUsername(request.target_instagram_id);
            if (requestTarget && TARGET_SET.has(requestTarget)) targets.add(requestTarget);
            addImage(
                images,
                targetProfileImageFromStepData(request.step_data),
                'target',
                requestId,
                targets,
                requestTarget,
            );
        }

        const results = await selectAllPages<{
            request_id: string;
            suspect_instagram_id: string;
            suspect_profile_image: string | null;
        }>((from, to) => supabaseAdmin
            .from('analysis_results')
            .select('request_id,suspect_instagram_id,suspect_profile_image')
            .in('request_id', slice)
            .not('suspect_profile_image', 'is', null)
            .order('request_id', { ascending: true })
            .order('suspect_instagram_id', { ascending: true })
            .range(from, to));
        for (const result of results) {
            const requestId = validRequestId(result.request_id);
            if (!requestId) continue;
            addImage(
                images,
                result.suspect_profile_image,
                'female',
                requestId,
                targetByRequest.get(requestId) ?? [],
                normalizeUsername(result.suspect_instagram_id),
            );
        }

        const privateAccounts = await selectAllPages<{
            request_id: string;
            instagram_id: string;
            profile_image: string | null;
        }>((from, to) => supabaseAdmin
            .from('private_accounts')
            .select('request_id,instagram_id,profile_image')
            .in('request_id', slice)
            .not('profile_image', 'is', null)
            .order('request_id', { ascending: true })
            .order('instagram_id', { ascending: true })
            .range(from, to));
        for (const account of privateAccounts) {
            const requestId = validRequestId(account.request_id);
            if (!requestId) continue;
            addImage(
                images,
                account.profile_image,
                'private',
                requestId,
                targetByRequest.get(requestId) ?? [],
                normalizeUsername(account.instagram_id),
            );
        }
        rowsScanned += requests.length + results.length + privateAccounts.length;
    }

    console.log(`[collect] requestCount=${requestIds.length} rowsScanned=${rowsScanned} uniqueSavedUrls=${images.size}`);
    return [...images.values()];
}

async function probeOne(
    image: ImageRecord,
    paceMs: number,
): Promise<ProbeStatus> {
    if (paceMs > 0) await delay(paceMs + Math.floor(Math.random() * paceMs));
    let lastReason = 'unexpected_error';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        try {
            await downloadSecureImage(image.canonicalUrl, {
                allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
                maxBytes: MAX_BYTES,
                timeoutMs: DOWNLOAD_TIMEOUT_MS,
                headers: DOWNLOAD_HEADERS,
                resolveHostname: preferIpv4,
            });
            return 'live';
        } catch (error) {
            if (!(error instanceof SecureImageFetchError)) return 'failed';
            lastReason = error.reason;
            if (error.reason === 'source_rejected') {
                return httpStatusFromError(error) === 403 ? 'expired' : 'failed';
            }
            if (error.reason === 'source_missing') return 'missing';
            if (
                !new Set(['network_failure', 'timeout', 'rate_limited', 'upstream_unavailable'])
                    .has(error.reason)
                || attempt === MAX_ATTEMPTS - 1
            ) break;
            await delay(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
        }
    }
    return lastReason === 'rate_limited' ? 'rateLimited' : 'failed';
}

async function probeImages(
    images: readonly ImageRecord[],
    options: Options,
): Promise<void> {
    let nextIndex = 0;
    let completed = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= images.length) return;
            const image = images[index];
            image.probeStatus = await probeOne(image, options.paceMs);
            completed += 1;
            if (completed % 50 === 0 || completed === images.length) {
                console.log(`[probe] ${completed}/${images.length}`);
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(options.concurrency, images.length) }, worker),
    );
}

function expiredImages(images: readonly ImageRecord[]): ImageRecord[] {
    return images.filter(image => image.probeStatus === 'expired');
}

function expiredAccounts(images: readonly ImageRecord[]): Set<string> {
    const accounts = new Set<string>();
    for (const image of expiredImages(images)) {
        for (const account of image.accounts) accounts.add(account);
    }
    return accounts;
}

function targetSummary(
    images: readonly ImageRecord[],
): Record<string, { expiredUrls: number; expiredAccounts: number }> {
    return Object.fromEntries(TARGET_USERNAMES.map(target => {
        const targetImages = images.filter(image => image.targetUsernames.has(target));
        const targetExpired = targetImages.filter(image => image.probeStatus === 'expired');
        const accounts = new Set<string>();
        for (const image of targetExpired) {
            for (const account of image.accounts) accounts.add(account);
        }
        return [target, { expiredUrls: targetExpired.length, expiredAccounts: accounts.size }];
    }));
}

function printSurvey(
    requestIds: readonly string[],
    images: readonly ImageRecord[],
): void {
    const counts: Record<ProbeStatus, number> = {
        live: 0,
        expired: 0,
        missing: 0,
        rateLimited: 0,
        failed: 0,
    };
    for (const image of images) counts[image.probeStatus ?? 'failed'] += 1;
    const accounts = expiredAccounts(images);
    const summary = {
        targets: TARGET_USERNAMES.length,
        requestCount: requestIds.length,
        uniqueSavedUrls: images.length,
        live: counts.live,
        expired403: counts.expired,
        missing: counts.missing,
        rateLimited: counts.rateLimited,
        failed: counts.failed,
        uniqueExpiredAccounts: accounts.size,
        estimatedApifyUsd: Number((accounts.size * PROFILE_MAX_CHARGE_USD).toFixed(4)),
        targetSummary: targetSummary(images),
    };
    console.log('[survey] ' + JSON.stringify(summary, null, 2));
    if (accounts.size >= APPROVAL_ACCOUNT_THRESHOLD) {
        console.log(`[survey] approvalRecommended=true threshold=${APPROVAL_ACCOUNT_THRESHOLD}`);
    }
}

// This maintenance run is deliberately fenced to one operator quota.  Do not
// add fallback slots here: the other credentials are exhausted for this month.
const SLOT_PRIORITY: readonly SlotName[] = ['tenth'];

const SLOT_ENV_KEY: Record<SlotName, string> = {
    primary: 'APIFY_PRIMARY_API_TOKEN',
    secondary: 'APIFY_SECONDARY_API_TOKEN',
    tertiary: 'APIFY_TERTIARY_API_TOKEN',
    quaternary: 'APIFY_QUATERNARY_API_TOKEN',
    quinary: 'APIFY_QUINARY_API_TOKEN',
    senary: 'APIFY_SENARY_API_TOKEN',
    septenary: 'APIFY_SEPTENARY_API_TOKEN',
    octonary: 'APIFY_OCTONARY_API_TOKEN',
    nonary: 'APIFY_NONARY_API_TOKEN',
    tenth: 'APIFY_TENTH_API_TOKEN',
};

function tokenFor(slot: SlotName): string | null {
    const named = process.env[SLOT_ENV_KEY[slot]]?.trim();
    if (named) return named;
    if (slot === 'primary') return process.env.APIFY_API_TOKEN?.trim() || null;
    return null;
}

function providerEnv(token: string): Record<string, string | undefined> {
    const env = { ...process.env };
    for (const key of Object.values(SLOT_ENV_KEY)) delete env[key];
    return {
        ...env,
        APIFY_API_TOKEN: token,
        APIFY_PRIMARY_API_TOKEN: token,
        APIFY_TENTH_API_TOKEN: token,
        APIFY_API_TOKEN_SLOT: 'primary',
        APIFY_ACTOR_CONCURRENCY: '1',
    };
}

function providerContext(slot: SlotName): ProviderCallContext {
    return {
        credentialSlot: slot as ApifyCredentialSlot,
        maxChargeUsd: PROFILE_MAX_CHARGE_USD,
        invocationWaitLimitSecs: 240,
        ...(slot === 'octonary' ? { allowConciergeBatchOctonary: true as const } : {}),
        ...(slot === 'nonary' ? { allowConciergeBatchNonary: true as const } : {}),
        recordUsage: () => undefined,
    };
}

async function inspectSlots(): Promise<{
    inspections: SlotInspection[];
    clients: SlotClient[];
}> {
    const inspections: SlotInspection[] = [];
    const clients: SlotClient[] = [];
    for (const slot of SLOT_PRIORITY) {
        const token = tokenFor(slot);
        if (!token) {
            inspections.push({ slot, configured: false, quota: 'unavailable', capacityAccounts: 0 });
            continue;
        }
        const client = new ApifyClient({ token, maxRetries: 0 });
        let quota: SlotInspection['quota'] = 'unknown';
        let capacityAccounts = 0;
        try {
            const [user, limits] = await Promise.all([
                client.user('me').get(),
                client.user('me').limits(),
            ]);
            const maximum = limits?.limits?.maxMonthlyUsageUsd;
            const current = limits?.current?.monthlyUsageUsd;
            const credits = user?.plan?.monthlyUsageCreditsUsd;
            const maxConcurrent = limits?.limits?.maxConcurrentActorJobs;
            const active = limits?.current?.activeActorJobCount;
            if (typeof maximum === 'number' && Number.isFinite(maximum)
                && typeof current === 'number' && Number.isFinite(current)
                && typeof credits === 'number' && Number.isFinite(credits)
                && typeof maxConcurrent === 'number' && Number.isFinite(maxConcurrent)
                && typeof active === 'number' && Number.isFinite(active)) {
                const remainingMonthly = maximum - current;
                const remainingCredits = credits - current;
                const hasCapacity = active < maxConcurrent;
                const remainingUsd = Math.min(remainingMonthly, remainingCredits);
                capacityAccounts = Math.max(
                    0,
                    Math.floor(remainingUsd / PROFILE_EXECUTION_MAX_CHARGE_USD),
                );
                quota = hasCapacity && capacityAccounts > 0 ? 'ok' : 'low';
            }
        } catch {
            quota = 'unknown';
        }
        inspections.push({ slot, configured: true, quota, capacityAccounts });
        // Unknown quota is not safe for a paid maintenance run.  The caller
        // reports it as unavailable instead of silently spending credit.
        if (quota === 'ok') {
            const env = providerEnv(token);
            clients.push({
                slot,
                token,
                provider: makeApifyProvider({
                    env,
                    client,
                }),
            });
        }
    }
    console.log('[apify-slots] ' + JSON.stringify(inspections));
    return { inspections, clients };
}

function quotaOrStartRejected(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('SCRAPING_PROVIDER_QUOTA_ERROR')
        || message.includes('SCRAPING_PROVIDER_START_REJECTED_ERROR');
}

async function downloadFreshProfileImage(
    account: string,
    urls: readonly string[],
    paceMs: number,
): Promise<{ bytes: Buffer; contentType: string } | null> {
    for (const url of urls) {
        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
            if (paceMs > 0) await delay(paceMs + Math.floor(Math.random() * paceMs));
            try {
                const result = await downloadSecureImage(url, {
                    allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
                    maxBytes: MAX_BYTES,
                    timeoutMs: DOWNLOAD_TIMEOUT_MS,
                    headers: DOWNLOAD_HEADERS,
                    resolveHostname: preferIpv4,
                });
                return { bytes: result.bytes, contentType: result.contentType };
            } catch (error) {
                if (!(error instanceof SecureImageFetchError)) return null;
                if (error.reason === 'source_missing' || error.reason === 'source_rejected') break;
                if (
                    !new Set(['network_failure', 'timeout', 'rate_limited', 'upstream_unavailable'])
                        .has(error.reason)
                    || attempt === MAX_ATTEMPTS - 1
                ) break;
                await delay(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
            }
        }
    }
    console.log(`[fresh-image] account=${account} status=unavailable`);
    return null;
}

async function freshProfileForAccount(
    account: string,
    clients: SlotClient[],
    paceMs: number,
    exhaustedSlots: Set<SlotName>,
): Promise<AccountFreshResult> {
    for (const client of clients) {
        if (exhaustedSlots.has(client.slot)) continue;
        try {
            const getProfileSummary = client.provider.getProfileSummary;
            if (!getProfileSummary) return { status: 'failed', reason: 'provider_summary_unavailable' };
            const profile = await getProfileSummary.call(
                client.provider,
                account,
                providerContext(client.slot),
            );
            if (!profile) return { status: 'failed', reason: 'account_not_found' };
            const imageUrls = [profile.profilePicUrlHD, profile.profilePicUrl]
                .filter((value): value is string => typeof value === 'string' && value.length > 0);
            if (imageUrls.length === 0) {
                return { status: 'failed', reason: 'fresh_profile_image_missing' };
            }
            const image = await downloadFreshProfileImage(account, imageUrls, paceMs);
            if (!image) return { status: 'failed', reason: 'fresh_profile_image_unavailable' };
            return {
                status: 'success',
                image: {
                    ...image,
                    account,
                    slot: client.slot,
                },
            };
        } catch (error) {
            if (quotaOrStartRejected(error)) {
                exhaustedSlots.add(client.slot);
                console.log(`[apify] slot=${client.slot} status=skipped`);
                continue;
            }
            return { status: 'failed', reason: redact(error) };
        }
    }
    return { status: 'failed', reason: exhaustedSlots.size > 0 ? 'apify_slot_unavailable' : 'apify_client_unavailable' };
}

async function cacheOne(
    image: ImageRecord,
    fresh: FreshImage,
): Promise<CacheStatus> {
    if (await readCache(image.cacheKey)) return 'alreadyCached';
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        await writeImageProxyCacheObject(
            image.cacheKey,
            fresh.bytes,
            fresh.contentType,
            process.env,
            cacheDependencies(),
        );
        if (await readCache(image.cacheKey)) return 'cached';
        if (attempt < MAX_ATTEMPTS - 1) {
            await delay(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
        }
    }
    return 'failed';
}

async function executeReimage(
    images: readonly ImageRecord[],
    options: Options,
): Promise<void> {
    const expired = expiredImages(images);
    const config = loadResultImageR2Config();
    cacheClient = new S3Client({
        endpoint: config.endpoint,
        region: 'auto',
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
        },
    });

    const needsFresh = [] as ImageRecord[];
    for (const image of expired) {
        if (await readCache(image.cacheKey)) {
            image.cacheStatus = 'alreadyCached';
        } else {
            needsFresh.push(image);
        }
    }
    const accounts = new Set<string>();
    for (const image of needsFresh) {
        for (const account of image.accounts) accounts.add(account);
    }
    console.log(`[execute] expired403=${expired.length} cacheMisses=${needsFresh.length} apifyAccounts=${accounts.size}`);

    if (accounts.size === 0) {
        for (const image of needsFresh) {
            image.cacheStatus = 'failed';
            image.failureReason = 'no_account_identity';
        }
        return;
    }

    const { clients, inspections } = await inspectSlots();
    const exhaustedSlots = new Set<SlotName>();
    const freshByAccount = new Map<string, AccountFreshResult>();
    const capacity = inspections.find(item => item.slot === 'tenth')?.capacityAccounts ?? 0;
    const accountsToProcess = [...accounts].slice(0, capacity);
    for (const account of [...accounts].slice(capacity)) {
        freshByAccount.set(account, {
            status: 'failed',
            reason: 'tenth_quota_capacity_exhausted',
        });
    }
    let accountIndex = 0;
    for (const account of accountsToProcess) {
        accountIndex += 1;
        const result = await freshProfileForAccount(account, clients, options.paceMs, exhaustedSlots);
        freshByAccount.set(account, result);
        console.log(`[apify] ${accountIndex}/${accounts.size} account=${account} status=${result.status}`);
    }

    for (const image of needsFresh) {
        const fresh = [...image.accounts]
            .map(account => freshByAccount.get(account)?.image)
            .find((value): value is FreshImage => value !== undefined);
        if (!fresh) {
            image.cacheStatus = 'failed';
            image.failureReason = [...image.accounts]
                .map(account => freshByAccount.get(account)?.reason)
                .find((value): value is string => Boolean(value)) ?? 'fresh_profile_unavailable';
            continue;
        }
        image.cacheStatus = await cacheOne(image, fresh);
        if (image.cacheStatus === 'failed') image.failureReason = 'r2_write_not_readable';
    }
}

async function verifyKeyParity(images: readonly ImageRecord[]): Promise<void> {
    const candidates = images.filter(image => (
        image.probeStatus === 'expired'
        && (image.cacheStatus === 'cached' || image.cacheStatus === 'alreadyCached')
    ));
    if (candidates.length === 0) {
        console.log('[parity] sample=0 hits=0 skipped=no-cached-results');
        return;
    }
    const sample = candidates.slice(0, Math.min(5, candidates.length));
    let hits = 0;
    let skipped = 0;
    for (const image of sample) {
        let path: string | undefined;
        try {
            path = createImageProxyPath(image.canonicalUrl);
        } catch {
            skipped += 1;
            continue;
        }
        if (!path) {
            skipped += 1;
            continue;
        }
        const parsed = new URL(path, 'https://proxy.invalid');
        const token = parsed.searchParams.get('token');
        const expires = parsed.searchParams.get('expires');
        if (!token || !expires) {
            skipped += 1;
            continue;
        }
        let authorizedUrl: string | null = null;
        try {
            authorizedUrl = verifyImageProxyToken(token, expires);
        } catch {
            authorizedUrl = null;
        }
        if (!authorizedUrl || imageProxyCacheKey(authorizedUrl) !== image.cacheKey) {
            skipped += 1;
            continue;
        }
        if (await readCache(image.cacheKey)) hits += 1;
        else skipped += 1;
    }
    console.log(`[parity] sample=${sample.length} hits=${hits} skipped=${skipped}`);
}

function printExecutionSummary(images: readonly ImageRecord[]): void {
    const expired = expiredImages(images);
    const counts = { cached: 0, alreadyCached: 0, failed: 0 };
    for (const image of expired) counts[image.cacheStatus ?? 'failed'] += 1;
    const byTarget = Object.fromEntries(TARGET_USERNAMES.map(target => {
        const targetExpired = expired.filter(image => image.targetUsernames.has(target));
        const targetCounts = { expired: targetExpired.length, cached: 0, alreadyCached: 0, failed: 0 };
        for (const image of targetExpired) {
            targetCounts[image.cacheStatus ?? 'failed'] += 1;
        }
        return [target, targetCounts];
    }));
    console.log('[summary] ' + JSON.stringify({
        expired403: expired.length,
        cached: counts.cached,
        alreadyCached: counts.alreadyCached,
        failed: counts.failed,
        byTarget,
        failures: expired
            .filter(image => image.cacheStatus === 'failed')
            .reduce<Record<string, number>>((result, image) => {
                const reason = image.failureReason ?? 'unknown';
                result[reason] = (result[reason] ?? 0) + 1;
                return result;
            }, {}),
    }, null, 2));
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    console.log(`[scope] G1 targets=${TARGET_USERNAMES.join(',')}`);
    const scope = await resolveRequestScope();
    const images = await collectImages(scope.requestIds, scope.targetByRequest);
    await probeImages(images, options);
    printSurvey(scope.requestIds, images);

    if (!options.execute) {
        console.log('[mode] survey-only; no Apify or R2 writes performed');
        return;
    }
    await executeReimage(images, options);
    await verifyKeyParity(images);
    printExecutionSummary(images);
}

main().catch((error) => {
    console.error(`[fatal] ${redact(error)}`);
    process.exit(1);
});
