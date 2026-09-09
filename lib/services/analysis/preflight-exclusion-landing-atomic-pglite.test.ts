import { readdirSync, readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

const migrationDirectory = new URL('../../../supabase/migrations/', import.meta.url);
const migration = (file: string): string => readFileSync(new URL(file, migrationDirectory), 'utf8');
const migrationName = readdirSync(migrationDirectory)
    .filter(name => name.endsWith('_atomic_preflight_exclusion_landing.sql'))[0];
const createLandingLeads = migration('20260719160000_add_landing_leads.sql');
const addInputContext = migration('20260725021500_add_landing_lead_input_context.sql');
const addJourneyContract = migration('20260909095950_add_landing_lead_journey_contract.sql');
const atomicExclusion = migrationName ? migration(migrationName) : '';
const databases: PGlite[] = [];

const ownerId = '123e4567-e89b-42d3-a456-426614174000';
const otherOwnerId = '223e4567-e89b-42d3-a456-426614174000';
const anonymousPreflightId = '323e4567-e89b-42d3-a456-426614174000';
const ownerPreflightId = '423e4567-e89b-42d3-a456-426614174000';
const targetJourneyId = '523e4567-e89b-42d3-a456-426614174000';
const staleAnonymousPreflightId = '623e4567-e89b-42d3-a456-426614174000';
const consumedPreflightId = '723e4567-e89b-42d3-a456-426614174000';
const blockedPreflightId = '823e4567-e89b-42d3-a456-426614174000';
const alternateJourneyId = '923e4567-e89b-42d3-a456-426614174000';
const future = '2099-01-01T00:00:00.000Z';
const past = '2000-01-01T00:00:00.000Z';

async function createDatabase(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
        CREATE SCHEMA extensions;
        CREATE SCHEMA auth;
        CREATE FUNCTION extensions.gen_random_uuid()
        RETURNS UUID LANGUAGE sql VOLATILE
        AS $$ SELECT pg_catalog.gen_random_uuid() $$;
        CREATE FUNCTION auth.uid()
        RETURNS UUID LANGUAGE sql STABLE
        AS $$ SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID $$;
        CREATE FUNCTION public.analysis_beta_has_access()
        RETURNS BOOLEAN LANGUAGE sql STABLE
        AS $$ SELECT TRUE $$;
        CREATE FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(UUID, VARCHAR, TEXT, TEXT)
        RETURNS BOOLEAN LANGUAGE sql
        AS $$ SELECT TRUE $$;
        CREATE FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
        RETURNS BOOLEAN LANGUAGE sql
        AS $$ SELECT TRUE $$;
        CREATE FUNCTION public.set_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
        RETURNS BOOLEAN LANGUAGE sql
        AS $$ SELECT TRUE $$;
        CREATE TABLE public.users(
            id UUID PRIMARY KEY,
            lifecycle TEXT NOT NULL DEFAULT 'active'
        );
        CREATE TABLE public.analysis_preflights(
            id UUID PRIMARY KEY,
            user_id UUID,
            claim_token_hash VARCHAR(64),
            claim_expires_at TIMESTAMPTZ,
            status TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            exclusion_decision TEXT NOT NULL DEFAULT 'pending',
            excluded_instagram_id TEXT,
            exclusion_decided_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
            target_instagram_id TEXT NOT NULL,
            beta_entry_provenance TEXT
        );
    `);
    await db.query(`INSERT INTO public.users(id) VALUES ($1), ($2)`, [ownerId, otherOwnerId]);
    await db.exec(createLandingLeads);
    await db.exec(addInputContext);
    await db.exec(addJourneyContract);
    await db.exec(atomicExclusion);
    return db;
}

async function setAuth(db: PGlite, userId: string | null): Promise<void> {
    await db.query(`SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, FALSE)`, [userId ?? '']);
}

async function callAtomic(
    db: PGlite,
    input: {
        preflightId: string;
        userId: string | null;
        claimTokenHash: string | null;
        decision: 'exclude' | 'skip';
        excludedInstagramId: string | null;
    },
) {
    return db.query<{ set_analysis_v2_preflight_exclusion_with_landing: boolean }>(
        `SELECT public.set_analysis_v2_preflight_exclusion_with_landing($1, $2, $3, $4, $5)`,
        [
            input.preflightId,
            input.userId,
            input.claimTokenHash,
            input.decision,
            input.excludedInstagramId,
        ],
    );
}

async function insertPreflight(
    db: PGlite,
    input: {
        id: string;
        userId: string | null;
        claimHash?: string | null;
        claimExpiresAt?: string | null;
        status?: string;
        expiresAt?: string;
        decision?: string;
        excludedInstagramId?: string | null;
        targetInstagramId?: string;
    },
): Promise<void> {
    await db.query(
        `INSERT INTO public.analysis_preflights(
            id, user_id, claim_token_hash, claim_expires_at,
            status, expires_at, exclusion_decision, excluded_instagram_id,
            target_instagram_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
            input.id,
            input.userId,
            input.claimHash ?? null,
            input.claimExpiresAt ?? null,
            input.status ?? 'ready',
            input.expiresAt ?? future,
            input.decision ?? 'pending',
            input.excludedInstagramId ?? null,
            input.targetInstagramId ?? 'target.user',
        ],
    );
}

