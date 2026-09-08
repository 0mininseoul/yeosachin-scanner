import {
    AuthenticatedProtectedTransport,
    AuthenticatedReceiverProbe,
    FetchProtectedTransport,
    type ReceiverProbeAuthority,
    type ReceiverTokenProvider,
    type ProtectedTransport,
} from './platform';
import { canonicalDigest, epochFail, isObject, type ProtectedRuntimeInput, type Role } from './contracts';
import type { CloudBuildAdapter } from './cloud-build';

const LOGGING_HOSTS = new Set(['logging.googleapis.com']);
const TASKS_HOSTS = new Set(['cloudtasks.googleapis.com']);
const SUPABASE_METHODS = ['GET'] as const;
const LOGGING_PATH = '/v2/entries:list';
const MAX_PAGES = 100;
const PAGE_SIZE = 1000;
const DAY_MS = 86_400_000;
const MAX_LOG_LAG_MS = 300_000;
const TASK_ACTIVITY_LOG_TYPE = 'type.googleapis.com/google.cloud.tasks.logging.v1.TaskActivityLog';
const GOOGLE_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GOOGLE_LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
const GOOGLE_RESOURCE_ATOM = /^[A-Za-z0-9_-]{1,128}$/;
const GOOGLE_QUEUE_ID = /^[A-Za-z0-9-]{1,100}$/;
const GOOGLE_LOG_ID = /^[A-Za-z0-9_.-]{1,512}$/;
const FILTER_ATOM = /^[A-Za-z0-9_.:-]{1,256}$/;

export type SupabaseLedgerSource = Readonly<{
    kind: 'supabase';
    source: string;
    origin: string;
    table: string;
    columns: readonly string[];
    eventTimeColumn: string;
    lookbackMs: number;
    selectorDigest: string;
}>;

export type CloudLoggingEvidenceSource = Readonly<{
    kind: 'cloud-logging';
    source: string;
    project: string;
    logName: string;
    resourceType: 'cloud_tasks_queue' | 'cloud_run_revision';
    /** The reviewed identity used to bind the exact fixed TaskActivityLog filter. */
    correlation: string;
    queueResources?: readonly string[];
    receiverRoutes?: readonly string[];
    sinkName: string;
    bucketResource: string;
    lookbackMs: number;
    selectorDigest: string;
}>;

export type LiveZeroWorkSources = Readonly<{
    providerLedger: SupabaseLedgerSource | CloudLoggingEvidenceSource;
    billingLedger: SupabaseLedgerSource | CloudLoggingEvidenceSource;
    taskAudit: CloudLoggingEvidenceSource;
    receiverLog: SupabaseLedgerSource | CloudLoggingEvidenceSource;
}>;

type EvidenceSource = SupabaseLedgerSource | CloudLoggingEvidenceSource;

function sortedKeys(value: Record<string, unknown>): string {
    return Object.keys(value).sort().join(',');
}

