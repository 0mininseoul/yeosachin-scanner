import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    type AnalysisCanonicalSupabaseClient,
} from './canonical-analysis-store';

export type AnalysisCanonicalReadFamily = 'jobs' | 'evidence' | 'cost' | 'cache' | 'audit';

export const ANALYSIS_CANONICAL_READ_FLAGS: Readonly<
    Record<AnalysisCanonicalReadFamily, 'ANALYSIS_CANONICAL_JOBS_READ'
        | 'ANALYSIS_CANONICAL_EVIDENCE_READ'
        | 'ANALYSIS_CANONICAL_COST_READ'
        | 'ANALYSIS_CANONICAL_CACHE_READ'
        | 'ANALYSIS_CANONICAL_AUDIT_READ'>
> = Object.freeze({
    jobs: 'ANALYSIS_CANONICAL_JOBS_READ',
    evidence: 'ANALYSIS_CANONICAL_EVIDENCE_READ',
    cost: 'ANALYSIS_CANONICAL_COST_READ',
    cache: 'ANALYSIS_CANONICAL_CACHE_READ',
    audit: 'ANALYSIS_CANONICAL_AUDIT_READ',
});

/** Hard bound for every collection returned by the service-only family RPC. */
export const CANONICAL_READ_MAX_ROWS = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AnalysisParityStatus = 'match' | 'mismatch' | 'blocked';

export interface AnalysisParitySummary {
    status: AnalysisParityStatus;
    mismatchPaths: string[];
}

export interface AnalysisParityAggregate {
    count: number;
    checksum: string | null;
    complete: boolean;
    ownership?: unknown;
    state?: unknown;
    counts?: unknown;
    orderHash?: unknown;
    contentHash?: unknown;
    cost?: unknown;
    retention?: unknown;
    unknownSource?: unknown;
    [key: string]: unknown;
}

const SANITIZED_PARITY_PATHS = new Set([
    'count',
    'checksum',
    'complete',
    'ownership',
    'state',
    'counts',
    'orderHash',
    'contentHash',
    'cost',
    'retention',
    'unknownSource',
    'request.status',
    'progress',
    'result',
    'provider.operation',
    'audit.retention',
    'source.missing',
    'canonical.missing',
    'canonical.error',
    'comparison.missing',
    'comparison.error',
]);

function stableCompareValue(value: unknown): string {
    const normalize = (candidate: unknown): unknown => {
        if (candidate === undefined) return '__undefined__';
        if (candidate === null) return null;
        if (Array.isArray(candidate)) return candidate.map(normalize);
        if (typeof candidate === 'object') {
            return Object.fromEntries(
                Object.entries(candidate as Record<string, unknown>)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, child]) => [key, normalize(child)]),
            );
        }
        return candidate;
    };
    return JSON.stringify(normalize(value));
}

export function nextAnalysisCanonicalAuditVersion(
    existingVersions: readonly number[],
    lateCost = false,
): number {
    const maxVersion = existingVersions.reduce((max, version) => (
        Number.isSafeInteger(version) && version > max ? version : max
    ), 0);
    // A late provider usage observation is a new immutable bundle version, never an update
    // to the prior cost/audit row. The same monotonic rule is safe for ordinary replays.
    const next = maxVersion + 1;
    if (next > 100_000) {
        throw new Error('ANALYSIS_CANONICAL_AUDIT_VERSION_EXHAUSTED');
    }
    if (lateCost) return next;
    return next;
}

export function analysisCanonicalReadEnabled(
    family: AnalysisCanonicalReadFamily,
    env: Record<string, string | undefined> = process.env,
): boolean {
    const value = env[ANALYSIS_CANONICAL_READ_FLAGS[family]];
    return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes'
        || value?.toLowerCase() === 'on';
}

export function buildAnalysisParity(input: {
    source: AnalysisParityAggregate | null;
    canonical: AnalysisParityAggregate | null;
}): AnalysisParitySummary {
    if (!input.source) return { status: 'blocked', mismatchPaths: ['source.missing'] };
    if (!input.canonical) return { status: 'blocked', mismatchPaths: ['canonical.missing'] };
    const mismatchPaths: string[] = [];
    const compare = (path: string, left: unknown, right: unknown): void => {
        if (stableCompareValue(left) !== stableCompareValue(right)) mismatchPaths.push(path);
    };
    compare('count', input.source.count, input.canonical.count);
    compare('checksum', input.source.checksum, input.canonical.checksum);
    compare('complete', input.source.complete, input.canonical.complete);
    for (const [field, path] of [
        ['ownership', 'ownership'],
        ['state', 'state'],
        ['counts', 'counts'],
        ['orderHash', 'orderHash'],
        ['contentHash', 'contentHash'],
        ['cost', 'cost'],
        ['retention', 'retention'],
        ['unknownSource', 'unknownSource'],
    ] as const) {
        const sourceValue = input.source[field];
        const canonicalValue = input.canonical[field];
        compare(path, sourceValue ?? null, canonicalValue ?? null);
    }
    return {
        status: mismatchPaths.length > 0 ? 'mismatch' : 'match',
        mismatchPaths,
    };
}