async function bindTargetLead(
    db: PGlite,
    preflightId: string,
    instagramId = 'target.user',
    options: {
        journeyId?: string;
        anonymousPrincipalHash?: string | null;
        authUserId?: string | null;
        mappingStatus?: 'legacy_unlinked' | 'anonymous_device' | 'authenticated_user';
    } = {},
): Promise<void> {
    await db.query(
        `INSERT INTO public.landing_leads(
            journey_id, instagram_id, input_context,
            anonymous_principal_hash, auth_user_id, mapping_status
         ) VALUES ($1, $2, 'target', $3, $4, $5)`,
        [
            options.journeyId ?? targetJourneyId,
            instagramId,
            options.anonymousPrincipalHash ?? null,
            options.authUserId ?? null,
            options.mappingStatus ?? 'legacy_unlinked',
        ],
    );
    await db.query(
        `SELECT public.bind_landing_lead_journey_to_preflight($1, $2)`,
        [options.journeyId ?? targetJourneyId, preflightId],
    );
}

async function insertExcludedLead(
    db: PGlite,
    preflightId: string,
    input: {
        journeyId: string;
        instagramId: string;
        anonymousPrincipalHash: string | null;
        authUserId: string | null;
        mappingStatus: 'legacy_unlinked' | 'anonymous_device' | 'authenticated_user';
    },
): Promise<void> {
    await db.query(
        `INSERT INTO public.landing_leads(
            journey_id, instagram_id, input_context,
            anonymous_principal_hash, auth_user_id, source_preflight_id,
            mapping_status, mapping_source
         ) VALUES ($1, $2, 'excluded', $3, $4, $5, $6, 'preflight_v1')`,
        [
            input.journeyId,
            input.instagramId,
            input.anonymousPrincipalHash,
            input.authUserId,
            preflightId,
            input.mappingStatus,
        ],
    );
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.close()));
});