export function validateLiveZeroWorkSources(value: unknown, expectedProject: string): value is LiveZeroWorkSources {
    if (!isObject(value)) return false;
    const names = ['providerLedger', 'billingLedger', 'taskAudit', 'receiverLog'] as const;
    if (sortedKeys(value) !== names.slice().sort().join(',') || !names.every(name => Object.prototype.hasOwnProperty.call(value, name))) return false;
    for (const name of names) {
        const source = value[name];
        if (!isObject(source) || typeof source.source !== 'string' || !bounded(source.source, 2048)) return false;
        const lookbackMs = source.lookbackMs;
        if (typeof lookbackMs !== 'number' || !Number.isSafeInteger(lookbackMs) || lookbackMs <= 0) return false;
        if (source.kind === 'supabase') {
            if (name === 'taskAudit') return false;
            const expected = 'columns,eventTimeColumn,kind,lookbackMs,origin,selectorDigest,source,table';
            if (sortedKeys(source) !== expected) return false;
            if (typeof source.origin !== 'string' || typeof source.table !== 'string' || !Array.isArray(source.columns)
                || typeof source.eventTimeColumn !== 'string'
                || typeof source.selectorDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.selectorDigest) || !bounded(source.table, 128)
                || source.columns.length === 0
                || source.columns.some(column => typeof column !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(column))
                || !validColumn(source.eventTimeColumn)) return false;
            try { sourceUrl(source.origin); } catch { return false; }
            const expectedLedger = {
                providerLedger: {
                    source: 'supabase:public.analysis_provider_cost_ledger',
                    table: 'analysis_provider_cost_ledger',
                    columns: ['run_id', 'request_id', 'operation_key', 'status', 'created_at'],
                    eventTimeColumn: 'created_at',
                },
                billingLedger: {
                    source: 'supabase:public.analysis_revenue_cost_operations',
                    table: 'analysis_revenue_cost_operations',
                    columns: ['request_id', 'owner_kind', 'owner_key_hash', 'operation_kind', 'status', 'created_at'],
                    eventTimeColumn: 'created_at',
                },
                receiverLog: {
                    source: 'supabase:public.analysis_step_events',
                    table: 'analysis_step_events',
                    columns: ['id', 'request_id', 'step', 'event_type', 'created_at'],
                    eventTimeColumn: 'created_at',
                },
            }[name as 'providerLedger' | 'billingLedger' | 'receiverLog'];
            if (!expectedLedger || source.source !== expectedLedger.source || source.table !== expectedLedger.table
                || source.eventTimeColumn !== expectedLedger.eventTimeColumn
                || source.columns.join(',') !== expectedLedger.columns.join(',')) return false;
        } else if (source.kind === 'cloud-logging') {
            // A Cloud Run request log is not a forbidden-event ledger: the two
            // authorized malformed probes are expected to appear there, while
            // structured provider/billing/user work may not have a request URL.
            // Keep Cloud Logging only for the independently reviewed Task
            // Activity Log source.
            if (name !== 'taskAudit') return false;
            const expected = name === 'taskAudit'
                ? 'bucketResource,correlation,kind,logName,lookbackMs,project,queueResources,resourceType,selectorDigest,sinkName,source'
                : 'bucketResource,correlation,kind,logName,lookbackMs,project,receiverRoutes,resourceType,selectorDigest,sinkName,source';
            if (sortedKeys(source) !== expected) return false;
            if (typeof source.project !== 'string' || source.project !== expectedProject || !GOOGLE_PROJECT.test(source.project) || !validLogName(source.logName, expectedProject)
                || (source.resourceType !== 'cloud_tasks_queue' && source.resourceType !== 'cloud_run_revision')
                || typeof source.correlation !== 'string' || !FILTER_ATOM.test(source.correlation)
                || typeof source.sinkName !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(source.sinkName)
                || !validBucketResource(source.bucketResource, expectedProject)
                || typeof source.selectorDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.selectorDigest)) return false;
            if (name === 'taskAudit') {
                if (source.resourceType !== 'cloud_tasks_queue' || !Array.isArray(source.queueResources)
                    || source.queueResources.length !== 2 || source.queueResources.some(resource => typeof resource !== 'string'
                    || !validQueueResource(resource, expectedProject))) return false;
            } else if (source.resourceType !== 'cloud_run_revision' || !Array.isArray(source.receiverRoutes)
                || source.receiverRoutes.length !== 2 || source.receiverRoutes.some(route => typeof route !== 'string'
                    || !validReceiverRoute(route))) return false;
        } else return false;
        if (source.selectorDigest !== evidenceSelectorDigest(source as unknown as EvidenceSource)) return false;
    }
    return true;
}

/** Digest only the concrete reviewed selector, excluding packet-bound source and window fields. */
export function evidenceSelectorDigest(source: SupabaseLedgerSource | CloudLoggingEvidenceSource): string {
    const selectors: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
        if (key !== 'source' && key !== 'lookbackMs' && key !== 'selectorDigest') selectors[key] = value;
    }
    // Resource unions are sets in the reviewed packet. Canonicalize their
    // order so an otherwise identical preflight/paid descriptor cannot be
    // rejected merely because a caller serialized the two roles differently.
    if ('queueResources' in selectors && Array.isArray(selectors.queueResources)) {
        selectors.queueResources = [...selectors.queueResources].sort();
    }
    if ('receiverRoutes' in selectors && Array.isArray(selectors.receiverRoutes)) {
        selectors.receiverRoutes = [...selectors.receiverRoutes].sort();
    }
    return canonicalDigest(selectors);
}

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'ADAPTER_RESPONSE_INVALID' | 'SOURCE_INVALID' | 'EVIDENCE_UNAVAILABLE'): never {
    epochFail(code);
}

