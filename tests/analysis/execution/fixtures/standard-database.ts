import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

import { safeStandardBudgetRpcFields } from './standard-shared-budget-evidence';

const migrationVersions = [
    '20261120160000',
    '20261120161000',
    '20261121130000',
    '20261122020200',
    '20261122020300',
    '20261122090000',
    '20261122110000',
    '20261122120000',
    '20261122130000',
    '20261122140000',
    '20261122150000',
    '20261123160000',
    '20261123170000',
    '20261123171000',
    '20261123172000',
    '20261123210000',
    '20261123211000',
    '20261124035000',
    '20261124163000',
    '20261124163001',
    '20261124163002',
    '20261124191000',
    '20261126031000',
    '20261126032000',
    '20261126100000',
    '20261126100001',
    '20261126100002',
    '20261126100003',
    '20261126100004',
    '20261127090000',
    '20261127091000',
    '20261127100000',
    '20261127101000',
    '20261127102000',
];

export interface StandardConnection {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, values?: unknown[],
    ): Promise<{ rows: Row[] }>;
    exec(sql: string): Promise<unknown>;
}

export interface StandardDatabase extends StandardConnection {
    transaction<T>(operation: (tx: StandardConnection) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}

export async function createStandardDatabase() {
    const db = await PGlite.create({ extensions: { pgcrypto } });
    try {
        await installStandardFixtureSchema(db);
        return db;
    } catch (error) {
        await db.close();
        throw error;
    }
}

// The baseline changes session settings. Keep every script on the same connection.
export async function installStandardFixtureSchema(
    db: Pick<StandardConnection, 'exec'>,
    { providerRecoveryParentFence = true, production = false }: { providerRecoveryParentFence?: boolean; production?: boolean } = {},
) {
    const devSql = (name: string) => readFileSync('supabase/dev-ui/' + name + '.sql', 'utf8');
    await db.exec(`
        CREATE ROLE anon;
        CREATE ROLE authenticated;
        CREATE ROLE service_role BYPASSRLS;
        CREATE SCHEMA auth;
        CREATE SCHEMA extensions;
        CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
        CREATE FUNCTION extensions.uuid_generate_v4() RETURNS uuid LANGUAGE SQL VOLATILE AS $$ SELECT gen_random_uuid() $$;
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE SQL STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL STABLE AS $$ SELECT current_setting('role') $$;
        CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_app_meta_data jsonb, raw_user_meta_data jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), email_confirmed_at timestamptz, deleted_at timestamptz);
        CREATE TABLE auth.identities(user_id uuid, provider text, identity_data jsonb);
        GRANT USAGE ON SCHEMA auth, extensions TO anon, authenticated, service_role;
        CREATE PUBLICATION supabase_realtime;
    `);
    // GraphQL is a managed extension. The application under test uses PostgREST.
    await db.exec(
        devSql('production-baseline').replace(/^CREATE EXTENSION IF NOT EXISTS pg_graphql .*;$/m, ''),
    );
    await db.exec('SET search_path TO public, extensions; SET row_security TO on');
    for (const name of production ? [] : [
        'control-plane',
        'live-budget',
        'live-owner-start',
        'live-owner-start-standard',
        'live-fresh-admission-secondary',
        'live-standard-preflight-replay',
        'live-standard-fresh-admission',
        'live-standard-fresh-profile-checkpoint',
        'live-standard-dispatch-recovery',
        'live-standard-archive-replay',
        'live-standard-archive-blite',
        'live-standard-archive-evidence',
        'live-standard-replay-scope-note',
    ])
        await db.exec(devSql(name));
    await db.exec('INSERT INTO public.analysis_v2_gemini_leases(slot) SELECT generate_series(1,8)');
    const files = readdirSync('supabase/migrations');
    for (const [version, table] of [
        ['20260724220000', 'analysis_v2_apify_secret_ref_prune_guard'],
        ['20260802010000', 'analysis_apify_credit_snapshots'],
        ['20260831100000', 'analysis_provider_admission_budgets'],
        ['20260904120000', 'analysis_provider_admission_budgets'],
        ['20260904120000', 'analysis_apify_credit_snapshots'],
    ]) {
        const migration = readFileSync(
            'supabase/migrations/' + files.find((name) => name.startsWith(version)),
            'utf8',
        );
        const start = migration.indexOf('INSERT INTO public.' + table);
        if (start < 0) throw new Error('Missing baseline configuration for ' + table);
        await db.exec(migration.slice(start, migration.indexOf(';', start) + 1));
    }
    await db.exec(`UPDATE analysis_apify_credit_snapshots SET health_state='healthy', monthly_limit_usd=10,
        monthly_usage_usd=1, billing_cycle_start_at=now()-interval '1 day', billing_cycle_end_at=now()+interval '1 day',
        observed_at=now() WHERE credential_slot='primary'`);
    for (const version of migrationVersions) {
        if (version === '20261126032000' && !providerRecoveryParentFence) continue;
        const matches = files.filter((name) => name.startsWith(version + '_'));
        if (matches.length !== 1) throw new Error('Expected one migration for ' + version);
        await db.exec(readFileSync('supabase/migrations/' + matches[0], 'utf8'));
    }
    for (const name of production ? [] : [
        'live-standard-provider-recovery',
        'live-standard-feature-concurrency',
        'live-standard-profile-media-ready',
        'live-standard-profile-shared-reader',
    ]) {
        await db.exec(devSql(name));
    }
}

function identifier(value: string) {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) throw new Error('Unsupported fixture SQL identifier');
    return '"' + value + '"';
}

