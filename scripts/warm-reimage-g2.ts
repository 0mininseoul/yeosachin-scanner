/**
 * Re-image the expired result-page profile images for the four G2 concierge
 * targets.  This is intentionally a group-scoped script so a maintenance run
 * cannot warm another worker's targets by accident.
 *
 * The survey phase is read-only against Postgres, Instagram, and R2.  The
 * execute phase re-scrapes only accounts whose stored image returned HTTP 403,
 * downloads the fresh profile image, and writes those bytes under the cache
 * key derived from the stored (expired) URL.  It never updates a result row or
 * republishes a request.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/warm-reimage-g2.ts --phase=survey
 *   npx tsx --env-file=.env.local scripts/warm-reimage-g2.ts --phase=execute
 *
 * Execute refuses to spend Apify credit when the survey finds more than the
 * large-run threshold unless --approve-large is explicitly provided.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { lookup } from 'node:dns/promises';
import { S3Client } from '@aws-sdk/client-s3';
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
    SecureImageFetchError,
    type ResolvedAddress,
} from '@/lib/services/media/secure-image-fetch';
import { targetProfileImageFromStepData } from '@/lib/services/analysis/result-interactions';
import { loadResultImageR2Config } from '@/lib/services/media/r2-result-image-store';
import { makeApifyProvider } from '@/lib/services/instagram/providers/apify';
import {
    getApifyClient,
    selectApifyApiToken,
} from '@/lib/services/instagram/providers/apify-relationship';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import type { InstagramProfile } from '@/lib/types/instagram';

const TARGETS = [
    'jeong._.7804',
    'wx_x1s',
    '9ad8fa.01',
    'xoukdl',
] as const;
const TARGET_SET = new Set<string>(TARGETS);
const ACTIVE_ORDER_STATUSES = ['completed', 'paid', 'analysis_in_progress'] as const;
const USERNAME_PATTERN = /^[a-z0-9._]{1,30}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_500, 5_000] as const;
const RETRYABLE_REASONS = new Set([
    'network_failure',
    'timeout',
    'rate_limited',
    'upstream_unavailable',
]);
const APIFY_PROFILE_MAX_CHARGE_USD = 0.0026;
const APIFY_PROFILE_EXECUTION_RESERVE_USD = 0.003;
const LARGE_RUN_EXPIRY_THRESHOLD = 100;
// G2 is deliberately pinned to the fresh-quota operator token.  Do not add
// fallback slots here: the other credentials are exhausted for this month.
const APIFY_SLOT: ApifyCredentialSlot = 'tenth';

type SourceKind = 'target' | 'female' | 'private';
type ProbeKind = 'live' | 'expired' | 'missing' | 'rateLimited' | 'failed' | 'unusable';

interface Options {
    phase: 'survey' | 'execute';
    concurrency: number;
    paceMs: number;
    approveLarge: boolean;
}

interface ImageRef {
    target: string;
    requestId: string;
    source: SourceKind;
    account: string;
    canonicalUrl: string;
    cacheKey: string;
}

interface ImageGroup {
    cacheKey: string;
    canonicalUrl: string;
    account: string;
    refs: ImageRef[];
}

interface Probe {
    kind: ProbeKind;
    status: number | null;
    bytes?: Buffer;
    contentType?: string;
}

interface TargetReport {
    target: string;
    requests: number;
    imageRefs: number;
    uniqueKeys: number;
    expired: number;
    expiredAccounts: number;
    expiredAlreadyCached: number;
    live: number;
    missing: number;
    rateLimited: number;
    failed: number;
    unusable: number;
    cached: number;
    alreadyCached: number;
    reimageAccounts: number;
    quotaSkipped: number;
    quotaSkippedAccounts: string[];
    refreshFailed: number;
    failedAccounts: string[];
}

interface SlotReadiness {
    slot: ApifyCredentialSlot;
    ready: boolean;
    reason: 'ready' | 'not_configured' | 'active_limit' | 'quota' | 'read_failed';
    allowedAccounts: number;
    remainingUsd: number | null;
    client?: ApifyClient;
}

interface FreshImage {
    profile: InstagramProfile;
    bytes: Buffer;
    contentType: string;
}

let cacheClient: S3Client | undefined;

function parseOptions(argv: readonly string[]): Options {
    let phase: Options['phase'] = 'survey';
    let concurrency = 1;
    let paceMs = 300;
    let approveLarge = false;

    for (const argument of argv) {
        const separatorIndex = argument.indexOf('=');
        const flag = separatorIndex === -1 ? argument : argument.slice(0, separatorIndex);
        const rawValue = separatorIndex === -1 ? undefined : argument.slice(separatorIndex + 1);
        switch (flag) {
            case '--phase':
                if (rawValue !== 'survey' && rawValue !== 'execute') {
                    throw new Error('invalid_phase');
                }
                phase = rawValue;
                break;
            case '--concurrency': {
                const value = Number(rawValue);
                if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
                    throw new Error('invalid_concurrency');
                }
                concurrency = value;
                break;
            }
            case '--pace-ms': {
                const value = Number(rawValue);
                if (!Number.isSafeInteger(value) || value < 0 || value > 10_000) {
                    throw new Error('invalid_pace');
                }
                paceMs = value;
                break;
            }
            case '--approve-large':
                approveLarge = true;
                break;
            default:
                throw new Error('unknown_option');
        }
    }

    return { phase, concurrency, paceMs, approveLarge };
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
        if (page.error) throw new Error('database_query_failed');
        const data = page.data ?? [];
        rows.push(...data);
        if (data.length < PAGE_SIZE) return rows;
    }
}

function targetForUsername(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return TARGET_SET.has(normalized) ? normalized : null;
}

function safeRequestId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return UUID_PATTERN.test(normalized) ? normalized : null;
}

function safeAccount(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const normalized = value.trim().toLowerCase();
    return USERNAME_PATTERN.test(normalized) ? normalized : null;
}

/** Resolve the current deliverable result request, preferring the paid order link. */
async function resolveRequestIds(): Promise<Map<string, string[]>> {
    const byTarget = new Map<string, string[]>();
    for (const target of TARGETS) byTarget.set(target, []);

    const orderRows = await selectAllPages<{
        target_instagram_id: string;
        result_request_id: string | null;
        status: string;
    }>((from, to) => supabaseAdmin
        .from('earlybird_orders')
        .select('target_instagram_id, result_request_id, status')
        .in('target_instagram_id', TARGETS)
        .in('status', ACTIVE_ORDER_STATUSES)
        .order('target_instagram_id', { ascending: true })
        .range(from, to));

    const orderLinked = new Set<string>();
    for (const row of orderRows) {
        const target = targetForUsername(row.target_instagram_id);
        const requestId = safeRequestId(row.result_request_id);
        if (!target || !requestId) continue;
        const ids = byTarget.get(target)!;
        if (!ids.includes(requestId)) ids.push(requestId);
        orderLinked.add(target);
    }

    // The frozen cohort table is FORCE RLS with no direct service-role grant.
    // Orders are the authoritative path for these paid targets; consult the
    // cohort only for an unresolved target, and tolerate its intentional deny.
    const unresolvedTargets = TARGETS.filter(target => (
        (byTarget.get(target)?.length ?? 0) === 0
    ));
    if (unresolvedTargets.length > 0) {
        try {
            const cohortRows = await selectAllPages<{
                target_username: string;
                original_result_request_id: string | null;
            }>((from, to) => supabaseAdmin
                .from('earlybird_concierge_batch_cohort_members')
                .select('target_username, original_result_request_id')
                .in('target_username', unresolvedTargets)
                .order('target_username', { ascending: true })
                .range(from, to));
            for (const row of cohortRows) {
                const target = targetForUsername(row.target_username);
                const requestId = safeRequestId(row.original_result_request_id);
                if (!target || !requestId || orderLinked.has(target)) continue;
                const ids = byTarget.get(target)!;
                if (!ids.includes(requestId)) ids.push(requestId);
            }
        } catch {
            console.log(`[scope] cohortFallback=unavailable unresolvedTargets=${unresolvedTargets.length}`);
        }
    }

    const directRows = await selectAllPages<{
        id: string;
        target_instagram_id: string;
        status: string;
        created_at: string;
    }>((from, to) => supabaseAdmin
        .from('analysis_requests')
        .select('id, target_instagram_id, status, created_at')
        .in('target_instagram_id', TARGETS)
        .eq('status', 'completed')
        .order('created_at', { ascending: false })
        .range(from, to));
    for (const row of directRows) {
        const target = targetForUsername(row.target_instagram_id);
        const requestId = safeRequestId(row.id);
        if (!target || !requestId) continue;
        const ids = byTarget.get(target)!;
        if (ids.length === 0) ids.push(requestId);
    }

    const summary = TARGETS.map(target => `${target}:${byTarget.get(target)!.length}`).join(' ');
    console.log(`[scope] request counts ${summary}`);
    return byTarget;
}

