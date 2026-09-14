import {
    canonicalDigest,
    epochFail,
    isDigest,
    isObject,
    isRole,
    PROJECT_ID_PATTERN,
    ROLES,
    type CapacityEpochPacket,
    type ProtectedProviderScope,
    type Role,
} from './contracts';
import { type ProtectedPacketInput } from './packet';
import { EpochError } from './contracts';
import {
    evidenceSelectorDigest,
    validateLiveZeroWorkSources,
    type LiveZeroWorkSources,
} from './live-evidence';
import {
    selectDesiredIdentityGraph,
    type IdentityGraphObservation,
    type IdentitySelection,
} from './owner-preparation';
import type { AuthenticatedProtectedTransport } from './platform';

const DEFAULT_MAX_PAGES = 100;
const PAGE_TOKEN = /^[^\u0000-\u001f\u007f]{1,2048}$/;
const SOURCE_SHA = /^[0-9a-f]{40}$/;
const VERCEL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERCEL_HOSTS = new Set(['api.vercel.com']);

function fail(code: 'PAGINATION_INCOMPLETE' | 'DISCOVERY_AMBIGUOUS' | 'PROJECT_MISMATCH' | 'EVIDENCE_UNAVAILABLE' | 'SOURCE_INVALID' | 'ADAPTER_RESPONSE_INVALID' | 'ADAPTER_REQUEST_INVALID' | 'CAPABILITY_BINDING_MISMATCH'): never {
    epochFail(code);
}

export type DiscoveryPage<T> = Readonly<{
    items: readonly T[];
    nextPageToken?: string;
}>;

export type PagedReader<T> = (pageToken?: string) => Promise<DiscoveryPage<T>>;

/** Read every page, rejecting truncation, loops, and malformed tokens. */
export async function collectFullyPaged<T>(options: Readonly<{
    readPage: PagedReader<T>;
    maxPages?: number;
}>): Promise<readonly T[]> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isSafeInteger(maxPages) || maxPages <= 0 || maxPages > DEFAULT_MAX_PAGES) fail('ADAPTER_REQUEST_INVALID');
    const result: T[] = [];
    const seenTokens = new Set<string>();
    let token: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
        let current: DiscoveryPage<T>;
        try { current = await options.readPage(token); } catch { fail('PAGINATION_INCOMPLETE'); }
        if (!isObject(current) || !Array.isArray(current.items)) fail('PAGINATION_INCOMPLETE');
        result.push(...current.items);
        const next = current.nextPageToken;
        if (next === undefined || next === '') return result;
        if (typeof next !== 'string' || !PAGE_TOKEN.test(next) || seenTokens.has(next)) fail('PAGINATION_INCOMPLETE');
        seenTokens.add(next);
        token = next;
    }
    fail('PAGINATION_INCOMPLETE');
}

/** Assert that every inventory row belongs to the exact intended project. */
export function assertSameProject<T>(items: readonly T[], expectedProject: string, projectOf: (item: T) => unknown): void {
    if (!PROJECT_ID_PATTERN.test(expectedProject)) fail('PROJECT_MISMATCH');
    for (const item of items) {
        if (projectOf(item) !== expectedProject) fail('PROJECT_MISMATCH');
    }
}

/** Pick exactly one resource from a fully paged inventory. */
export function selectExactResource<T>(items: readonly T[], predicate: (item: T) => boolean): T {
    const matches = items.filter(predicate);
    if (matches.length !== 1) fail('DISCOVERY_AMBIGUOUS');
    return matches[0]!;
}

/** Verify the fixed source/build SHA relation before any desired mutation. */
export function assertSourceBuildMatch(input: Readonly<{
    sourceSha: string;
    buildSourceSha: string;
    runtimeSourceSha: string;
}>): void {
    if (!SOURCE_SHA.test(input.sourceSha) || input.buildSourceSha !== input.sourceSha || input.runtimeSourceSha !== input.sourceSha) fail('SOURCE_INVALID');
}

export const assertExactSourceBuild = assertSourceBuildMatch;

/**
 * Validate the four exact zero-work selectors and recompute each selector
 * digest. A syntactically valid but caller-recomputed digest is not enough.
 */
