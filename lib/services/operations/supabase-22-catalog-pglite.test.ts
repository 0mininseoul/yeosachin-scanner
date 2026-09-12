import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    SUPABASE_22_CATALOG_PAGE_SIZE,
    SUPABASE_22_CATALOG_ROW_LIMIT,
    adaptSupabase22CatalogRows,
    collectSupabase22CatalogEvidence,
    evaluateSupabase22Catalog,
    SUPABASE_OPERATIONAL_RETAINED_TABLES,
    SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES,
    SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES,
    SUPABASE_OPERATIONAL_RETAINED_OPERATOR_INVOKER_HELPER_NAMES,
    SUPABASE_OPERATIONAL_ROUTINE_NAMES,
    SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES,
    SUPABASE_OPERATIONAL_RETAINED_OPERATOR_TRIGGER_NAMES,
    formatSupabaseOperationalRoutineIdentity,
    SUPABASE_22_CATALOG_QUERY,
    SUPABASE_22_CATALOG_QUERIES,
} from './supabase-22-evidence';

const CANONICAL_TABLES = [
    ...SUPABASE_OPERATIONAL_RETAINED_TABLES,
];

describe('Supabase 22 catalog collector with a disposable catalog', () => {
    let db: PGlite;

    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon;
            CREATE ROLE authenticated;
            CREATE ROLE service_role;
            CREATE TABLE public.users (id integer);
            CREATE TABLE public.analysis_requests (id integer);
            REVOKE ALL ON TABLE public.users, public.analysis_requests
                FROM PUBLIC, anon, authenticated, service_role;
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('collects catalog rows without turning SQL execution into a mutation path', async () => {
        let queryCount = 0;
        const query = async (sql: string): Promise<unknown> => {
            queryCount += 1;
            expect(sql.trim()).toMatch(/^SELECT\b/i);
            expect(sql.replace(/'(?:''|[^'])*'/g, "''").toUpperCase())
                .not.toMatch(/\b(DROP|TRUNCATE|ALTER|INSERT|UPDATE|DELETE)\b/);
            if (sql.trim() === SUPABASE_22_CATALOG_QUERY.trim()) {
                const result = await db.query<{ relname: string }>(sql);
                expect(result.rows.map(row => row.relname)).toEqual(['analysis_requests', 'users']);
            }
            const queryName = Object.entries(SUPABASE_22_CATALOG_QUERIES)
                .find(([, candidate]) => candidate === sql)?.[0];
            if (queryName === 'acls') {
                const aclResult = await db.query<{
                    object_name: string;
                    object_kind: string;
                    public_allowed: boolean;
                    anon_allowed: boolean;
                    authenticated_allowed: boolean;
                    service_allowed: boolean;
                }>(sql);
                expect(aclResult.rows.map(row => row.object_name)).toEqual([
                    'analysis_requests', 'users',
                ]);
                expect(aclResult.rows.every(row =>
                    row.object_kind === 'relation'
                    && row.public_allowed === false
                    && row.anon_allowed === false
                    && row.authenticated_allowed === false
                    && row.service_allowed === false,
                )).toBe(true);
            }
            const rows: Record<string, readonly unknown[]> = {
                tables: [
                    {
                        relname: 'users',
                        relkind: 'r',
                        relpersistence: 'p',
                        relrowsecurity: true,
                        relforcerowsecurity: true,
                    },
                    {
                        relname: 'analysis_requests',
                        relkind: 'r',
                        relpersistence: 'p',
                        relrowsecurity: true,
                        relforcerowsecurity: true,
                    },
                ],
                policies: [],
                acls: [],
                routines: [],
                dependencies: [],
                foreignKeys: [],
                triggers: [],
                views: [],
                sequences: [],
                partitions: [],
                publications: [],
                migrationHistory: [{ version: '20260905000000', pending: false }],
                legacyWriters: [
                    { object_name: 'public.users', active: false },
                    { object_name: 'public.analysis_requests', active: false },
                ],
            };
            return { rows: rows[queryName ?? ''] ?? [], rowCount: rows[queryName ?? '']?.length ?? 0 };
        };

        const evidence = await collectSupabase22CatalogEvidence({ query });

        expect(queryCount).toBe(Object.keys(SUPABASE_22_CATALOG_QUERIES).length);
        expect(evidence.publicTableCount).toBe(2);
        expect(evidence.canonicalTables).toEqual([]);
        expect(evidence.unexpectedTables).toEqual(['analysis_requests', 'users']);
        expect(evidence.missingTables).toEqual(CANONICAL_TABLES.filter(
            table => !['analysis_requests', 'users'].includes(table),
        ));
        expect(evidence.dependencyClean).toBe(false);
        expect(evidence.rlsClean).toBe(true);
    });

    it('reports a non-SELECT table privilege instead of treating the ACL as empty', async () => {
        await db.exec('GRANT MAINTAIN ON TABLE public.users TO service_role');
        try {
            const result = await db.query<{
                object_name: string;
                service_allowed: boolean;
            }>(SUPABASE_22_CATALOG_QUERIES.acls);
            expect(result.rows.find(row => row.object_name === 'users')?.service_allowed)
                .toBe(true);
        } finally {
            await db.exec('REVOKE MAINTAIN ON TABLE public.users FROM service_role');
        }
    });

    it('fails closed when a public table is RLS-enabled but not FORCE RLS', () => {
        const snapshot = {
            tables: SUPABASE_OPERATIONAL_RETAINED_TABLES.map(name => ({
                name,
                relkind: 'r' as const,
                rlsEnabled: true,
                forceRls: name === 'analysis_jobs' ? false : true,
            })),
            acls: [],
            dependencies: [],
            foreignKeys: [],
            securityDefinerFunctions: [],
            migrationHistory: [],
            legacyWriters: [],
            views: [],
            sequences: [],
            partitions: [],
            publications: [],
            triggers: [],
            policies: [],
            metadataAvailability: {
                catalog: true,
                acl: true,
                routine: true,
                trigger: true,
                dependency: true,
                migration: true,
                rls: true,
                view: true,
                publication: true,
                sequence: true,
                partition: true,
                foreignKey: true,
                legacyWriter: true,
            },
        };

        expect(evaluateSupabase22Catalog(snapshot as never).rlsClean).toBe(false);
    });

    it('keeps invoker-only analysis helpers out of the SECURITY DEFINER allowlist', () => {
        const invokerHelpers = [
            'analysis_canonical_json_object_has_exact_keys',
            'analysis_canonical_json_value_valid',
            'analysis_canonical_payload_valid',
            'analysis_canonical_payload_has_only_keys',
        ];
        for (const name of invokerHelpers) {
            expect(SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES).not.toContain(name);
            expect(SUPABASE_OPERATIONAL_ROUTINE_NAMES).not.toContain(name);
        }
        expect(SUPABASE_22_CATALOG_QUERIES.routines).toMatch(/p\.prosecdef/);
        expect(SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES).toEqual([
            'claim_anonymous_analysis_v2_preflight_with_landing',
            'set_analysis_v2_preflight_exclusion_with_landing',
            'set_authenticated_analysis_v2_preflight_exclusion',
        ]);
        for (const name of SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES) {
            expect(SUPABASE_OPERATIONAL_ROUTINE_NAMES).toContain(name);
        }
    });

    it('rejects an ambiguous/truncated catalog result at the bounded adapter boundary', async () => {
        await expect(collectSupabase22CatalogEvidence({
            query: async sql => {
                const queryName = Object.entries(SUPABASE_22_CATALOG_QUERIES)
                    .find(([, candidate]) => candidate === sql)?.[0];
                if (queryName === 'tables') {
                    return { rows: [], rowCount: SUPABASE_22_CATALOG_ROW_LIMIT + 1 };
                }
                return { rows: [], rowCount: 0 };
            },
        })).rejects.toThrow('SUPABASE_22_CATALOG_RESULT_AMBIGUOUS');
    });

    it('fails closed when any catalog evidence family is absent', () => {
        const completeSnapshot = {
            tables: SUPABASE_OPERATIONAL_RETAINED_TABLES.map(name => ({
                name,
                relkind: 'r' as const,
                rlsEnabled: true,
                forceRls: true,
            })),
            acls: [
                ...SUPABASE_OPERATIONAL_RETAINED_TABLES.map(objectName => ({
                    objectName,
                    resolved: true,
                    serviceRoleOnly: true,
                })),
                { objectName: 'canonical-routine', resolved: true, serviceRoleOnly: true },
            ],
            dependencies: [{ objectName: 'public.analysis_requests', resolved: true, allowed: true }],
            foreignKeys: [{ objectName: 'fk-1', resolved: true, allowed: true }],
            securityDefinerFunctions: [{
                name: 'canonical-routine',
                securityDefiner: true,
                searchPathEmpty: true,
                executePublic: false,
                executeAnon: false,
                executeAuthenticated: false,
                executeServiceRole: true,
            }],
            migrationHistory: [{ version: '20260905000000', pending: false }],
            legacyWriters: [],
            views: [],
            sequences: [],
            partitions: [],
            publications: [],
            triggers: [{ objectName: 'trigger-1', resolved: true, allowed: true }],
            policies: [{ tableName: 'users', enabled: true }],
        };

        const undercoveredAclSnapshot = {
            ...completeSnapshot,
            acls: [{ objectName: 'users', resolved: true, serviceRoleOnly: true }],
        };
        expect(evaluateSupabase22Catalog(undercoveredAclSnapshot as never).aclClean).toBe(false);

        for (const key of [
            'tables', 'acls', 'securityDefinerFunctions', 'triggers', 'dependencies',
            'migrationHistory', 'views', 'publications', 'sequences', 'partitions',
            'foreignKeys', 'policies', 'legacyWriters',
        ]) {
            const missing = { ...completeSnapshot } as Record<string, unknown>;
            delete missing[key];
            const evidence = evaluateSupabase22Catalog(missing as never);
            expect(evidence.clean, key).toBe(false);
        }
    });

    it('requires explicit service-only ACL evidence for routines', () => {
        const snapshot = {
            tables: SUPABASE_OPERATIONAL_RETAINED_TABLES.map(name => ({
                name,
                relkind: 'r' as const,
                rlsEnabled: true,
                forceRls: true,
            })),
            acls: [
                ...SUPABASE_OPERATIONAL_RETAINED_TABLES.map(objectName => ({
                    objectName,
                    resolved: true,
                    serviceRoleOnly: true,
                })),
                {
                    objectName: SUPABASE_OPERATIONAL_ROUTINE_NAMES[0],
                    resolved: true,
                    serviceRoleOnly: false,
                },
            ],
            dependencies: [{ objectName: 'public.analysis_requests', resolved: true, allowed: true }],
            foreignKeys: [{ objectName: 'fk-1', resolved: true, allowed: true }],
            securityDefinerFunctions: [{
                name: SUPABASE_OPERATIONAL_ROUTINE_NAMES[0],
                securityDefiner: true,
                searchPathEmpty: true,
                executePublic: false,
                executeAnon: false,
                executeAuthenticated: false,
                executeServiceRole: true,
            }],
            migrationHistory: [{ version: '20260905000000', pending: false }],
            legacyWriters: [],
            views: [],
            sequences: [],
            partitions: [],
            publications: [],
            triggers: [{ objectName: 'trigger-1', resolved: true, allowed: true }],
            policies: [{ tableName: 'users', enabled: true }],
        };

        const evidence = evaluateSupabase22Catalog(snapshot as never);

        expect(evidence.aclClean).toBe(false);
        expect(evidence.routinesClean).toBe(false);
        expect(evidence.clean).toBe(false);
    });

    it('distinguishes relation, private-helper, and service-RPC ACL contracts', () => {
        const relationAcl = (objectName: string) => ({
            objectName,
            objectKind: 'relation' as const,
            resolved: true,
            publicAllowed: false,
            anonAllowed: false,
            authenticatedAllowed: false,
            serviceRoleAllowed: false,
        });
        const privateRoutine = (name: string) => ({
            name,
            identityArguments: (name === 'create_or_replay_landing_lead_exclusion'
                ? 'pg_catalog.uuid,pg_catalog.text'
                : formatSupabaseOperationalRoutineIdentity(name).slice(
                name.length + 1,
                -1,
            )),
            securityDefiner: true,
            searchPathEmpty: true,
            executePublic: false,
            executeAnon: false,
            executeAuthenticated: false,
            executeServiceRole: false,
        });
        const serviceRpc = (name: string) => ({
            name,
            identityArguments: formatSupabaseOperationalRoutineIdentity(name).slice(
                name.length + 1,
                -1,
            ),
            securityDefiner: true,
            searchPathEmpty: true,
            executePublic: false,
            executeAnon: false,
            executeAuthenticated: false,
            executeServiceRole: true,
        });
        const invokerRoutine = (name: string) => ({
            name,
            identityArguments: name === 'analysis_order_audit_bundle_payload'
                ? 'public.analysis_order_audit_bundles'
                : formatSupabaseOperationalRoutineIdentity(name).slice(
                    name.length + 1,
                    -1,
                ),
            securityDefiner: false,
            searchPathEmpty: true,
            executePublic: false,
            executeAnon: false,
            executeAuthenticated: false,
            executeServiceRole: false,
        });
        const clientRpc = (name: string) => ({
            name,
            identityArguments: formatSupabaseOperationalRoutineIdentity(name).slice(
                name.length + 1,
                -1,
            ),
            securityDefiner: true,
            searchPathEmpty: true,
            executePublic: false,
            executeAnon: name === 'set_analysis_v2_preflight_exclusion_with_landing',
            executeAuthenticated: true,
            executeServiceRole: false,
        });
        const observedRoutineIdentity = (name: string) => name === 'create_or_replay_landing_lead_exclusion'
            ? `public.${name}(pg_catalog.uuid,pg_catalog.text)`
            : name === 'analysis_order_audit_bundle_payload'
                ? `public.${name}(public.analysis_order_audit_bundles)`
                : formatSupabaseOperationalRoutineIdentity(name);
        const snapshot = {
            tables: SUPABASE_OPERATIONAL_RETAINED_TABLES.map(name => ({
                name,
                relkind: 'r' as const,
                rlsEnabled: true,
                forceRls: true,
            })),
            acls: [
                ...SUPABASE_OPERATIONAL_RETAINED_TABLES.map(relationAcl),
                ...SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES.map(name => ({
                    ...relationAcl(observedRoutineIdentity(name)),
                    objectKind: 'routine' as const,
                })),
                ...SUPABASE_OPERATIONAL_RETAINED_OPERATOR_INVOKER_HELPER_NAMES.map(name => ({
                    ...relationAcl(observedRoutineIdentity(name)),
                    objectKind: 'routine' as const,
                })),
                ...SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES.map(name => ({
                    ...relationAcl(observedRoutineIdentity(name)),
                    objectKind: 'routine' as const,
                    serviceRoleAllowed: true,
                })),
                ...SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES.map(name => ({
                    ...relationAcl(observedRoutineIdentity(name)),
                    objectKind: 'routine' as const,
                    anonAllowed: name === 'set_analysis_v2_preflight_exclusion_with_landing',
                    authenticatedAllowed: true,
                })),
            ],
            dependencies: [
                ...SUPABASE_OPERATIONAL_RETAINED_TABLES,
                ...SUPABASE_OPERATIONAL_ROUTINE_NAMES.map(observedRoutineIdentity),
            ].map(objectName => ({
                objectName,
                resolved: true,
                allowed: true,
                details: [],
            })),
            foreignKeys: [],
            securityDefinerFunctions: [
                ...SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES.map(privateRoutine),
                ...SUPABASE_OPERATIONAL_RETAINED_OPERATOR_INVOKER_HELPER_NAMES.map(invokerRoutine),
                ...SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES.map(serviceRpc),
                ...SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES.map(clientRpc),
            ],
            migrationHistory: [{ version: '20260905000000', pending: false }],
            legacyWriters: SUPABASE_OPERATIONAL_RETAINED_TABLES.map(objectName => ({
                objectName,
                active: false,
            })),
            views: [],
            sequences: [],
            partitions: [],
            publications: [],
            triggers: SUPABASE_OPERATIONAL_RETAINED_OPERATOR_TRIGGER_NAMES.map(name => ({
                objectName: `public.analysis_order_audit_bundles.${name}`,
                resolved: true,
                allowed: true,
                details: [],
            })),
            policies: SUPABASE_OPERATIONAL_RETAINED_TABLES.map(tableName => ({
                tableName,
                enabled: true,
                details: [],
            })),
            metadataAvailability: {
                catalog: true,
                acl: true,
                routine: true,
                trigger: true,
                dependency: true,
                migration: true,
                rls: true,
                view: true,
                publication: true,
                sequence: true,
                partition: true,
                foreignKey: true,
                legacyWriter: true,
            },
        };

        const evidence = evaluateSupabase22Catalog(snapshot as never);
        expect(evidence.canonicalRelationsAclClean).toBe(true);
        expect(evidence.privateRoutinesAclClean).toBe(true);
        expect(evidence.serviceRpcsAclClean).toBe(true);
        expect(evidence.clientRpcsAclClean).toBe(true);
        expect(evidence.aclClean).toBe(true);
        expect(evidence.routinesClean).toBe(true);

        const wrongSignature = evaluateSupabase22Catalog({
            ...snapshot,
            securityDefinerFunctions: snapshot.securityDefinerFunctions.map((routine, index) =>
                index === 0 ? { ...routine, identityArguments: 'text' } : routine),
        } as never);
        expect(wrongSignature.routinesClean).toBe(false);
        expect(wrongSignature.privateRoutinesAclClean).toBe(false);
        expect(wrongSignature.clean).toBe(false);

        const relationGrant = evaluateSupabase22Catalog({
            ...snapshot,
            acls: snapshot.acls.map(acl => acl.objectName === SUPABASE_OPERATIONAL_RETAINED_TABLES[0]
                ? { ...acl, serviceRoleAllowed: true }
                : acl),
        } as never);
        expect(relationGrant.canonicalRelationsAclClean).toBe(false);
        expect(relationGrant.aclClean).toBe(false);

        const privateGrant = evaluateSupabase22Catalog({
            ...snapshot,
            acls: snapshot.acls.map(acl => acl.objectName === formatSupabaseOperationalRoutineIdentity(
                SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES[0],
            )
                ? { ...acl, serviceRoleAllowed: true }
                : acl),
            securityDefinerFunctions: snapshot.securityDefinerFunctions.map(routine => routine.name
                === SUPABASE_OPERATIONAL_PRIVATE_ROUTINE_NAMES[0]
                ? { ...routine, executeServiceRole: true }
                : routine),
        } as never);
        expect(privateGrant.privateRoutinesAclClean).toBe(false);
        expect(privateGrant.aclClean).toBe(false);

        const serviceRpcRevoked = evaluateSupabase22Catalog({
            ...snapshot,
            acls: snapshot.acls.map(acl => acl.objectName === formatSupabaseOperationalRoutineIdentity(
                SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES[0],
            )
                ? { ...acl, serviceRoleAllowed: false }
                : acl),
            securityDefinerFunctions: snapshot.securityDefinerFunctions.map(routine => routine.name
                === SUPABASE_OPERATIONAL_SERVICE_RPC_NAMES[0]
                ? { ...routine, executeServiceRole: false }
                : routine),
        } as never);
        expect(serviceRpcRevoked.serviceRpcsAclClean).toBe(false);
        expect(serviceRpcRevoked.aclClean).toBe(false);

        const clientRpcRevoked = evaluateSupabase22Catalog({
            ...snapshot,
            acls: snapshot.acls.map(acl => acl.objectName
                === formatSupabaseOperationalRoutineIdentity(SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES[0])
                ? { ...acl, authenticatedAllowed: false }
                : acl),
            securityDefinerFunctions: snapshot.securityDefinerFunctions.map(routine =>
                routine.name === SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES[0]
                    ? { ...routine, executeAuthenticated: false }
                    : routine),
        } as never);
        expect(clientRpcRevoked.clientRpcsAclClean).toBe(false);
        expect(clientRpcRevoked.aclClean).toBe(false);

        const missingClientRpc = evaluateSupabase22Catalog({
            ...snapshot,
            acls: snapshot.acls.filter(acl => acl.objectName
                !== formatSupabaseOperationalRoutineIdentity(SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES[0])),
            securityDefinerFunctions: snapshot.securityDefinerFunctions.filter(routine =>
                routine.name !== SUPABASE_OPERATIONAL_CLIENT_RPC_NAMES[0]),
        } as never);
        expect(missingClientRpc.routinesClean).toBe(false);
        expect(missingClientRpc.clientRpcsAclClean).toBe(false);
        expect(missingClientRpc.aclClean).toBe(false);

        const extraRoutine = evaluateSupabase22Catalog({
            ...snapshot,
            securityDefinerFunctions: [
                ...snapshot.securityDefinerFunctions,
                serviceRpc('unexpected_rpc'),
            ],
            acls: [
                ...snapshot.acls,
                {
                    ...relationAcl('unexpected_rpc'),
                    objectKind: 'routine' as const,
                    serviceRoleAllowed: true,
                },
            ],
        } as never);
        expect(extraRoutine.privateRoutinesAclClean).toBe(true);
        expect(extraRoutine.serviceRpcsAclClean).toBe(true);
        expect(extraRoutine.clientRpcsAclClean).toBe(true);
        expect(extraRoutine.aclClean).toBe(true);
    });

    it('aggregates policy and pg_depend rows into deterministic one-row-per-object evidence', () => {
        const snapshot = adaptSupabase22CatalogRows({
            tables: [
                {
                    relname: 'users',
                    relkind: 'r',
                    relpersistence: 'p',
                    relrowsecurity: true,
                    relforcerowsecurity: true,
                },
            ],
            policies: [
                {
                    schema_name: 'public',
                    table_name: 'users',
                    policy_name: 'z-last',
                    enabled: true,
                    command: 'r',
                    roles: ['authenticated'],
                    using_expression: '(owner_id = auth.uid())',
                    check_expression: null,
                    permissive: true,
                },
                {
                    schema_name: 'public',
                    table_name: 'users',
                    policy_name: 'a-first',
                    enabled: true,
                    command: 'w',
                    roles: ['authenticated'],
                    using_expression: null,
                    check_expression: '(owner_id = auth.uid())',
                    permissive: true,
                },
            ],
            acls: [],
            routines: [],
            dependencies: [
                {
                    object_name: 'public.users',
                    dependent_object: 'public.users',
                    referenced_object: 'public.users_id_seq',
                    dependency_type: 'n',
                    class_id: 'pg_class',
                    ref_class_id: 'pg_class',
                    object_sub_id: 0,
                    ref_object_sub_id: 0,
                    resolved: true,
                    allowed: true,
                },
                {
                    object_name: 'public.users',
                    dependent_object: 'public.users',
                    referenced_object: 'public.auth_uid',
                    dependency_type: 'n',
                    class_id: 'pg_policy',
                    ref_class_id: 'pg_proc',
                    object_sub_id: 0,
                    ref_object_sub_id: 0,
                    resolved: true,
                    allowed: true,
                },
            ],
            foreignKeys: [],
            triggers: [],
            views: [],
            sequences: [],
            partitions: [],
            publications: [],
            migrationHistory: [],
            legacyWriters: [],
        });

        expect(snapshot.policies).toHaveLength(1);
        expect(snapshot.policies[0]).toMatchObject({
            tableName: 'users',
            enabled: true,
            details: [
                {
                    policyName: 'a-first',
                    command: 'w',
                    roles: ['authenticated'],
                    usingExpression: null,
                    checkExpression: '(owner_id = auth.uid())',
                    permissive: true,
                },
                {
                    policyName: 'z-last',
                    command: 'r',
                    roles: ['authenticated'],
                    usingExpression: '(owner_id = auth.uid())',
                    checkExpression: null,
                    permissive: true,
                },
            ],
        });
        expect(snapshot.dependencies).toHaveLength(1);
        expect(snapshot.dependencies[0]?.details).toHaveLength(2);
        expect(snapshot.dependencies[0]?.details?.map(detail => detail.referencedObject))
            .toEqual(['public.auth_uid', 'public.users_id_seq']);
    });

    it('accepts grouped dependency details with summary resolution flags', () => {
        const snapshot = adaptSupabase22CatalogRows({
            tables: [],
            policies: [],
            acls: [],
            routines: [],
            dependencies: [{
                object_name: 'public.users',
                resolved: true,
                allowed: true,
                dependency_details: [{
                    dependent_object: 'public.users',
                    referenced_object: 'public.users_id_seq',
                    dependency_type: 'n',
                    class_id: 'pg_class',
                    ref_class_id: 'pg_class',
                    object_sub_id: 0,
                    ref_object_sub_id: 0,
                    resolved: true,
                    allowed: true,
                }],
            }],
            foreignKeys: [],
            triggers: [],
            views: [],
            sequences: [],
            partitions: [],
            publications: [],
            migrationHistory: [],
            legacyWriters: [],
        });

        expect(snapshot.dependencies[0]?.details).toHaveLength(1);
    });

    it('uses an observed activity boolean for legacy-writer rows instead of a null placeholder', () => {
        const query = SUPABASE_22_CATALOG_QUERIES.legacyWriters;
        expect(query).toContain('pg_catalog.pg_stat_activity');
        expect(query).toContain('EXISTS');
        expect(query).not.toContain('NULL::boolean');
    });

    it('keeps the operational-policy migration additive until post-deploy contraction evidence', () => {
        const migration = readFileSync(join(
            process.cwd(),
            'supabase/migrations/20260913130000_contract_supabase_operational_policy_v1.sql',
        ), 'utf8');
        expect(migration).not.toMatch(/\b(?:DROP|TRUNCATE|ALTER)\b/i);
        expect(migration).not.toMatch(/current_setting\s*\(/i);
        expect(migration).not.toContain('app.supabase_operational_policy');
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.enqueue_analysis_execution_retry_v1',
        );
        expect(migration).toContain(
            'CREATE OR REPLACE FUNCTION public.load_analysis_execution_family_v1',
        );
        expect(migration).toContain("'progress'");
        expect(migration).toContain("'result'");
        expect(migration).toContain('analysis_execution_json_value_valid_v1(v_entry.value)');
        expect(migration).not.toMatch(
            /CREATE\s+(?:OR REPLACE\s+)?FUNCTION\s+public\.(?:record_analysis_canonical_job|append_analysis_canonical_event)/i,
        );
    });

    it('executes the additive migration and preserves old objects and nested execution behavior', async () => {
        const migrationDb = await PGlite.create();
        try {
            await migrationDb.exec(`
                CREATE ROLE anon;
                CREATE ROLE authenticated;
                CREATE ROLE service_role;
                CREATE SCHEMA extensions;
                CREATE FUNCTION extensions.digest(bytea, text)
                RETURNS bytea LANGUAGE sql IMMUTABLE
                AS $$ SELECT decode(md5($1), 'hex') $$;
                CREATE TABLE public.analysis_jobs (
                    id uuid PRIMARY KEY,
                    request_id uuid NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT now()
                );
                CREATE TABLE public.analysis_events (
                    id bigserial PRIMARY KEY,
                    request_id uuid NOT NULL,
                    kind text NOT NULL,
                    state text NOT NULL,
                    payload jsonb NOT NULL,
                    content_hash text NOT NULL,
                    retention_class text NOT NULL,
                    created_at timestamptz NOT NULL DEFAULT now()
                );
                CREATE UNIQUE INDEX analysis_events_retry_unique
                    ON public.analysis_events(request_id, state, content_hash)
                    WHERE kind = 'operational' AND state = 'canonical_retry';
                CREATE FUNCTION public.analysis_canonical_payload_valid(jsonb)
                RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
                CREATE FUNCTION public.record_analysis_canonical_job(text)
                RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
                CREATE FUNCTION public.append_analysis_canonical_event(text)
                RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT true $$;
            `);

            const relationRows = async () => (await migrationDb.query<{
                relname: string;
                relkind: string;
            }>(`
                SELECT c.relname, c.relkind
                FROM pg_catalog.pg_class AS c
                JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'i', 'S')
                ORDER BY c.relname
            `)).rows;
            const routineRows = async () => (await migrationDb.query<{
                proname: string;
                identity_arguments: string;
            }>(`
                SELECT p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)
                    AS identity_arguments
                FROM pg_catalog.pg_proc AS p
                JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.proname IN (
                      'analysis_canonical_payload_valid',
                      'record_analysis_canonical_job',
                      'append_analysis_canonical_event'
                  )
                ORDER BY p.proname
            `)).rows;
            const beforeRelations = await relationRows();
            const beforeRoutines = await routineRows();
            const migration = readFileSync(join(
                process.cwd(),
                'supabase/migrations/20260913130000_contract_supabase_operational_policy_v1.sql',
            ), 'utf8');

            await migrationDb.exec(migration);

            expect(await relationRows()).toEqual(beforeRelations);
            expect(await routineRows()).toEqual(beforeRoutines);
            const addedRoutines = await migrationDb.query<{ proname: string }>(`
                SELECT p.proname
                FROM pg_catalog.pg_proc AS p
                JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                  AND p.proname IN (
                      'analysis_execution_json_object_has_exact_keys_v1',
                      'analysis_execution_json_value_valid_v1',
                      'analysis_execution_payload_valid_v1',
                      'analysis_execution_payload_has_only_keys_v1',
                      'enqueue_analysis_execution_retry_v1',
                      'load_analysis_execution_family_v1'
                  )
                ORDER BY p.proname
            `);
            expect(addedRoutines.rows.map(row => row.proname)).toEqual([
                'analysis_execution_json_object_has_exact_keys_v1',
                'analysis_execution_json_value_valid_v1',
                'analysis_execution_payload_has_only_keys_v1',
                'analysis_execution_payload_valid_v1',
                'enqueue_analysis_execution_retry_v1',
                'load_analysis_execution_family_v1',
            ]);
            const legacyBehavior = await migrationDb.query<{
                validator: boolean;
                job: boolean;
                event: boolean;
            }>(`
                SELECT
                    public.analysis_canonical_payload_valid('{}'::jsonb) AS validator,
                    public.record_analysis_canonical_job('legacy') AS job,
                    public.append_analysis_canonical_event('legacy') AS event
            `);
            expect(legacyBehavior.rows[0]).toEqual({
                validator: true,
                job: true,
                event: true,
            });

            const validation = await migrationDb.query<{
                retry_valid: boolean;
                nested_valid: boolean;
                nested_invalid: boolean;
            }>(`
                SELECT
                    public.analysis_execution_payload_valid_v1(
                        '{"family":"events","retryKey":"fixture"}'::jsonb
                    ) AS retry_valid,
                    public.analysis_execution_payload_valid_v1(
                        '{"schemaVersion":1,"progress":{"state":"running","completed":1,"total":2},"result":{"rank":1,"score":0.5}}'::jsonb
                    ) AS nested_valid,
                    public.analysis_execution_payload_valid_v1(
                        '{"schemaVersion":1,"progress":{"state":"running","completed":1}}'::jsonb
                    ) AS nested_invalid
            `);
            expect(validation.rows[0]).toEqual({
                retry_valid: true,
                nested_valid: true,
                nested_invalid: false,
            });

            const requestId = '00000000-0000-4000-8000-000000000001';
            const firstRetry = await migrationDb.query<{ result: Record<string, unknown> }>(`
                SELECT public.enqueue_analysis_execution_retry_v1(
                    '${requestId}'::uuid, 'events'
                ) AS result
            `);
            const secondRetry = await migrationDb.query<{ result: Record<string, unknown> }>(`
                SELECT public.enqueue_analysis_execution_retry_v1(
                    '${requestId}'::uuid, 'events'
                ) AS result
            `);
            expect(firstRetry.rows[0]?.result).toMatchObject({
                kind: 'operational',
                state: 'canonical_retry',
            });
            expect(secondRetry.rows[0]?.result).toMatchObject({
                kind: 'operational',
                state: 'canonical_retry',
            });
            expect(secondRetry.rows[0]?.result.id).toBe(firstRetry.rows[0]?.result.id);
            const retryCount = await migrationDb.query<{ count: number }>(`
                SELECT pg_catalog.count(*)::integer AS count
                FROM public.analysis_events
                WHERE request_id = '${requestId}'::uuid
                  AND state = 'canonical_retry'
            `);
            expect(retryCount.rows[0]?.count).toBe(1);

            const loaded = await migrationDb.query<{ result: Record<string, unknown> }>(`
                SELECT public.load_analysis_execution_family_v1(
                    '${requestId}'::uuid, 'events'
                ) AS result
            `);
            expect(loaded.rows[0]?.result).toMatchObject({
                jobs: [],
                events: [expect.objectContaining({ state: 'canonical_retry' })],
            });
            await expect(migrationDb.query(`
                SELECT public.load_analysis_execution_family_v1(
                    '${requestId}'::uuid, 'artifacts'
                )
            `)).rejects.toThrow('ANALYSIS_CANONICAL_INVALID_READ_FAMILY');
        } finally {
            await migrationDb.close();
        }
    });

    it('paginates a dependency catalog larger than one bounded response', async () => {
        const dependencyQueries: string[] = [];
        const dependencyRow = (index: number) => ({
            object_name: `public.dependency_${index}`,
            dependent_object: `public.dependency_${index}`,
            referenced_object: 'public.users',
            dependency_type: 'n',
            class_id: 'pg_class',
            ref_class_id: 'pg_class',
            object_sub_id: 0,
            ref_object_sub_id: 0,
            resolved: true,
            allowed: true,
        });

        const evidence = await collectSupabase22CatalogEvidence({
            query: async sql => {
                if (sql.includes('FROM pg_catalog.pg_depend AS dependency')) {
                    dependencyQueries.push(sql);
                    const offset = Number(sql.match(/OFFSET (\d+)\s*$/i)?.[1] ?? -1);
                    if (offset === 0) {
                        return {
                            rows: Array.from({ length: SUPABASE_22_CATALOG_PAGE_SIZE + 1 }, (_, index) =>
                                dependencyRow(index)),
                            rowCount: SUPABASE_22_CATALOG_PAGE_SIZE + 1,
                        };
                    }
                    if (offset === SUPABASE_22_CATALOG_PAGE_SIZE) {
                        return { rows: [dependencyRow(9999)], rowCount: 1 };
                    }
                }
                return { rows: [], rowCount: 0 };
            },
        });

        expect(evidence.status).toBe('blocked');
        expect(dependencyQueries).toHaveLength(2);
        expect(dependencyQueries[0]).toMatch(/LIMIT \d+ OFFSET 0\s*$/i);
        expect(dependencyQueries[1]).toMatch(
            new RegExp(`LIMIT \\d+ OFFSET ${SUPABASE_22_CATALOG_PAGE_SIZE}\\s*$`, 'i'),
        );
    });
});
