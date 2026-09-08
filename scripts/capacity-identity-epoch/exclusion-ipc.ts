/**
 * Private child-side IPC client for the exclusion supervisor.
 *
 * It accepts only fixed operation/entry-point tokens. Protected selectors are
 * derived from the already validated child environment and sent over the
 * inherited control pipe, never through argv or ordinary output.
 */
import { randomBytes } from 'node:crypto';
import { readSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { epochFail, type Role } from './contracts';
import type { ExclusionEntryPoint, ExclusionResource } from './exclusion-bridge';
import {
    validateDescriptor,
    validateSerializedLease,
    type SerializedLease,
} from '../check-capacity-identity-epoch-exclusion';
import { rejectDuplicateJsonKeys } from './packet';

const FD = /^\d{1,9}$/;
const ENTRY_POINTS = ['epoch', 'role-deployer', 'capacity-queue', 'preflight-maintenance', 'paid-maintenance'] as const;
const ROLES = ['preflight', 'paid'] as const;
const SAFE_VALUE = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const REQUEST_ID = /^[0-9a-f]{32}$/;
const CHANNEL_NONCE = /^[0-9a-f]{64}$/;
const EVIDENCE = /^[A-Za-z0-9_-]{1,32768}$/;
type Command = 'assert' | 'adopt';
type SelectorSource = 'role' | 'generic';

function fail(): never {
    epochFail('ADAPTER_REQUEST_INVALID');
}

function parseFd(value: string | undefined): number {
    if (value === undefined || !FD.test(value)) fail();
    const fd = Number(value);
    if (!Number.isSafeInteger(fd)) fail();
    return fd;
}

function parseArguments(argv: readonly string[]): Readonly<{
    command: Command;
    entryPoint: ExclusionEntryPoint;
    role: Role;
    selectorSource: SelectorSource;
    writeFd: number;
    readFd: number;
}> {
    const command = argv[0];
    if (command !== 'assert' && command !== 'adopt') fail();
    let entryPoint: ExclusionEntryPoint = 'epoch';
    let role: Role | undefined;
    let selectorSource: SelectorSource = 'role';
    let writeFd: number | undefined;
    let readFd: number | undefined;
    for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--entry-point' && entryPoint === 'epoch') {
            const value = argv[++index];
            if (value === undefined || !ENTRY_POINTS.includes(value as ExclusionEntryPoint)) fail();
            entryPoint = value as ExclusionEntryPoint;
        } else if (arg === '--role' && role === undefined) {
            const value = argv[++index];
            if (value === undefined || !ROLES.includes(value as Role)) fail();
            role = value as Role;
        } else if (arg === '--selector-source' && selectorSource === 'role') {
            const value = argv[++index];
            if (value !== 'role' && value !== 'generic') fail();
            selectorSource = value;
        } else if (arg === '--control-write-fd' && writeFd === undefined) {
            writeFd = parseFd(argv[++index]);
        } else if (arg === '--control-read-fd' && readFd === undefined) {
            readFd = parseFd(argv[++index]);
        } else {
            fail();
        }
    }
    if (writeFd === undefined || readFd === undefined || entryPoint === 'epoch' || role === undefined) fail();
    return { command, entryPoint, role: role!, selectorSource, writeFd, readFd };
}