function addImageRef(
    refs: ImageRef[],
    input: {
        target: string;
        requestId: string;
        source: SourceKind;
        account: unknown;
        rawUrl: unknown;
    },
): void {
    const account = safeAccount(input.account);
    if (!account || typeof input.rawUrl !== 'string' || input.rawUrl.length === 0) return;
    let canonicalUrl: string;
    try {
        canonicalUrl = canonicalizeImageProxyUrl(input.rawUrl);
    } catch {
        return;
    }
    const cacheKey = imageProxyCacheKey(canonicalUrl);
    if (!cacheKey) return;
    refs.push({
        target: input.target,
        requestId: input.requestId,
        source: input.source,
        account,
        canonicalUrl,
        cacheKey,
    });
}

async function collectImageRefs(
    requestIdsByTarget: ReadonlyMap<string, readonly string[]>,
): Promise<ImageRef[]> {
    const targetRequestIds = new Map<string, string>();
    const allRequestIds = new Set<string>();
    for (const target of TARGETS) {
        const requestId = requestIdsByTarget.get(target)?.[0];
        if (requestId) {
            targetRequestIds.set(requestId, target);
            allRequestIds.add(requestId);
        }
    }
    const ids = [...allRequestIds];
    const refs: ImageRef[] = [];

    for (const slice of chunk(ids, CHUNK_SIZE)) {
        const requests = await selectAllPages<{
            id: string;
            target_instagram_id: string;
            step_data: unknown;
        }>((from, to) => supabaseAdmin
            .from('analysis_requests')
            .select('id, target_instagram_id, step_data')
            .in('id', slice)
            .order('id', { ascending: true })
            .range(from, to));
        for (const request of requests) {
            const target = targetForUsername(request.target_instagram_id)
                ?? targetRequestIds.get(request.id);
            const account = safeAccount(request.target_instagram_id);
            if (!target || !account) continue;
            addImageRef(refs, {
                target,
                requestId: request.id,
                source: 'target',
                account,
                rawUrl: targetProfileImageFromStepData(request.step_data),
            });
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
            const target = targetRequestIds.get(result.request_id);
            if (!target) continue;
            addImageRef(refs, {
                target,
                requestId: result.request_id,
                source: 'female',
                account: result.suspect_instagram_id,
                rawUrl: result.suspect_profile_image,
            });
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
            const target = targetRequestIds.get(account.request_id);
            if (!target) continue;
            addImageRef(refs, {
                target,
                requestId: account.request_id,
                source: 'private',
                account: account.instagram_id,
                rawUrl: account.profile_image,
            });
        }
    }

    console.log(`[collect] image refs=${refs.length}`);
    return refs;
}

