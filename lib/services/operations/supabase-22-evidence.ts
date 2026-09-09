import { assertPiiSafeConsolidationOutput } from '../analysis/order-audit-consolidation';

export { assertPiiSafeConsolidationOutput } from '../analysis/order-audit-consolidation';

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const RETENTION_CLASS_PATTERN = /^(?:short|standard|permanent)$/;
const ARCHIVE_MANIFEST_SCHEMA = 'supabase-22-archive-manifest-v1' as const;
const RESTORE_MANIFEST_SCHEMA = 'supabase-22-restore-manifest-v1' as const;
const ARCHIVE_ENCRYPTION_ALGORITHM = 'AES-256-GCM' as const;

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

export type Supabase22EncryptionEvidence = Readonly<{
    algorithm: string;
    verified: boolean;
}>;

export type Supabase22ArchiveManifest = Readonly<{
    schemaVersion: typeof ARCHIVE_MANIFEST_SCHEMA;
    selectedCount: number;
    aggregateChecksum: string;
    encrypted: boolean;
    encryption: Supabase22EncryptionEvidence;
    retentionClass: string;
}>;

export type Supabase22RestoreManifest = Readonly<{
    schemaVersion: typeof RESTORE_MANIFEST_SCHEMA;
    selectedCount: number;
    aggregateChecksum: string;
    encrypted: boolean;
    encryption: Supabase22EncryptionEvidence;
    retentionClass: string;
}>;

