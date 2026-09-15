import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { canonicalDigest, EpochError, epochFail, isObject } from './contracts';
import { readOwnerBoundedFile, supabaseProjectRefFromOrigin } from './owner-auth';

const MAX_INTERVAL_MS = 15 * 60 * 1_000;
const MAX_RETENTION_MS = 31 * 24 * 60 * 60 * 1_000;

type Input = Readonly<{
    origin: string;
    windowStartMs?: number;
    windowEndMs: number;
    now: () => number;
    leaseCheck: () => Promise<void>;
    /** Provider-free seam for the fixed aggregate SELECT only. */
    query?: (sql: string) => Promise<unknown>;
}>;

async function queryOwnerDatabase(origin: string, sql: string): Promise<unknown> {
    // Resolve lazily after owner-production has constructed the collector.
    // Reuse its strict canonical-worktree and pinned-executable checks.
    const paths = await import('./owner-production');
    const cwd = process.cwd();
    const workdir = paths.resolvePrimaryRepositoryRootForOwner(cwd);
    const command = paths.resolveLocalSupabaseCliPathForOwner(cwd);
    const expectedRef = supabaseProjectRefFromOrigin(origin);
    const actualRef = readOwnerBoundedFile(join(workdir, 'supabase', '.temp', 'project-ref'), process.getuid?.() ?? -1);
    if (actualRef?.trim() !== expectedRef) epochFail('OWNER_AUTH_UNAVAILABLE');
    return new Promise((resolve, reject) => {
        execFile(command, ['--agent=yes', '--workdir', workdir, 'db', 'query', '--linked', '--output', 'json', sql], {
            cwd: workdir, shell: false, timeout: 30_000, maxBuffer: 32 * 1024, encoding: 'utf8',
            env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin', HOME: homedir(), LANG: 'C',
                NODE_ENV: 'production', NO_COLOR: '1' },
        }, (error, stdout) => {
            if (error) { reject(new EpochError('EVIDENCE_UNAVAILABLE')); return; }
            try {
                const parsed: unknown = JSON.parse(stdout);
                // The pinned CLI may emit a bare row array, while the normal
                // agent envelope carries exactly { boundary, rows, warning }.
                // Keep only the rows at this boundary; helper validation below
                // remains strict and never accepts raw CLI metadata.
                if (Array.isArray(parsed)) {
                    resolve({ rows: parsed });
                } else if (isObject(parsed) && Array.isArray(parsed.rows)
                    && Object.keys(parsed).length === 3
                    && Object.prototype.hasOwnProperty.call(parsed, 'boundary')
                    && Object.prototype.hasOwnProperty.call(parsed, 'rows')
                    && Object.prototype.hasOwnProperty.call(parsed, 'warning')) {
                    resolve({ rows: parsed.rows });
                } else {
                    reject(new EpochError('EVIDENCE_UNAVAILABLE'));
                }
            } catch { reject(new EpochError('EVIDENCE_UNAVAILABLE')); }
        });
    });
}

function isExactZero(value: unknown): boolean {
    // PostgreSQL bigint fields may be serialized as JSON numbers or as the
    // string "0" by the linked CLI. Missing, fractional, or other textual
    // values are never treated as zero.
    return value === 0 || value === '0';
}

/**
 * One SELECT provides a consistent snapshot of authoritative admissions.
 * The authenticated linked owner CLI returns only counts. No table grant,
 * migration, service key, raw user row, or database password is required.
 */
export async function readIdleAdmissionEvidence(input: Input): Promise<Readonly<{ digest: string; count: 0; observedAtMs: number }>> {
    supabaseProjectRefFromOrigin(input.origin);
    if (!Number.isSafeInteger(input.windowEndMs) || input.windowEndMs < 0 || input.windowEndMs > input.now()
        || (input.windowStartMs !== undefined && (!Number.isSafeInteger(input.windowStartMs)
            || input.windowStartMs < 0 || input.windowStartMs >= input.windowEndMs
            || input.windowEndMs - input.windowStartMs > MAX_INTERVAL_MS
            || input.windowEndMs - input.windowStartMs >= MAX_RETENTION_MS))) epochFail('EVIDENCE_UNAVAILABLE');
    const parts = [
        "(select count(*) from public.analysis_provider_admission_leases where state in ('leased','recovery_required')) as provider_active",
        "(select count(*) from public.analysis_preflights where status in ('pending','processing')) as preflight_active",
        "(select count(*) from public.analysis_requests where status in ('pending','processing')) as request_active",
        "(select count(*) from public.analysis_pipeline_jobs where status = 'processing') as job_active",
    ];
    const expectedKeys = ['provider_active', 'preflight_active', 'request_active', 'job_active'];
    if (input.windowStartMs !== undefined) {
        const start = new Date(input.windowStartMs).toISOString();
        const end = new Date(input.windowEndMs).toISOString();
        const changeSources = [
            ['provider', 'analysis_provider_admission_leases', ['created_at', 'updated_at']],
            ['preflight', 'analysis_preflights', ['created_at', 'updated_at']],
            // analysis_requests intentionally has no updated_at. Its lifecycle
            // is bounded by creation and terminal completion timestamps.
            ['request', 'analysis_requests', ['created_at', 'completed_at']],
            ['job', 'analysis_pipeline_jobs', ['created_at', 'updated_at']],
        ] as const;
        for (const [name, table, timestampColumns] of changeSources) {
            const key = name + '_changes';
            const period = " between '" + start + "'::timestamptz and '" + end + "'::timestamptz";
            const periods = timestampColumns.map(column => column + period).join(' or ');
            parts.push('(select count(*) from public.' + table + ' where (' + periods + ')) as ' + key);
            expectedKeys.push(key);
        }
    }
    const sql = 'select ' + parts.join(', ') + ', floor(extract(epoch from statement_timestamp()) * 1000)::bigint as observed_at_ms';
    await input.leaseCheck();
    const response = await (input.query ?? (query => queryOwnerDatabase(input.origin, query)))(sql);
    await input.leaseCheck();
    if (!isObject(response) || !Array.isArray(response.rows) || response.rows.length !== 1 || !isObject(response.rows[0])) epochFail('EVIDENCE_UNAVAILABLE');
    const row = response.rows[0];
    if (Object.keys(row).length !== expectedKeys.length + 1 || expectedKeys.some(key => !isExactZero(row[key]))) epochFail('EVIDENCE_UNAVAILABLE');
    const observedAtMs = Number(row.observed_at_ms);
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < input.windowEndMs || observedAtMs > input.now()
        || input.now() - observedAtMs > 300_000) epochFail('EVIDENCE_UNAVAILABLE');
    return { digest: canonicalDigest(Object.fromEntries(expectedKeys.map(key => [key, 0]))), count: 0, observedAtMs };
}