export interface AnalysisCanonicalNormalizedProjection {
    requestStatus?: string | null;
    ownership?: unknown;
    state?: unknown;
    counts?: unknown;
    orderHash?: string | null;
    contentHash?: string | null;
    progress?: Readonly<{
        state: string;
        completed: number;
        total: number;
    }> | null;
    result?: Readonly<{
        rank: number | null;
        score: number | null;
    }> | null;
    providerOperation?: string | null;
    cost?: Readonly<{
        amountKnown: number | null;
        amountConservative?: number | null;
        usageUnknown: boolean;
        sourceHash?: string | null;
    }> | null;
    retention?: string | null;
    auditRetention?: string | null;
    unknownSource?: unknown;
}

export function compareAnalysisCanonicalProjection(
    source: AnalysisCanonicalNormalizedProjection | null,
    canonical: AnalysisCanonicalNormalizedProjection | null,
): AnalysisParitySummary {
    if (!source) return { status: 'blocked', mismatchPaths: ['source.missing'] };
    if (!canonical) return { status: 'blocked', mismatchPaths: ['canonical.missing'] };
    const mismatchPaths: string[] = [];
    const compare = (path: string, left: unknown, right: unknown): void => {
        if (stableCompareValue(left) !== stableCompareValue(right)) mismatchPaths.push(path);
    };
    compare('ownership', source.ownership ?? null, canonical.ownership ?? null);
    compare('state', source.state ?? null, canonical.state ?? null);
    compare('counts', source.counts ?? null, canonical.counts ?? null);
    compare('orderHash', source.orderHash ?? null, canonical.orderHash ?? null);
    compare('contentHash', source.contentHash ?? null, canonical.contentHash ?? null);
    compare('request.status', source.requestStatus ?? null, canonical.requestStatus ?? null);
    compare('progress', source.progress ?? null, canonical.progress ?? null);
    compare('result', source.result ?? null, canonical.result ?? null);
    compare('provider.operation', source.providerOperation ?? null, canonical.providerOperation ?? null);
    compare('cost', source.cost ?? null, canonical.cost ?? null);
    compare('retention', source.retention ?? null, canonical.retention ?? null);
    compare('audit.retention', source.auditRetention ?? null, canonical.auditRetention ?? null);
    compare('unknownSource', source.unknownSource ?? null, canonical.unknownSource ?? null);
    return {
        status: mismatchPaths.length > 0 ? 'mismatch' : 'match',
        mismatchPaths,
    };
}

export interface AnalysisCanonicalReadBundle {
    jobs: readonly unknown[];
    events: readonly unknown[];
    artifacts: readonly unknown[];
    costs: readonly unknown[];
    caches: readonly unknown[];
    audits: readonly unknown[];
}

interface CanonicalReadRpcResult {
    data: unknown;
    error: { code?: string; message?: string } | null;
}

export interface AnalysisCanonicalReadStore {
    loadRequest(requestId: string, family: AnalysisCanonicalReadFamily): Promise<AnalysisCanonicalReadBundle | null>;
    shadowRead<T>(input: {
        family: AnalysisCanonicalReadFamily;
        legacy: () => Promise<T>;
        canonical: () => Promise<T>;
        compare: (legacy: T, canonical: T) => AnalysisParitySummary;
        onMismatch?: (summary: AnalysisParitySummary) => void;
    }): Promise<T>;
}

function asRows(value: unknown, key: keyof AnalysisCanonicalReadBundle): readonly unknown[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('ANALYSIS_CANONICAL_READ_ERROR: invalid canonical response.');
    }
    const rows = (value as Record<string, unknown>)[key];
    if (!Array.isArray(rows)) {
        throw new Error(`ANALYSIS_CANONICAL_READ_ERROR: invalid canonical ${key} collection.`);
    }
    if (rows.length > CANONICAL_READ_MAX_ROWS) {
        throw new Error(`ANALYSIS_CANONICAL_READ_ERROR: oversized canonical ${key} collection.`);
    }
    if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) {
        throw new Error(`ANALYSIS_CANONICAL_READ_ERROR: invalid canonical ${key} row.`);
    }
    return Object.freeze([...rows]);
}

