import { assertPiiSafeConsolidationOutput } from '../analysis/order-audit-consolidation';

export { assertPiiSafeConsolidationOutput } from '../analysis/order-audit-consolidation';

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** The only public base/partitioned tables that the approved contract permits. */
export const SUPABASE_22_CANONICAL_TABLES = [
    'account_lifecycle', 'analysis_artifacts', 'analysis_audit_bundles',
    'analysis_cache', 'analysis_costs', 'analysis_events', 'analysis_jobs',
    'analysis_preflights', 'analysis_provider_runs', 'analysis_requests',
    'analysis_results', 'earlybird_orders', 'earlybird_waitlist',
    'fulfillment_jobs', 'landing_leads', 'maintenance_jobs',
    'notification_outbox', 'payment_events', 'result_feedback',
    'system_configuration', 'system_leases', 'users',
] as const;

const canonicalTableSet = new Set<string>(SUPABASE_22_CANONICAL_TABLES);

export type Supabase22GateStatus = 'ready' | 'mismatch' | 'blocked';
export type Supabase22ArchiveRestoreStatus = 'verified' | 'mismatch' | 'blocked' | 'not_run';

export type Supabase22ArchiveEvidence = Readonly<{
    verified: boolean;
    aggregateChecksum: string | null;
    restoreStatus: Supabase22ArchiveRestoreStatus;
}>;

export type Supabase22GateInput = Readonly<{
    publicTableCount: number;
    canonicalTables: readonly string[];
    unexpectedTables: readonly string[];
    missingTables: readonly string[];
    dependencyClean: boolean;
    migrationHistoryClean: boolean;
    genuineCompletedBundleCount: number;
    parityStatus: Supabase22GateStatus;
    archiveManifest: Supabase22ArchiveEvidence;
    rollbackEvidenceVerified: boolean;
    observationWindowClosed: boolean;
    ownerApprovalRecorded: boolean;
    /** Optional aliases used when importing the extended readiness contract. */
    canonicalSetMatch?: boolean;
    catalogDependencyClean?: boolean;
    archiveRestoreChecksumMatch?: boolean;
    /** True only when all pending payment evidence has an independent disposition. */
    paymentPendingDispositionRecorded?: boolean;
    /** True only when the run was proven not to activate admission or a real canary. */
    noActivationOrCanary?: boolean;
}>;

export type Supabase22Evidence = Supabase22GateInput & Readonly<{
    schemaVersion: 'supabase-22-evidence-v1';
    status: Supabase22GateStatus;
    destructiveOperations: 'refused';
    missingGates: readonly string[];
}>;

function sortedUnique(values: readonly string[]): string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function exactCanonicalSet(input: Supabase22GateInput): boolean {
    const observed = sortedUnique(input.canonicalTables);
    return observed.length === SUPABASE_22_CANONICAL_TABLES.length
        && observed.join('\u0000')
        === SUPABASE_22_CANONICAL_TABLES.join('\u0000')
        && input.unexpectedTables.length === 0
        && input.missingTables.length === 0;
}

function addGate(gates: string[], gate: string): void {
    if (!gates.includes(gate)) gates.push(gate);
}

/**
 * Evaluate every contraction prerequisite without granting a destructive capability.
 * Missing evidence is intentionally represented as a missing gate rather than inferred
 * from a count or from an empty fixture.
 */