function object(value: unknown): Record<string, unknown> {
    if (!isObject(value)) fail('ADAPTER_RESPONSE_INVALID');
    return value;
}

function bounded(value: unknown, max = 4096): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function validColumn(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value);
}

function validLogName(value: unknown, expectedProject?: string): value is string {
    if (typeof value !== 'string') return false;
    const match = /^projects\/([^/]+)\/logs\/([^/]+)$/.exec(value);
    return match !== null && GOOGLE_PROJECT.test(match[1]!) && (expectedProject === undefined || match[1] === expectedProject)
        && GOOGLE_LOG_ID.test(match[2]!);
}

function validQueueResource(value: unknown, expectedProject?: string): value is string {
    if (typeof value !== 'string') return false;
    const match = /^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/.exec(value);
    return match !== null && GOOGLE_PROJECT.test(match[1]!) && (expectedProject === undefined || match[1] === expectedProject)
        && GOOGLE_LOCATION.test(match[2]!) && GOOGLE_QUEUE_ID.test(match[3]!);
}

function validBucketResource(value: unknown, expectedProject?: string): value is string {
    if (typeof value !== 'string') return false;
    const match = /^projects\/([^/]+)\/locations\/([^/]+)\/buckets\/([^/]+)$/.exec(value);
    return match !== null && GOOGLE_PROJECT.test(match[1]!) && (expectedProject === undefined || match[1] === expectedProject)
        && GOOGLE_LOCATION.test(match[2]!) && GOOGLE_RESOURCE_ATOM.test(match[3]!);
}

