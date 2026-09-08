import { describe, expect, it } from 'vitest';
import { canonicalDigest, EpochError } from './contracts';
import { AuthenticatedProtectedTransport, type ProtectedHttpRequest, type ProtectedHttpResponse, type ProtectedTransport } from './platform';
import { evidenceSelectorDigest, LiveEvidenceCollector, validateLiveZeroWorkSources, type CloudLoggingEvidenceSource, type LiveZeroWorkSources, type SupabaseLedgerSource } from './live-evidence';

const PROJECT = 'example-project';
const QUEUE = `projects/${PROJECT}/locations/asia-northeast3/queues/fixture`;
const NOW = 1_000_000;
const SUPABASE_API_KEY = 'fixture-supabase-api-key';
const SOURCE_BASE = {
    kind: 'cloud-logging', source: 'fixture-task-audit', project: PROJECT, logName: `projects/${PROJECT}/logs/fixture`,
    resourceType: 'cloud_tasks_queue', correlation: 'fixture-watermark', queueResources: [QUEUE, `projects/${PROJECT}/locations/asia-northeast3/queues/paid`],
    sinkName: 'fixture-sink', bucketResource: `projects/${PROJECT}/locations/global/buckets/fixture`,
} as const;
const SOURCE: CloudLoggingEvidenceSource = { ...SOURCE_BASE, lookbackMs: 60_000, selectorDigest: evidenceSelectorDigest({ ...SOURCE_BASE, lookbackMs: 60_000, selectorDigest: '0'.repeat(64) } as CloudLoggingEvidenceSource) };

function sources(source: CloudLoggingEvidenceSource = SOURCE): LiveZeroWorkSources {
    return { providerLedger: source, billingLedger: source, taskAudit: source, receiverLog: source };
}

const VALID_RECEIVER_SOURCE: CloudLoggingEvidenceSource = (() => {
    const base = {
        kind: 'cloud-logging' as const, source: 'fixture-receiver-log', project: PROJECT,
        logName: `projects/${PROJECT}/logs/receiver`, resourceType: 'cloud_run_revision' as const,
        correlation: 'fixture-receiver', receiverRoutes: ['https://preflight.example.com/api/analysis/preflight/worker', 'https://paid.example.com/api/analysis/v2/worker'],
        sinkName: 'fixture-receiver-sink', bucketResource: `projects/${PROJECT}/locations/global/buckets/fixture`, lookbackMs: 60_000,
    };
    return { ...base, selectorDigest: evidenceSelectorDigest({ ...base, selectorDigest: '0'.repeat(64) }) };
})();

const SEMANTIC_LEDGER_SOURCES = (() => {
    const origin = 'https://supabase.example.invalid/';
    const source = (base: Omit<SupabaseLedgerSource, 'lookbackMs' | 'selectorDigest'>): SupabaseLedgerSource => {
        const withWindow = { ...base, lookbackMs: 60_000 };
        return { ...withWindow, selectorDigest: evidenceSelectorDigest({ ...withWindow, selectorDigest: '0'.repeat(64) }) };
    };
    return {
        providerLedger: source({
            kind: 'supabase', source: 'supabase:public.analysis_provider_cost_ledger', origin,
            table: 'analysis_provider_cost_ledger', columns: ['run_id', 'request_id', 'operation_key', 'status', 'created_at'],
            eventTimeColumn: 'created_at',
        }),
        billingLedger: source({
            kind: 'supabase', source: 'supabase:public.analysis_revenue_cost_operations', origin,
            table: 'analysis_revenue_cost_operations', columns: ['request_id', 'owner_kind', 'owner_key_hash', 'operation_kind', 'status', 'created_at'],
            eventTimeColumn: 'created_at',
        }),
        taskAudit: SOURCE,
        receiverLog: source({
            kind: 'supabase', source: 'supabase:public.analysis_step_events', origin,
            table: 'analysis_step_events', columns: ['id', 'request_id', 'step', 'event_type', 'created_at'],
            eventTimeColumn: 'created_at',
        }),
    } satisfies LiveZeroWorkSources;
})();

type LoggingOptions = Readonly<{
    paginateCollections?: boolean;
    exclusionPageToken?: boolean;
    watermarkCoveredEndMs?: number;
    includePostWindowEntry?: boolean;
    retentionDays?: number;
    legacySinkDestination?: boolean;
}>;