export function evaluateSupabase22Gate(input: Supabase22GateInput): Supabase22Evidence {
    const missingGates: string[] = [];
    const canonicalSetMatch = exactCanonicalSet(input);

    if (input.publicTableCount !== SUPABASE_22_CANONICAL_TABLES.length) {
        addGate(missingGates, 'public-table-count');
    }
    if (input.missingTables.length > 0) addGate(missingGates, 'missing-table');
    if (input.unexpectedTables.length > 0) addGate(missingGates, 'unexpected-table');
    if (!canonicalSetMatch) addGate(missingGates, 'canonical-table-set');
    if (!input.dependencyClean) addGate(missingGates, 'dependency-inventory');
    if ('canonicalSetMatch' in input && input.canonicalSetMatch !== true) {
        addGate(missingGates, 'canonical-table-set');
    }
    if ('catalogDependencyClean' in input && input.catalogDependencyClean !== true) {
        addGate(missingGates, 'dependency-inventory');
    }
    if (!input.migrationHistoryClean) addGate(missingGates, 'migration-history');
    if (input.genuineCompletedBundleCount <= 0) addGate(missingGates, 'genuine-completed-bundle');
    if (input.parityStatus !== 'ready') addGate(missingGates, 'per-order-parity');
    if (!input.archiveManifest.verified
        || typeof input.archiveManifest.aggregateChecksum !== 'string'
        || !HASH_PATTERN.test(input.archiveManifest.aggregateChecksum)) {
        addGate(missingGates, 'archive-manifest');
    }
    if (input.archiveManifest.restoreStatus !== 'verified') {
        addGate(missingGates, 'restore-drill');
    }
    if ('archiveRestoreChecksumMatch' in input && input.archiveRestoreChecksumMatch !== true) {
        addGate(missingGates, 'restore-drill');
    }
    if (!input.rollbackEvidenceVerified) addGate(missingGates, 'rollback-evidence');
    if (!input.observationWindowClosed) addGate(missingGates, 'observation-window');
    if (!input.ownerApprovalRecorded) addGate(missingGates, 'separate-approval');
    if ('paymentPendingDispositionRecorded' in input
        && input.paymentPendingDispositionRecorded !== true) {
        addGate(missingGates, 'payment-pending-disposition');
    }
    if ('noActivationOrCanary' in input && input.noActivationOrCanary !== true) {
        addGate(missingGates, 'no-activation-or-canary');
    }

    const mismatchOnly = missingGates.length > 0
        && missingGates.every(gate => gate === 'public-table-count' || gate === 'per-order-parity');
    const status: Supabase22GateStatus = missingGates.length === 0
        ? 'ready'
        : mismatchOnly ? 'mismatch' : 'blocked';
    const evidence: Supabase22Evidence = {
        ...input,
        canonicalTables: sortedUnique(input.canonicalTables),
        unexpectedTables: sortedUnique(input.unexpectedTables),
        missingTables: sortedUnique(input.missingTables),
        schemaVersion: 'supabase-22-evidence-v1',
        status,
        destructiveOperations: 'refused',
        missingGates,
    };
    assertPiiSafeConsolidationOutput(evidence);
    return evidence;
}

export type Supabase22ApprovalRecordInput = Readonly<{
    allowlistHash: string | null;
    approvedAt: string | null;
    approvedByRole: string | null;
    exactObjectNames: readonly string[];
    signatureVerified: boolean;
}>;

export type Supabase22ApprovalEvidence = Readonly<{
    recorded: boolean;
    allowlistHash: string | null;
    approvedAt: string | null;
    approvedByRole: string | null;
    exactObjectCount: number;
}>;

/** Parse approval metadata without returning a signature, token, or operator identity. */
export function parseSupabase22ApprovalRecord(
    input: Supabase22ApprovalRecordInput,
): Supabase22ApprovalEvidence {
    const objectNames = input.exactObjectNames.filter(name =>
        typeof name === 'string' && SAFE_NAME_PATTERN.test(name));
    const valid = typeof input.allowlistHash === 'string'
        && HASH_PATTERN.test(input.allowlistHash)
        && typeof input.approvedAt === 'string'
        && ISO_DATE_PATTERN.test(input.approvedAt)
        && (input.approvedByRole === 'owner' || input.approvedByRole === 'operator')
        && objectNames.length > 0
        && objectNames.length === input.exactObjectNames.length
        && input.signatureVerified === true;
    const result: Supabase22ApprovalEvidence = {
        recorded: valid,
        allowlistHash: valid ? input.allowlistHash : null,
        approvedAt: valid ? input.approvedAt : null,
        approvedByRole: valid ? input.approvedByRole : null,
        exactObjectCount: valid ? objectNames.length : 0,
    };
    assertPiiSafeConsolidationOutput(result);
    return result;
}

