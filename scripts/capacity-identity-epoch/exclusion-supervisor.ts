/**
 * Fixed ordinary-mutation exclusion supervisor.
 *
 * The protected descriptor arrives once on an inherited FD. The supervisor
 * owns concrete GCS/native leases for the complete subprocess interval;
 * shell entry points communicate only through a private inherited pipe.
 */
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
    EpochError,
    epochFail,
    hasExactKeys,
    isObject,
    type Role,
} from './contracts';
import { rejectDuplicateJsonKeys } from './packet';
import { createAuthenticatedGcsJournalStorage } from './gcs';
import {
    readBridgeDescriptor,
    serializeSession,
} from '../check-capacity-identity-epoch-exclusion';
import {
    acquireExclusion,
    assertExclusion,
    deriveEntryPointResources,
    releaseExclusion,
    renewExclusion,
    type ExclusionEntryPoint,
    type ExclusionResource,
    type ExclusionSession,
    type LegacyLockStorage,
} from './exclusion-bridge';
import type { ReservationStorage } from './exclusion';

const ENTRY_POINTS = ['epoch', 'role-deployer', 'capacity-queue', 'preflight-maintenance', 'paid-maintenance'] as const;
const ROLES = ['preflight', 'paid'] as const;
const FD = /^\d{1,9}$/;
const SAFE_RESOURCE = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const REQUEST_ID = /^[0-9a-f]{32}$/;
const CHANNEL_NONCE = /^[0-9a-f]{64}$/;
const MAX_CONTROL_LINE = 64 * 1024;
const MAX_EVIDENCE_BYTES = 32 * 1024;

type SupervisorOptions = Readonly<{
    entryPoint: ExclusionEntryPoint;
    descriptorFd: number;
}>;

type ControlRequest =
    | Readonly<{ id: string; nonce: string; op: 'assert'; resources?: readonly string[] }>
    | Readonly<{ id: string; nonce: string; op: 'renew' }>
    | Readonly<{ id: string; nonce: string; op: 'release' }>
    | Readonly<{
        id: string;
        nonce: string;
        op: 'adopt';
        entryPoint: ExclusionEntryPoint;
        role: Role;
        resources: readonly ExclusionResource[];
    }>;

type SupervisorStorage = ReservationStorage & LegacyLockStorage;
type SupervisorStorageFactory = (bucket: string) => SupervisorStorage;

function fail(code: Parameters<typeof epochFail>[0]): never {
    epochFail(code);
}

function parseFd(value: string | undefined): number {
    if (value === undefined || !FD.test(value)) fail('ADAPTER_REQUEST_INVALID');
    const fd = Number(value);
    if (!Number.isSafeInteger(fd)) fail('ADAPTER_REQUEST_INVALID');
    return fd;
}

function parseArguments(argv: readonly string[]): SupervisorOptions {
    if (argv.length !== 4 || argv[0] !== '--entry-point' || argv[2] !== '--descriptor-fd') {
        fail('ADAPTER_REQUEST_INVALID');
    }
    const entryPoint = argv[1];
    if (!ENTRY_POINTS.includes(entryPoint as ExclusionEntryPoint)) fail('ADAPTER_REQUEST_INVALID');
    return { entryPoint: entryPoint as ExclusionEntryPoint, descriptorFd: parseFd(argv[3]) };
}

function parseResourceStrings(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length === 0
        || value.some(resource => typeof resource !== 'string' || !SAFE_RESOURCE.test(resource))) {
        fail('CAPABILITY_BINDING_MISMATCH');
    }
    const resources = [...new Set(value as string[])].sort();
    if (resources.length !== value.length) fail('CAPABILITY_BINDING_MISMATCH');
    return resources;
}

function parseResourceObjects(value: unknown): readonly ExclusionResource[] {
    if (!Array.isArray(value) || value.length === 0) fail('CAPABILITY_BINDING_MISMATCH');
    const resources: ExclusionResource[] = [];
    for (const resource of value) {
        if (!isObject(resource) || !hasExactKeys(resource, ['kind', 'resource'])
            || typeof resource.kind !== 'string' || typeof resource.resource !== 'string'
            || !SAFE_RESOURCE.test(resource.resource)) {
            fail('CAPABILITY_BINDING_MISMATCH');
        }
        resources.push(resource as ExclusionResource);
    }
    return resources;
}