export function validateLedgerCoverage(value: unknown, expectedProject: string): LiveZeroWorkSources {
    if (value === null || value === undefined || !validateLiveZeroWorkSources(value, expectedProject)) fail('EVIDENCE_UNAVAILABLE');
    const sources = value as LiveZeroWorkSources;
    for (const source of Object.values(sources)) {
        if (evidenceSelectorDigest(source) !== source.selectorDigest) fail('EVIDENCE_UNAVAILABLE');
    }
    return sources;
}

export type OwnerDiscoveryPass = Readonly<{
    /** Complete packet seed assembled from one fresh read-only pass. */
    packetInput: ProtectedPacketInput;
    /** Full old identity inventory, kept only in memory. */
    identityGraph: IdentityGraphObservation;
    /** Existing deterministic policy result for this pass. */
    identitySelection?: IdentitySelection;
    /** Null is allowed only for a prepare/epoch inspect that cannot prove evidence. */
    zeroWorkSources: LiveZeroWorkSources | null;
    /** Exact SHA relationships obtained from source/build/runtime records. */
    sourceBuild: readonly Readonly<{ sourceSha: string; buildSourceSha: string; runtimeSourceSha: string }>[];
}>;

export type OwnerDiscoveryResult = Readonly<{
    pass: OwnerDiscoveryPass;
    discoveryDigest: string;
    identityGraphDigest: string;
    sourceBuildComplete: true;
    ledgerCoverageComplete: boolean;
}>;

function validateProviderScope(scope: ProtectedProviderScope, packetInput: ProtectedPacketInput): void {
    if (!isObject(scope)
        || scope.googleProjectId !== packetInput.providerScope.googleProjectId
        || scope.googleProjectId !== packetInput.oldManifest.build.project
        || scope.googleProjectId !== packetInput.desiredManifest.build.project) fail('CAPABILITY_BINDING_MISMATCH');
}

/** Validate all non-provider facts that a fresh discovery pass must contain. */
export function validateOwnerDiscoveryPass(value: unknown): asserts value is OwnerDiscoveryPass {
    if (!isObject(value)
        || !isObject(value.packetInput)
        || !isObject(value.identityGraph)
        || !Array.isArray(value.sourceBuild)
        || (value.zeroWorkSources !== null && !isObject(value.zeroWorkSources))) fail('EVIDENCE_UNAVAILABLE');
    const packetInput = value.packetInput as ProtectedPacketInput;
    // createProtectedPacket performs the complete contract validation.  It is
    // intentionally called here so discovery cannot hand an unchecked seed to
    // the descriptor builder.
    try {
        const packet = {
            ...packetInput,
            observationInputs: packetInput.observationInputs,
        } as CapacityEpochPacket;
        // The seed lacks derived digest fields, so only validate after the
        // descriptor builder creates the packet. Structural checks below are
        // still performed now; no provider result is trusted as a marker.
        if (!Array.isArray(packet.roleSet) || packet.roleSet.length !== ROLES.length || !packet.roleSet.every(isRole)) fail('EVIDENCE_UNAVAILABLE');
    } catch (error) {
        if (error instanceof Error && error.message === 'EVIDENCE_UNAVAILABLE') throw error;
        fail('EVIDENCE_UNAVAILABLE');
    }
    validateProviderScope(packetInput.providerScope, packetInput);
    const expectedProject = packetInput.providerScope.googleProjectId;
    if (value.zeroWorkSources !== null) validateLedgerCoverage(value.zeroWorkSources, expectedProject);
    for (const relation of value.sourceBuild as readonly Readonly<{ sourceSha: string; buildSourceSha: string; runtimeSourceSha: string }>[]) {
        assertSourceBuildMatch(relation);
    }
    const graph = value.identityGraph as IdentityGraphObservation;
    const selection = value.identitySelection as IdentitySelection | undefined;
    const derived = selectDesiredIdentityGraph(graph);
    if (selection !== undefined && selection.preparationDigest !== derived.preparationDigest) fail('DISCOVERY_AMBIGUOUS');
}

function digestProjection(result: OwnerDiscoveryPass): Readonly<Record<string, unknown>> {
    const packetInput = result.packetInput;
    return {
        packetInput,
        identityGraph: result.identityGraph,
        sourceBuild: result.sourceBuild,
        zeroWorkSources: result.zeroWorkSources,
    };
}