export type Supabase22CatalogTable = Readonly<{
    name: string;
    relkind: 'r' | 'p';
    relpersistence?: string;
    rlsEnabled: boolean;
    forceRls?: boolean;
}>;

export type Supabase22CatalogRoutine = Readonly<{
    name: string;
    identityArguments?: string;
    securityDefiner: boolean;
    searchPathEmpty: boolean;
    executePublic: boolean;
    executeAnon: boolean;
    executeAuthenticated: boolean;
    executeServiceRole: boolean;
}>;

export type Supabase22CatalogDependency = Readonly<{
    resolved: boolean;
    allowed: boolean;
}>;

export type Supabase22CatalogSnapshot = Readonly<{
    tables: readonly Supabase22CatalogTable[];
    dependencies: readonly Supabase22CatalogDependency[];
    securityDefinerFunctions: readonly Supabase22CatalogRoutine[];
    migrationHistory: readonly Readonly<{ version: string; pending?: boolean }>[];
    legacyWriters: readonly Readonly<{ active: boolean }>[];
    views: readonly Readonly<{ resolved: boolean; allowed: boolean }>[];
    sequences: readonly Readonly<{ resolved: boolean; allowed: boolean }>[];
    partitions: readonly Readonly<{ resolved: boolean; allowed: boolean }>[];
    publications: readonly Readonly<{ resolved: boolean; allowed: boolean }>[];
    triggers: readonly Readonly<{ resolved: boolean; allowed: boolean }>[];
    policies: readonly Readonly<{ tableName: string; enabled: boolean }>[];
}>;

export type Supabase22CatalogEvidence = Readonly<{
    schemaVersion: 'supabase-22-catalog-v1';
    status: 'ready' | 'blocked';
    publicTableCount: number;
    canonicalTables: readonly string[];
    unexpectedTables: readonly string[];
    missingTables: readonly string[];
    dependencyClean: boolean;
    migrationHistoryClean: boolean;
    rlsClean: boolean;
    routinesClean: boolean;
    aclClean: boolean;
    triggersClean: boolean;
    foreignKeysClean: boolean;
    viewsClean: boolean;
    publicationsClean: boolean;
    sequencesClean: boolean;
    partitionsClean: boolean;
    legacyWritersClean: boolean;
    clean: boolean;
    destructiveOperations: 'refused';
}>;

export function isSafeSecurityDefinerRoutine(routine: Supabase22CatalogRoutine): boolean {
    if (!routine.securityDefiner) return true;
    return routine.searchPathEmpty
        && !routine.executePublic
        && !routine.executeAnon
        && !routine.executeAuthenticated
        && routine.executeServiceRole;
}

function catalogObjectsClean(
    values: readonly Readonly<{ resolved: boolean; allowed: boolean }>[],
): boolean {
    return values.every(value => value.resolved && value.allowed);
}

