import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    SUPABASE_22_CATALOG_ROW_LIMIT,
    adaptSupabase22CatalogRows,
    collectSupabase22CatalogEvidence,
    evaluateSupabase22Catalog,
    SUPABASE_22_CANONICAL_TABLES,
    SUPABASE_22_CANONICAL_PRIVATE_ROUTINE_NAMES,
    SUPABASE_22_CANONICAL_ROUTINE_NAMES,
    SUPABASE_22_CANONICAL_SERVICE_RPC_NAMES,
    SUPABASE_22_CATALOG_QUERY,
    SUPABASE_22_CATALOG_QUERIES,
} from './supabase-22-evidence';

const CANONICAL_TABLES = [
    'account_lifecycle', 'analysis_artifacts', 'analysis_audit_bundles',
    'analysis_cache', 'analysis_costs', 'analysis_events', 'analysis_jobs',
    'analysis_preflights', 'analysis_provider_runs', 'analysis_requests',
    'analysis_results', 'earlybird_orders', 'earlybird_waitlist',
    'fulfillment_jobs', 'landing_leads', 'maintenance_jobs',
    'notification_outbox', 'payment_events', 'result_feedback',
    'system_configuration', 'system_leases', 'users',
];

describe('Supabase 22 catalog collector with a disposable catalog', () => {
    let db: PGlite;

    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE TABLE public.users (id integer);
            CREATE TABLE public.analysis_requests (id integer);
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
            expect(sql.toUpperCase()).not.toMatch(/\b(DROP|TRUNCATE|ALTER|INSERT|UPDATE|DELETE)\b/);
            if (sql.trim() === SUPABASE_22_CATALOG_QUERY.trim()) {
                const result = await db.query<{ relname: string }>(sql);
                expect(result.rows.map(row => row.relname)).toEqual(['analysis_requests', 'users']);
            }
            const queryName = Object.entries(SUPABASE_22_CATALOG_QUERIES)
                .find(([, candidate]) => candidate === sql)?.[0];
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
        expect(evidence.canonicalTables).toEqual(['analysis_requests', 'users']);
        expect(evidence.unexpectedTables).toEqual([]);
        expect(evidence.missingTables).toEqual(CANONICAL_TABLES.filter(
            table => !['analysis_requests', 'users'].includes(table),
        ));
        expect(evidence.dependencyClean).toBe(false);
        expect(evidence.rlsClean).toBe(true);
    });

    it('fails closed when a public table is RLS-enabled but not FORCE RLS', () => {
        const snapshot = {
            tables: SUPABASE_22_CANONICAL_TABLES.map(name => ({
                name,
                relkind: 'r' as const,
                rlsEnabled: true,
                forceRls: name === 'users' ? false : true,
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
            tables: SUPABASE_22_CANONICAL_TABLES.map(name => ({
                name,
                relkind: 'r' as const,
                rlsEnabled: true,
                forceRls: true,
            })),
            acls: [
                ...SUPABASE_22_CANONICAL_TABLES.map(objectName => ({
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
            tables: SUPABASE_22_CANONICAL_TABLES.map(name => ({
                name,
                relkind: 'r' as const,
                rlsEnabled: true,
                forceRls: true,
            })),
            acls: [
                ...SUPABASE_22_CANONICAL_TABLES.map(objectName => ({
                    objectName,
                    resolved: true,
                    serviceRoleOnly: true,
                })),
                {
                    objectName: SUPABASE_22_CANONICAL_ROUTINE_NAMES[0],
                    resolved: true,
                    serviceRoleOnly: false,
                },
            ],
            dependencies: [{ objectName: 'public.analysis_requests', resolved: true, allowed: true }],
            foreignKeys: [{ objectName: 'fk-1', resolved: true, allowed: true }],
            securityDefinerFunctions: [{
                name: SUPABASE_22_CANONICAL_ROUTINE_NAMES[0],
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
            identityArguments: '',
            securityDefiner: true,
            searchPathEmpty: true,
            executePublic: false,
            executeAnon: false,
            executeAuthenticated: false,
            executeServiceRole: false,
        });
        const serviceRpc = (name: string) => ({
            name,
            identityArguments: '',
            securityDefiner: true,
            searchPathEmpty: true,
            executePublic: false,
            executeAnon: false,
            executeAuthenticated: false,
            executeServiceRole: true,
        });
        const snapshot = {
            tables: SUPABASE_22_CANONICAL_TABLES.map(name => ({
                name,
                relkind: 'r' as const,
                rlsEnabled: true,
                forceRls: true,
            })),
            acls: [
                ...SUPABASE_22_CANONICAL_TABLES.map(relationAcl),
                ...SUPABASE_22_CANONICAL_PRIVATE_ROUTINE_NAMES.map(name => ({
                    ...relationAcl(name),
                    objectKind: 'routine' as const,
                })),
                ...SUPABASE_22_CANONICAL_SERVICE_RPC_NAMES.map(name => ({
                    ...relationAcl(name),
                    objectKind: 'routine' as const,
                    serviceRoleAllowed: true,
                })),
            ],
            dependencies: [
                ...SUPABASE_22_CANONICAL_TABLES,
                ...SUPABASE_22_CANONICAL_ROUTINE_NAMES,
            ].map(objectName => ({
                objectName,
                resolved: true,
                allowed: true,
                details: [],
            })),
            foreignKeys: [],
            securityDefinerFunctions: [
                ...SUPABASE_22_CANONICAL_PRIVATE_ROUTINE_NAMES.map(privateRoutine),
                ...SUPABASE_22_CANONICAL_SERVICE_RPC_NAMES.map(serviceRpc),
            ],
            migrationHistory: [{ version: '20260905000000', pending: false }],
            legacyWriters: SUPABASE_22_CANONICAL_TABLES.map(objectName => ({
                objectName,
                active: false,
            })),
            views: [],
            sequences: [],
            partitions: [],
            publications: [],
            triggers: [],
            policies: SUPABASE_22_CANONICAL_TABLES.map(tableName => ({
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
        expect(evidence.aclClean).toBe(true);
        expect(evidence.routinesClean).toBe(true);

        const relationGrant = evaluateSupabase22Catalog({
            ...snapshot,
            acls: snapshot.acls.map(acl => acl.objectName === 'users'
                ? { ...acl, serviceRoleAllowed: true }
                : acl),
        } as never);
        expect(relationGrant.canonicalRelationsAclClean).toBe(false);
        expect(relationGrant.aclClean).toBe(false);

        const privateGrant = evaluateSupabase22Catalog({
            ...snapshot,
            acls: snapshot.acls.map(acl => acl.objectName === SUPABASE_22_CANONICAL_PRIVATE_ROUTINE_NAMES[0]
                ? { ...acl, serviceRoleAllowed: true }
                : acl),
            securityDefinerFunctions: snapshot.securityDefinerFunctions.map(routine => routine.name
                === SUPABASE_22_CANONICAL_PRIVATE_ROUTINE_NAMES[0]
                ? { ...routine, executeServiceRole: true }
                : routine),
        } as never);
        expect(privateGrant.privateRoutinesAclClean).toBe(false);
        expect(privateGrant.aclClean).toBe(false);

        const serviceRpcRevoked = evaluateSupabase22Catalog({
            ...snapshot,
            acls: snapshot.acls.map(acl => acl.objectName === SUPABASE_22_CANONICAL_SERVICE_RPC_NAMES[0]
                ? { ...acl, serviceRoleAllowed: false }
                : acl),
            securityDefinerFunctions: snapshot.securityDefinerFunctions.map(routine => routine.name
                === SUPABASE_22_CANONICAL_SERVICE_RPC_NAMES[0]
                ? { ...routine, executeServiceRole: false }
                : routine),
        } as never);
        expect(serviceRpcRevoked.serviceRpcsAclClean).toBe(false);
        expect(serviceRpcRevoked.aclClean).toBe(false);

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
        expect(extraRoutine.privateRoutinesAclClean).toBe(false);
        expect(extraRoutine.serviceRpcsAclClean).toBe(false);
        expect(extraRoutine.aclClean).toBe(false);
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

    it('uses an observed activity boolean for legacy-writer rows instead of a null placeholder', () => {
        const query = SUPABASE_22_CATALOG_QUERIES.legacyWriters;
        expect(query).toContain('pg_catalog.pg_stat_activity');
        expect(query).toContain('EXISTS');
        expect(query).not.toContain('NULL::boolean');
    });
});