function groupImageRefs(refs: readonly ImageRef[]): ImageGroup[] {
    const groups = new Map<string, ImageGroup>();
    for (const ref of refs) {
        const existing = groups.get(ref.cacheKey);
        if (existing) {
            existing.refs.push(ref);
            continue;
        }
        groups.set(ref.cacheKey, {
            cacheKey: ref.cacheKey,
            canonicalUrl: ref.canonicalUrl,
            account: ref.account,
            refs: [ref],
        });
    }
    return [...groups.values()];
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

function statusFromError(error: unknown): number | null {
    if (!(error instanceof SecureImageFetchError)) return null;
    const status = error.message.match(/status\s+(\d{3})/i)?.[1];
    return status ? Number(status) : null;
}

function isRetryable(error: unknown): boolean {
    return error instanceof SecureImageFetchError && RETRYABLE_REASONS.has(error.reason);
}

async function probeImage(
    url: string,
    keepBytes: boolean,
    paceMs: number,
): Promise<Probe> {
    if (paceMs > 0) await delay(paceMs + Math.floor(Math.random() * paceMs));
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        try {
            const download = await downloadSecureImage(url, {
                allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
                maxBytes: MAX_BYTES,
                timeoutMs: DOWNLOAD_TIMEOUT_MS,
                headers: DOWNLOAD_HEADERS,
                resolveHostname: preferIpv4,
            });
            return {
                kind: 'live',
                status: 200,
                ...(keepBytes ? { bytes: download.bytes, contentType: download.contentType } : {}),
            };
        } catch (error) {
            lastError = error;
            const status = statusFromError(error);
            if (status === 403) return { kind: 'expired', status };
            if (status === 404 || status === 410) return { kind: 'missing', status };
            if (status === 429) return { kind: 'rateLimited', status };
            if (!(isRetryable(error) && attempt < MAX_ATTEMPTS - 1)) break;
            await delay(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
        }
    }
    if (lastError instanceof SecureImageFetchError) {
        if (lastError.reason === 'source_missing') return { kind: 'missing', status: null };
        if (lastError.reason === 'rate_limited') return { kind: 'rateLimited', status: null };
        if (lastError.reason === 'invalid_url' || lastError.reason === 'blocked_source') {
            return { kind: 'unusable', status: null };
        }
    }
    return { kind: 'failed', status: statusFromError(lastError) };
}

function emptyReport(target: string): TargetReport {
    return {
        target,
        requests: 0,
        imageRefs: 0,
        uniqueKeys: 0,
        expired: 0,
        expiredAccounts: 0,
        expiredAlreadyCached: 0,
        live: 0,
        missing: 0,
        rateLimited: 0,
        failed: 0,
        unusable: 0,
        cached: 0,
        alreadyCached: 0,
        reimageAccounts: 0,
        quotaSkipped: 0,
        quotaSkippedAccounts: [],
        refreshFailed: 0,
        failedAccounts: [],
    };
}

function reportsForRefs(refs: readonly ImageRef[], requestIdsByTarget: ReadonlyMap<string, readonly string[]>): Map<string, TargetReport> {
    const reports = new Map<string, TargetReport>(TARGETS.map(target => [target, emptyReport(target)]));
    for (const target of TARGETS) {
        reports.get(target)!.requests = requestIdsByTarget.get(target)?.length ?? 0;
    }
    for (const ref of refs) reports.get(ref.target)!.imageRefs += 1;
    return reports;
}

function incrementProbeReport(report: TargetReport, kind: ProbeKind): void {
    report[kind === 'rateLimited' ? 'rateLimited' : kind] += 1;
}

async function survey(
    refs: readonly ImageRef[],
    requestIdsByTarget: ReadonlyMap<string, readonly string[]>,
    options: Options,
): Promise<{
    groups: ImageGroup[];
    probes: Map<string, Probe>;
    reports: Map<string, TargetReport>;
}> {
    const reports = reportsForRefs(refs, requestIdsByTarget);
    const groups = groupImageRefs(refs);
    for (const target of TARGETS) reports.get(target)!.uniqueKeys = new Set(
        refs.filter(ref => ref.target === target).map(ref => ref.cacheKey),
    ).size;

    const probes = new Map<string, Probe>();
    let completed = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = completed;
            completed += 1;
            if (index >= groups.length) return;
            const group = groups[index];
            const probe = await probeImage(group.canonicalUrl, false, options.paceMs);
            probes.set(group.cacheKey, probe);
            for (const ref of group.refs) incrementProbeReport(reports.get(ref.target)!, probe.kind);
            if (completed % 25 === 0 || completed === groups.length) {
                console.log(`[probe] ${completed}/${groups.length}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(1, groups.length)) }, worker));

    for (const group of groups) {
        const probe = probes.get(group.cacheKey);
        if (probe?.kind !== 'expired') continue;
        const cached = await readCache(group.cacheKey);
        if (cached) {
            for (const ref of group.refs) reports.get(ref.target)!.expiredAlreadyCached += 1;
        }
    }
    for (const target of TARGETS) {
        const targetGroups = groups.filter(group => group.refs.some(ref => ref.target === target));
        const expiredAccounts = new Set(
            targetGroups
                .filter(group => probes.get(group.cacheKey)?.kind === 'expired')
                .map(group => group.account),
        );
        reports.get(target)!.expiredAccounts = expiredAccounts.size;
    }
    return { groups, probes, reports };
}

function printReports(
    reports: ReadonlyMap<string, TargetReport>,
    phase: Options['phase'],
): void {
    for (const target of TARGETS) {
        const report = reports.get(target)!;
        console.log(`[report] phase=${phase} ${JSON.stringify(report)}`);
    }
    const total = TARGETS.reduce((sum, target) => sum + reports.get(target)!.expired, 0);
    const accounts = new Set<string>();
    // Account names are intentionally not printed here; the coordinator only
    // needs bounded counts before approving paid work.
    for (const report of reports.values()) {
        if (report.expiredAccounts > 0) accounts.add(report.target);
    }
    console.log(`[report-total] phase=${phase} expiredRefs=${total} targetsWithExpiry=${accounts.size}`);
}

function safeErrorCategory(error: unknown): string {
    if (!(error instanceof Error)) return 'unknown';
    const message = error.message;
    if (message.includes('QUOTA')) return 'quota';
    if (message.includes('NOT_FOUND') || message.includes('not-found')) return 'not_found';
    if (message.includes('INCOMPLETE')) return 'incomplete';
    if (message.includes('CONFIG')) return 'config';
    return 'provider_error';
}

function providerEnv(token: string): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
        // The provider factory's static definition reads primary.  The call
        // context below carries the actual slot identity used for billing.
        APIFY_API_TOKEN_SLOT: 'primary',
        APIFY_API_TOKEN: token,
        APIFY_PRIMARY_API_TOKEN: token,
        APIFY_ACTOR_CONCURRENCY: '1',
    };
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

async function inspectApifySlot(slot: ApifyCredentialSlot): Promise<SlotReadiness> {
    try {
        selectApifyApiToken(process.env, slot);
    } catch {
        return {
            slot,
            ready: false,
            reason: 'not_configured',
            allowedAccounts: 0,
            remainingUsd: null,
        };
    }
    try {
        const client = getApifyClient(process.env, slot);
        const limits = await client.user().limits();
        const maximum = Number(limits?.limits?.maxMonthlyUsageUsd);
        const used = Number(limits?.current?.monthlyUsageUsd);
        const maxConcurrent = Number(limits?.limits?.maxConcurrentActorJobs);
        const active = Number(limits?.current?.activeActorJobCount);
        const remainingMonthly = maximum - used;
        const allowedAccounts = Number.isFinite(remainingMonthly)
            ? Math.floor((Math.max(0, remainingMonthly) + Number.EPSILON)
                / APIFY_PROFILE_EXECUTION_RESERVE_USD)
            : 0;
        const hasCapacity = Number.isFinite(maxConcurrent)
            && Number.isFinite(active)
            && active < maxConcurrent;
        if (!hasCapacity) {
            return {
                slot,
                ready: false,
                reason: 'active_limit',
                allowedAccounts,
                remainingUsd: Number.isFinite(remainingMonthly) ? remainingMonthly : null,
            };
        }
        if (allowedAccounts < 1) {
            return {
                slot,
                ready: false,
                reason: 'quota',
                allowedAccounts: 0,
                remainingUsd: Number.isFinite(remainingMonthly) ? remainingMonthly : null,
            };
        }
        return {
            slot,
            ready: true,
            reason: 'ready',
            allowedAccounts,
            remainingUsd: Number.isFinite(remainingMonthly) ? remainingMonthly : null,
            client,
        };
    } catch {
        return {
            slot,
            ready: false,
            reason: 'read_failed',
            allowedAccounts: 0,
            remainingUsd: null,
        };
    }
}

async function chooseApifySlot(): Promise<SlotReadiness> {
    const readiness = await inspectApifySlot(APIFY_SLOT);
    console.log(`[apify-slot] ${APIFY_SLOT}=${readiness.reason}`);
    if (readiness.ready) return readiness;
    throw new Error(`no_apify_slot_with_quota:${readiness.reason}`);
}

async function fetchFreshProfile(
    account: string,
    slot: SlotReadiness,
): Promise<FreshImage> {
    if (!slot.client) throw new Error('apify_client_missing');
    const token = selectApifyApiToken(process.env, slot.slot);
    const provider = makeApifyProvider({
        env: providerEnv(token),
        client: new ApifyClient({ token, maxRetries: 0 }),
    });
    const profile = await provider.getProfileSummary?.(account, {
        credentialSlot: slot.slot,
        maxChargeUsd: APIFY_PROFILE_MAX_CHARGE_USD,
        invocationWaitLimitSecs: 75,
        recordUsage: () => undefined,
    });
    if (!profile || profile.username.toLowerCase() !== account) {
        throw new Error('profile_not_found');
    }
    const freshUrl = profile.profilePicUrlHD || profile.profilePicUrl;
    if (!freshUrl) throw new Error('profile_image_missing');
    const download = await probeImage(freshUrl, true, 0);
    if (download.kind !== 'live' || !download.bytes || !download.contentType) {
        throw new Error(`fresh_image_${download.kind}`);
    }
    return { profile, bytes: download.bytes, contentType: download.contentType };
}

async function writeFreshToExpiredKeys(
    accountGroups: readonly ImageGroup[],
    fresh: FreshImage,
): Promise<{ cached: Set<string>; alreadyCached: Set<string>; failed: Set<string> }> {
    const cached = new Set<string>();
    const alreadyCached = new Set<string>();
    const failed = new Set<string>();
    for (const group of accountGroups) {
        if (await readCache(group.cacheKey)) {
            alreadyCached.add(group.cacheKey);
            continue;
        }
        await writeImageProxyCacheObject(
            group.cacheKey,
            fresh.bytes,
            fresh.contentType,
            process.env,
            cacheDependencies(),
        );
        if (await readCache(group.cacheKey)) cached.add(group.cacheKey);
        else failed.add(group.cacheKey);
    }
    return { cached, alreadyCached, failed };
}

async function execute(
    groups: readonly ImageGroup[],
    probes: ReadonlyMap<string, Probe>,
    reports: Map<string, TargetReport>,
    options: Options,
): Promise<void> {
    const expiredGroups = groups.filter(group => probes.get(group.cacheKey)?.kind === 'expired');
    const uncachedGroups: ImageGroup[] = [];
    for (const group of expiredGroups) {
        if (await readCache(group.cacheKey)) {
            for (const ref of group.refs) reports.get(ref.target)!.alreadyCached += 1;
        } else {
            uncachedGroups.push(group);
        }
    }
    const expiredAccounts = new Set(uncachedGroups.map(group => group.account));
    if (uncachedGroups.length > LARGE_RUN_EXPIRY_THRESHOLD && !options.approveLarge) {
        throw new Error('large_run_requires_approval');
    }
    if (uncachedGroups.length === 0) {
        console.log('[execute] no HTTP 403 images require re-image');
        return;
    }
    console.log(`[execute] expired403Keys=${expiredGroups.length} cacheMissKeys=${uncachedGroups.length} accounts=${expiredAccounts.size}`);
    const slot = await chooseApifySlot();
    console.log(
        `[apify] tenthRemainingUsd=${slot.remainingUsd === null ? 'unknown' : slot.remainingUsd.toFixed(6)}`
        + ` allowedAccounts=${slot.allowedAccounts}`,
    );
    const byAccount = new Map<string, ImageGroup[]>();
    for (const group of uncachedGroups) {
        const list = byAccount.get(group.account) ?? [];
        list.push(group);
        byAccount.set(group.account, list);
    }

    const accounts = [...byAccount.entries()].sort(([left], [right]) => left.localeCompare(right));
    const allowedAccountCount = Math.min(slot.allowedAccounts, accounts.length);
    const allowedAccounts = accounts.slice(0, allowedAccountCount);
    const skippedAccounts = accounts.slice(allowedAccountCount);
    for (const [account, accountGroups] of skippedAccounts) {
        for (const group of accountGroups) {
            for (const ref of group.refs) {
                const report = reports.get(ref.target)!;
                report.quotaSkipped += 1;
                if (!report.quotaSkippedAccounts.includes(account)) {
                    report.quotaSkippedAccounts.push(account);
                }
            }
        }
    }
    if (skippedAccounts.length > 0) {
        console.log(`[apify] tenthQuotaSkippedAccounts=${skippedAccounts.length}`);
    }
    const reimageAccountsByTarget = new Map<string, Set<string>>();
    for (const target of TARGETS) reimageAccountsByTarget.set(target, new Set());
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= allowedAccounts.length) return;
            const [account, accountGroups] = allowedAccounts[index];
            try {
                const fresh = await fetchFreshProfile(account, slot);
                for (const group of accountGroups) {
                    for (const ref of group.refs) reimageAccountsByTarget.get(ref.target)!.add(account);
                }
                const writes = await writeFreshToExpiredKeys(accountGroups, fresh);
                for (const group of accountGroups) {
                    for (const ref of group.refs) {
                        const report = reports.get(ref.target)!;
                        if (writes.cached.has(group.cacheKey)) report.cached += 1;
                        else if (writes.alreadyCached.has(group.cacheKey)) report.alreadyCached += 1;
                        else if (writes.failed.has(group.cacheKey)) {
                            report.refreshFailed += 1;
                            if (!report.failedAccounts.includes(account)) report.failedAccounts.push(account);
                        }
                    }
                }
                console.log(`[reimage] account=${account} keys=${accountGroups.length} cached=${writes.cached.size} alreadyCached=${writes.alreadyCached.size} failed=${writes.failed.size}`);
            } catch (error) {
                const category = safeErrorCategory(error);
                for (const group of accountGroups) {
                    for (const ref of group.refs) {
                        const report = reports.get(ref.target)!;
                        report.refreshFailed += 1;
                        if (!report.failedAccounts.includes(account)) report.failedAccounts.push(account);
                    }
                }
                console.log(`[reimage-failed] account=${account} keys=${accountGroups.length} category=${category}`);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, Math.max(1, allowedAccounts.length)) }, worker));
    for (const target of TARGETS) {
        reports.get(target)!.reimageAccounts = reimageAccountsByTarget.get(target)!.size;
    }
}

/** Verify that the public proxy token derives the same stable key we warmed. */
async function verifyKeyParity(
    groups: readonly ImageGroup[],
    probes: ReadonlyMap<string, Probe>,
): Promise<void> {
    const candidates: ImageGroup[] = [];
    for (const group of groups) {
        if (probes.get(group.cacheKey)?.kind !== 'expired') continue;
        if (await readCache(group.cacheKey)) candidates.push(group);
        if (candidates.length >= 5) break;
    }
    const sample = candidates;
    let hits = 0;
    let skipped = 0;
    for (const group of sample) {
        try {
            const path = createImageProxyPath(group.canonicalUrl);
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
            const authorizedUrl = verifyImageProxyToken(token, expires);
            if (!authorizedUrl || imageProxyCacheKey(authorizedUrl) !== group.cacheKey) {
                skipped += 1;
                continue;
            }
            if (await readCache(group.cacheKey)) hits += 1;
            else skipped += 1;
        } catch {
            skipped += 1;
        }
    }
    console.log(`[parity] sample=${sample.length} hits=${hits} skipped=${skipped}`);
}

async function main(): Promise<void> {
    const options = parseOptions(process.argv.slice(2));
    const r2Config = loadResultImageR2Config();
    cacheClient = new S3Client({
        endpoint: r2Config.endpoint,
        region: 'auto',
        credentials: {
            accessKeyId: r2Config.accessKeyId,
            secretAccessKey: r2Config.secretAccessKey,
        },
    });
    console.log(`[start] group=G2 phase=${options.phase} targets=${TARGETS.length}`);
    const requestIdsByTarget = await resolveRequestIds();
    const refs = await collectImageRefs(requestIdsByTarget);
    const result = await survey(refs, requestIdsByTarget, options);
    printReports(result.reports, options.phase);
    if (options.phase === 'execute') {
        await execute(result.groups, result.probes, result.reports, options);
        await verifyKeyParity(result.groups, result.probes);
        printReports(result.reports, options.phase);
    }
    cacheClient.destroy();
}

main().catch(error => {
    console.error(`[fatal] ${safeErrorCategory(error)}`);
    cacheClient?.destroy();
    process.exit(1);
});