/** Evaluate normalized PostgreSQL catalog rows. This function never repairs the catalog. */
export function evaluateSupabase22Catalog(
    snapshot: Supabase22CatalogSnapshot,
): Supabase22CatalogEvidence {
    const tables = Array.isArray(snapshot.tables) ? snapshot.tables : [];
    const dependencies = Array.isArray(snapshot.dependencies) ? snapshot.dependencies : null;
    const routines = Array.isArray(snapshot.securityDefinerFunctions)
        ? snapshot.securityDefinerFunctions : null;
    const migrationHistory = Array.isArray(snapshot.migrationHistory)
        ? snapshot.migrationHistory : null;
    const legacyWriters = Array.isArray(snapshot.legacyWriters) ? snapshot.legacyWriters : null;
    const views = Array.isArray(snapshot.views) ? snapshot.views : null;
    const sequences = Array.isArray(snapshot.sequences) ? snapshot.sequences : null;
    const partitions = Array.isArray(snapshot.partitions) ? snapshot.partitions : null;
    const publications = Array.isArray(snapshot.publications) ? snapshot.publications : null;
    const triggers = Array.isArray(snapshot.triggers) ? snapshot.triggers : null;
    const policies = Array.isArray(snapshot.policies) ? snapshot.policies : null;
    const metadataComplete = dependencies !== null
        && routines !== null
        && migrationHistory !== null
        && legacyWriters !== null
        && views !== null
        && sequences !== null
        && partitions !== null
        && publications !== null
        && triggers !== null
        && policies !== null;
    const publicTables = tables
        .filter(table => table.relkind === 'r' || table.relkind === 'p')
        .map(table => table.name)
        .sort((left, right) => left.localeCompare(right));
    const canonicalTables = publicTables.filter(name => canonicalTableSet.has(name));
    const unexpectedTables = publicTables.filter(name => !canonicalTableSet.has(name));
    const missingTables = SUPABASE_22_CANONICAL_TABLES.filter(name => !publicTables.includes(name));
    const rlsClean = publicTables.length > 0
        && tables
            .filter(table => table.relkind === 'r' || table.relkind === 'p')
            .every(table => table.rlsEnabled === true);
    const routinesClean = routines !== null
        && routines.every(isSafeSecurityDefinerRoutine);
    const dependencyClean = dependencies !== null
        && dependencies.every(value => value.resolved && value.allowed);
    const migrationHistoryClean = migrationHistory !== null
        && migrationHistory.length > 0
        && migrationHistory.every(migration =>
            typeof migration.version === 'string'
            && migration.version.length > 0
            && migration.pending !== true);
    const legacyWritersClean = legacyWriters !== null
        && legacyWriters.every(writer => writer.active !== true);
    const viewsClean = views !== null && catalogObjectsClean(views);
    const sequencesClean = sequences !== null && catalogObjectsClean(sequences);
    const partitionsClean = partitions !== null && catalogObjectsClean(partitions);
    const publicationsClean = publications !== null && catalogObjectsClean(publications);
    const triggersClean = triggers !== null && catalogObjectsClean(triggers);
    const policiesClean = policies !== null && policies.every(policy => policy.enabled === true);
    const clean = publicTables.length === SUPABASE_22_CANONICAL_TABLES.length
        && canonicalTables.join('\u0000') === SUPABASE_22_CANONICAL_TABLES.join('\u0000')
        && unexpectedTables.length === 0
        && missingTables.length === 0
        && metadataComplete
        && dependencyClean
        && migrationHistoryClean
        && rlsClean
        && routinesClean
        && viewsClean
        && sequencesClean
        && partitionsClean
        && publicationsClean
        && triggersClean
        && policiesClean
        && legacyWritersClean;
    const evidence: Supabase22CatalogEvidence = {
        schemaVersion: 'supabase-22-catalog-v1',
        status: clean ? 'ready' : 'blocked',
        publicTableCount: publicTables.length,
        canonicalTables,
        unexpectedTables,
        missingTables,
        dependencyClean,
        migrationHistoryClean,
        rlsClean,
        routinesClean,
        aclClean: routinesClean,
        triggersClean,
        foreignKeysClean: dependencyClean,
        viewsClean,
        publicationsClean,
        sequencesClean,
        partitionsClean,
        legacyWritersClean,
        clean,
        destructiveOperations: 'refused',
    };
    assertPiiSafeConsolidationOutput(evidence);
    return evidence;
}

/** One read-only catalog query; the database function behind this query must be read-only. */
export const SUPABASE_22_CATALOG_QUERY = `
SELECT c.relname,
       c.relkind,
       c.relpersistence,
       c.relrowsecurity,
       c.relforcerowsecurity
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
ORDER BY c.relname
`;

/**
 * Read-only catalog query fragments used by the service-role catalog RPC. Keeping
 * each surface explicit prevents a table-count check from being mistaken for a
 * dependency proof.
 */