/** Build a safe digest projection from a validated read-only pass. */
export function summarizeOwnerDiscovery(result: OwnerDiscoveryResult): Readonly<{
    discoveryDigest: string;
    identityGraphDigest: string;
    sourceBuildComplete: true;
    ledgerCoverageComplete: boolean;
}> {
    return Object.freeze({
        discoveryDigest: result.discoveryDigest,
        identityGraphDigest: result.identityGraphDigest,
        sourceBuildComplete: true,
        ledgerCoverageComplete: result.ledgerCoverageComplete,
    });
}

export type OwnerDiscoveryReader = () => Promise<OwnerDiscoveryPass>;

/**
 * A discovery coordinator that performs one fresh, provider-backed pass per
 * call. The reader owns the exact adapter selectors; this class supplies the
 * shared completeness, project, source, ledger, and digest gates.
 */
export class OwnerDiscovery {
    private readonly readPass: OwnerDiscoveryReader;

    constructor(options: Readonly<{ readPass: OwnerDiscoveryReader }>) {
        this.readPass = options.readPass;
    }

    async discover(): Promise<OwnerDiscoveryResult> {
        let pass: OwnerDiscoveryPass;
        try { pass = await this.readPass(); } catch (error) {
            if (error instanceof EpochError) throw error;
            fail('EVIDENCE_UNAVAILABLE');
        }
        validateOwnerDiscoveryPass(pass);
        const identitySelection = pass.identitySelection ?? selectDesiredIdentityGraph(pass.identityGraph);
        const identityGraphDigest = identitySelection.identityGraphDigest;
        const discoveryDigest = canonicalDigest(digestProjection({ ...pass, identitySelection }));
        return Object.freeze({
            pass: Object.freeze({ ...pass, identitySelection }),
            discoveryDigest,
            identityGraphDigest,
            sourceBuildComplete: true,
            ledgerCoverageComplete: pass.zeroWorkSources !== null,
        });
    }
}

export type ExactVercelProductionEnv = Readonly<{
    keys: readonly string[];
    sensitiveKeys: readonly string[];
    count: number;
}>;

export type ExactVercelProductionEnvValues = ExactVercelProductionEnv & Readonly<{
    /**
     * Values are returned only to the in-process owner adapter.  Callers must
     * not serialize this object or include it in safe summaries.
     */
    values: Readonly<Record<string, string>>;
}>;

/**
 * Read the linked production environment without decrypting or returning
 * values. This helper is intentionally separate from packet assembly so a
 * production env response cannot become an accidental log payload.
 */
export async function readExactVercelProductionEnv(input: Readonly<{
    transport: AuthenticatedProtectedTransport;
    projectId: string;
    teamId: string;
}>): Promise<ExactVercelProductionEnv> {
    if (!VERCEL_ID.test(input.projectId) || !VERCEL_ID.test(input.teamId)) fail('ADAPTER_REQUEST_INVALID');
    const path = `/v9/projects/${encodeURIComponent(input.projectId)}/env`;
    const items = await collectFullyPaged({
        readPage: async (pageToken) => {
            const query = new URLSearchParams({ teamId: input.teamId, target: 'production', decrypt: 'false', limit: '100' });
            if (pageToken !== undefined) query.set('until', pageToken);
            const { value } = await input.transport.json({
                method: 'GET',
                url: `https://api.vercel.com${path}?${query.toString()}`,
                allowedHosts: VERCEL_HOSTS,
                allowedPath: candidate => candidate === path,
                allowedMethods: ['GET'],
                allowedQueryKeys: pageToken === undefined ? ['decrypt', 'limit', 'target', 'teamId'] : ['decrypt', 'limit', 'target', 'teamId', 'until'],
                acceptedStatuses: [200],
            });
            if (!isObject(value) || !Array.isArray(value.envs)) fail('ADAPTER_RESPONSE_INVALID');
            const pagination = value.pagination;
            if (pagination !== undefined && pagination !== null && !isObject(pagination)) fail('ADAPTER_RESPONSE_INVALID');
            const nextValue = isObject(pagination) ? pagination.next : undefined;
            if (nextValue !== undefined && nextValue !== null && typeof nextValue !== 'string') fail('PAGINATION_INCOMPLETE');
            const nextPageToken = typeof nextValue === 'string' ? nextValue : undefined;
            return { items: value.envs, ...(nextPageToken === undefined ? {} : { nextPageToken }) };
        },
    });
    const keys: string[] = [];
    const sensitiveKeys: string[] = [];
    for (const item of items) {
        if (!isObject(item) || typeof item.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.key)) fail('ADAPTER_RESPONSE_INVALID');
        keys.push(item.key);
        if (item.type === 'sensitive' || item.value === undefined) sensitiveKeys.push(item.key);
    }
    const unique = new Set(keys);
    if (unique.size !== keys.length) fail('DISCOVERY_AMBIGUOUS');
    return Object.freeze({ keys: Object.freeze([...keys].sort()), sensitiveKeys: Object.freeze([...sensitiveKeys].sort()), count: keys.length });
}