// A local PostgREST transport. Use the catalog for named argument types and set-returning
// functions so callers execute the same SQL and receive the same JSON shape as in Dev.
export function localDatabaseClient(db: StandardDatabase, subject?: string | null) {
    function scoped<T>(operation: (tx: StandardConnection) => Promise<T>) {
        return db.transaction(async (tx) => {
            const role = subject === undefined ? 'service_role' : subject ? 'authenticated' : 'anon';
            await tx.exec('SET LOCAL ROLE ' + role);
            if (subject) await tx.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [subject]);
            return operation(tx);
        });
    }
    async function rpc(name: string, args: Record<string, unknown> = {}) {
        const keys = Object.keys(args);
        const { rows } = await db.query<{ names: string[]; types: string[]; returns_set: boolean }>(
            `
            SELECT p.proargnames[1:p.pronargs] AS names, ARRAY(
                SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t
            ) AS types, p.proretset AS returns_set
            FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = $1
              AND p.pronargs - p.pronargdefaults <= $2
              AND $3::text[] <@ coalesce(p.proargnames[1:p.pronargs], '{}'::text[])
            ORDER BY p.pronargs LIMIT 1
        `,
            [name, keys.length, keys],
        );
        const signature = rows[0];
        if (!signature) throw new Error('Missing fixture RPC ' + name);
        const types = keys.map((k) => signature.types[signature.names.indexOf(k)]);
        const bindings = keys.map((k, i) => identifier(k) + ' => $' + (i + 1) + '::' + types[i]);
        const call = 'public.' + identifier(name) + '(' + bindings.join(', ') + ')';
        const sql = signature.returns_set
            ? 'SELECT coalesce(jsonb_agg(to_jsonb(r)), ' +
              "'[]'::jsonb" +
              ') AS value FROM (SELECT * FROM ' +
              call +
              ') r'
            : 'SELECT to_jsonb(' + call + ') AS value';
        const values = keys.map((k, i) =>
            args[k] == null ? null : types[i]?.startsWith('json') ? JSON.stringify(args[k]) : args[k],
        );
        try {
            const value = await scoped(
                async (tx) => (await tx.query<{ value: unknown }>(sql, values)).rows[0]?.value,
            );
            return { data: value, error: null };
        } catch (cause) {
            const error = cause as { code: string; message: string; constraint?: string; hint?: string; detail?: string };
            const constraint = error.code === '23514' && /^[a-z][a-z0-9_]{0,62}$/.test(error.constraint ?? '')
                ? error.constraint : undefined;
            return { data: null, error: { code: error.code, message: error.message, constraint, ...safeStandardBudgetRpcFields(name, error) } };
        }
    }
    function from(table: string) {
        const filters: string[] = [];
        const args: unknown[] = [];
        let columns = '*';
        return {
            async insert(row: Record<string, unknown>) {
                const keys = Object.keys(row);
                await scoped(async (tx) => {
                    await tx.query(
                        'INSERT INTO public.' +
                            identifier(table) +
                            ' (' +
                            keys.map(identifier).join(',') +
                            ') VALUES (' +
                            keys.map((_, i) => '$' + (i + 1)).join(',') +
                            ')',
                        Object.values(row),
                    );
                });
                return { error: null };
            },
            select(fields: string) {
                columns = fields
                    .split(',')
                    .map((s) => identifier(s.trim()))
                    .join(',');
                return this;
            },
            eq(field: string, value: unknown) {
                filters.push(identifier(field) + ' = $' + args.push(value));
                return this;
            },
            async maybeSingle() {
                const { rows } = await scoped(async (tx) => {
                    return tx.query<{ value: unknown }>(
                        'SELECT to_jsonb(r) AS value FROM (SELECT ' +
                            columns +
                            ' FROM public.' +
                            identifier(table) +
                            ' WHERE ' +
                            filters.join(' AND ') +
                            ') r',
                        args,
                    );
                });
                if (rows.length > 1) throw new Error('Ambiguous fixture row in ' + table);
                return { data: rows[0]?.value ?? null, error: null };
            },
        };
    }
    return { rpc, from };
}