export type Supabase22ArchiveEvidence = Readonly<{
    verified: boolean;
    aggregateChecksum: string | null;
    restoreStatus: Supabase22ArchiveRestoreStatus;
    /** A parsed archive manifest is required for readiness; absence is blocked. */
    manifest?: Supabase22ArchiveManifest | null;
    /** A parsed isolated restore manifest is required for a verified restore. */
    restoreManifest?: Supabase22RestoreManifest | null;
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
    /** Production attestations are mandatory; missing values fail closed at runtime. */
    canonicalSetMatch: boolean;
    catalogDependencyClean: boolean;
    archiveRestoreChecksumMatch: boolean;
    /** True only when all pending payment evidence has an independent disposition. */
    paymentPendingDispositionRecorded: boolean;
    /** True only when the run was proven not to activate admission or a real canary. */
    noActivationOrCanary: boolean;
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

function isSafeRetentionClass(value: unknown): value is string {
    return typeof value === 'string' && RETENTION_CLASS_PATTERN.test(value);
}

function isSafeEncryptionEvidence(value: unknown): value is Supabase22EncryptionEvidence {
    return isRecord(value)
        && value.algorithm === ARCHIVE_ENCRYPTION_ALGORITHM
        && typeof value.verified === 'boolean'
        && value.verified === true;
}

export function isGenuineArchiveManifest(value: unknown): value is Supabase22ArchiveManifest {
    return isRecord(value)
        && value.schemaVersion === ARCHIVE_MANIFEST_SCHEMA
        && Number.isSafeInteger(value.selectedCount)
        && (value.selectedCount as number) > 0
        && typeof value.aggregateChecksum === 'string'
        && HASH_PATTERN.test(value.aggregateChecksum)
        && value.encrypted === true
        && isSafeEncryptionEvidence(value.encryption)
        && isSafeRetentionClass(value.retentionClass);
}

export function isGenuineRestoreManifest(value: unknown): value is Supabase22RestoreManifest {
    return isRecord(value)
        && value.schemaVersion === RESTORE_MANIFEST_SCHEMA
        && Number.isSafeInteger(value.selectedCount)
        && (value.selectedCount as number) >= 0
        && typeof value.aggregateChecksum === 'string'
        && HASH_PATTERN.test(value.aggregateChecksum)
        && value.encrypted === true
        && isSafeEncryptionEvidence(value.encryption)
        && isSafeRetentionClass(value.retentionClass);
}

function archiveManifestEvidenceClean(
    archive: Supabase22ArchiveEvidence,
    expectedCount: number,
): boolean {
    return archive.verified === true
        && typeof archive.aggregateChecksum === 'string'
        && HASH_PATTERN.test(archive.aggregateChecksum)
        && isGenuineArchiveManifest(archive.manifest)
        && archive.manifest.selectedCount === expectedCount
        && archive.manifest.aggregateChecksum === archive.aggregateChecksum;
}

function restoreManifestEvidenceClean(
    archive: Supabase22ArchiveEvidence,
    expectedCount: number,
): boolean {
    return archive.restoreStatus === 'verified'
        && isGenuineRestoreManifest(archive.restoreManifest)
        && archive.restoreManifest.selectedCount === expectedCount
        && archive.restoreManifest.aggregateChecksum === archive.aggregateChecksum
        && isGenuineArchiveManifest(archive.manifest)
        && archive.restoreManifest.retentionClass === archive.manifest.retentionClass;
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
    if (input.canonicalSetMatch !== true) {
        addGate(missingGates, 'canonical-table-set');
    }
    if (input.catalogDependencyClean !== true) {
        addGate(missingGates, 'dependency-inventory');
    }
    if (!input.migrationHistoryClean) addGate(missingGates, 'migration-history');
    if (input.genuineCompletedBundleCount <= 0) addGate(missingGates, 'genuine-completed-bundle');
    if (input.parityStatus !== 'ready') addGate(missingGates, 'per-order-parity');
    if (!archiveManifestEvidenceClean(input.archiveManifest, input.genuineCompletedBundleCount)) {
        addGate(missingGates, 'archive-manifest');
    }
    if (!restoreManifestEvidenceClean(input.archiveManifest, input.genuineCompletedBundleCount)) {
        addGate(missingGates, 'restore-drill');
    }
    if (input.archiveRestoreChecksumMatch !== true) {
        addGate(missingGates, 'restore-drill');
    }
    if (!input.rollbackEvidenceVerified) addGate(missingGates, 'rollback-evidence');
    if (!input.observationWindowClosed) addGate(missingGates, 'observation-window');
    if (!input.ownerApprovalRecorded) addGate(missingGates, 'separate-approval');
    if (input.paymentPendingDispositionRecorded !== true) {
        addGate(missingGates, 'payment-pending-disposition');
    }
    if (input.noActivationOrCanary !== true) {
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

export type Supabase22CatalogAcl = Readonly<{
    objectName: string;
    resolved: boolean;
    /** Explicitly parsed from pg_class/pg_proc ACLs, never inferred from routine flags. */
    serviceRoleOnly: boolean;
}>;

export type Supabase22CatalogDependency = Readonly<{
    /** Stable catalog object identity used to prove row-level coverage. */
    objectName: string;
    resolved: boolean;
    allowed: boolean;
}>;

export type Supabase22CatalogMetadataAvailability = Readonly<{
    catalog: boolean;
    acl: boolean;
    routine: boolean;
    trigger: boolean;
    dependency: boolean;
    migration: boolean;
    rls: boolean;
    view: boolean;
    publication: boolean;
    sequence: boolean;
    partition: boolean;
    foreignKey: boolean;
    legacyWriter: boolean;
}>;

export type Supabase22CatalogSnapshot = Readonly<{
    tables: readonly Supabase22CatalogTable[];
    acls: readonly Supabase22CatalogAcl[];
    dependencies: readonly Supabase22CatalogDependency[];
    foreignKeys: readonly Supabase22CatalogDependency[];
    securityDefinerFunctions: readonly Supabase22CatalogRoutine[];
    migrationHistory: readonly Readonly<{ version: string; pending?: boolean }>[];
    legacyWriters: readonly Readonly<{ active: boolean }>[];
    views: readonly Supabase22CatalogDependency[];
    sequences: readonly Supabase22CatalogDependency[];
    partitions: readonly Supabase22CatalogDependency[];
    publications: readonly Supabase22CatalogDependency[];
    triggers: readonly Supabase22CatalogDependency[];
    policies: readonly Readonly<{ tableName: string; enabled: boolean }>[];
    /** Every catalog query must explicitly attest that its result is available. */
    metadataAvailability: Supabase22CatalogMetadataAvailability;
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
    metadataAvailability: Supabase22CatalogMetadataAvailability;
    clean: boolean;
    destructiveOperations: 'refused';
}>;

export function isSafeSecurityDefinerRoutine(routine: Supabase22CatalogRoutine): boolean {
    return routine.securityDefiner === true
        && routine.searchPathEmpty
        && !routine.executePublic
        && !routine.executeAnon
        && !routine.executeAuthenticated
        && routine.executeServiceRole;
}

function catalogObjectsClean(
    values: readonly Supabase22CatalogDependency[],
    requireEvidence = false,
): boolean {
    if (requireEvidence && values.length === 0) return false;
    const objectNames = values.map(value => value.objectName);
    return objectNames.every(name => typeof name === 'string' && name.length > 0)
        && new Set(objectNames).size === objectNames.length
        && values.every(value => value.resolved === true && value.allowed === true);
}

/** Evaluate normalized PostgreSQL catalog rows. This function never repairs the catalog. */
export function evaluateSupabase22Catalog(
    snapshot: Supabase22CatalogSnapshot,
): Supabase22CatalogEvidence {
    const source = isRecord(snapshot)
        ? snapshot as Partial<Supabase22CatalogSnapshot>
        : {};
    const tables = Array.isArray(source.tables) ? source.tables : [];
    const acls = Array.isArray(source.acls) ? source.acls : null;
    const dependencies = Array.isArray(source.dependencies) ? source.dependencies : null;
    const foreignKeys = Array.isArray(source.foreignKeys) ? source.foreignKeys : null;
    const routines = Array.isArray(source.securityDefinerFunctions)
        ? source.securityDefinerFunctions : null;
    const migrationHistory = Array.isArray(source.migrationHistory)
        ? source.migrationHistory : null;
    const legacyWriters = Array.isArray(source.legacyWriters) ? source.legacyWriters : null;
    const views = Array.isArray(source.views) ? source.views : null;
    const sequences = Array.isArray(source.sequences) ? source.sequences : null;
    const partitions = Array.isArray(source.partitions) ? source.partitions : null;
    const publications = Array.isArray(source.publications) ? source.publications : null;
    const triggers = Array.isArray(source.triggers) ? source.triggers : null;
    const policies = Array.isArray(source.policies) ? source.policies : null;
    const availability = isRecord(source.metadataAvailability)
        ? source.metadataAvailability as Partial<Supabase22CatalogMetadataAvailability>
        : null;
    const metadataAvailability: Supabase22CatalogMetadataAvailability = {
        catalog: availability?.catalog === true,
        acl: availability?.acl === true,
        routine: availability?.routine === true,
        trigger: availability?.trigger === true,
        dependency: availability?.dependency === true,
        migration: availability?.migration === true,
        rls: availability?.rls === true,
        view: availability?.view === true,
        publication: availability?.publication === true,
        sequence: availability?.sequence === true,
        partition: availability?.partition === true,
        foreignKey: availability?.foreignKey === true,
        legacyWriter: availability?.legacyWriter === true,
    };
    const metadataComplete = Object.values(metadataAvailability).every(Boolean)
        && acls !== null
        && dependencies !== null
        && foreignKeys !== null
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
    const rlsClean = metadataAvailability.rls
        && publicTables.length > 0
        && tables
            .filter(table => table.relkind === 'r' || table.relkind === 'p')
            .every(table => table.rlsEnabled === true);
    const routinesClean = metadataAvailability.routine
        && routines !== null
        && routines.length > 0
        && routines.every(isSafeSecurityDefinerRoutine);
    const expectedAclObjectNames = new Set([
        ...publicTables,
        ...(routines ?? []).map(routine => routine.identityArguments !== undefined
            ? `${routine.name}(${routine.identityArguments})`
            : routine.name),
    ]);
    const observedAclObjectNames = acls === null
        ? new Set<string>()
        : new Set(acls.map(acl => acl.objectName));
    const aclClean = metadataAvailability.acl
        && acls !== null
        && expectedAclObjectNames.size > 0
        && acls.length === expectedAclObjectNames.size
        && observedAclObjectNames.size === expectedAclObjectNames.size
        && [...expectedAclObjectNames].every(name => observedAclObjectNames.has(name))
        && acls.every(acl => acl.resolved === true && acl.serviceRoleOnly === true);
    const dependencyClean = metadataAvailability.dependency
        && dependencies !== null
        && catalogObjectsClean(dependencies, true);
    const foreignKeysClean = metadataAvailability.foreignKey
        && foreignKeys !== null
        && catalogObjectsClean(foreignKeys);
    const migrationHistoryClean = metadataAvailability.migration
        && migrationHistory !== null
        && migrationHistory.length > 0
        && migrationHistory.every(migration =>
            typeof migration.version === 'string'
            && migration.version.length > 0
            && migration.pending !== true);
    const legacyWritersClean = metadataAvailability.legacyWriter
        && legacyWriters !== null
        && legacyWriters.every(writer => writer.active === false);
    const viewsClean = metadataAvailability.view && views !== null && catalogObjectsClean(views);
    const sequencesClean = metadataAvailability.sequence
        && sequences !== null && catalogObjectsClean(sequences);
    const partitionsClean = metadataAvailability.partition
        && partitions !== null && catalogObjectsClean(partitions);
    const publicationsClean = metadataAvailability.publication
        && publications !== null && catalogObjectsClean(publications);
    const triggersClean = metadataAvailability.trigger
        && triggers !== null && catalogObjectsClean(triggers);
    const policiesClean = metadataAvailability.rls
        && policies !== null && policies.every(policy => policy.enabled === true);
    const clean = metadataAvailability.catalog
        && publicTables.length === SUPABASE_22_CANONICAL_TABLES.length
        && canonicalTables.join('\u0000') === SUPABASE_22_CANONICAL_TABLES.join('\u0000')
        && unexpectedTables.length === 0
        && missingTables.length === 0
        && metadataComplete
        && dependencyClean
        && aclClean
        && migrationHistoryClean
        && rlsClean
        && routinesClean
        && viewsClean
        && sequencesClean
        && partitionsClean
        && publicationsClean
        && triggersClean
        && foreignKeysClean
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
        aclClean,
        triggersClean,
        foreignKeysClean,
        viewsClean,
        publicationsClean,
        sequencesClean,
        partitionsClean,
        legacyWritersClean,
        metadataAvailability,
        clean,
        destructiveOperations: 'refused',
    };
    assertPiiSafeConsolidationOutput(evidence);
    return evidence;
}

/** Read-only catalog query executed through an injected service-role connection. */
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
 * Read-only catalog query fragments used by an injected service-role catalog reader. Keeping
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
    acls: `
SELECT n.nspname,
       c.relname AS object_name,
       'relation' AS object_kind,
       c.relacl,
       pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') AS anon_select,
       pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') AS authenticated_select,
       pg_catalog.has_table_privilege('service_role', c.oid, 'SELECT') AS service_select
FROM pg_catalog.pg_class AS c
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
UNION ALL
SELECT n.nspname,
       p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')' AS object_name,
       'routine' AS object_kind,
       p.proacl,
       pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_execute
FROM pg_catalog.pg_proc AS p
JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosecdef
ORDER BY object_name
`,
    foreignKeys: `
SELECT con.conname, con.convalidated,
       pg_catalog.pg_get_constraintdef(con.oid) AS definition
FROM pg_catalog.pg_constraint AS con
JOIN pg_catalog.pg_class AS c ON c.oid = con.conrelid
JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND con.contype = 'f'
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
SELECT dependent_object.object_identity AS dependent_object,
       referenced_object.object_identity AS referenced_object,
       dependency.deptype,
       (dependent_object.object_identity IS NOT NULL
        AND referenced_object.object_identity IS NOT NULL) AS resolved,
       (
           dependency.deptype IN ('n', 'a', 'i')
           AND dependency.classid IN (
               'pg_catalog.pg_class'::pg_catalog.regclass,
               'pg_catalog.pg_proc'::pg_catalog.regclass,
               'pg_catalog.pg_type'::pg_catalog.regclass,
               'pg_catalog.pg_constraint'::pg_catalog.regclass,
               'pg_catalog.pg_trigger'::pg_catalog.regclass,
               'pg_catalog.pg_rewrite'::pg_catalog.regclass,
               'pg_catalog.pg_namespace'::pg_catalog.regclass,
               'pg_catalog.pg_attrdef'::pg_catalog.regclass,
               'pg_catalog.pg_policy'::pg_catalog.regclass,
               'pg_catalog.pg_partitioned_table'::pg_catalog.regclass,
               'pg_catalog.pg_init_privs'::pg_catalog.regclass,
               'pg_catalog.pg_enum'::pg_catalog.regclass,
               'pg_catalog.pg_collation'::pg_catalog.regclass,
               'pg_catalog.pg_opclass'::pg_catalog.regclass,
               'pg_catalog.pg_operator'::pg_catalog.regclass,
               'pg_catalog.pg_cast'::pg_catalog.regclass,
               'pg_catalog.pg_extension'::pg_catalog.regclass
           )
           AND dependency.refclassid IN (
               'pg_catalog.pg_class'::pg_catalog.regclass,
               'pg_catalog.pg_proc'::pg_catalog.regclass,
               'pg_catalog.pg_type'::pg_catalog.regclass,
               'pg_catalog.pg_constraint'::pg_catalog.regclass,
               'pg_catalog.pg_trigger'::pg_catalog.regclass,
               'pg_catalog.pg_rewrite'::pg_catalog.regclass,
               'pg_catalog.pg_namespace'::pg_catalog.regclass,
               'pg_catalog.pg_attrdef'::pg_catalog.regclass,
               'pg_catalog.pg_policy'::pg_catalog.regclass,
               'pg_catalog.pg_partitioned_table'::pg_catalog.regclass,
               'pg_catalog.pg_init_privs'::pg_catalog.regclass,
               'pg_catalog.pg_enum'::pg_catalog.regclass,
               'pg_catalog.pg_collation'::pg_catalog.regclass,
               'pg_catalog.pg_opclass'::pg_catalog.regclass,
               'pg_catalog.pg_operator'::pg_catalog.regclass,
               'pg_catalog.pg_cast'::pg_catalog.regclass,
               'pg_catalog.pg_extension'::pg_catalog.regclass
           )
       ) AS allowed
FROM pg_catalog.pg_depend AS dependency
CROSS JOIN LATERAL pg_catalog.pg_identify_object(
    dependency.classid,
    dependency.objid,
    dependency.objsubid
) AS dependent_object(object_type, object_schema, object_name, object_identity)
CROSS JOIN LATERAL pg_catalog.pg_identify_object(
    dependency.refclassid,
    dependency.refobjid,
    dependency.refobjsubid
) AS referenced_object(object_type, object_schema, object_name, object_identity)
WHERE (
      dependent_object.object_schema = 'public'
      OR referenced_object.object_schema = 'public'
  )
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

export interface Supabase22CatalogQueryClient {
    query(sql: string): PromiseLike<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const CATALOG_SNAPSHOT_KEYS = [
    'tables', 'acls', 'dependencies', 'foreignKeys', 'securityDefinerFunctions',
    'migrationHistory', 'legacyWriters', 'views', 'sequences', 'partitions',
    'publications', 'triggers', 'policies', 'metadataAvailability',
] as const;
const CATALOG_METADATA_KEYS = [
    'catalog', 'acl', 'routine', 'trigger', 'dependency', 'migration', 'rls',
    'view', 'publication', 'sequence', 'partition', 'foreignKey', 'legacyWriter',
] as const;

function hasOnlyKeys(
    value: Record<string, unknown>,
    requiredKeys: readonly string[],
    optionalKeys: readonly string[] = [],
): boolean {
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    return Object.keys(value).every(key => allowed.has(key))
        && requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function safeCatalogName(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function parseCatalogDependency(value: unknown): Supabase22CatalogDependency {
    if (!isRecord(value)
        || !hasOnlyKeys(value, ['objectName', 'resolved', 'allowed'])
        || !safeCatalogName(value.objectName)
        || typeof value.resolved !== 'boolean'
        || typeof value.allowed !== 'boolean') {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    return {
        objectName: value.objectName,
        resolved: value.resolved,
        allowed: value.allowed,
    };
}

/** Parse and reconstruct a normalized catalog snapshot; unknown fields never cross this boundary. */
export function parseSupabase22CatalogSnapshot(value: unknown): Supabase22CatalogSnapshot {
    if (!isRecord(value)
        || !hasOnlyKeys(value, CATALOG_SNAPSHOT_KEYS)) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    const arrays = CATALOG_SNAPSHOT_KEYS.filter(key => key !== 'metadataAvailability');
    if (!arrays.every(key => Array.isArray(value[key]))) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    const metadataAvailability = value.metadataAvailability;
    if (!isRecord(metadataAvailability)
        || !hasOnlyKeys(metadataAvailability, CATALOG_METADATA_KEYS)
        || !CATALOG_METADATA_KEYS.every(key => typeof metadataAvailability[key] === 'boolean')) {
        throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
    }
    const tables: Supabase22CatalogTable[] = [];
    for (const raw of value.tables as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, ['name', 'relkind', 'rlsEnabled'], ['relpersistence', 'forceRls'])
            || !safeCatalogName(raw.name)
            || (raw.relkind !== 'r' && raw.relkind !== 'p')
            || typeof raw.rlsEnabled !== 'boolean'
            || (raw.relpersistence !== undefined && typeof raw.relpersistence !== 'string')
            || (raw.forceRls !== undefined && typeof raw.forceRls !== 'boolean')) {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        tables.push({
            name: raw.name,
            relkind: raw.relkind,
            ...(raw.relpersistence === undefined ? {} : { relpersistence: raw.relpersistence }),
            rlsEnabled: raw.rlsEnabled,
            ...(raw.forceRls === undefined ? {} : { forceRls: raw.forceRls }),
        });
    }
    const acls: Supabase22CatalogAcl[] = [];
    for (const raw of value.acls as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, ['objectName', 'resolved', 'serviceRoleOnly'])
            || !safeCatalogName(raw.objectName)
            || typeof raw.resolved !== 'boolean'
            || typeof raw.serviceRoleOnly !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        acls.push({
            objectName: raw.objectName,
            resolved: raw.resolved,
            serviceRoleOnly: raw.serviceRoleOnly,
        });
    }
    const routines: Supabase22CatalogRoutine[] = [];
    for (const raw of value.securityDefinerFunctions as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, [
                'name', 'securityDefiner', 'searchPathEmpty', 'executePublic', 'executeAnon',
                'executeAuthenticated', 'executeServiceRole',
            ], ['identityArguments'])
            || !safeCatalogName(raw.name)
            || (raw.identityArguments !== undefined && !safeCatalogName(raw.identityArguments))
            || typeof raw.securityDefiner !== 'boolean'
            || typeof raw.searchPathEmpty !== 'boolean'
            || typeof raw.executePublic !== 'boolean'
            || typeof raw.executeAnon !== 'boolean'
            || typeof raw.executeAuthenticated !== 'boolean'
            || typeof raw.executeServiceRole !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        routines.push({
            name: raw.name,
            ...(raw.identityArguments === undefined ? {} : { identityArguments: raw.identityArguments }),
            securityDefiner: raw.securityDefiner,
            searchPathEmpty: raw.searchPathEmpty,
            executePublic: raw.executePublic,
            executeAnon: raw.executeAnon,
            executeAuthenticated: raw.executeAuthenticated,
            executeServiceRole: raw.executeServiceRole,
        });
    }
    const migrationHistory: Array<{ version: string; pending?: boolean }> = [];
    for (const raw of value.migrationHistory as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, ['version'], ['pending'])
            || !safeCatalogName(raw.version)
            || (raw.pending !== undefined && typeof raw.pending !== 'boolean')) {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        migrationHistory.push({
            version: raw.version,
            ...(raw.pending === undefined ? {} : { pending: raw.pending }),
        });
    }
    const legacyWriters: Array<{ active: boolean }> = [];
    for (const raw of value.legacyWriters as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, ['active'])
            || typeof raw.active !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        legacyWriters.push({ active: raw.active });
    }
    const objectCollections: Record<
        'dependencies' | 'foreignKeys' | 'views' | 'sequences' | 'partitions' | 'publications' | 'triggers',
        Supabase22CatalogDependency[]
    > = {
        dependencies: [],
        foreignKeys: [],
        views: [],
        sequences: [],
        partitions: [],
        publications: [],
        triggers: [],
    };
    for (const key of Object.keys(objectCollections) as Array<keyof typeof objectCollections>) {
        objectCollections[key] = (value[key] as unknown[]).map(parseCatalogDependency);
    }
    const policies: Array<{ tableName: string; enabled: boolean }> = [];
    for (const raw of value.policies as unknown[]) {
        if (!isRecord(raw)
            || !hasOnlyKeys(raw, ['tableName', 'enabled'])
            || !safeCatalogName(raw.tableName)
            || typeof raw.enabled !== 'boolean') {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
        policies.push({ tableName: raw.tableName, enabled: raw.enabled });
    }
    return {
        tables,
        acls,
        ...objectCollections,
        securityDefinerFunctions: routines,
        migrationHistory,
        legacyWriters,
        policies,
        metadataAvailability: Object.fromEntries(
            CATALOG_METADATA_KEYS.map(key => [key, metadataAvailability[key] === true]),
        ) as Supabase22CatalogMetadataAvailability,
    };
}

export async function collectSupabase22CatalogEvidence(
    client: Supabase22CatalogQueryClient,
): Promise<Supabase22CatalogEvidence> {
    const queries = Object.entries(SUPABASE_22_CATALOG_QUERIES);
    const snapshots: Supabase22CatalogSnapshot[] = [];
    for (const [, sql] of queries) {
        if (!/^\s*SELECT\b/i.test(sql)
            || /\b(?:DROP|TRUNCATE|ALTER|INSERT|UPDATE|DELETE|GRANT|REVOKE)\b/i.test(sql)) {
            throw new Error('SUPABASE_22_CATALOG_QUERY_NOT_READ_ONLY');
        }
        let raw: unknown;
        try {
            raw = await client.query(sql);
        } catch {
            throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
        }
        if (isRecord(raw) && 'error' in raw && raw.error) {
            throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
        }
        if (isRecord(raw) && 'data' in raw && raw.data !== undefined) raw = raw.data;
        try {
            // The injected connection owns row normalization, but every
            // bounded catalog query must attest the same complete snapshot.
            // A single table-shaped response is never enough to claim clean.
            snapshots.push(parseSupabase22CatalogSnapshot(raw));
        } catch {
            throw new Error('SUPABASE_22_CATALOG_PAYLOAD_INVALID');
        }
    }
    const serialized = JSON.stringify(snapshots[0]);
    if (!serialized || snapshots.some(snapshot => JSON.stringify(snapshot) !== serialized)) {
        throw new Error('SUPABASE_22_CATALOG_COVERAGE_MISMATCH');
    }
    return evaluateSupabase22Catalog(snapshots[0]!);
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

const TRAFFIC_FAMILY_NAME_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const MAX_TRAFFIC_FAMILIES = 64;

/**
 * Traffic evidence must come from an explicitly provisioned, bounded,
 * read-only reader.  The previous RPC-shaped interface named a repository
 * function that is not present in this worktree; retaining that call would
 * turn an unavailable observation into an ambiguous failure.  Callers that
 * cannot provide this reader fail closed below.
 */
export interface Supabase22TrafficRpcClient {
    readBoundedTrafficEvidence?: () => PromiseLike<unknown>;
    /** @deprecated An RPC client alone is intentionally not accepted. */
    rpc?: (...args: unknown[]) => PromiseLike<unknown>;
}

function parseTrafficEvidence(value: unknown): Supabase22RollbackEvidenceInput {
    if (!isRecord(value) || !Array.isArray(value.families)
        || Object.keys(value).length !== 3
        || !Object.prototype.hasOwnProperty.call(value, 'families')
        || !Object.prototype.hasOwnProperty.call(value, 'activeLegacyWriterCount')
        || !Object.prototype.hasOwnProperty.call(value, 'observationWindowClosed')
        || !Number.isSafeInteger(value.activeLegacyWriterCount)
        || (value.activeLegacyWriterCount as number) < 0
        || typeof value.observationWindowClosed !== 'boolean') {
        throw new Error('SUPABASE_22_TRAFFIC_PAYLOAD_INVALID');
    }
    const families = value.families as unknown[];
    if (families.length === 0 || families.length > MAX_TRAFFIC_FAMILIES) {
        throw new Error('SUPABASE_22_TRAFFIC_PAYLOAD_INVALID');
    }
    const seenFamilies = new Set<string>();
    const sanitizedFamilies: Supabase22FamilyTrafficEvidence[] = [];
    if (families.some(family => {
        if (!isRecord(family)) return true;
        const keys = [
            'family', 'serverOnly', 'legacyReaderAvailable', 'canonicalReaderEnabled',
            'canonicalWriterEnabled', 'shadowMismatch', 'retryQueueCount',
            'retryQueueBounded', 'activeLegacyWriterCount',
        ];
        if (Object.keys(family).length !== keys.length
            || keys.some(key => !Object.prototype.hasOwnProperty.call(family, key))) {
            return true;
        }
        if (typeof family.family !== 'string'
            || !TRAFFIC_FAMILY_NAME_PATTERN.test(family.family)
            || seenFamilies.has(family.family)) {
            return true;
        }
        seenFamilies.add(family.family);
        if (typeof family.serverOnly !== 'boolean'
            || typeof family.legacyReaderAvailable !== 'boolean'
            || typeof family.canonicalReaderEnabled !== 'boolean'
            || typeof family.canonicalWriterEnabled !== 'boolean'
            || typeof family.shadowMismatch !== 'boolean'
            || typeof family.retryQueueBounded !== 'boolean') {
            return true;
        }
        if (typeof family.retryQueueCount !== 'number'
            || !Number.isSafeInteger(family.retryQueueCount)
            || family.retryQueueCount < 0
            || typeof family.activeLegacyWriterCount !== 'number'
            || !Number.isSafeInteger(family.activeLegacyWriterCount)
            || family.activeLegacyWriterCount < 0) {
            return true;
        }
        sanitizedFamilies.push({
            family: family.family,
            serverOnly: family.serverOnly === true,
            legacyReaderAvailable: family.legacyReaderAvailable === true,
            canonicalReaderEnabled: family.canonicalReaderEnabled === true,
            canonicalWriterEnabled: family.canonicalWriterEnabled === true,
            shadowMismatch: family.shadowMismatch === true,
            retryQueueCount: family.retryQueueCount,
            retryQueueBounded: family.retryQueueBounded === true,
            activeLegacyWriterCount: family.activeLegacyWriterCount,
        });
        return false;
    })) {
        throw new Error('SUPABASE_22_TRAFFIC_PAYLOAD_INVALID');
    }
    const activeLegacyWriterCount = value.activeLegacyWriterCount as number;
    return {
        families: sanitizedFamilies,
        activeLegacyWriterCount,
        observationWindowClosed: value.observationWindowClosed,
    };
}

/** Read aggregate traffic counters only; route payloads and actor identifiers never leave the reader. */
export async function collectSupabase22RollbackEvidence(
    client: Supabase22TrafficRpcClient,
): Promise<Supabase22RollbackEvidence> {
    if (typeof client.readBoundedTrafficEvidence !== 'function') {
        throw new Error('SUPABASE_22_TRAFFIC_READ_UNAVAILABLE');
    }
    let raw: unknown;
    try {
        raw = await client.readBoundedTrafficEvidence();
    } catch {
        throw new Error('SUPABASE_22_TRAFFIC_READ_FAILED');
    }
    if (raw === null || raw === undefined) {
        throw new Error('SUPABASE_22_TRAFFIC_READ_FAILED');
    }
    return evaluateSupabase22RollbackEvidence(parseTrafficEvidence(raw));
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