export function deriveResources(
    entryPoint: ExclusionEntryPoint,
    role: Role,
    selectorSource: SelectorSource = 'role',
): readonly ExclusionResource[] {
    const prefix = selectorSource === 'generic'
        ? 'ANALYSIS_TASKS'
        : role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const project = process.env[prefix + '_PROJECT'];
    const location = process.env[prefix + '_LOCATION'];
    const service = process.env[prefix + '_CLOUD_RUN_SERVICE'];
    const region = process.env[prefix + '_CLOUD_RUN_REGION'];
    const queue = process.env[prefix + '_QUEUE'];
    const maintenanceLocation = selectorSource === 'generic'
        ? region
        : process.env[role === 'preflight'
            ? 'PREFLIGHT_TASKS_MAINTENANCE_LOCATION'
            : 'ANALYSIS_V2_MAINTENANCE_LOCATION'] ?? region;
    const recoveryJob = selectorSource === 'generic'
        ? undefined
        : process.env[role === 'preflight'
            ? 'PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB'
            : 'ANALYSIS_V2_RECOVERY_SCHEDULER_JOB']
            ?? (role === 'preflight' ? 'analysis-preflight-recovery' : 'analysis-v2-recovery');
    const retentionJob = process.env.ANALYSIS_V2_RETENTION_SCHEDULER_JOB ?? 'analysis-v2-preflight-retention';
    if (typeof project !== 'string' || !SAFE_VALUE.test(project)) fail();
    const serviceResource = typeof service === 'string' && SAFE_VALUE.test(service)
        && typeof region === 'string' && SAFE_VALUE.test(region)
        ? 'projects/' + project + '/locations/' + region + '/services/' + service
        : undefined;
    if (entryPoint !== 'capacity-queue' && serviceResource === undefined) fail();
    const needsQueue = entryPoint === 'epoch' || entryPoint === 'capacity-queue';
    if (needsQueue && (typeof location !== 'string' || !SAFE_VALUE.test(location)
        || typeof queue !== 'string' || !SAFE_VALUE.test(queue))) fail();
    const resources: ExclusionResource[] = [];
    if (serviceResource !== undefined) {
        resources.push({ kind: 'service', resource: serviceResource });
        resources.push({ kind: 'iam', resource: serviceResource });
    }
    const taskServiceAccount = process.env[prefix + '_SERVICE_ACCOUNT_EMAIL'];
    if (typeof taskServiceAccount === 'string' && SAFE_VALUE.test(taskServiceAccount)) {
        resources.push({ kind: 'iam', resource: 'projects/' + project + '/serviceAccounts/' + taskServiceAccount });
    }
    const iamScope = process.env.ANALYSIS_TASKS_IAM_SCOPE ?? 'project';
    if (iamScope === 'project') resources.push({ kind: 'iam', resource: 'projects/' + project });
    else if (iamScope !== 'queue') fail();
    if (entryPoint === 'role-deployer') return resources;
    if (entryPoint === 'capacity-queue') {
        resources.push({
            kind: 'queue',
            resource: 'projects/' + project + '/locations/' + location + '/queues/' + queue,
        });
        return resources;
    }
    if (typeof maintenanceLocation !== 'string' || !SAFE_VALUE.test(maintenanceLocation)
        || typeof recoveryJob !== 'string' || !SAFE_VALUE.test(recoveryJob)) fail();
    const schedulerResource = 'projects/' + project + '/locations/' + maintenanceLocation + '/jobs/' + recoveryJob;
    resources.push({ kind: 'scheduler', resource: schedulerResource });
    if (entryPoint === 'paid-maintenance') {
        if (!SAFE_VALUE.test(retentionJob)) fail();
        resources.push({
            kind: 'retention',
            resource: 'projects/' + project + '/locations/' + maintenanceLocation + '/jobs/' + retentionJob,
        });
    }
    if (entryPoint === 'preflight-maintenance' || entryPoint === 'paid-maintenance') return resources;
    resources.push({
        kind: 'queue',
        resource: 'projects/' + project + '/locations/' + location + '/queues/' + queue,
    });
    return resources;
}

export function deriveLegacyServices(entryPoint: ExclusionEntryPoint, role: Role): readonly Readonly<{
    bucket: string;
    project: string;
    region: string;
    service: string;
}>[] {
    if (entryPoint !== 'role-deployer') return [];
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const bucket = process.env.ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET;
    const project = process.env[prefix + '_PROJECT'];
    const region = process.env[prefix + '_CLOUD_RUN_REGION'];
    const service = process.env[prefix + '_CLOUD_RUN_SERVICE'];
    for (const value of [bucket, project, region, service]) {
        if (typeof value !== 'string' || !SAFE_VALUE.test(value)) fail();
    }
    return [{ bucket: bucket!, project: project!, region: region!, service: service! }];
}

function readLine(fd: number): string {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < 4096) {
        const chunk = Buffer.allocUnsafe(256);
        const count = readSync(fd, chunk, 0, chunk.length, null);
        if (count === 0) break;
        const part = chunk.subarray(0, count);
        const newline = part.indexOf(10);
        if (newline >= 0) {
            chunks.push(part.subarray(0, newline));
            return Buffer.concat(chunks).toString('utf8');
        }
        chunks.push(part);
        total += count;
    }
    fail();
}

type ParsedResponse = Readonly<{ code: string; evidence?: SerializedLease }>;