function parseRequest(line: string, channelNonce: string): ControlRequest {
    if (line.length === 0 || line.length > MAX_CONTROL_LINE) fail('ADAPTER_REQUEST_INVALID');
    let value: unknown;
    try {
        rejectDuplicateJsonKeys(line);
        value = JSON.parse(line) as unknown;
    } catch (error) {
        if (error instanceof EpochError) fail('ADAPTER_REQUEST_INVALID');
        fail('ADAPTER_REQUEST_INVALID');
    }
    if (!isObject(value) || typeof value.id !== 'string' || !REQUEST_ID.test(value.id)
        || typeof value.nonce !== 'string' || value.nonce !== channelNonce || !CHANNEL_NONCE.test(value.nonce)
        || typeof value.op !== 'string') {
        fail('ADAPTER_REQUEST_INVALID');
    }
    switch (value.op) {
        case 'assert':
            if (hasExactKeys(value, ['id', 'nonce', 'op'])) return { id: value.id, nonce: value.nonce, op: 'assert' };
            if (!hasExactKeys(value, ['id', 'nonce', 'op', 'resources'])) fail('ADAPTER_REQUEST_INVALID');
            return { id: value.id, nonce: value.nonce, op: 'assert', resources: parseResourceStrings(value.resources) };
        case 'renew':
            if (!hasExactKeys(value, ['id', 'nonce', 'op'])) fail('ADAPTER_REQUEST_INVALID');
            return { id: value.id, nonce: value.nonce, op: 'renew' };
        case 'release':
            if (!hasExactKeys(value, ['id', 'nonce', 'op'])) fail('ADAPTER_REQUEST_INVALID');
            return { id: value.id, nonce: value.nonce, op: 'release' };
        case 'adopt':
            if (!hasExactKeys(value, ['entryPoint', 'id', 'nonce', 'op', 'resources', 'role'])
                || typeof value.entryPoint !== 'string'
                || !ENTRY_POINTS.includes(value.entryPoint as ExclusionEntryPoint)
                || typeof value.role !== 'string'
                || !ROLES.includes(value.role as Role)) fail('ADAPTER_REQUEST_INVALID');
            return {
                id: value.id,
                nonce: value.nonce,
                op: 'adopt',
                entryPoint: value.entryPoint as ExclusionEntryPoint,
                role: value.role as Role,
                resources: parseResourceObjects(value.resources),
            };
        default:
            fail('ADAPTER_REQUEST_INVALID');
    }
}

function equalResources(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((resource, index) => resource === right[index]);
}

function assertParentBinding(descriptorResources: readonly string[], requested?: readonly string[]): void {
    if (requested !== undefined && !equalResources([...descriptorResources].sort(), [...requested].sort())) {
        fail('CAPABILITY_BINDING_MISMATCH');
    }
}

function enqueueOperation<T>(
    state: { tail: Promise<unknown> },
    operation: () => Promise<T>,
): Promise<T> {
    const next = state.tail.catch(() => undefined).then(operation);
    state.tail = next;
    void next.catch(() => { /* each caller receives its own result */ });
    return next;
}

function encodeLeaseEvidence(session: ExclusionSession): string {
    const evidence = JSON.stringify(serializeSession(session));
    const encoded = Buffer.from(evidence, 'utf8').toString('base64url');
    if (Buffer.byteLength(encoded, 'ascii') > MAX_EVIDENCE_BYTES) fail('ADAPTER_RESPONSE_INVALID');
    return encoded;
}