class LoggingTransport implements ProtectedTransport {
    readonly requests: ProtectedHttpRequest[] = [];
    private readonly options: LoggingOptions;
    watermarkCoveredEndMs: number;
    events: readonly unknown[] = [];
    constructor(options: LoggingOptions = {}) { this.options = options; this.watermarkCoveredEndMs = options.watermarkCoveredEndMs ?? NOW; }

    async request(request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> {
        this.requests.push(request);
        const url = new URL(request.url);
        if (url.hostname === 'cloudtasks.googleapis.com') {
            return this.response(request, 200, { name: QUEUE, stackdriverLoggingConfig: { samplingRatio: 1 } });
        }
        if (url.hostname !== 'logging.googleapis.com') throw new Error('unexpected host');
        if (request.method === 'GET' && url.pathname.endsWith('/sinks')) {
            if (this.options.paginateCollections && url.searchParams.get('pageToken') === null) return this.response(request, 200, { sinks: [], nextPageToken: 'sink-page-2' });
            const destination = this.options.legacySinkDestination
                ? SOURCE.bucketResource
                : `logging.googleapis.com/${SOURCE.bucketResource}`;
            return this.response(request, 200, { sinks: [{ name: SOURCE.sinkName, destination, filter: this.filter() }] });
        }
        if (request.method === 'GET' && url.pathname.endsWith('/exclusions')) {
            if (this.options.exclusionPageToken && url.searchParams.get('pageToken') === null) return this.response(request, 200, { exclusions: [], nextPageToken: 'exclusion-page-2' });
            return this.response(request, 200, { exclusions: [] });
        }
        if (request.method === 'GET' && url.pathname.includes('/buckets/')) return this.response(request, 200, { retentionDays: this.options.retentionDays ?? 30 });
        if (request.method === 'POST' && url.pathname === '/v2/entries:list') {
            const body = JSON.parse(request.body ?? '{}') as { filter?: string };
            if (body.filter?.includes('receiveTimestamp >=')) {
                if (this.options.includePostWindowEntry === false) return this.response(request, 200, { entries: [] });
                const coveredEndMs = this.watermarkCoveredEndMs;
                const iso = new Date(coveredEndMs).toISOString();
                return this.response(request, 200, {
                    entries: [{ timestamp: iso, receiveTimestamp: iso, jsonPayload: { '@type': 'type.googleapis.com/google.cloud.tasks.logging.v1.TaskActivityLog', taskCreationLog: { status: 'OK' } } }],
                });
            }
            return this.response(request, 200, { entries: this.events });
        }
        throw new Error(`unexpected logging path ${url.pathname}`);
    }

    private filter(): string {
        const selectors = SOURCE.queueResources!.map(resource => {
            const match = /^projects\/([^/]+)\/locations\/([^/]+)\/queues\/([^/]+)$/.exec(resource)!;
            return `(resource.labels.project_id="${match[1]}" AND resource.labels.location="${match[2]}" AND resource.labels.queue_id="${match[3]}")`;
        });
        return `logName="${SOURCE.logName}" AND resource.type="cloud_tasks_queue" AND jsonPayload."@type"="type.googleapis.com/google.cloud.tasks.logging.v1.TaskActivityLog" AND (${selectors.sort().join(' OR ')})`;
    }

    private response(request: ProtectedHttpRequest, status: number, value: unknown): ProtectedHttpResponse {
        return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), url: request.url };
    }
}

function collector(logging: LoggingTransport, sourceSet: LiveZeroWorkSources = sources(), now = () => NOW): LiveEvidenceCollector {
    const transport = new AuthenticatedProtectedTransport({ transport: logging, tokenProvider: async () => 'fixture-token', timeoutMs: 1_000 });
    return new LiveEvidenceCollector({
        cloudBuild: {} as never, loggingTransport: transport, tasksTransport: transport,
        supabaseApiKey: SUPABASE_API_KEY,
        sources: sourceSet, receiverTokenProvider: async () => 'fixture-receiver-token', now,
    });
}

function expectEvidenceUnavailable(error: unknown): boolean {
    return error instanceof EpochError && error.code === 'EVIDENCE_UNAVAILABLE';
}

