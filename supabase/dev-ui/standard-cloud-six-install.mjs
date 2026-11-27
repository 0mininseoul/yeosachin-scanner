import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function body(name, expectedHash) {
    const source = readFileSync(new URL(name + '.sql', import.meta.url), 'utf8');
    if (expectedHash && createHash('sha256').update(source).digest('hex') !== expectedHash)
        throw new Error('Dev allocator source changed');
    const begin = source.match(/^BEGIN;$/gm);
    const end = source.match(/^COMMIT;$/gm);
    if (begin?.length !== 1 || end?.length !== 1 || !source.trimEnd().endsWith('COMMIT;'))
        throw new Error('Dev SQL transaction boundary changed');
    return source.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
}

// Emit one transaction. There is no instant at which a live grant can use the extra slots.
// The existing eight-slot public entry points remain available throughout and after the install.
export function standardCloudSixInstallSql() {
    return ['BEGIN;', body('standard-cloud-six'), body('standard-cloud-six-orders'),
        `CREATE TEMP TABLE dev_six_original_provider ON COMMIT DROP AS SELECT pg_get_functiondef(
            'public.acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)'::regprocedure) AS definition;
        CREATE TEMP TABLE dev_six_original_limits ON COMMIT DROP AS SELECT budget_key,max_active,rate_limit_per_minute
            FROM public.analysis_provider_admission_budgets WHERE workload_role='paid' AND logical_provider='gemini';
        CREATE TEMP TABLE dev_six_original_acl ON COMMIT DROP AS SELECT oid,proacl FROM pg_proc WHERE pronamespace='public'::regnamespace;`,
        `DO $$ BEGIN IF to_regprocedure('public.acquire_dev_standard_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)') IS NOT NULL
            THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_PREEXISTING_EXPANSION'; END IF; END; $$;`,
        body('live-standard-capacity', 'cfe2c3ed45b9ef6d4ca04ae63ee714c3a118e1be130c1de54816a3fb4eb4ef16'),
        body('standard-cloud-six-capacity'), body('standard-cloud-six-vertex-budget'),
        `DO $$ BEGIN IF EXISTS(SELECT FROM pg_temp.dev_six_original_acl a LEFT JOIN pg_proc p ON p.oid=a.oid
            WHERE p.oid IS NULL OR a.proacl IS DISTINCT FROM p.proacl) OR EXISTS(
            SELECT FROM pg_temp.dev_six_original_limits l JOIN public.analysis_provider_admission_budgets b USING(budget_key)
            WHERE (l.max_active,l.rate_limit_per_minute) IS DISTINCT FROM (b.max_active,b.rate_limit_per_minute))
            THEN RAISE EXCEPTION 'DEV_CLOUD_SIX_EXISTING_POLICY_DRIFT'; END IF; END; $$;`, 'COMMIT;', ''].join('\n');
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
    process.stdout.write(standardCloudSixInstallSql());