function validReceiverRoute(value: unknown): value is string {
    if (typeof value !== 'string' || value.length > 2048 || /["'\u0000-\u001f\u007f]/.test(value)) return false;
    let parsed: URL;
    try { parsed = new URL(value); } catch { return false; }
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.port === ''
        && parsed.search === '' && parsed.hash === '' && /^[A-Za-z0-9.-]{1,253}$/.test(parsed.hostname)
        && parsed.pathname.startsWith('/') && !/["'\u0000-\u001f\u007f]/.test(parsed.pathname);
}

function sourceUrl(origin: string): URL {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { fail('ADAPTER_REQUEST_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== '/') fail('ADAPTER_REQUEST_INVALID');
    return parsed;
}

function parseTimestamp(value: unknown): number {
    if (typeof value !== 'string') fail('EVIDENCE_UNAVAILABLE');
    const result = Date.parse(value);
    if (!Number.isFinite(result)) fail('EVIDENCE_UNAVAILABLE');
    return result;
}

function sourceProof(source: string, windowStartMs: number, windowEndMs: number, observedAtMs: number, count: number, watermarkDigest: string): Record<string, unknown> {
    const coverageLagMs = observedAtMs - windowEndMs;
    return {
        provenance: source,
        digest: canonicalDigest({ source, windowStartMs, windowEndMs, count, watermarkDigest }),
        observedAtMs,
        coveredStartMs: windowStartMs,
        coveredEndMs: windowEndMs,
        coverageLagMs,
        freshnessLagMs: coverageLagMs,
        complete: true,
        eventCount: count,
        deltaCount: count,
    };
}

type PageResult = Readonly<{ entries: readonly unknown[] }>;

/**
 * Concrete evidence collectors for the reviewed primary sources. Every
 * mutable coverage fact is read from its provider: descriptors only select
 * the exact reviewed source identities and fixed filters.
 */
export class LiveEvidenceCollector {
    private readonly cloudBuild: CloudBuildAdapter;
    private readonly loggingTransport: AuthenticatedProtectedTransport;
    private readonly tasksTransport: AuthenticatedProtectedTransport;
    private readonly supabaseTransport?: AuthenticatedProtectedTransport;
    private readonly supabaseApiKey?: string;
    private readonly sources?: LiveZeroWorkSources;
    private readonly receiverTransport: ProtectedTransport;
    private readonly receiverTokenProvider: ReceiverTokenProvider;
    private readonly now: () => number;

    constructor(options: Readonly<{
        cloudBuild: CloudBuildAdapter;
        loggingTransport: AuthenticatedProtectedTransport;
        tasksTransport: AuthenticatedProtectedTransport;
        supabaseTransport?: AuthenticatedProtectedTransport;
        /** Required PostgREST apikey from the private inherited credential boundary. */
        supabaseApiKey?: string;
        sources?: LiveZeroWorkSources;
        receiverTransport?: ProtectedTransport;
        receiverTokenProvider: ReceiverTokenProvider;
        now?: () => number;
    }>) {
        this.cloudBuild = options.cloudBuild;
        this.loggingTransport = options.loggingTransport;
        this.tasksTransport = options.tasksTransport;
        this.supabaseTransport = options.supabaseTransport;
        this.supabaseApiKey = options.supabaseApiKey;
        this.sources = options.sources;
        this.receiverTransport = options.receiverTransport ?? new FetchProtectedTransport(65_536);
        this.receiverTokenProvider = options.receiverTokenProvider;
        this.now = options.now ?? (() => Date.now());
    }

    sourceObservation(input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; runtime: ProtectedRuntimeInput }>): Promise<unknown> {
        return this.cloudBuild.sourceObservation(input);
    }

    buildObservation(input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; image: string }>): Promise<string> {
        return this.cloudBuild.buildObservation(input);
    }

    async zeroWorkBaseline(input: Readonly<{ nowMs: number }>): Promise<unknown> {
        const sources = this.requireSources();
        if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) fail('EVIDENCE_UNAVAILABLE');
        const sourceDigests: Record<string, string> = {};
        for (const [name, source] of Object.entries(sources)) {
            const snapshot = await this.readSnapshot(source, Math.max(0, input.nowMs - source.lookbackMs), input.nowMs);
            sourceDigests[name] = canonicalDigest(snapshot);
        }
        // This value is intentionally stateless. The coordinator persists its
        // digest in the journal and a fresh process re-reads this exact window.
        return { capturedAtMs: input.nowMs, sourceDigests };
    }

    async zeroWorkObservation(input: Readonly<{ windowStartMs: number; windowEndMs: number; nowMs: number; baselineDigest?: string }>): Promise<unknown> {
        const sources = this.requireSources();
        if (!Number.isSafeInteger(input.windowStartMs) || !Number.isSafeInteger(input.windowEndMs)
            || !Number.isSafeInteger(input.nowMs) || input.windowStartMs < 0 || input.windowEndMs <= input.windowStartMs
            || input.windowEndMs > input.nowMs || input.baselineDigest === undefined) fail('EVIDENCE_UNAVAILABLE');
        // Bind to the durable journal checkpoint, not process memory. This
        // re-observation works after a CLI crash/restart and fails closed if
        // the provider changed the baseline window.
        const baseline = await this.zeroWorkBaseline({ nowMs: input.windowStartMs });
        if (canonicalDigest(baseline) !== input.baselineDigest) fail('EVIDENCE_UNAVAILABLE');
        const proof: Record<string, unknown> = { windowStartMs: input.windowStartMs, windowEndMs: input.windowEndMs };
        for (const [name, source] of Object.entries(sources)) {
            const events = await this.readWindow(source, input.windowStartMs, input.windowEndMs);
            if (events.coveredEndMs < input.windowEndMs) fail('EVIDENCE_UNAVAILABLE');
            proof[name] = sourceProof(sourceKey(source), input.windowStartMs, input.windowEndMs, events.observedAtMs, events.count, events.watermarkDigest);
        }
        return proof;
    }

    async probe(input: Readonly<{ role: Role; runtime: ProtectedRuntimeInput; revision: string; authority: ReceiverProbeAuthority }>): Promise<Readonly<{ status: number; code: string }>> {
        const receiver = new AuthenticatedReceiverProbe({ transport: this.receiverTransport, tokenProvider: this.receiverTokenProvider, authority: input.authority });
        return receiver.malformedBody();
    }

    private requireSources(): LiveZeroWorkSources {
        if (!this.sources) fail('EVIDENCE_UNAVAILABLE');
        return this.sources;
    }

    private async readSnapshot(source: EvidenceSource, windowStartMs: number, windowEndMs: number): Promise<unknown> {
        if (source.kind === 'supabase') {
            const result = await this.readSupabaseRows(source, windowStartMs, windowEndMs);
            // PostgREST's authenticated Date header is the only source-time
            // contract available here. It proves that the bounded exact-count
            // snapshot was served no earlier than the requested window end;
            // unlike a synthetic watermark row it also works for zero rows.
            return { rows: result.rows };
        }
        await this.assertLoggingCoverage(source, windowStartMs, windowEndMs, this.now());
        const events = await this.readLoggingEntries(source, windowStartMs, windowEndMs);
        await this.readLoggingWatermark(source, windowEndMs);
        return { events };
    }

    private async readWindow(source: EvidenceSource, windowStartMs: number, windowEndMs: number): Promise<{ count: number; coveredEndMs: number; observedAtMs: number; watermarkDigest: string }> {
        if (source.kind === 'supabase') {
            const result = await this.readSupabaseRows(source, windowStartMs, windowEndMs);
            return {
                count: result.rows.length,
                coveredEndMs: windowEndMs,
                observedAtMs: result.observedAtMs,
                watermarkDigest: canonicalDigest({ source: source.source, observedAtMs: result.observedAtMs }),
            };
        }
        await this.assertLoggingCoverage(source, windowStartMs, windowEndMs, this.now());
        const events = await this.readLoggingEntries(source, windowStartMs, windowEndMs);
        const watermark = await this.readLoggingWatermark(source, windowEndMs);
        const trustedNowMs = this.now();
        if (trustedNowMs < watermark.observedAtMs || trustedNowMs - watermark.observedAtMs > MAX_LOG_LAG_MS) fail('EVIDENCE_UNAVAILABLE');
        // Keep source evidence's receiveTimestamp intact. The trusted local
        // clock only bounds it; it must never masquerade as the source fact.
        return { count: events.length, coveredEndMs: watermark.coveredEndMs, observedAtMs: watermark.observedAtMs, watermarkDigest: watermark.digest };
    }

    private async readSupabaseRows(source: SupabaseLedgerSource, windowStartMs: number, windowEndMs: number): Promise<{ rows: readonly unknown[]; observedAtMs: number }> {
        if (!this.supabaseTransport || !bounded(this.supabaseApiKey, 8192)) fail('EVIDENCE_UNAVAILABLE');
        const origin = sourceUrl(source.origin);
        const path = `/rest/v1/${encodeURIComponent(source.table)}`;
        const rows: unknown[] = [];
        let offset = 0;
        let total: number | undefined;
        let observedAtMs = 0;
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const queryParams = new URLSearchParams({
                select: source.columns.join(','),
                [source.eventTimeColumn]: `gte.${new Date(windowStartMs).toISOString()}`,
                limit: String(PAGE_SIZE),
                offset: String(offset),
                order: `${source.eventTimeColumn}.asc`,
            });
            queryParams.append(source.eventTimeColumn, `lte.${new Date(windowEndMs).toISOString()}`);
            const { response, value } = await this.supabaseTransport.json({
                method: 'GET', url: `${origin.origin}${path}?${queryParams.toString()}`,
                allowedHosts: new Set([origin.hostname]), allowedPath: candidate => candidate === path,
                allowedMethods: SUPABASE_METHODS, allowedQueryKeys: [...queryParams.keys()],
                additionalHeaders: { Prefer: 'count=exact', apikey: this.supabaseApiKey }, acceptedStatuses: [200],
            });
            observedAtMs = Math.max(observedAtMs, this.supabaseServerDate(response, windowEndMs));
            if (!Array.isArray(value) || value.length > PAGE_SIZE || (value.length === 0 && total !== undefined && offset < total)) fail('EVIDENCE_UNAVAILABLE');
            const rangeValue = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-range')?.[1];
            if (typeof rangeValue !== 'string') fail('EVIDENCE_UNAVAILABLE');
            const range = rangeValue.match(/^(?:(\d+)-(\d+)|\*)\/(\d+|\*)$/);
            if (!range) fail('EVIDENCE_UNAVAILABLE');
            const rangeTotal = range[3] === '*' ? undefined : Number(range[3]);
            if (rangeTotal === undefined || !Number.isSafeInteger(rangeTotal) || (total !== undefined && total !== rangeTotal)) fail('EVIDENCE_UNAVAILABLE');
            total = rangeTotal;
            const rangeStart = range[1] === undefined ? undefined : Number(range[1]);
            const rangeEnd = range[2] === undefined ? undefined : Number(range[2]);
            if (value.length === 0) {
                if (total !== offset && !(total === 0 && offset === 0)) fail('EVIDENCE_UNAVAILABLE');
            } else if (rangeStart !== offset || rangeEnd !== offset + value.length - 1) fail('EVIDENCE_UNAVAILABLE');
            for (const row of value) {
                if (!isObject(row)) fail('EVIDENCE_UNAVAILABLE');
                const timestamp = parseTimestamp(row[source.eventTimeColumn]);
                if (timestamp < windowStartMs || timestamp > windowEndMs) fail('EVIDENCE_UNAVAILABLE');
            }
            rows.push(...value);
            offset += value.length;
            if (offset === total) return { rows, observedAtMs };
            if (value.length === 0 || value.length < PAGE_SIZE) fail('EVIDENCE_UNAVAILABLE');
        }
        fail('EVIDENCE_UNAVAILABLE');
    }

    private supabaseServerDate(response: { headers: Readonly<Record<string, string>> }, windowEndMs: number): number {
        const header = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'date')?.[1];
        if (typeof header !== 'string' || !bounded(header, 128)) fail('EVIDENCE_UNAVAILABLE');
        const observedAtMs = Date.parse(header);
        if (!Number.isSafeInteger(observedAtMs) || observedAtMs < windowEndMs) fail('EVIDENCE_UNAVAILABLE');
        const trustedNowMs = this.now();
        if (!Number.isSafeInteger(trustedNowMs) || observedAtMs - trustedNowMs > MAX_LOG_LAG_MS || trustedNowMs - observedAtMs > MAX_LOG_LAG_MS) fail('EVIDENCE_UNAVAILABLE');
        return observedAtMs;
    }

    private async readLoggingEntries(source: CloudLoggingEvidenceSource, windowStartMs: number, windowEndMs: number): Promise<readonly unknown[]> {
        const result = await this.readLoggingPages(`${this.logFilter(source)} AND timestamp >= "${new Date(windowStartMs).toISOString()}" AND timestamp <= "${new Date(windowEndMs).toISOString()}"`);
        const entries: unknown[] = [];
        for (const entry of result.entries) {
            const item = object(entry);
            const timestamp = parseTimestamp(item.timestamp);
            if (timestamp < windowStartMs || timestamp > windowEndMs) fail('EVIDENCE_UNAVAILABLE');
            if (source.resourceType === 'cloud_tasks_queue') {
                if (!isObject(item.jsonPayload)) fail('EVIDENCE_UNAVAILABLE');
                const payload = item.jsonPayload;
                // TaskActivityLog's taskCreationLog is the reviewed primary
                // evidence. Attempt/delete payloads are not task creation and
                // must not inflate the forbidden-event count.
                if (payload.taskCreationLog !== undefined) {
                    if (!isObject(payload.taskCreationLog)) fail('EVIDENCE_UNAVAILABLE');
                    entries.push(entry);
                }
            } else {
                entries.push(entry);
            }
        }
        return entries;
    }

    private async readLoggingWatermark(source: CloudLoggingEvidenceSource, windowEndMs: number): Promise<{ coveredEndMs: number; observedAtMs: number; digest: string }> {
        // Cloud Logging does not expose a query watermark. Use only a real
        // TaskActivityLog entry's receiveTimestamp observed after the frozen
        // window; a custom marker would manufacture coverage and is not a
        // production Cloud Tasks source. If no such entry exists, fail closed.
        const result = await this.readLoggingPages(`${this.logFilter(source)} AND receiveTimestamp >= "${new Date(windowEndMs).toISOString()}"`);
        const trustedNowMs = this.now();
        const candidates: Array<{ coveredEndMs: number; receiveTimestamp: number; entry: unknown }> = [];
        for (const entry of result.entries) {
            const item = object(entry);
            const receiveTimestamp = parseTimestamp(item.receiveTimestamp);
            if (receiveTimestamp >= windowEndMs && receiveTimestamp <= trustedNowMs && trustedNowMs - receiveTimestamp <= MAX_LOG_LAG_MS) {
                candidates.push({ coveredEndMs: receiveTimestamp, receiveTimestamp, entry });
            }
        }
        const watermark = candidates.sort((left, right) => right.coveredEndMs - left.coveredEndMs)[0];
        if (!watermark || watermark.coveredEndMs < windowEndMs) fail('EVIDENCE_UNAVAILABLE');
        return { coveredEndMs: watermark.coveredEndMs, observedAtMs: watermark.receiveTimestamp, digest: canonicalDigest(watermark.entry) };
    }

    private async readLoggingPages(filter: string): Promise<PageResult> {
        let pageToken: string | undefined;
        const seen = new Set<string>();
        const entries: unknown[] = [];
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const body: Record<string, unknown> = {
                resourceNames: [`projects/${this.requireProject(filter)}`], filter, orderBy: 'timestamp asc', pageSize: PAGE_SIZE,
            };
            if (pageToken !== undefined) body.pageToken = pageToken;
            const { value } = await this.loggingTransport.json({
                method: 'POST', url: `https://logging.googleapis.com${LOGGING_PATH}`, allowedHosts: LOGGING_HOSTS,
                allowedPath: candidate => candidate === LOGGING_PATH, allowedMethods: ['POST'], allowedQueryKeys: [], acceptedStatuses: [200], body,
            });
            const result = object(value);
            if (result.entries !== undefined && !Array.isArray(result.entries)) fail('ADAPTER_RESPONSE_INVALID');
            entries.push(...(result.entries ?? []));
            if (result.nextPageToken === undefined || result.nextPageToken === '') return { entries };
            if (!bounded(result.nextPageToken, 2048) || seen.has(result.nextPageToken)) fail('EVIDENCE_UNAVAILABLE');
            seen.add(result.nextPageToken);
            pageToken = result.nextPageToken;
        }
        fail('EVIDENCE_UNAVAILABLE');
    }

    private requireProject(filter: string): string {
        const source = this.requireSources();
        const candidate = Object.values(source).find(value => value.kind === 'cloud-logging' && filter.includes(`logName="${value.logName}"`));
        if (!candidate || candidate.kind !== 'cloud-logging') fail('EVIDENCE_UNAVAILABLE');
        return candidate.project;
    }

    private logFilter(source: CloudLoggingEvidenceSource): string {
        if (source.resourceType === 'cloud_tasks_queue') {
            const queueSelectors = source.queueResources!.map(resource => {
                const match = /^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/.exec(resource);
                if (!match || match[1] !== source.project) fail('EVIDENCE_UNAVAILABLE');
                return `(resource.labels.project_id="${match[1]}" AND resource.labels.location="${match[2]}" AND resource.labels.queue_id="${match[3]}")`;
            }).sort();
            return `logName="${source.logName}" AND resource.type="cloud_tasks_queue" AND jsonPayload."@type"="${TASK_ACTIVITY_LOG_TYPE}" AND (${queueSelectors.join(' OR ')})`;
        }
        return `logName="${source.logName}" AND resource.type="cloud_run_revision" AND httpRequest.requestUrl=(${[...source.receiverRoutes!].sort().map(route => `"${route}"`).join(' OR ')})`;
    }

    private async listLoggingCollection(path: string, key: 'sinks' | 'exclusions'): Promise<readonly unknown[]> {
        let pageToken: string | undefined;
        const seen = new Set<string>();
        const items: unknown[] = [];
        for (let page = 0; page < MAX_PAGES; page += 1) {
            const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) });
            if (pageToken !== undefined) params.set('pageToken', pageToken);
            const allowedQueryKeys = pageToken === undefined ? ['pageSize'] : ['pageSize', 'pageToken'];
            const { value } = await this.loggingTransport.json({
                method: 'GET', url: `https://logging.googleapis.com${path}?${params.toString()}`, allowedHosts: LOGGING_HOSTS,
                allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys, acceptedStatuses: [200],
            });
            const body = object(value);
            if (body[key] !== undefined && !Array.isArray(body[key])) fail('ADAPTER_RESPONSE_INVALID');
            items.push(...((body[key] as unknown[] | undefined) ?? []));
            if (body.nextPageToken === undefined || body.nextPageToken === '') return items;
            if (!bounded(body.nextPageToken, 2048) || seen.has(body.nextPageToken)) fail('EVIDENCE_UNAVAILABLE');
            seen.add(body.nextPageToken);
            pageToken = body.nextPageToken;
        }
        fail('EVIDENCE_UNAVAILABLE');
    }

    private async assertLoggingCoverage(source: CloudLoggingEvidenceSource, windowStartMs: number, windowEndMs: number, observedNowMs: number): Promise<void> {
        const sinkPath = `/v2/projects/${encodeURIComponent(source.project)}/sinks`;
        const sinks = await this.listLoggingCollection(sinkPath, 'sinks');
        const matches = sinks.filter(item => isObject(item) && item.name === source.sinkName);
        if (matches.length !== 1) fail('EVIDENCE_UNAVAILABLE');
        const sink = object(matches[0]);
        if (sink.destination !== `logging.googleapis.com/${source.bucketResource}` || sink.filter !== this.logFilter(source)) fail('EVIDENCE_UNAVAILABLE');
        const bucketPath = `/v2/${source.bucketResource}`;
        const { value: bucketValue } = await this.loggingTransport.json({
            method: 'GET', url: `https://logging.googleapis.com${bucketPath}`, allowedHosts: LOGGING_HOSTS,
            allowedPath: candidate => candidate === bucketPath, allowedMethods: ['GET'], allowedQueryKeys: [], acceptedStatuses: [200],
        });
        const bucket = object(bucketValue);
        const retentionDays = bucket.retentionDays;
        if (typeof retentionDays !== 'number' || !Number.isSafeInteger(retentionDays) || retentionDays <= 0
            || windowStartMs < observedNowMs - retentionDays * DAY_MS || windowEndMs > observedNowMs) fail('EVIDENCE_UNAVAILABLE');
        const exclusionsPath = `/v2/projects/${encodeURIComponent(source.project)}/exclusions`;
        const exclusions = await this.listLoggingCollection(exclusionsPath, 'exclusions');
        // A non-empty exclusion is ambiguous without proving filter implication
        // against the exact fixed selector, so fail closed.
        if (exclusions.length !== 0) fail('EVIDENCE_UNAVAILABLE');
        if (source.resourceType === 'cloud_tasks_queue') {
            for (const queueResource of source.queueResources!) {
                const queuePath = `/v2/${queueResource}`;
                const { value: queueValue } = await this.tasksTransport.json({
                    method: 'GET', url: `https://cloudtasks.googleapis.com${queuePath}`, allowedHosts: TASKS_HOSTS,
                    allowedPath: candidate => candidate === queuePath, allowedMethods: ['GET'], allowedQueryKeys: [], acceptedStatuses: [200],
                });
                const queue = object(queueValue);
                const loggingConfig = object(queue.stackdriverLoggingConfig);
                if (loggingConfig.samplingRatio !== 1) fail('EVIDENCE_UNAVAILABLE');
            }
        }
    }
}

function sourceKey(source: EvidenceSource): string {
    return source.source;
}