async function runSupervisor(options: SupervisorOptions, storageFactory: SupervisorStorageFactory): Promise<void> {
    const descriptor = await readBridgeDescriptor(options.descriptorFd);
    if (descriptor.entryPoint !== options.entryPoint || descriptor.lease !== null) {
        fail('CAPABILITY_BINDING_MISMATCH');
    }
    const resources = deriveEntryPointResources({
        entryPoint: descriptor.entryPoint,
        role: descriptor.role ?? undefined,
        resources: descriptor.resources,
    });
    const storage = storageFactory(descriptor.bucket);
    let session: ExclusionSession = await acquireExclusion({
        storage,
        rawStorage: storage,
        resources,
        epochDigest: descriptor.epochDigest,
        ownerDigest: descriptor.ownerDigest,
        leaseMs: descriptor.leaseMs,
        legacyServices: descriptor.legacyServices,
    });
    let released = false;
    let fatalError: EpochError | undefined;
    const channelNonce = randomBytes(32).toString('hex');
    const operationState = { tail: Promise.resolve() as Promise<unknown> };
    const respond = (id: string, value: string, evidence?: string): void => {
        process.stdout.write(id + ' ' + channelNonce + ' ' + value + (evidence === undefined ? '' : ' ' + evidence) + '\n');
    };
    const renewalEveryMs = Math.max(50, Math.floor(descriptor.leaseMs / 3));
    const heartbeat = setInterval(() => {
        void enqueueOperation(operationState, async () => {
            if (fatalError !== undefined || released) return;
            session = await renewExclusion(session);
        }).catch(error => {
            if (error instanceof EpochError) fatalError ??= error;
            else fatalError ??= new EpochError('LOCK_LOST');
        });
    }, renewalEveryMs);
    process.stdout.write('READY ' + channelNonce + '\n');
    try {
        const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
        for await (const line of input) {
            let request: ControlRequest | undefined;
            try {
                request = parseRequest(line, channelNonce);
                const currentRequest = request;
                await enqueueOperation(operationState, async () => {
                    if (fatalError !== undefined) throw fatalError;
                    if (currentRequest.op === 'assert') {
                        assertParentBinding(resources, currentRequest.resources);
                        await assertExclusion(session);
                        return;
                    }
                    if (currentRequest.op === 'renew') {
                        session = await renewExclusion(session);
                        return;
                    }
                    if (currentRequest.op === 'adopt') {
                        const nested = deriveEntryPointResources({
                            entryPoint: currentRequest.entryPoint,
                            role: currentRequest.role,
                            resources: currentRequest.resources,
                        });
                        if (nested.some(resource => !resources.includes(resource))) {
                            fail('CAPABILITY_BINDING_MISMATCH');
                        }
                        await assertExclusion(session);
                        return;
                    }
                    await releaseExclusion(session);
                    released = true;
                });
                const response = currentRequest.op === 'release'
                    ? 'RELEASED'
                    : request.op === 'renew'
                        ? 'RENEWED'
                            : currentRequest.op === 'adopt'
                            ? 'ADOPTED'
                            : 'ASSERT_OK';
                respond(
                    currentRequest.id,
                    response,
                    currentRequest.op === 'release' ? undefined : encodeLeaseEvidence(session),
                );
                if (currentRequest.op === 'release') break;
            } catch (error) {
                if (error instanceof EpochError) {
                    if (request !== undefined) respond(request.id, 'ERR ' + error.code);
                    else process.stdout.write('ERR ADAPTER_REQUEST_INVALID\n');
                    if (request?.op === 'release' || error.code === 'LOCK_LOST' || error.code === 'ABORTED_EPOCH') break;
                } else {
                    if (request !== undefined) respond(request.id, 'ERR ADAPTER_REQUEST_INVALID');
                    else process.stdout.write('ERR ADAPTER_REQUEST_INVALID\n');
                    break;
                }
            }
        }
        input.close();
    } finally {
        clearInterval(heartbeat);
        try {
            await operationState.tail;
            if (!released) await releaseExclusion(session);
        } catch {
            if (!released) process.exitCode = 2;
        }
    }
}

export async function runExclusionSupervisor(argv: readonly string[]): Promise<void> {
    await runSupervisor(parseArguments(argv), bucket => createAuthenticatedGcsJournalStorage({ bucket }));
}

export async function runExclusionSupervisorWithStorage(
    argv: readonly string[],
    storageFactory: SupervisorStorageFactory,
): Promise<void> {
    await runSupervisor(parseArguments(argv), storageFactory);
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedScript) {
    void runExclusionSupervisor(process.argv.slice(2)).catch((error: unknown) => {
        if (error instanceof EpochError) {
            process.stdout.write('ERR ' + error.code + '\n');
            process.stderr.write(error.code + '\n');
            process.exitCode = 2;
        } else {
            process.stdout.write('ERR ADAPTER_REQUEST_INVALID\n');
            process.stderr.write('ADAPTER_REQUEST_INVALID\n');
            process.exitCode = 2;
        }
    });
}
