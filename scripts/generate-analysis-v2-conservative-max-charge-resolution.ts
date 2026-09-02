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
const RUN_ID_PATTERN = /^[A-Za-z0-9:_-]{8,256}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,256}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const REPOSITORY_ROOT = realpathSync(resolvePath(fileURLToPath(new URL('../', import.meta.url))));

export interface ConservativeMaxChargeCandidate {
    requestId: string;
    jobKey: string;
    operationKey: string;
    inputHash: string;
    jobClaimToken: string;
    reservationToken: string;
    runId: string;
    logicalProvider: 'apify';
    actorId: string;
    credentialSlot: 'tertiary';
    maxChargeUsd: number;
    reservedAt: string;
    runStartedAt: string;
    terminalizedAt: string;
    status: 'succeeded';
    revenueCostChildActive?: boolean;
}

const CANDIDATE_KEYS = new Set([
    'requestId',
    'jobKey',
    'operationKey',
    'inputHash',
    'jobClaimToken',
    'reservationToken',
    'runId',
    'logicalProvider',
    'actorId',
    'credentialSlot',
    'maxChargeUsd',
    'reservedAt',
    'runStartedAt',
    'terminalizedAt',
    'status',
    'revenueCostChildActive',
]);

function fail(message: string): never {
    throw new Error(`invalid conservative max-charge candidate file: ${message}`);
}

