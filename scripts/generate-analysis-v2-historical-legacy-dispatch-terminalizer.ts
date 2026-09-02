import {
    chmodSync,
    lstatSync,
    readFileSync,
    realpathSync,
    writeFileSync,
} from 'node:fs';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve as resolvePath,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const OPERATION_KEY_PATTERN = /^(?:target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const TASK_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/=-]{0,511}$/;
const REPOSITORY_ROOT = realpathSync(resolvePath(fileURLToPath(new URL('../', import.meta.url))));

export interface HistoricalLegacyDispatchCandidate {
    requestId: string;
    jobKey: string;
    inputHash: string;
    priorStatus: 'pending' | 'processing';
    priorDispatchState: 'delivered';
    priorDispatchGeneration: number;
    priorDispatchReservationToken: string;
    priorDispatchReservedAt: string;
    priorDispatchedAt: string;
    priorDeliveredAt: string;
    priorDispatchTaskName: string;
    priorDispatchWorkloadRole: null;
    priorDispatchContractVersion: null;
    priorClaimWorkloadRole: null;
    priorClaimContractVersion: null;
    priorLeaseToken: string | null;
    priorLeaseExpiresAt: string | null;
    manualResolutionOperationKey: string | null;
    manualResolutionEvidenceHash: string | null;
}

const CANDIDATE_KEYS = new Set([
    'requestId',
    'jobKey',
    'inputHash',
    'priorStatus',
    'priorDispatchState',
    'priorDispatchGeneration',
    'priorDispatchReservationToken',
    'priorDispatchReservedAt',
    'priorDispatchedAt',
    'priorDeliveredAt',
    'priorDispatchTaskName',
    'priorDispatchWorkloadRole',
    'priorDispatchContractVersion',
    'priorClaimWorkloadRole',
    'priorClaimContractVersion',
    'priorLeaseToken',
    'priorLeaseExpiresAt',
    'manualResolutionOperationKey',
    'manualResolutionEvidenceHash',
]);

function fail(message: string): never {
    throw new Error(`invalid historical legacy-dispatch candidate file: ${message}`);
}