describe('live evidence primary-source contracts', () => {
    it('binds provider, billing, and receiver slots to durable forbidden-event ledgers instead of receiver request logs', () => {
        expect(validateLiveZeroWorkSources(SEMANTIC_LEDGER_SOURCES, PROJECT)).toBe(true);
        expect(SEMANTIC_LEDGER_SOURCES.providerLedger.kind).toBe('supabase');
        expect(SEMANTIC_LEDGER_SOURCES.billingLedger.kind).toBe('supabase');
        expect(SEMANTIC_LEDGER_SOURCES.receiverLog.kind).toBe('supabase');
    });

    it('rejects filter-injection atoms in log names, queue resources, and receiver routes', () => {
        expect(validateLiveZeroWorkSources(SEMANTIC_LEDGER_SOURCES, PROJECT)).toBe(true);
        const injectedLog = { ...SEMANTIC_LEDGER_SOURCES, taskAudit: { ...SOURCE, logName: `${SOURCE.logName}\" OR TRUE`, selectorDigest: '0'.repeat(64) } };
        expect(validateLiveZeroWorkSources(injectedLog, PROJECT)).toBe(false);
        const injectedQueue = { ...SOURCE, queueResources: [`${QUEUE}\" OR TRUE`, SOURCE.queueResources![1]!], selectorDigest: '0'.repeat(64) };
        expect(validateLiveZeroWorkSources({ ...SEMANTIC_LEDGER_SOURCES, taskAudit: injectedQueue }, PROJECT)).toBe(false);
        const routeSource = { ...VALID_RECEIVER_SOURCE, receiverRoutes: ['https://preflight.example.com/api/analysis/worker\" OR TRUE', 'https://paid.example.com/api/analysis/worker'], selectorDigest: '0'.repeat(64) };
        expect(validateLiveZeroWorkSources({ ...SEMANTIC_LEDGER_SOURCES, receiverLog: routeSource }, PROJECT)).toBe(false);
    });

    it('canonicalizes the complete task queue union independently of descriptor order', () => {
        const reversed = [...SOURCE.queueResources!].reverse();
        const reordered = { ...SOURCE, queueResources: reversed };
        const bound = { ...SEMANTIC_LEDGER_SOURCES, taskAudit: { ...reordered, selectorDigest: evidenceSelectorDigest(reordered) } };
        expect(validateLiveZeroWorkSources(bound, PROJECT)).toBe(true);
        expect(validateLiveZeroWorkSources({ ...bound, taskAudit: { ...bound.taskAudit, queueResources: reversed.slice(0, 1) } }, PROJECT)).toBe(false);
        const crossRole = `${QUEUE.replace('/queues/fixture', '/queues/another-role')}`;
        const substituted = [reversed[0]!, crossRole] as const;
        const substitutedSource = { ...SOURCE, queueResources: substituted };
        expect(validateLiveZeroWorkSources({ ...bound, taskAudit: { ...substitutedSource, selectorDigest: evidenceSelectorDigest(substitutedSource) } }, PROJECT)).toBe(true);
    });

    it('rebinds a fresh collector to the durable baseline digest without process memory', async () => {
        const first = new LoggingTransport({ watermarkCoveredEndMs: NOW + 1 });
        const baseline = await collector(first, sources(), () => NOW + 1).zeroWorkBaseline({ nowMs: NOW });
        const digest = canonicalDigest(baseline);
        const restarted = collector(new LoggingTransport({ watermarkCoveredEndMs: NOW + 1 }), sources(), () => NOW + 1);
        const proof = await restarted.zeroWorkObservation({ windowStartMs: NOW, windowEndMs: NOW + 1, nowMs: NOW + 1, baselineDigest: digest });
        expect(proof).toMatchObject({ windowStartMs: NOW, windowEndMs: NOW + 1 });
    });

    it('allows a newer independently observed watermark when the exact baseline event window is unchanged', async () => {
        const transport = new LoggingTransport({ watermarkCoveredEndMs: NOW + 1 });
        const baseline = await collector(transport, sources(), () => NOW + 1).zeroWorkBaseline({ nowMs: NOW });
        transport.watermarkCoveredEndMs = NOW + 2;
        const restarted = collector(transport, sources(), () => NOW + 2);
        await expect(restarted.zeroWorkObservation({ windowStartMs: NOW, windowEndMs: NOW + 2, nowMs: NOW + 2, baselineDigest: canonicalDigest(baseline) })).resolves.toBeDefined();
    });

    it('accepts a watermark received after the frozen window end when the trusted collector clock bounds its lag', async () => {
        const transport = new LoggingTransport({ watermarkCoveredEndMs: NOW + 2 });
        const baseline = await collector(transport, sources(), () => NOW + 3).zeroWorkBaseline({ nowMs: NOW });
        const proof = await collector(transport, sources(), () => NOW + 3).zeroWorkObservation({
            windowStartMs: NOW, windowEndMs: NOW + 1, nowMs: NOW + 1, baselineDigest: canonicalDigest(baseline),
        });
        expect((proof as { providerLedger: { observedAtMs: number } }).providerLedger.observedAtMs).toBe(NOW + 2);
    });

    it('rejects a late event inserted into the durable baseline window after capture', async () => {
        const transport = new LoggingTransport({ watermarkCoveredEndMs: NOW + 1 });
        const baseline = await collector(transport, sources(), () => NOW + 1).zeroWorkBaseline({ nowMs: NOW });
        transport.events = [{ timestamp: new Date(NOW - 30_000).toISOString() }];
        await expect(collector(transport, sources(), () => NOW + 1).zeroWorkObservation({ windowStartMs: NOW, windowEndMs: NOW + 1, nowMs: NOW + 1, baselineDigest: canonicalDigest(baseline) })).rejects.satisfy(expectEvidenceUnavailable);
    });

    it('paginates sink and exclusion collections through empty pages with continuation tokens', async () => {
        const transport = new LoggingTransport({ paginateCollections: true, exclusionPageToken: true });
        const value = await collector(transport).zeroWorkBaseline({ nowMs: NOW });
        expect(value).toBeDefined();
        const collectionRequests = transport.requests.filter(request => request.method === 'GET' && (new URL(request.url).pathname.endsWith('/sinks') || new URL(request.url).pathname.endsWith('/exclusions')));
        expect(collectionRequests.some(request => new URL(request.url).searchParams.get('pageToken') === 'sink-page-2')).toBe(true);
        expect(collectionRequests.some(request => new URL(request.url).searchParams.get('pageToken') === 'exclusion-page-2')).toBe(true);
    });

    it('requires the documented logging.googleapis.com bucket sink destination while retaining the bucket resource for GET', async () => {
        const transport = new LoggingTransport({ legacySinkDestination: true });
        await expect(collector(transport).zeroWorkBaseline({ nowMs: NOW })).rejects.satisfy(expectEvidenceUnavailable);
        const bucketRequest = transport.requests.find(request => request.method === 'GET' && new URL(request.url).pathname.includes('/buckets/'));
        expect(bucketRequest).toBeUndefined();
    });

    it('rejects a window whose start is outside observed bucket retention', async () => {
        const observedNow = 3 * 86_400_000;
        const start = observedNow - 2 * 86_400_000;
        const transport = new LoggingTransport({ retentionDays: 1, watermarkCoveredEndMs: observedNow });
        await expect(collector(transport, sources(), () => observedNow).zeroWorkBaseline({ nowMs: start })).rejects.satisfy(expectEvidenceUnavailable);
    });

    it('requires an independently observed ingestion watermark before complete coverage', async () => {
        const transport = new LoggingTransport({ includePostWindowEntry: false });
        await expect(collector(transport).zeroWorkBaseline({ nowMs: NOW })).rejects.satisfy(expectEvidenceUnavailable);
    });

    it('uses the documented TaskActivityLog selector and receiveTimestamp watermark source', async () => {
        const transport = new LoggingTransport();
        await collector(transport).zeroWorkBaseline({ nowMs: NOW });
        const loggingQueries = transport.requests
            .filter(request => request.method === 'POST' && new URL(request.url).pathname === '/v2/entries:list')
            .map(request => JSON.parse(request.body ?? '{}') as { filter?: string });
        expect(loggingQueries.some(query => query.filter?.includes('jsonPayload."@type"="type.googleapis.com/google.cloud.tasks.logging.v1.TaskActivityLog"'))).toBe(true);
        expect(loggingQueries.some(query => query.filter?.includes('receiveTimestamp >='))).toBe(true);
        expect(loggingQueries.every(query => !query.filter?.includes('capacityIdentityEpochWatermark'))).toBe(true);
    });

    it('rejects a real TaskActivityLog taskCreationLog inside the requested window', async () => {
        const transport = new LoggingTransport();
        const baseline = await collector(transport).zeroWorkBaseline({ nowMs: NOW });
        transport.watermarkCoveredEndMs = NOW + 2;
        const stamp = new Date(NOW + 1).toISOString();
        transport.events = [{
            timestamp: stamp,
            receiveTimestamp: stamp,
            jsonPayload: { '@type': 'type.googleapis.com/google.cloud.tasks.logging.v1.TaskActivityLog', taskCreationLog: { status: 'OK' } },
        }];
        await expect(collector(transport, sources(), () => NOW + 2).zeroWorkObservation({
            windowStartMs: NOW, windowEndMs: NOW + 1, nowMs: NOW + 1, baselineDigest: canonicalDigest(baseline),
        })).rejects.satisfy(expectEvidenceUnavailable);
    });

    it('follows exact-count Supabase pagination instead of trusting one server-capped page', async () => {
        const supabaseSourceBase = {
            kind: 'supabase', source: 'fixture-provider-ledger', origin: 'https://supabase.example.invalid/', table: 'ledger',
            columns: ['event_time', 'kind'], eventTimeColumn: 'event_time',
        } as const;
        const supabaseSource: SupabaseLedgerSource = { ...supabaseSourceBase, lookbackMs: 60_000, selectorDigest: evidenceSelectorDigest({ ...supabaseSourceBase, lookbackMs: 60_000, selectorDigest: '0'.repeat(64) } as SupabaseLedgerSource) };
        const supabase = new SupabaseTransport({ date: new Date(NOW + 1_000).toUTCString() });
        const google = new LoggingTransport();
        const supabaseAuthenticated = new AuthenticatedProtectedTransport({ transport: supabase, tokenProvider: async () => 'fixture-token', timeoutMs: 1_000, additionalAllowedHosts: new Set(['supabase.example.invalid']) });
        const loggingAuthenticated = new AuthenticatedProtectedTransport({ transport: google, tokenProvider: async () => 'fixture-token', timeoutMs: 1_000 });
        const instance = new LiveEvidenceCollector({
            cloudBuild: {} as never, loggingTransport: loggingAuthenticated, tasksTransport: loggingAuthenticated,
            supabaseTransport: supabaseAuthenticated, supabaseApiKey: SUPABASE_API_KEY, sources: SOURCE_WITH_PROVIDER_SUPABASE(supabaseSource), receiverTokenProvider: async () => 'fixture-token', now: () => NOW + 1_000,
        });
        const baseline = await instance.zeroWorkBaseline({ nowMs: NOW });
        expect(baseline).toBeDefined();
        const ledgerRequests = supabase.requests.filter(request => new URL(request.url).pathname.endsWith('/ledger'));
        expect(ledgerRequests).toHaveLength(2);
        expect(new URL(ledgerRequests[0]!.url).searchParams.get('event_time')).toBe(`gte.${new Date(NOW - 60_000).toISOString()}`);
        expect(ledgerRequests.every(request => request.headers.apikey === SUPABASE_API_KEY)).toBe(true);
    });

    it('accepts a zero-row exact-count ledger page when the authenticated PostgREST Date proves coverage after the window', async () => {
        const supabase = new SupabaseTransport({ rows: [], date: new Date(NOW + 1_000).toUTCString() });
        const google = new LoggingTransport();
        const instance = collectorWithSupabase(supabase, google, SEMANTIC_LEDGER_SOURCES);
        await expect(instance.zeroWorkBaseline({ nowMs: NOW })).resolves.toBeDefined();
        expect(supabase.requests.every(request => new URL(request.url).pathname.startsWith('/rest/v1/analysis_'))).toBe(true);
    });

    it('never queries a separate synthetic watermark table', async () => {
        const supabase = new SupabaseTransport({ rows: [], date: new Date(NOW + 1_000).toUTCString() });
        const google = new LoggingTransport();
        const instance = collectorWithSupabase(supabase, google, SEMANTIC_LEDGER_SOURCES);
        await instance.zeroWorkBaseline({ nowMs: NOW });
        expect(supabase.requests.every(request => new URL(request.url).pathname.startsWith('/rest/v1/analysis_'))).toBe(true);
    });

    it('rejects a Supabase ledger page without a trustworthy server Date', async () => {
        const supabase = new SupabaseTransport({ rows: [], date: undefined });
        const google = new LoggingTransport();
        const instance = collectorWithSupabase(supabase, google, SEMANTIC_LEDGER_SOURCES);
        await expect(instance.zeroWorkBaseline({ nowMs: NOW })).rejects.satisfy(expectEvidenceUnavailable);
    });

    it('rejects a Supabase ledger page whose server Date predates the requested window end', async () => {
        const supabase = new SupabaseTransport({ rows: [], date: new Date(NOW - 1_000).toUTCString() });
        const google = new LoggingTransport();
        const instance = collectorWithSupabase(supabase, google, SEMANTIC_LEDGER_SOURCES);
        await expect(instance.zeroWorkBaseline({ nowMs: NOW })).rejects.satisfy(expectEvidenceUnavailable);
    });

    it('rejects a Supabase transport without the required private apikey header', async () => {
        const supabase = new SupabaseTransport({ rows: [], date: new Date(NOW + 1_000).toUTCString() });
        const google = new LoggingTransport();
        const supabaseAuthenticated = new AuthenticatedProtectedTransport({ transport: supabase, tokenProvider: async () => 'fixture-token', timeoutMs: 1_000, additionalAllowedHosts: new Set(['supabase.example.invalid']) });
        const loggingAuthenticated = new AuthenticatedProtectedTransport({ transport: google, tokenProvider: async () => 'fixture-token', timeoutMs: 1_000 });
        const instance = new LiveEvidenceCollector({
            cloudBuild: {} as never, loggingTransport: loggingAuthenticated, tasksTransport: loggingAuthenticated,
            supabaseTransport: supabaseAuthenticated, sources: SEMANTIC_LEDGER_SOURCES, receiverTokenProvider: async () => 'fixture-token', now: () => NOW + 1_000,
        });
        await expect(instance.zeroWorkBaseline({ nowMs: NOW })).rejects.satisfy(expectEvidenceUnavailable);
    });
});