export const SUPABASE_22_CATALOG_QUERIES = {
    tables: SUPABASE_22_CATALOG_QUERY,
    constraints: `
SELECT con.conname, con.contype, con.convalidated
FROM pg_catalog.pg_constraint AS con
JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
`,
    policies: `
SELECT policy.schemaname, policy.tablename, policy.policyname,
       policy.cmd, policy.roles, policy.qual, policy.with_check
FROM pg_catalog.pg_policies AS policy
WHERE policy.schemaname = 'public'
`,
    roles: `
SELECT n.nspname, c.relname, c.relacl
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
`,
    triggers: `
SELECT n.nspname, c.relname, trigger_row.tgname,
       trigger_row.tgenabled, trigger_row.tgisinternal
FROM pg_catalog.pg_trigger AS trigger_row
JOIN pg_catalog.pg_class AS c ON c.oid = trigger_row.tgrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
`,
    routines: `
SELECT n.nspname, p.proname,
       pg_catalog.pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       p.proconfig, p.proacl
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
`,
    dependencies: `
SELECT dependent_ns.nspname AS dependent_schema,
       dependent.relname AS dependent_name,
       referenced_ns.nspname AS referenced_schema,
       referenced.relname AS referenced_name,
       dependency.deptype
FROM pg_catalog.pg_depend AS dependency
JOIN pg_catalog.pg_class AS dependent ON dependent.oid = dependency.objid
JOIN pg_catalog.pg_namespace AS dependent_ns ON dependent_ns.oid = dependent.relnamespace
LEFT JOIN pg_catalog.pg_class AS referenced ON referenced.oid = dependency.refobjid
LEFT JOIN pg_catalog.pg_namespace AS referenced_ns ON referenced_ns.oid = referenced.relnamespace
WHERE dependent_ns.nspname = 'public'
`,
    publications: `
SELECT publication.pubname, publication_rel.prrelid::regclass::text AS relation_name
FROM pg_catalog.pg_publication AS publication
JOIN pg_catalog.pg_publication_rel AS publication_rel
  ON publication_rel.prpubid = publication.oid
`,
    sequences: `
SELECT sequence_row.sequence_schema, sequence_row.sequence_name
FROM information_schema.sequences AS sequence_row
WHERE sequence_row.sequence_schema = 'public'
`,
    partitions: `
SELECT child_ns.nspname AS child_schema, child.relname AS child_name,
       parent_ns.nspname AS parent_schema, parent.relname AS parent_name
FROM pg_catalog.pg_inherits AS inheritance
JOIN pg_catalog.pg_class AS child ON child.oid = inheritance.inhrelid
JOIN pg_catalog.pg_namespace AS child_ns ON child_ns.oid = child.relnamespace
JOIN pg_catalog.pg_class AS parent ON parent.oid = inheritance.inhparent
JOIN pg_catalog.pg_namespace AS parent_ns ON parent_ns.oid = parent.relnamespace
WHERE child_ns.nspname = 'public' OR parent_ns.nspname = 'public'
`,
    views: `
SELECT view_row.schemaname, view_row.viewname, view_row.viewowner,
       view_row.definition
FROM pg_catalog.pg_views AS view_row
WHERE view_row.schemaname = 'public'
`,
    extensions: `
SELECT extension.extname, extension.extversion
FROM pg_catalog.pg_extension AS extension
ORDER BY extension.extname
`,
} as const;