function quoteSql(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function nullableSql(value: string | null, type: string): string {
    return value === null ? `NULL::${type}` : `${quoteSql(value)}::${type}`;
}

function isInsideRepository(filePath: string): boolean {
    const relativePath = relative(REPOSITORY_ROOT, filePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function assertAbsoluteOutsideRepository(filePath: string, label: string): string {
    if (!isAbsolute(filePath)) fail(`${label} must be an absolute path`);
    if (isInsideRepository(filePath)) fail(`${label} must be outside the repository`);
    return filePath;
}

export function readPrivateCandidateFile(filePath: string): string {
    const safePath = assertAbsoluteOutsideRepository(filePath, 'input');
    const stats = lstatSync(safePath);
    if (stats.isSymbolicLink()) fail('input must not be a symbolic link');
    if (!stats.isFile()) fail('input must be a regular file');
    const realPath = realpathSync(safePath);
    if (isInsideRepository(realPath)) fail('input must resolve outside the repository');
    const mode = stats.mode & 0o777;
    if (mode !== 0o400 && mode !== 0o600) fail('input must have private mode 0400 or 0600');
    return readFileSync(safePath, 'utf8');
}

export function writePrivateTerminalizationSqlFile(filePath: string, sql: string): void {
    const safePath = assertAbsoluteOutsideRepository(filePath, 'output');
    const parentPath = dirname(safePath);
    const realParentPath = realpathSync(parentPath);
    const realDestination = join(realParentPath, basename(safePath));
    if (isInsideRepository(realDestination)) fail('output parent must resolve outside the repository');
    try {
        if (lstatSync(safePath).isSymbolicLink()) fail('output must not be a symbolic link');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    writeFileSync(safePath, sql, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(safePath, 0o600);
}

function requireString(candidate: Record<string, unknown>, key: string): string {
    const value = candidate[key];
    return typeof value === 'string' && value.length > 0
        ? value
        : fail(`${key} must be a non-empty string`);
}

function requireTimestamp(candidate: Record<string, unknown>, key: string): string {
    const value = requireString(candidate, key);
    if (!Number.isFinite(Date.parse(value)) || !ISO_TIMESTAMP_PATTERN.test(value)) {
        fail(`${key} must include a timezone`);
    }
    return value;
}

function requireNullableString(candidate: Record<string, unknown>, key: string): string | null {
    const value = candidate[key];
    if (value === null) return null;
    if (typeof value === 'string' && value.length > 0) return value;
    fail(`${key} must be a string or null`);
}

function requireNullableTimestamp(candidate: Record<string, unknown>, key: string): string | null {
    const value = requireNullableString(candidate, key);
    if (value !== null && (!Number.isFinite(Date.parse(value)) || !ISO_TIMESTAMP_PATTERN.test(value))) {
        fail(`${key} must include a timezone or be null`);
    }
    return value;
}

function parseCandidate(value: unknown, index: number): HistoricalLegacyDispatchCandidate {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(`candidate ${index + 1} must be an object`);
    }
    const candidate = value as Record<string, unknown>;
    const unexpected = Object.keys(candidate).find((key) => !CANDIDATE_KEYS.has(key));
    if (unexpected) fail(`candidate ${index + 1} contains unsupported field ${unexpected}`);

    const requestId = requireString(candidate, 'requestId');
    const jobKey = requireString(candidate, 'jobKey');
    const inputHash = requireString(candidate, 'inputHash');
    const priorStatus = requireString(candidate, 'priorStatus');
    const priorDispatchState = requireString(candidate, 'priorDispatchState');
    const priorDispatchGeneration = candidate.priorDispatchGeneration;
    const priorDispatchReservationToken = requireString(candidate, 'priorDispatchReservationToken');
    const priorDispatchReservedAt = requireTimestamp(candidate, 'priorDispatchReservedAt');
    const priorDispatchedAt = requireTimestamp(candidate, 'priorDispatchedAt');
    const priorDeliveredAt = requireTimestamp(candidate, 'priorDeliveredAt');
    const priorDispatchTaskName = requireString(candidate, 'priorDispatchTaskName');
    const priorDispatchWorkloadRole = candidate.priorDispatchWorkloadRole;
    const priorDispatchContractVersion = candidate.priorDispatchContractVersion;
    const priorClaimWorkloadRole = candidate.priorClaimWorkloadRole;
    const priorClaimContractVersion = candidate.priorClaimContractVersion;
    const priorLeaseToken = requireNullableString(candidate, 'priorLeaseToken');
    const priorLeaseExpiresAt = requireNullableTimestamp(candidate, 'priorLeaseExpiresAt');
    const manualResolutionOperationKey = requireNullableString(candidate, 'manualResolutionOperationKey');
    const manualResolutionEvidenceHash = requireNullableString(candidate, 'manualResolutionEvidenceHash');

    if (!UUID_PATTERN.test(requestId) || !UUID_PATTERN.test(priorDispatchReservationToken)) {
        fail(`candidate ${index + 1} has an invalid UUID`);
    }
    if (priorLeaseToken !== null && !UUID_PATTERN.test(priorLeaseToken)) {
        fail(`candidate ${index + 1} has an invalid lease UUID`);
    }
    if (!JOB_KEY_PATTERN.test(jobKey)) fail(`candidate ${index + 1} has an invalid job key`);
    if (!SHA256_PATTERN.test(inputHash)
        || (manualResolutionEvidenceHash !== null && !SHA256_PATTERN.test(manualResolutionEvidenceHash))) {
        fail(`candidate ${index + 1} has an invalid SHA-256 hash`);
    }
    if (priorStatus !== 'pending' && priorStatus !== 'processing') {
        fail(`candidate ${index + 1} priorStatus must be pending or processing`);
    }
    if (priorDispatchState !== 'delivered') {
        fail(`candidate ${index + 1} priorDispatchState must be delivered`);
    }
    if (typeof priorDispatchGeneration !== 'number'
        || !Number.isInteger(priorDispatchGeneration)
        || priorDispatchGeneration < 1
        || priorDispatchGeneration > 1000) {
        fail(`candidate ${index + 1} has an invalid dispatch generation`);
    }
    if (!TASK_NAME_PATTERN.test(priorDispatchTaskName)) {
        fail(`candidate ${index + 1} has an invalid dispatch task name`);
    }
    if (priorDispatchWorkloadRole !== null || priorDispatchContractVersion !== null
        || priorClaimWorkloadRole !== null || priorClaimContractVersion !== null) {
        fail(`candidate ${index + 1} must preserve roleless legacy provenance`);
    }
    if (priorStatus === 'pending' && (priorLeaseToken !== null || priorLeaseExpiresAt !== null)) {
        fail(`candidate ${index + 1} pending job must have no lease`);
    }
    if (priorStatus === 'processing' && (priorLeaseToken === null || priorLeaseExpiresAt === null)) {
        fail(`candidate ${index + 1} processing job must include a lease`);
    }
    if (manualResolutionOperationKey !== null && !OPERATION_KEY_PATTERN.test(manualResolutionOperationKey)) {
        fail(`candidate ${index + 1} has an invalid manual-resolution operation key`);
    }
    if ((manualResolutionOperationKey === null) !== (manualResolutionEvidenceHash === null)) {
        fail(`candidate ${index + 1} manual-resolution fields must both be strings or both be null`);
    }
    const timestamps = [priorDispatchReservedAt, priorDispatchedAt, priorDeliveredAt].map(Date.parse);
    if (timestamps[0] > timestamps[1] || timestamps[1] > timestamps[2]) {
        fail(`candidate ${index + 1} dispatch timestamps must be reserved <= dispatched <= delivered`);
    }

    return {
        requestId,
        jobKey,
        inputHash,
        priorStatus,
        priorDispatchState,
        priorDispatchGeneration,
        priorDispatchReservationToken,
        priorDispatchReservedAt,
        priorDispatchedAt,
        priorDeliveredAt,
        priorDispatchTaskName,
        priorDispatchWorkloadRole: null,
        priorDispatchContractVersion: null,
        priorClaimWorkloadRole: null,
        priorClaimContractVersion: null,
        priorLeaseToken,
        priorLeaseExpiresAt,
        manualResolutionOperationKey,
        manualResolutionEvidenceHash,
    };
}

export function parseCandidateFile(contents: string): HistoricalLegacyDispatchCandidate[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch {
        fail('file must contain JSON');
    }
    if (!Array.isArray(parsed) || parsed.length !== 5) {
        fail('the owner candidate gate must contain exactly five rows');
    }
    const candidates = parsed.map(parseCandidate);
    const identities = new Set<string>();
    for (const candidate of candidates) {
        const identity = `${candidate.requestId}\u0000${candidate.jobKey}`;
        if (identities.has(identity)) fail('candidate identity tuples must be unique');
        identities.add(identity);
    }
    return candidates;
}

export function generateTerminalizationSql(
    candidates: readonly HistoricalLegacyDispatchCandidate[],
    auditEvidenceHash: string,
    terminalStatus: 'failed' | 'cancelled' = 'failed'
): string {
    if (candidates.length !== 5) fail('exactly five candidates are required');
    if (!SHA256_PATTERN.test(auditEvidenceHash)) fail('audit evidence hash must be lowercase SHA-256');
    if (terminalStatus !== 'failed' && terminalStatus !== 'cancelled') {
        fail('terminal status must be failed or cancelled');
    }
    const calls = candidates.map((candidate) => `SELECT public.resolve_analysis_v2_historical_legacy_dispatch(
    ${quoteSql(candidate.requestId)}::UUID,
    ${quoteSql(candidate.jobKey)},
    ${quoteSql(candidate.inputHash)},
    ${quoteSql(candidate.priorStatus)},
    ${quoteSql(candidate.priorDispatchState)},
    ${candidate.priorDispatchGeneration},
    ${quoteSql(candidate.priorDispatchReservationToken)}::UUID,
    ${quoteSql(candidate.priorDispatchReservedAt)}::TIMESTAMPTZ,
    ${quoteSql(candidate.priorDispatchedAt)}::TIMESTAMPTZ,
    ${quoteSql(candidate.priorDeliveredAt)}::TIMESTAMPTZ,
    ${quoteSql(candidate.priorDispatchTaskName)},
    NULL::TEXT,
    NULL::SMALLINT,
    NULL::TEXT,
    NULL::SMALLINT,
    ${nullableSql(candidate.priorLeaseToken, 'UUID')},
    ${nullableSql(candidate.priorLeaseExpiresAt, 'TIMESTAMPTZ')},
    ${nullableSql(candidate.manualResolutionOperationKey, 'TEXT')},
    ${nullableSql(candidate.manualResolutionEvidenceHash, 'TEXT')},
    ${quoteSql(terminalStatus)},
    ${quoteSql(auditEvidenceHash)}
);`).join('\n');

    return `-- Generated from a sanitized owner-only candidate file.
-- Fixed bounded job error code: 'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED'.
-- Execute in a database-owner session only; this file makes no network or runtime calls.
BEGIN;
${calls}
COMMIT;
`;
}

const GENERATOR_ARGUMENTS = new Set(['input', 'output', 'audit-evidence-hash', 'terminal-status']);

export function parseGeneratorArguments(argv: readonly string[]): {
    input: string;
    output: string;
    auditEvidenceHash: string;
    terminalStatus: 'failed' | 'cancelled';
} {
    const values = new Map<string, string>();
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (!token.startsWith('--')) fail(`unexpected argument ${token}`);
        const [name, inlineValue] = token.slice(2).split('=', 2);
        if (!GENERATOR_ARGUMENTS.has(name)) fail(`unknown option --${name}`);
        const value = inlineValue ?? argv[++index];
        if (!value || value.startsWith('--')) fail(`--${name} requires a value`);
        if (values.has(name)) fail(`duplicate option --${name}`);
        values.set(name, value);
    }
    const input = values.get('input');
    const output = values.get('output');
    const auditEvidenceHash = values.get('audit-evidence-hash');
    const terminalStatus = values.get('terminal-status') ?? 'failed';
    if (!input || !output || !auditEvidenceHash) {
        fail('--input, --output, and --audit-evidence-hash are required');
    }
    if (terminalStatus !== 'failed' && terminalStatus !== 'cancelled') {
        fail('--terminal-status must be failed or cancelled');
    }
    if (!SHA256_PATTERN.test(auditEvidenceHash)) fail('audit evidence hash must be lowercase SHA-256');
    for (const filePath of [input, output]) {
        if (basename(filePath) === '.env.local' || basename(filePath) === '.env') {
            fail('environment files are not valid input or output');
        }
    }
    return { input, output, auditEvidenceHash, terminalStatus };
}

if (process.argv[1]?.endsWith('generate-analysis-v2-historical-legacy-dispatch-terminalizer.ts')) {
    const { input, output, auditEvidenceHash, terminalStatus } = parseGeneratorArguments(process.argv.slice(2));
    const candidates = parseCandidateFile(readPrivateCandidateFile(input));
    writePrivateTerminalizationSqlFile(output, generateTerminalizationSql(candidates, auditEvidenceHash, terminalStatus));
}