describe('atomic preflight exclusion landing RPC', () => {
    it('keeps the atomic owner-or-claim RPC browser-scoped and search-path hardened', () => {
        expect(migrationName).toBeTruthy();
        expect(atomicExclusion).toMatch(/SECURITY DEFINER[\s\S]*?SET search_path = ''/);
        expect(atomicExclusion).toMatch(/SET lock_timeout = '5s'/);
        expect(atomicExclusion).toMatch(/SET statement_timeout = '2min'/);
        expect(atomicExclusion).toContain("NOTIFY pgrst, 'reload schema';");
        expect(atomicExclusion).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_analysis_v2_preflight_exclusion_with_landing\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
        );
        expect(atomicExclusion).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_analysis_v2_preflight_exclusion_with_landing\([\s\S]*?\) TO anon, authenticated/,
        );
        expect(atomicExclusion).not.toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_analysis_v2_preflight_exclusion_with_landing\([\s\S]*?\) TO service_role/,
        );
        expect(atomicExclusion).toMatch(
            /CREATE OR REPLACE FUNCTION public\.set_anonymous_analysis_v2_preflight_exclusion[\s\S]*?set_analysis_v2_preflight_exclusion_with_landing/,
        );
        expect(atomicExclusion).toMatch(
            /CREATE OR REPLACE FUNCTION public\.set_authenticated_analysis_v2_preflight_exclusion[\s\S]*?set_analysis_v2_preflight_exclusion_with_landing/,
        );
        expect(atomicExclusion).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_anonymous_analysis_v2_preflight_exclusion\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
        );
        expect(atomicExclusion).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_anonymous_analysis_v2_preflight_exclusion\([\s\S]*?\) TO anon, authenticated/,
        );
        expect(atomicExclusion).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_authenticated_analysis_v2_preflight_exclusion\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
        );
        expect(atomicExclusion).toMatch(
            /GRANT EXECUTE ON FUNCTION public\.set_authenticated_analysis_v2_preflight_exclusion\([\s\S]*?\) TO authenticated/,
        );
        expect(atomicExclusion).toMatch(
            /REVOKE ALL ON FUNCTION public\.set_analysis_v2_preflight_exclusion\([\s\S]*?FROM PUBLIC, anon, authenticated, service_role/,
        );
    });

    it('enforces browser-only execution and RLS on the durable landing boundary', async () => {
        const db = await createDatabase();
        const privileges = await db.query<{
            anon_execute: boolean;
            authenticated_execute: boolean;
            service_execute: boolean;
            legacy_service_execute: boolean;
            anon_select: boolean;
            authenticated_select: boolean;
            service_select: boolean;
            row_security: boolean;
            force_row_security: boolean;
        }>(`
            SELECT
                pg_catalog.has_function_privilege(
                    'anon',
                    'public.set_analysis_v2_preflight_exclusion_with_landing(uuid,uuid,character varying,text,text)'::regprocedure,
                    'EXECUTE'
                ) AS anon_execute,
                pg_catalog.has_function_privilege(
                    'authenticated',
                    'public.set_analysis_v2_preflight_exclusion_with_landing(uuid,uuid,character varying,text,text)'::regprocedure,
                    'EXECUTE'
                ) AS authenticated_execute,
                pg_catalog.has_function_privilege(
                    'service_role',
                    'public.set_analysis_v2_preflight_exclusion_with_landing(uuid,uuid,character varying,text,text)'::regprocedure,
                    'EXECUTE'
                ) AS service_execute,
                pg_catalog.has_function_privilege(
                    'service_role',
                    'public.set_analysis_v2_preflight_exclusion(uuid,uuid,text,text)'::regprocedure,
                    'EXECUTE'
                ) AS legacy_service_execute,
                pg_catalog.has_table_privilege('anon', 'public.landing_leads', 'SELECT') AS anon_select,
                pg_catalog.has_table_privilege('authenticated', 'public.landing_leads', 'SELECT') AS authenticated_select,
                pg_catalog.has_table_privilege('service_role', 'public.landing_leads', 'SELECT') AS service_select,
                relation.relrowsecurity AS row_security,
                relation.relforcerowsecurity AS force_row_security
            FROM pg_catalog.pg_class AS relation
            WHERE relation.oid = 'public.landing_leads'::pg_catalog.regclass
        `);
        expect(privileges.rows).toEqual([{
            anon_execute: true,
            authenticated_execute: true,
            service_execute: false,
            legacy_service_execute: false,
            anon_select: false,
            authenticated_select: false,
            service_select: false,
            row_security: true,
            force_row_security: true,
        }]);
    });

    it('requires the authenticated owner and never inserts for a foreign owner', async () => {
        const db = await createDatabase();
        await insertPreflight(db, { id: ownerPreflightId, userId: ownerId });
        await bindTargetLead(db, ownerPreflightId);
        await setAuth(db, otherOwnerId);

        await expect(callAtomic(db, {
            preflightId: ownerPreflightId,
            userId: otherOwnerId,
            claimTokenHash: null,
            decision: 'exclude',
            excludedInstagramId: 'excluded.user',
        })).rejects.toThrow('ANALYSIS_V2_PREFLIGHT_NOT_FOUND');

        const rows = await db.query<{ exclusion_decision: string; count: number }>(
            `SELECT preflight.exclusion_decision,
                    (SELECT COUNT(*)::INTEGER FROM public.landing_leads WHERE input_context = 'excluded') AS count
             FROM public.analysis_preflights AS preflight WHERE preflight.id = $1`,
            [ownerPreflightId],
        );
        expect(rows.rows).toEqual([{ exclusion_decision: 'pending', count: 0 }]);
    });

    it('accepts only a live anonymous claim token and rejects stale or foreign tokens', async () => {
        const db = await createDatabase();
        const claimHash = 'a'.repeat(64);
        await insertPreflight(db, {
            id: anonymousPreflightId,
            userId: null,
            claimHash,
            claimExpiresAt: future,
        });
        await bindTargetLead(db, anonymousPreflightId);
        await setAuth(db, null);

        await expect(callAtomic(db, {
            preflightId: anonymousPreflightId,
            userId: null,
            claimTokenHash: 'b'.repeat(64),
            decision: 'exclude',
            excludedInstagramId: 'excluded.user',
        })).rejects.toThrow('ANONYMOUS_PREFLIGHT_CLAIM_INVALID');

        await insertPreflight(db, {
            id: staleAnonymousPreflightId,
            userId: null,
            claimHash: 'c'.repeat(64),
            claimExpiresAt: past,
        });
        await bindTargetLead(db, staleAnonymousPreflightId);
        await expect(callAtomic(db, {
            preflightId: staleAnonymousPreflightId,
            userId: null,
            claimTokenHash: 'c'.repeat(64),
            decision: 'exclude',
            excludedInstagramId: 'stale.user',
        })).rejects.toThrow('ANONYMOUS_PREFLIGHT_CLAIM_INVALID');

        await expect(callAtomic(db, {
            preflightId: anonymousPreflightId,
            userId: null,
            claimTokenHash: claimHash,
            decision: 'exclude',
            excludedInstagramId: 'excluded.user',
        })).resolves.toMatchObject({ rows: [{ set_analysis_v2_preflight_exclusion_with_landing: true }] });

        const count = await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count FROM public.landing_leads WHERE input_context = 'excluded'`,
        );
        expect(count.rows[0]?.count).toBe(1);
    });

    it('rejects invalid lifecycle, expiry, immutable, and target decisions before lead insertion', async () => {
        const db = await createDatabase();
        const cases = [
            { id: '623e4567-e89b-42d3-a456-426614174000', status: 'blocked', error: 'ANALYSIS_V2_PREFLIGHT_NOT_READY' },
            { id: '723e4567-e89b-42d3-a456-426614174000', expiresAt: past, error: 'ANALYSIS_V2_PREFLIGHT_EXPIRED' },
            { id: '823e4567-e89b-42d3-a456-426614174000', decision: 'skip', error: 'PREFLIGHT_IMMUTABLE' },
            { id: '923e4567-e89b-42d3-a456-426614174000', targetInstagramId: 'excluded.user', error: 'ANALYSIS_V2_INVALID_EXCLUSION' },
        ] as const;

        for (const item of cases) {
            await insertPreflight(db, {
                id: item.id,
                userId: ownerId,
                status: 'status' in item ? item.status : undefined,
                expiresAt: 'expiresAt' in item ? item.expiresAt : undefined,
                decision: 'decision' in item ? item.decision : undefined,
                targetInstagramId: 'targetInstagramId' in item ? item.targetInstagramId : undefined,
            });
            await bindTargetLead(db, item.id);
            await setAuth(db, ownerId);
            await expect(callAtomic(db, {
                preflightId: item.id,
                userId: ownerId,
                claimTokenHash: null,
                decision: 'exclude',
                excludedInstagramId: 'excluded.user',
            })).rejects.toThrow(item.error);
        }

        const rows = await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count FROM public.landing_leads WHERE input_context = 'excluded'`,
        );
        expect(rows.rows[0]?.count).toBe(0);
    });

    it('validates expiry and lifecycle before replaying or self-healing an identical exclusion', async () => {
        const db = await createDatabase();
        const replayCases = [
            {
                id: ownerPreflightId,
                status: 'ready',
                expiresAt: past,
                error: 'ANALYSIS_V2_PREFLIGHT_EXPIRED',
            },
            {
                id: consumedPreflightId,
                status: 'consumed',
                expiresAt: future,
                error: 'ANALYSIS_V2_PREFLIGHT_CONSUMED',
            },
            {
                id: blockedPreflightId,
                status: 'blocked',
                expiresAt: future,
                error: 'ANALYSIS_V2_PREFLIGHT_NOT_READY',
            },
        ] as const;

        await setAuth(db, ownerId);
        for (const replayCase of replayCases) {
            await insertPreflight(db, {
                id: replayCase.id,
                userId: ownerId,
                status: replayCase.status,
                expiresAt: replayCase.expiresAt,
                decision: 'exclude',
                excludedInstagramId: 'excluded.user',
            });
            await bindTargetLead(db, replayCase.id);

            await expect(callAtomic(db, {
                preflightId: replayCase.id,
                userId: ownerId,
                claimTokenHash: null,
                decision: 'exclude',
                excludedInstagramId: 'EXCLUDED.USER',
            })).rejects.toThrow(replayCase.error);
        }

        const rows = await db.query<{ exclusion_decision: string; count: number }>(
            `SELECT preflight.exclusion_decision,
                    (SELECT COUNT(*)::INTEGER FROM public.landing_leads WHERE input_context = 'excluded') AS count
             FROM public.analysis_preflights AS preflight
             WHERE preflight.id = $1
             ORDER BY preflight.id`,
            [ownerPreflightId],
        );
        expect(rows.rows).toEqual([{ exclusion_decision: 'exclude', count: 0 }]);
        const excludedCount = await db.query<{ count: number }>(
            `SELECT COUNT(*)::INTEGER AS count FROM public.landing_leads WHERE input_context = 'excluded'`,
        );
        expect(excludedCount.rows[0]?.count).toBe(0);
    });

    it('serializes concurrent identical exclusions into one insert and one replay', async () => {
        const db = await createDatabase();
        await insertPreflight(db, { id: ownerPreflightId, userId: ownerId });
        await bindTargetLead(db, ownerPreflightId);
        await setAuth(db, ownerId);

        const attempts = await Promise.all([
            callAtomic(db, {
                preflightId: ownerPreflightId,
                userId: ownerId,
                claimTokenHash: null,
                decision: 'exclude',
                excludedInstagramId: 'excluded.user',
            }),
            callAtomic(db, {
                preflightId: ownerPreflightId,
                userId: ownerId,
                claimTokenHash: null,
                decision: 'exclude',
                excludedInstagramId: 'EXCLUDED.USER',
            }),
        ]);
        expect(attempts.map(attempt => attempt.rows[0]?.set_analysis_v2_preflight_exclusion_with_landing).sort())
            .toEqual([false, true]);

        const rows = await db.query<{ exclusion_decision: string; count: number }>(
            `SELECT preflight.exclusion_decision,
                    (SELECT COUNT(*)::INTEGER FROM public.landing_leads WHERE input_context = 'excluded') AS count
             FROM public.analysis_preflights AS preflight WHERE preflight.id = $1`,
            [ownerPreflightId],
        );
        expect(rows.rows).toEqual([{ exclusion_decision: 'exclude', count: 1 }]);
    });

    it('serializes conflicting exclusion decisions and commits only the winner', async () => {
        const db = await createDatabase();
        await insertPreflight(db, { id: ownerPreflightId, userId: ownerId });
        await bindTargetLead(db, ownerPreflightId);
        await setAuth(db, ownerId);

        const attempts = await Promise.allSettled([
            callAtomic(db, {
                preflightId: ownerPreflightId,
                userId: ownerId,
                claimTokenHash: null,
                decision: 'exclude',
                excludedInstagramId: 'excluded.user',
            }),
            callAtomic(db, {
                preflightId: ownerPreflightId,
                userId: ownerId,
                claimTokenHash: null,
                decision: 'skip',
                excludedInstagramId: null,
            }),
        ]);
        expect(attempts.filter(attempt => attempt.status === 'fulfilled')).toHaveLength(1);
        const rejected = attempts.find(attempt => attempt.status === 'rejected');
        expect(rejected?.status === 'rejected' && String(rejected.reason)).toContain('PREFLIGHT_IMMUTABLE');

        const rows = await db.query<{ exclusion_decision: string; excluded_instagram_id: string | null; count: number }>(
            `SELECT preflight.exclusion_decision, preflight.excluded_instagram_id,
                    (SELECT COUNT(*)::INTEGER FROM public.landing_leads WHERE input_context = 'excluded') AS count
             FROM public.analysis_preflights AS preflight WHERE preflight.id = $1`,
            [ownerPreflightId],
        );
        expect(rows.rows[0]?.exclusion_decision).toMatch(/^(exclude|skip)$/);
        if (rows.rows[0]?.exclusion_decision === 'exclude') {
            expect(rows.rows[0]?.excluded_instagram_id).toBe('excluded.user');
            expect(rows.rows[0]?.count).toBe(1);
        } else {
            expect(rows.rows[0]?.excluded_instagram_id).toBeNull();
            expect(rows.rows[0]?.count).toBe(0);
        }
    });

    it.each([
        ['instagram id', { instagramId: 'different.user' }],
        ['journey', { journeyId: alternateJourneyId }],
        ['mapping role', { mappingStatus: 'anonymous_device' as const }],
        ['anonymous identity', { anonymousPrincipalHash: 'c'.repeat(64) }],
        ['authenticated identity', { authUserId: otherOwnerId }],
    ])('rolls back the durable decision when a legacy excluded row has a conflicting %s', async (_label, mismatch) => {
        const db = await createDatabase();
        const expectedTarget = {
            journeyId: targetJourneyId,
            anonymousPrincipalHash: 'b'.repeat(64),
            authUserId: ownerId,
            mappingStatus: 'authenticated_user' as const,
        };
        await insertPreflight(db, { id: ownerPreflightId, userId: ownerId });
        await bindTargetLead(db, ownerPreflightId, 'target.user', expectedTarget);
        await insertExcludedLead(db, ownerPreflightId, {
            journeyId: 'journeyId' in mismatch ? mismatch.journeyId : expectedTarget.journeyId,
            instagramId: 'instagramId' in mismatch ? mismatch.instagramId : 'excluded.user',
            anonymousPrincipalHash: 'anonymousPrincipalHash' in mismatch
                ? mismatch.anonymousPrincipalHash
                : expectedTarget.anonymousPrincipalHash,
            authUserId: 'authUserId' in mismatch ? mismatch.authUserId : expectedTarget.authUserId,
            mappingStatus: 'mappingStatus' in mismatch ? mismatch.mappingStatus : expectedTarget.mappingStatus,
        });
        await setAuth(db, ownerId);

        await expect(callAtomic(db, {
            preflightId: ownerPreflightId,
            userId: ownerId,
            claimTokenHash: null,
            decision: 'exclude',
            excludedInstagramId: 'excluded.user',
        })).rejects.toThrow('LANDING_LEAD_TARGET_MISMATCH');

        const rows = await db.query<{
            exclusion_decision: string;
            instagram_id: string;
            journey_id: string;
            mapping_status: string;
            anonymous_principal_hash: string | null;
            auth_user_id: string | null;
        }>(
            `SELECT preflight.exclusion_decision,
                    lead.instagram_id, lead.journey_id, lead.mapping_status,
                    lead.anonymous_principal_hash, lead.auth_user_id
             FROM public.analysis_preflights AS preflight
             INNER JOIN public.landing_leads AS lead
                 ON lead.source_preflight_id = preflight.id
                AND lead.input_context = 'excluded'
             WHERE preflight.id = $1`,
            [ownerPreflightId],
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]?.exclusion_decision).toBe('pending');
        expect(rows.rows[0]).toMatchObject({
            instagram_id: 'instagramId' in mismatch ? mismatch.instagramId : 'excluded.user',
            journey_id: 'journeyId' in mismatch ? mismatch.journeyId : expectedTarget.journeyId,
            mapping_status: 'mappingStatus' in mismatch ? mismatch.mappingStatus : expectedTarget.mappingStatus,
            anonymous_principal_hash: 'anonymousPrincipalHash' in mismatch
                ? mismatch.anonymousPrincipalHash
                : expectedTarget.anonymousPrincipalHash,
            auth_user_id: 'authUserId' in mismatch ? mismatch.authUserId : expectedTarget.authUserId,
        });
    });

    it('replays an identical exclusion once and rolls back the decision when its target lead is absent', async () => {
        const db = await createDatabase();
        await insertPreflight(db, { id: ownerPreflightId, userId: ownerId });
        await setAuth(db, ownerId);

        await expect(callAtomic(db, {
            preflightId: ownerPreflightId,
            userId: ownerId,
            claimTokenHash: null,
            decision: 'exclude',
            excludedInstagramId: 'excluded.user',
        })).rejects.toThrow('LANDING_LEAD_TARGET_MISSING');
        const rolledBack = await db.query<{ exclusion_decision: string }>(
            `SELECT exclusion_decision FROM public.analysis_preflights WHERE id = $1`,
            [ownerPreflightId],
        );
        expect(rolledBack.rows).toEqual([{ exclusion_decision: 'pending' }]);

        await bindTargetLead(db, ownerPreflightId);
        await expect(callAtomic(db, {
            preflightId: ownerPreflightId,
            userId: ownerId,
            claimTokenHash: null,
            decision: 'exclude',
            excludedInstagramId: 'excluded.user',
        })).resolves.toMatchObject({ rows: [{ set_analysis_v2_preflight_exclusion_with_landing: true }] });
        await expect(callAtomic(db, {
            preflightId: ownerPreflightId,
            userId: ownerId,
            claimTokenHash: null,
            decision: 'exclude',
            excludedInstagramId: 'EXCLUDED.USER',
        })).resolves.toMatchObject({ rows: [{ set_analysis_v2_preflight_exclusion_with_landing: false }] });

        const rows = await db.query<{ exclusion_decision: string; excluded_instagram_id: string; count: number }>(
            `SELECT preflight.exclusion_decision, preflight.excluded_instagram_id,
                    (SELECT COUNT(*)::INTEGER FROM public.landing_leads WHERE input_context = 'excluded') AS count
             FROM public.analysis_preflights AS preflight WHERE preflight.id = $1`,
            [ownerPreflightId],
        );
        expect(rows.rows).toEqual([{
            exclusion_decision: 'exclude',
            excluded_instagram_id: 'excluded.user',
            count: 1,
        }]);
    });
});