export interface Supabase22CatalogRpcClient {
    query(sql: string): PromiseLike<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCatalogSnapshot(value: unknown): Supabase22CatalogSnapshot {
    if (!isRecord(value)) throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    const arrayKeys = [
        'tables', 'dependencies', 'securityDefinerFunctions', 'migrationHistory',
        'legacyWriters', 'views', 'sequences', 'partitions', 'publications',
        'triggers', 'policies',
    ] as const;
    if (!arrayKeys.every(key => Array.isArray(value[key]))) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    const snapshot = value as unknown as Supabase22CatalogSnapshot;
    if (snapshot.tables.some(table =>
        !isRecord(table)
        || typeof table.name !== 'string'
        || (table.relkind !== 'r' && table.relkind !== 'p')
        || typeof table.rlsEnabled !== 'boolean')) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    if (snapshot.securityDefinerFunctions.some(routine =>
        !isRecord(routine)
        || typeof routine.name !== 'string'
        || typeof routine.securityDefiner !== 'boolean'
        || typeof routine.searchPathEmpty !== 'boolean'
        || typeof routine.executePublic !== 'boolean'
        || typeof routine.executeAnon !== 'boolean'
        || typeof routine.executeAuthenticated !== 'boolean'
        || typeof routine.executeServiceRole !== 'boolean')) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    return snapshot;
}

export async function collectSupabase22CatalogEvidence(
    client: Supabase22CatalogRpcClient,
): Promise<Supabase22CatalogEvidence> {
    if (!/^\s*SELECT\b/i.test(SUPABASE_22_CATALOG_QUERY)
        || /\b(?:DROP|TRUNCATE|ALTER|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/i.test(SUPABASE_22_CATALOG_QUERY)) {
        throw new Error('SUPABASE_22_CATALOG_QUERY_NOT_READ_ONLY');
    }
    let raw: unknown;
    try {
        raw = await client.query(SUPABASE_22_CATALOG_QUERY);
    } catch {
        throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    }
    if (isRecord(raw) && 'error' in raw && raw.error) {
        throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    }
    if (isRecord(raw) && 'data' in raw && raw.data !== undefined) raw = raw.data;
    return evaluateSupabase22Catalog(parseCatalogSnapshot(raw));
}

export type Supabase22FamilyReaderInput = Readonly<{
    canonicalEnabled: boolean;
    shadowMismatch: boolean;
    legacyAvailable: boolean;
}>;

export type Supabase22FamilyReader = Readonly<{
    reader: 'canonical' | 'legacy' | 'blocked';
    status: 'canonical' | 'legacy' | 'rollback_required' | 'rollback_unavailable';
}>;

export function resolveFamilyReader(input: Supabase22FamilyReaderInput): Supabase22FamilyReader {
    if (!input.legacyAvailable) return { reader: 'blocked', status: 'rollback_unavailable' };
    if (input.shadowMismatch) return { reader: 'legacy', status: 'rollback_required' };
    if (input.canonicalEnabled) return { reader: 'canonical', status: 'canonical' };
    return { reader: 'legacy', status: 'legacy' };
}

export type Supabase22FamilyTrafficEvidence = Readonly<{
    family: string;
    serverOnly: boolean;
    legacyReaderAvailable: boolean;
    canonicalReaderEnabled: boolean;
    canonicalWriterEnabled: boolean;
    shadowMismatch: boolean;
    retryQueueCount: number;
    retryQueueBounded: boolean;
    activeLegacyWriterCount: number;
}>;

export type Supabase22RollbackEvidenceInput = Readonly<{
    families: readonly Supabase22FamilyTrafficEvidence[];
    activeLegacyWriterCount: number;
    observationWindowClosed: boolean;
}>;

export type Supabase22RollbackEvidence = Readonly<{
    verified: boolean;
    rollbackEvidenceVerified: boolean;
    observationWindowClosed: boolean;
    familyReaders: readonly Supabase22FamilyReader[];
    missingGates: readonly string[];
    destructiveOperations: 'refused';
}>;

export function evaluateSupabase22RollbackEvidence(
    input: Supabase22RollbackEvidenceInput,
): Supabase22RollbackEvidence {
    const familyReaders = input.families.map(family => resolveFamilyReader({
        canonicalEnabled: family.canonicalReaderEnabled,
        shadowMismatch: family.shadowMismatch,
        legacyAvailable: family.legacyReaderAvailable,
    }));
    const missingGates: string[] = [];
    if (input.families.length === 0 || input.families.some(family => !family.serverOnly)) {
        addGate(missingGates, 'server-only-flags');
    }
    if (input.families.length === 0
        || input.families.some(family => !family.legacyReaderAvailable)) {
        addGate(missingGates, 'legacy-reader');
    }
    if (input.families.length === 0 || input.families.some(family =>
        !family.canonicalReaderEnabled
        || !family.canonicalWriterEnabled)) {
        addGate(missingGates, 'canonical-flags');
    }
    if (input.families.length === 0 || input.families.some(family =>
        family.retryQueueCount < 0 || !family.retryQueueBounded)) {
        addGate(missingGates, 'bounded-retry-queue');
    }
    if (input.activeLegacyWriterCount !== 0
        || input.families.some(family => family.activeLegacyWriterCount !== 0)) {
        addGate(missingGates, 'zero-legacy-writers');
    }
    if (input.families.some(family => family.shadowMismatch)) {
        addGate(missingGates, 'shadow-read-parity');
    }
    if (!input.observationWindowClosed) addGate(missingGates, 'observation-window');
    const evidence: Supabase22RollbackEvidence = {
        verified: missingGates.length === 0,
        rollbackEvidenceVerified: missingGates.length === 0,
        observationWindowClosed: input.observationWindowClosed,
        familyReaders,
        missingGates,
        destructiveOperations: 'refused',
    };
    assertPiiSafeConsolidationOutput(evidence);
    return evidence;
}

export interface Supabase22TrafficRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

function parseTrafficEvidence(value: unknown): Supabase22RollbackEvidenceInput {
    if (!isRecord(value) || !Array.isArray(value.families)
        || typeof value.activeLegacyWriterCount !== 'number'
        || typeof value.observationWindowClosed !== 'boolean') {
        throw new Error('SUPABASE_22_TRAFFIC_PAYLOAD_INVALID');
    }
    const families = value.families as unknown[];
    if (families.some(family => {
        if (!isRecord(family)) return true;
        return typeof family.family !== 'string'
            || typeof family.serverOnly !== 'boolean'
            || typeof family.legacyReaderAvailable !== 'boolean'
            || typeof family.canonicalReaderEnabled !== 'boolean'
            || typeof family.canonicalWriterEnabled !== 'boolean'
            || typeof family.shadowMismatch !== 'boolean'
            || typeof family.retryQueueCount !== 'number'
            || typeof family.retryQueueBounded !== 'boolean'
            || typeof family.activeLegacyWriterCount !== 'number';
    })) {
        throw new Error('SUPABASE_22_TRAFFIC_PAYLOAD_INVALID');
    }
    return value as unknown as Supabase22RollbackEvidenceInput;
}

/** Read aggregate traffic counters only; route payloads and actor identifiers never leave the RPC. */
export async function collectSupabase22RollbackEvidence(
    client: Supabase22TrafficRpcClient,
): Promise<Supabase22RollbackEvidence> {
    let response: { data: unknown; error: { message?: string } | null };
    try {
        response = await client.rpc('read_supabase_22_traffic_observation', {});
    } catch {
        throw new Error('SUPABASE_22_TRAFFIC_READ_FAILED');
    }
    if (response.error || response.data === null || response.data === undefined) {
        throw new Error('SUPABASE_22_TRAFFIC_READ_FAILED');
    }
    return evaluateSupabase22RollbackEvidence(parseTrafficEvidence(response.data));
}

export type Supabase22PaymentPendingEvidence = Readonly<{
    pendingOrderCount: number;
    independentlyEvidencedCount: number;
    dispositionRecordedCount: number;
}>;

/** Payment-pending disposition is evidence-only; this function never changes an order state. */
export function isPaymentPendingDispositionRecorded(
    evidence: Supabase22PaymentPendingEvidence,
): boolean {
    return Number.isSafeInteger(evidence.pendingOrderCount)
        && evidence.pendingOrderCount >= 0
        && Number.isSafeInteger(evidence.independentlyEvidencedCount)
        && evidence.independentlyEvidencedCount >= 0
        && Number.isSafeInteger(evidence.dispositionRecordedCount)
        && evidence.dispositionRecordedCount >= 0
        && evidence.independentlyEvidencedCount === evidence.pendingOrderCount
        && evidence.dispositionRecordedCount === evidence.pendingOrderCount;
}