/**
 * Read the same exact production environment inventory when a concrete
 * owner adapter needs a value in memory.  The key allowlist is enforced by
 * the caller after this response is parsed; this helper never writes the
 * response to a file, process environment, or diagnostic output.
 */
export async function readExactVercelProductionEnvValues(input: Readonly<{
    transport: AuthenticatedProtectedTransport;
    projectId: string;
    teamId: string;
    allowedKeys: ReadonlySet<string>;
}>): Promise<ExactVercelProductionEnvValues> {
    if (!(input.allowedKeys instanceof Set) || input.allowedKeys.size === 0) fail('ADAPTER_REQUEST_INVALID');
    if (!VERCEL_ID.test(input.projectId) || !VERCEL_ID.test(input.teamId)) fail('ADAPTER_REQUEST_INVALID');
    const path = `/v9/projects/${encodeURIComponent(input.projectId)}/env`;
    const items = await collectFullyPaged({
        readPage: async (pageToken) => {
            const query = new URLSearchParams({ teamId: input.teamId, target: 'production', decrypt: 'true', limit: '100' });
            if (pageToken !== undefined) query.set('until', pageToken);
            const { value } = await input.transport.json({
                method: 'GET',
                url: `https://api.vercel.com${path}?${query.toString()}`,
                allowedHosts: VERCEL_HOSTS,
                allowedPath: candidate => candidate === path,
                allowedMethods: ['GET'],
                allowedQueryKeys: pageToken === undefined ? ['decrypt', 'limit', 'target', 'teamId'] : ['decrypt', 'limit', 'target', 'teamId', 'until'],
                acceptedStatuses: [200],
            });
            if (!isObject(value) || !Array.isArray(value.envs)) fail('ADAPTER_RESPONSE_INVALID');
            const pagination = value.pagination;
            if (pagination !== undefined && pagination !== null && !isObject(pagination)) fail('ADAPTER_RESPONSE_INVALID');
            const nextValue = isObject(pagination) ? pagination.next : undefined;
            if (nextValue !== undefined && nextValue !== null && typeof nextValue !== 'string') fail('PAGINATION_INCOMPLETE');
            const nextPageToken = typeof nextValue === 'string' ? nextValue : undefined;
            return { items: value.envs, ...(nextPageToken === undefined ? {} : { nextPageToken }) };
        },
    });
    const values: Record<string, string> = {};
    const seenKeys = new Set<string>();
    const keys: string[] = [];
    const sensitiveKeys: string[] = [];
    for (const item of items) {
        if (!isObject(item) || typeof item.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.key)) fail('ADAPTER_RESPONSE_INVALID');
        if (seenKeys.has(item.key)) fail('DISCOVERY_AMBIGUOUS');
        seenKeys.add(item.key);
        keys.push(item.key);
        if (item.type === 'sensitive') sensitiveKeys.push(item.key);
        // Production projects contain application variables outside this
        // preparation contract. Ignore those entries without ever retaining
        // their decrypted values; only the fixed allowlist crosses this
        // helper's boundary.
        if (!input.allowedKeys.has(item.key)) continue;
        if (typeof item.value !== 'string' || item.value.length === 0 || item.value.length > 8192
            || /[\u0000-\u001f\u007f]/.test(item.value)) fail('ADAPTER_RESPONSE_INVALID');
        values[item.key] = item.value;
    }
    return Object.freeze({
        keys: Object.freeze([...keys].sort()),
        sensitiveKeys: Object.freeze([...sensitiveKeys].sort()),
        count: keys.length,
        values: Object.freeze(values),
    });
}