function decodeEvidence(encoded: string, options: Readonly<{
    entryPoint: ExclusionEntryPoint;
    role?: Role;
    resources: readonly ExclusionResource[];
}>): SerializedLease {
    if (!EVIDENCE.test(encoded)) fail();
    let raw: string;
    try {
        raw = Buffer.from(encoded, 'base64url').toString('utf8');
        if (Buffer.from(raw, 'utf8').toString('base64url') !== encoded) fail();
        rejectDuplicateJsonKeys(raw);
    } catch {
        fail();
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(raw) as unknown;
    } catch {
        fail();
    }
    const lease = validateSerializedLease(decoded);
    const bucket = process.env.ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET;
    if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/.test(bucket)) fail();
    const ownerDigest = lease.reservationLease.record.ownerDigest;
    const epochDigest = lease.reservationLease.record.epochDigest;
    const descriptor = validateDescriptor({
        bucket,
        entryPoint: options.entryPoint,
        role: options.role ?? null,
        resources: options.resources,
        legacyServices: deriveLegacyServices(options.entryPoint, options.role ?? 'preflight'),
        epochDigest,
        ownerDigest,
        leaseMs: 60_000,
        lease,
    });
    const expectedResources = options.resources
        .map(resource => resource.kind + ':' + resource.resource)
        .sort();
    const actualResources = descriptor.resources
        .map(resource => resource.kind + ':' + resource.resource)
        .sort();
    if (expectedResources.length !== actualResources.length
        || expectedResources.some((resource, index) => resource !== actualResources[index])) fail();
    return lease;
}

function parseResponse(line: string, id: string, options: Readonly<{
    entryPoint: ExclusionEntryPoint;
    role?: Role;
    resources: readonly ExclusionResource[];
}>): ParsedResponse {
    const nonce = process.env.ANALYSIS_CAPACITY_EXCLUSION_CONTROL_NONCE;
    if (typeof nonce !== 'string' || !CHANNEL_NONCE.test(nonce)) fail();
    const match = /^([0-9a-f]{32}) ([0-9a-f]{64}) (ASSERT_OK|ADOPTED|ERR (?:ADAPTER_REQUEST_INVALID|ADAPTER_RESPONSE_INVALID|ABORTED_EPOCH|CAPABILITY_BINDING_MISMATCH|CAPABILITY_INVALID|GENERATION_PRECONDITION_FAILED|JOURNAL_INVALID|LOCK_LOST|PROTECTED_INPUT_UNAVAILABLE|RESOURCE_INVALID|ADAPTER_TIMEOUT))(?: ([A-Za-z0-9_-]{1,32768}))?$/.exec(line);
    if (!match || match[1] !== id || match[2] !== nonce) fail();
    const code = match[3]!;
    if ((code === 'ASSERT_OK' || code === 'ADOPTED') && match[4] === undefined) fail();
    return {
        code,
        ...(match[4] === undefined ? {} : { evidence: decodeEvidence(match[4], options) }),
    };
}

async function run(argv: readonly string[]): Promise<void> {
    const options = parseArguments(argv);
    const nonce = process.env.ANALYSIS_CAPACITY_EXCLUSION_CONTROL_NONCE;
    if (typeof nonce !== 'string' || !CHANNEL_NONCE.test(nonce)) fail();
    const resources = deriveResources(options.entryPoint, options.role, options.selectorSource);
    const request = options.command === 'assert'
        ? { op: 'assert', resources: resources!.map(resource => resource.kind + ':' + resource.resource) }
        : options.command === 'adopt'
            ? {
                op: 'adopt',
                entryPoint: options.entryPoint,
                role: options.role,
                resources: resources!,
            }
            : { op: 'adopt', entryPoint: options.entryPoint, role: options.role, resources };
    const id = randomBytes(16).toString('hex');
    writeSync(options.writeFd, Buffer.from(JSON.stringify({ id, nonce, ...request }) + '\n'));
    const response = readLine(options.readFd);
    const expected = options.command === 'assert' ? 'ASSERT_OK' : 'ADOPTED';
    const parsed = parseResponse(response, id, {
        entryPoint: options.entryPoint,
        role: options.role,
        resources,
    });
    const code = parsed.code;
    if (code === expected) return;
    if (code.startsWith('ERR ')) {
        process.stderr.write(code.slice(4) + '\n');
        process.exitCode = 2;
        return;
    }
    fail();
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedScript) {
    void run(process.argv.slice(2)).catch(() => {
        process.stderr.write('ADAPTER_REQUEST_INVALID\n');
        process.exitCode = 2;
    });
}
