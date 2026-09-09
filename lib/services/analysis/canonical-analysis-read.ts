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

export type AnalysisParityStatus = 'match' | 'mismatch' | 'blocked';

export interface AnalysisParitySummary {
    status: AnalysisParityStatus;
    mismatchPaths: string[];
}

export interface AnalysisParityAggregate {
    count: number;
    checksum: string | null;
    complete: boolean;
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
    if (input.source.count !== input.canonical.count) mismatchPaths.push('count');
    if (input.source.checksum !== input.canonical.checksum) mismatchPaths.push('checksum');
    if (input.source.complete !== input.canonical.complete) mismatchPaths.push('complete');
    return {
        status: mismatchPaths.length > 0 ? 'mismatch' : 'match',
        mismatchPaths,
    };
}

export interface AnalysisCanonicalNormalizedProjection {
    requestStatus?: string | null;
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
        usageUnknown: boolean;
    }> | null;
    auditRetention?: string | null;
}

export function compareAnalysisCanonicalProjection(
    source: AnalysisCanonicalNormalizedProjection | null,
    canonical: AnalysisCanonicalNormalizedProjection | null,
): AnalysisParitySummary {
    if (!source) return { status: 'blocked', mismatchPaths: ['source.missing'] };
    if (!canonical) return { status: 'blocked', mismatchPaths: ['canonical.missing'] };
    const mismatchPaths: string[] = [];
    const compare = (path: string, left: unknown, right: unknown) => {
        if (JSON.stringify(left) !== JSON.stringify(right)) mismatchPaths.push(path);
    };
    compare('request.status', source.requestStatus ?? null, canonical.requestStatus ?? null);
    compare('progress', source.progress ?? null, canonical.progress ?? null);
    compare('result', source.result ?? null, canonical.result ?? null);
    compare('provider.operation', source.providerOperation ?? null, canonical.providerOperation ?? null);
    compare('cost', source.cost ?? null, canonical.cost ?? null);
    compare('audit.retention', source.auditRetention ?? null, canonical.auditRetention ?? null);
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
        compare?: (legacy: T, canonical: T) => AnalysisParitySummary;
        onMismatch?: (summary: AnalysisParitySummary) => void;
    }): Promise<T>;
}

function asRows(value: unknown, key: keyof AnalysisCanonicalReadBundle): readonly unknown[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const rows = (value as Record<string, unknown>)[key];
    return Array.isArray(rows) ? rows : [];
}

function parseBundle(value: unknown): AnalysisCanonicalReadBundle {
    return {
        jobs: asRows(value, 'jobs'),
        events: asRows(value, 'events'),
        artifacts: asRows(value, 'artifacts'),
        costs: asRows(value, 'costs'),
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

    return {
        async loadRequest(requestId, family) {
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
            compare?: (legacy: T, canonical: T) => AnalysisParitySummary;
            onMismatch?: (summary: AnalysisParitySummary) => void;
        }) {
            const legacy = await input.legacy();
            if (!analysisCanonicalReadEnabled(input.family, env)) return legacy;
            let canonical: T;
            try {
                canonical = await input.canonical();
            } catch {
                return legacy;
            }
            const summary = input.compare
                ? input.compare(legacy, canonical)
                : ({ status: 'match', mismatchPaths: [] } satisfies AnalysisParitySummary);
            if (summary.status !== 'match') {
                try {
                    input.onMismatch?.(summary);
                } catch {
                    // Shadow telemetry cannot change the legacy response path.
                }
                try {
                    options.onMismatch?.({ family: input.family, summary });
                } catch {
                    // The injected diagnostic hook is also fail-open.
                }
                return legacy;
            }
            return canonical;
        },
    };
}

export const analysisCanonicalReadStore = createAnalysisCanonicalReadStore();