function sanitizeParitySummary(value: unknown): AnalysisParitySummary {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid comparison result');
    }
    const candidate = value as Record<string, unknown>;
    if (
        (candidate.status !== 'match' && candidate.status !== 'mismatch' && candidate.status !== 'blocked')
        || !Array.isArray(candidate.mismatchPaths)
        || candidate.mismatchPaths.length > 32
        || candidate.mismatchPaths.some(path => (
            typeof path !== 'string' || !SANITIZED_PARITY_PATHS.has(path)
        ))
        || (candidate.status === 'match' && candidate.mismatchPaths.length > 0)
    ) {
        throw new Error('invalid comparison result');
    }
    return {
        status: candidate.status,
        mismatchPaths: [...candidate.mismatchPaths] as string[],
    };
}

function parseBundle(value: unknown): AnalysisCanonicalReadBundle {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('ANALYSIS_CANONICAL_READ_ERROR: invalid canonical response.');
    }
    const unknownKeys = Object.keys(value as Record<string, unknown>)
        .filter(key => !(['jobs', 'events', 'artifacts', 'costs', 'caches', 'audits'] as const).includes(
            key as 'jobs' | 'events' | 'artifacts' | 'costs' | 'caches' | 'audits'
        ));
    if (unknownKeys.length > 0) {
        throw new Error('ANALYSIS_CANONICAL_READ_ERROR: unknown canonical collection.');
    }
    return {
        jobs: asRows(value, 'jobs'),
        events: asRows(value, 'events'),
        artifacts: asRows(value, 'artifacts'),
        costs: asRows(value, 'costs'),
        caches: asRows(value, 'caches'),
        audits: asRows(value, 'audits'),
    };
}

export function createAnalysisCanonicalReadStore(
    client: AnalysisCanonicalSupabaseClient = supabaseAdmin,
    options: {
        env?: Record<string, string | undefined>;
        onMismatch?: (input: {
            family: AnalysisCanonicalReadFamily;
            summary: AnalysisParitySummary;
        }) => void;
    } = {},
): AnalysisCanonicalReadStore {
    const env = options.env ?? process.env;

    const reportMismatch = (
        family: AnalysisCanonicalReadFamily,
        summary: AnalysisParitySummary,
        callback?: (summary: AnalysisParitySummary) => void,
    ): void => {
        try {
            callback?.(summary);
        } catch {
            // Shadow telemetry cannot change the legacy response path.
        }
        try {
            options.onMismatch?.({ family, summary });
        } catch {
            // The injected diagnostic hook is also fail-open.
        }
    };

    return {
        async loadRequest(requestId, family) {
            if (!UUID_PATTERN.test(requestId)) {
                throw new Error('ANALYSIS_CANONICAL_READ_ERROR: invalid request id.');
            }
            if (!analysisCanonicalReadEnabled(family, env)) return null;
            const result = await client.rpc('load_analysis_canonical_family', {
                p_request_id: requestId,
                p_family: family,
            }) as CanonicalReadRpcResult;
            if (result.error) throw new Error(
                result.error.message || result.error.code || 'canonical read failed'
            );
            return parseBundle(result.data);
        },

        async shadowRead<T>(input: {
            family: AnalysisCanonicalReadFamily;
            legacy: () => Promise<T>;
            canonical: () => Promise<T>;
            compare: (legacy: T, canonical: T) => AnalysisParitySummary;
            onMismatch?: (summary: AnalysisParitySummary) => void;
        }) {
            const legacy = await input.legacy();
            if (!analysisCanonicalReadEnabled(input.family, env)) return legacy;
            let canonical: T;
            try {
                canonical = await input.canonical();
            } catch {
                reportMismatch(input.family, {
                    status: 'blocked',
                    mismatchPaths: ['canonical.error'],
                }, input.onMismatch);
                return legacy;
            }
            if (typeof input.compare !== 'function') {
                const summary = {
                    status: 'blocked',
                    mismatchPaths: ['comparison.missing'],
                } satisfies AnalysisParitySummary;
                reportMismatch(input.family, summary, input.onMismatch);
                return legacy;
            }
            let summary: AnalysisParitySummary;
            try {
                summary = sanitizeParitySummary(input.compare(legacy, canonical));
            } catch {
                summary = {
                    status: 'blocked',
                    mismatchPaths: ['comparison.error'],
                } satisfies AnalysisParitySummary;
            }
            if (summary.status !== 'match') {
                reportMismatch(input.family, summary, input.onMismatch);
                return legacy;
            }
            return canonical;
        },
    };
}

export const analysisCanonicalReadStore = createAnalysisCanonicalReadStore();