function quoteSql(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function isInsideRepository(filePath: string): boolean {
    const relativePath = relative(REPOSITORY_ROOT, filePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function assertAbsoluteOutsideRepository(filePath: string, label: string): string {
    if (!isAbsolute(filePath)) fail(`${label} must be an absolute path`);
    if (isInsideRepository(filePath)) {
        fail(`${label} must be outside the repository`);
    }
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
    if (mode !== 0o400 && mode !== 0o600) {
        fail('input must have private mode 0400 or 0600');
    }
    return readFileSync(safePath, 'utf8');
}

export function writePrivateResolutionSqlFile(filePath: string, sql: string): void {
    const safePath = assertAbsoluteOutsideRepository(filePath, 'output');
    const parentPath = dirname(safePath);
    const realParentPath = realpathSync(parentPath);
    const realDestination = join(realParentPath, basename(safePath));
    if (isInsideRepository(realDestination)) {
        fail('output parent must resolve outside the repository');
    }
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
    if (!Number.isFinite(Date.parse(value))) fail(`${key} must be a timestamp`);
    return value;
}

function parseCandidate(value: unknown, index: number): ConservativeMaxChargeCandidate {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(`candidate ${index + 1} must be an object`);
    }
    const candidate = value as Record<string, unknown>;
    const unexpected = Object.keys(candidate).find((key) => !CANDIDATE_KEYS.has(key));
    if (unexpected) fail(`candidate ${index + 1} contains unsupported field ${unexpected}`);

    const requestId = requireString(candidate, 'requestId');
    const jobKey = requireString(candidate, 'jobKey');
    const operationKey = requireString(candidate, 'operationKey');
    const inputHash = requireString(candidate, 'inputHash');
    const jobClaimToken = requireString(candidate, 'jobClaimToken');
    const reservationToken = requireString(candidate, 'reservationToken');
    const runId = requireString(candidate, 'runId');
    const logicalProvider = requireString(candidate, 'logicalProvider');
    const actorId = requireString(candidate, 'actorId');
    const credentialSlot = requireString(candidate, 'credentialSlot');
    const maxChargeUsd = candidate.maxChargeUsd;
    const reservedAt = requireTimestamp(candidate, 'reservedAt');
    const runStartedAt = requireTimestamp(candidate, 'runStartedAt');
    const terminalizedAt = requireTimestamp(candidate, 'terminalizedAt');
    const status = requireString(candidate, 'status');

    if (!UUID_PATTERN.test(requestId) || !UUID_PATTERN.test(jobClaimToken)
        || !UUID_PATTERN.test(reservationToken)) fail(`candidate ${index + 1} has an invalid UUID`);
    if (!JOB_KEY_PATTERN.test(jobKey)) fail(`candidate ${index + 1} has an invalid job key`);
    if (!OPERATION_KEY_PATTERN.test(operationKey)) fail(`candidate ${index + 1} has an invalid operation key`);
    if (!SHA256_PATTERN.test(inputHash)) fail(`candidate ${index + 1} has an invalid input hash`);
    if (!RUN_ID_PATTERN.test(runId)) fail(`candidate ${index + 1} has an invalid run ID`);
    if (!ACTOR_ID_PATTERN.test(actorId)) fail(`candidate ${index + 1} has an invalid actor ID`);
    if (logicalProvider !== 'apify') fail(`candidate ${index + 1} must use Apify`);
    if (credentialSlot !== 'tertiary') fail(`candidate ${index + 1} must use tertiary`);
    if (status !== 'succeeded') fail(`candidate ${index + 1} must be succeeded`);
    if (typeof maxChargeUsd !== 'number' || !Number.isFinite(maxChargeUsd) || maxChargeUsd <= 0) {
        fail(`candidate ${index + 1} has an invalid max charge`);
    }
    for (const [key, timestamp] of [
        ['reservedAt', reservedAt],
        ['runStartedAt', runStartedAt],
        ['terminalizedAt', terminalizedAt],
    ] as const) {
        if (!ISO_TIMESTAMP_PATTERN.test(timestamp)) {
            fail(`candidate ${index + 1} ${key} must include a timezone`);
        }
    }
    if (Date.parse(reservedAt) > Date.parse(runStartedAt)
        || Date.parse(runStartedAt) > Date.parse(terminalizedAt)) {
        fail(`candidate ${index + 1} timestamps must be reserved <= started <= terminal`);
    }

    return {
        requestId,
        jobKey,
        operationKey,
        inputHash,
        jobClaimToken,
        reservationToken,
        runId,
        logicalProvider,
        actorId,
        credentialSlot,
        maxChargeUsd,
        reservedAt,
        runStartedAt,
        terminalizedAt,
        status,
        ...(typeof candidate.revenueCostChildActive === 'boolean'
            ? { revenueCostChildActive: candidate.revenueCostChildActive }
            : {}),
    };
}

export function parseCandidateFile(contents: string): ConservativeMaxChargeCandidate[] {
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
        const identity = `${candidate.requestId}\u0000${candidate.jobKey}\u0000${candidate.operationKey}`;
        if (identities.has(identity)) fail('candidate identity tuples must be unique');
        identities.add(identity);
    }
    return candidates;
}

export function generateResolutionSql(
    candidates: readonly ConservativeMaxChargeCandidate[],
    evidenceHash: string
): string {
    if (candidates.length !== 5) fail('exactly five candidates are required');
    if (!SHA256_PATTERN.test(evidenceHash)) fail('evidence hash must be lowercase SHA-256');

    const calls = candidates.map((candidate) => `SELECT public.resolve_analysis_v2_provider_run_conservative_max_charge(
    ${quoteSql(candidate.requestId)}::UUID,
    ${quoteSql(candidate.jobKey)},
    ${quoteSql(candidate.operationKey)},
    ${quoteSql(candidate.inputHash)},
    ${quoteSql(candidate.jobClaimToken)}::UUID,
    ${quoteSql(candidate.reservationToken)}::UUID,
    ${quoteSql(candidate.runId)},
    ${quoteSql(candidate.logicalProvider)},
    ${quoteSql(candidate.actorId)},
    ${quoteSql(candidate.credentialSlot)},
    ${candidate.maxChargeUsd},
    ${quoteSql(candidate.reservedAt)}::TIMESTAMPTZ,
    ${quoteSql(candidate.runStartedAt)}::TIMESTAMPTZ,
    ${quoteSql(candidate.terminalizedAt)}::TIMESTAMPTZ,
    ${quoteSql(candidate.status)},
    'conservative_max_charge',
    ${quoteSql(evidenceHash)}
);`).join('\n');

    return `-- Generated from a sanitized owner-only candidate file.
-- Execute in a database-owner session only; this file makes no network or environment calls.
BEGIN;
${calls}
COMMIT;
`;
}

const GENERATOR_ARGUMENTS = new Set(['input', 'output', 'evidence-hash']);

export function parseGeneratorArguments(argv: readonly string[]): {
    input: string;
    output: string;
    evidenceHash: string;
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
    const evidenceHash = values.get('evidence-hash');
    if (!input || !output || !evidenceHash) fail('--input, --output, and --evidence-hash are required');
    for (const filePath of [input, output]) {
        if (basename(filePath) === '.env.local' || basename(filePath) === '.env') {
            fail('environment files are not valid input or output');
        }
    }
    return { input, output, evidenceHash };
}

if (process.argv[1]?.endsWith('generate-analysis-v2-conservative-max-charge-resolution.ts')) {
    const { input, output, evidenceHash } = parseGeneratorArguments(process.argv.slice(2));
    const candidates = parseCandidateFile(readPrivateCandidateFile(input));
    writePrivateResolutionSqlFile(output, generateResolutionSql(candidates, evidenceHash));
}