function SOURCE_WITH_PROVIDER_SUPABASE(provider: SupabaseLedgerSource): LiveZeroWorkSources {
    return { providerLedger: provider, billingLedger: SOURCE, taskAudit: SOURCE, receiverLog: SOURCE };
}

class SupabaseTransport implements ProtectedTransport {
    readonly requests: ProtectedHttpRequest[] = [];
    private readonly options: Readonly<{ rows?: readonly unknown[]; date?: string }>;
    constructor(options: Readonly<{ rows?: readonly unknown[]; date?: string }> = {}) { this.options = options; }
    async request(request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> {
        this.requests.push(request);
        const url = new URL(request.url);
        const table = url.pathname.split('/').at(-1);
        const dateHeaders: Record<string, string> = this.options.date === undefined ? {} : { date: this.options.date };
        if (this.options.rows !== undefined) {
            return { status: 200, headers: { 'content-range': `*/${this.options.rows.length}`, ...dateHeaders }, body: JSON.stringify(this.options.rows), url: request.url };
        }
        if (table === 'ledger') {
            const offset = Number(url.searchParams.get('offset'));
            const rows = offset === 0
                ? Array.from({ length: 1000 }, (_, index) => ({ event_time: new Date(NOW).toISOString(), kind: `event-${index}` }))
                : [{ event_time: new Date(NOW).toISOString(), kind: 'event-1000' }];
            const start = offset === 0 ? 0 : 1000;
            return { status: 200, headers: { 'content-range': `${start}-${start + rows.length - 1}/1001`, ...dateHeaders }, body: JSON.stringify(rows), url: request.url };
        }
        throw new Error('unexpected supabase table');
    }
}

function collectorWithSupabase(supabase: SupabaseTransport, google: LoggingTransport, sourceSet: LiveZeroWorkSources): LiveEvidenceCollector {
    const supabaseAuthenticated = new AuthenticatedProtectedTransport({ transport: supabase, tokenProvider: async () => 'fixture-token', timeoutMs: 1_000, additionalAllowedHosts: new Set(['supabase.example.invalid']) });
    const loggingAuthenticated = new AuthenticatedProtectedTransport({ transport: google, tokenProvider: async () => 'fixture-token', timeoutMs: 1_000 });
    return new LiveEvidenceCollector({
        cloudBuild: {} as never, loggingTransport: loggingAuthenticated, tasksTransport: loggingAuthenticated,
        supabaseTransport: supabaseAuthenticated, supabaseApiKey: SUPABASE_API_KEY, sources: sourceSet, receiverTokenProvider: async () => 'fixture-token', now: () => NOW + 1_000,
    });
}
