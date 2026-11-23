import 'server-only';

import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ANALYSIS_V2_DEV_ARCHIVE_MAX_FRAGMENTS } from '@/lib/services/analysis/v2-media-artifact-store';
import { archivedBliteOutcomeSchema } from '@/lib/services/precheckout/blite-contract';
import {
    devLiveStandardCaptureConfigured,
    devLiveStandardTarget,
    devLiveStandardReplayConfiguration,
    type DevLiveApproval,
} from './live-approval';
import { createDevStandardArchiveStore, DevStandardArchiveStorageRetryError } from './standard-archive-store';

export { DevStandardArchiveStorageRetryError } from './standard-archive-store';

type ArchiveInputIdentity = readonly (string | number | boolean | null)[];
type ArchiveCoverage = Readonly<{ profileBatches: readonly number[] }>;
const POINTER_KIND = 'capture-coverage-v1';
const COVERAGE_KIND = 'capture-summary-v1';
const PROFILE_PROOF_KIND = 'source-profile-proof-v1';
const targetProfileJob = 'track:target-evidence:collect';
const POINTER_HASH = /^[a-f0-9]{64}$/;
const ARCHIVE_LIFETIME_MS = 24 * 60 * 60_000;
type ArchiveStore = ReturnType<typeof createDevStandardArchiveStore>;
type ArchiveReader = Pick<ArchiveStore, 'readFragment'>;
type SealedArchive = NonNullable<Awaited<ReturnType<ArchiveStore['openSealedArchive']>>>;

const resultImageManifest = z.object({
    imageCount: z.number().int().nonnegative(),
    expectedRows: z.number().int().positive(),
    orderedManifestHash: z.string().regex(POINTER_HASH),
    imageInputs: z.array(z.tuple([
        z.enum(['target', 'female', 'private']),
        z.string().max(256),
        z.string().regex(POINTER_HASH).nullable(),
    ])).min(1).max(ANALYSIS_V2_DEV_ARCHIVE_MAX_FRAGMENTS),
}).strict().refine(data => (
    data.expectedRows === data.imageInputs.length
    && data.imageCount === data.imageInputs.filter(input => input[2] !== null).length
    && data.imageInputs.filter(input => input[0] === 'target').length === 1
    && new Set(data.imageInputs.map(inputKey)).size === data.imageInputs.length
));

export class DevStandardArchiveError extends Error {
    constructor() {
        super('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        this.name = 'DevStandardArchiveError';
    }
}

interface DevStandardArchiveSession {
    readonly mode: 'capture' | 'replay';
    readonly target?: string;
    ready(): boolean;
    beginPreflightCapture(): Promise<void>;
    capture(kind: string, identity: ArchiveInputIdentity, value: unknown): Promise<void>;
    load(kind: string, identity: ArchiveInputIdentity): Promise<unknown>;
    find(kind: string, identity: ArchiveInputIdentity): Promise<{ value: unknown } | null>;
    fail(): never;
    seal(coverage: ArchiveCoverage): Promise<void>;
}

const workerArchive = new AsyncLocalStorage<DevStandardArchiveSession>();

export function currentDevStandardArchive(): DevStandardArchiveSession | null {
    return workerArchive.getStore() ?? null;
}

export async function beginDevStandardArchivePreflight(): Promise<void> {
    const archive = currentDevStandardArchive();
    if (archive?.mode === 'capture') await archive.beginPreflightCapture();
}

function fail(error?: unknown): never {
    if (error instanceof DevStandardArchiveStorageRetryError) throw error;
    throw new DevStandardArchiveError();
}

export async function captureDevStandardInput(
    kind: string,
    identity: ArchiveInputIdentity,
    value: unknown,
): Promise<void> {
    const archive = currentDevStandardArchive();
    if (archive?.mode === 'capture') await archive.capture(kind, identity, value);
}

export async function sealDevStandardArchive(coverage: ArchiveCoverage): Promise<void> {
    const archive = currentDevStandardArchive();
    if (archive?.mode === 'capture') await archive.seal(coverage);
}

function inputKey(identity: ArchiveInputIdentity): string {
    return createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex');
}

function coverageKey(kind: string, identity: ArchiveInputIdentity, target: string): string | null {
    if (identity[0] !== target) return null;
    const hasOrdinal = kind === 'relationship-side-v1'
        || kind === 'candidate-profile-batch-v1'
        || kind === PROFILE_PROOF_KIND;
    const single = kind === 'preflight-profile-v1'
        || kind === 'fresh-profile-v1'
        || kind === 'formal-target-profile-v2'
        || kind === 'preflight-blite-policy-v1'
        || kind === 'target-evidence-v1'
        || kind === 'reverse-coverage-v1'
        || kind === 'result-image-manifest-v1';
    if (hasOrdinal && identity.length >= 2) return inputKey([kind, identity[1]!]);
    return single ? inputKey([kind]) : null;
}

function requiredCoverage(coverage: ArchiveCoverage): ReadonlyArray<readonly [string, (number | string)?]> {
    if (coverage.profileBatches.length > 32 || coverage.profileBatches.some(
        (batch, index) => batch !== index,
    )) return fail();
    return [
        ['preflight-profile-v1'],
        ['fresh-profile-v1'],
        ['relationship-side-v1', 'followers'],
        ['relationship-side-v1', 'following'],
        ['formal-target-profile-v2'],
        ['preflight-blite-policy-v1'],
        [PROFILE_PROOF_KIND, targetProfileJob],
        ['target-evidence-v1'],
        ['reverse-coverage-v1'],
        ['result-image-manifest-v1'],
        ...coverage.profileBatches.flatMap(batch => [
            ['candidate-profile-batch-v1', batch] as const,
            [PROFILE_PROOF_KIND, `track:profiles:batch:${batch}`] as const,
        ]),
    ];
}

async function verifyCoverage(store: ArchiveReader, coverage: ArchiveCoverage, target: string): Promise<void> {
    await Promise.all(requiredCoverage(coverage).map(async identity => {
        const [kind, ordinal] = identity;
        const pointer = await store.readFragment({
            kind: POINTER_KIND,
            inputKey: inputKey(ordinal === undefined ? [kind] : [kind, ordinal]),
        });
        if (typeof pointer?.value !== 'string' || !POINTER_HASH.test(pointer.value)) return fail();
        const fragment = await store.readFragment({ kind, inputKey: pointer.value });
        if (!fragment) return fail();
        if (kind === 'preflight-blite-policy-v1') {
            if (typeof fragment.value !== 'boolean') return fail();
            if (fragment.value) {
                const preview = await store.readFragment({
                    kind: 'preflight-blite-outcome-v1', inputKey: inputKey([target]),
                });
                if (!archivedBliteOutcomeSchema.safeParse(preview?.value).success) return fail();
            }
        }
        if (kind === PROFILE_PROOF_KIND && !z.object({
            providerOperationKey: z.string().regex(/^[a-z][a-z0-9:._-]{1,159}$/),
            providerInputHash: z.string().regex(POINTER_HASH),
        }).strict().safeParse(fragment.value).success) return fail();
        if (kind === 'result-image-manifest-v1') {
            const parsed = resultImageManifest.safeParse(fragment.value);
            if (!parsed.success) return fail();
            const inputs = parsed.data.imageInputs;
            for (let offset = 0; offset < inputs.length; offset += 8) {
                await Promise.all(inputs.slice(offset, offset + 8).map(async input => {
                    const image = await store.readFragment({ kind: 'result-image-v1', inputKey: inputKey(input) });
                    if (!image || (input[2] === null && image.value !== 'source_missing')) fail();
                }));
            }
        }
    }));
}

const aiImageSelection = z.array(z.tuple([
    z.string().regex(/^ai-stage-policy-v[0-9.]+$/),
    z.string().regex(POINTER_HASH),
    z.number().int().nonnegative(),
])).max(128);

async function verifyMediaSelectionMembership(reader: SealedArchive): Promise<void> {
    const images = new Set(reader.inputKeys('ai-image'));
    const selections = reader.inputKeys('ai-image-selection-v1');
    const referenced = new Set<string>();
    for (let offset = 0; offset < selections.length; offset += 8) {
        await Promise.all(selections.slice(offset, offset + 8).map(async key => {
            const fragment = await reader.readFragment({ kind: 'ai-image-selection-v1', inputKey: key });
            const parsed = aiImageSelection.safeParse(fragment?.value);
            if (!parsed.success) return fail();
            for (const selection of parsed.data) {
                const imageKey = inputKey(selection);
                if (!images.has(imageKey)) fail();
                referenced.add(imageKey);
            }
        }));
    }
    if (referenced.size !== images.size) fail();
}

function storeForEnvironment(env: Record<string, string | undefined>): ArchiveStore {
    const bucketName = env.DEV_LIVE_STANDARD_ARCHIVE_BUCKET;
    const slot = env.DEV_LIVE_STANDARD_ARCHIVE_SLOT;
    const key = env.DEV_LIVE_STANDARD_ARCHIVE_KEY;
    if (!bucketName || !slot || !key) return fail();
    return createDevStandardArchiveStore({ bucketName, slot, key });
}

async function readArchiveInput(
    store: ArchiveReader,
    kind: string,
    identity: ArchiveInputIdentity,
): Promise<unknown> {
    try {
        const result = await store.readFragment({ kind, inputKey: inputKey(identity) });
        if (result) return result.value;
    } catch (error) {
        return fail(error);
    }
    return fail();
}

function readonlySession(reader: ArchiveReader, target: string): DevStandardArchiveSession {
    return {
        mode: 'replay',
        target,
        fail,
        ready: () => true,
        beginPreflightCapture: async () => fail(),
        load: (kind, identity) => readArchiveInput(reader, kind, identity),
        find: async () => fail(),
        capture: async () => fail(),
        seal: async () => fail(),
    };
}

/** Open a sealed archive for a registered QA target. This grants no Dev analysis admission. */
export async function withVerifiedDevStandardArchive<T>(
    target: string,
    operation: (coverage: ArchiveCoverage) => T,
    env: Record<string, string | undefined> = process.env,
): Promise<T> {
    let reader: ArchiveReader;
    let coverage: ArchiveCoverage;
    try {
        const store = storeForEnvironment(env);
        const opened = await store.openSealedArchive();
        if (opened?.binding.target !== target) return fail();
        reader = opened;
        const summary = await readArchiveInput(reader, COVERAGE_KIND, [target]);
        if (!Array.isArray(summary) || summary.some(batch => !Number.isInteger(batch))) return fail();
        coverage = { profileBatches: summary };
        await verifyCoverage(reader, coverage, target);
        await verifyMediaSelectionMembership(opened);
        if (!(await store.verifySealedMembership())) return fail();
    } catch (error) {
        return fail(error);
    }
    return workerArchive.run(readonlySession(reader, target), () => operation(coverage));
}

/** Called within workers after the registered Dev and delivery authorization checks. */
export async function withDevStandardArchiveApproval<T>(
    approval: DevLiveApproval,
    operation: () => T,
    env: Record<string, string | undefined> = process.env,
): Promise<T> {
    if (approval.planId !== 'standard') return operation();
    const config = devLiveStandardReplayConfiguration(env);
    const replay = approval.archiveReplay;
    if (replay || config) {
        const expiresAt = replay ? Date.parse(replay.expiresAt) : NaN;
        if (!replay || !config || !Number.isFinite(expiresAt) || expiresAt <= Date.now()
            || config.sourceGrantId !== replay.sourceGrantId || config.slotHash !== replay.slotHash
            || devLiveStandardTarget(env) !== approval.targetInstagramId) return fail();
        let opened: SealedArchive | null;
        try {
            opened = await storeForEnvironment(env).openSealedArchive();
        } catch (error) {
            return fail(error);
        }
        if (opened?.binding.grantId !== replay.sourceGrantId
            || opened.binding.target !== approval.targetInstagramId
            || opened.binding.expiresAt !== expiresAt) return fail();
        return workerArchive.run(readonlySession(opened, approval.targetInstagramId), operation);
    }
    if (env.DEV_LIVE_STANDARD_COLLECTION_MODE !== 'archive_capture') return operation();
    const role = env.DEV_LIVE_WORKLOAD;
    if ((role !== 'preflight' && role !== 'paid') || !devLiveStandardCaptureConfigured(env)
        || devLiveStandardTarget(env) !== approval.targetInstagramId) return fail();
    const approvedAt = Date.parse(approval.approvedAt);
    const notBefore = Date.parse(env.DEV_LIVE_STANDARD_ARCHIVE_APPROVAL_NOT_BEFORE ?? '');
    if (!Number.isFinite(approvedAt) || approvedAt < notBefore || approvedAt > Date.now()) return fail();
    const expected = {
        grantId: approval.id,
        target: approval.targetInstagramId,
        expiresAt: approvedAt + ARCHIVE_LIFETIME_MS,
    };
    let store: ArchiveStore;
    let bound = false;
    try {
        store = storeForEnvironment(env);
        const binding = await store.readBinding();
        if (binding) {
            if (binding.grantId !== expected.grantId
                || binding.target !== expected.target
                || binding.expiresAt !== expected.expiresAt) return fail();
            bound = true;
        } else if (role === 'paid') return fail();
    } catch (error) {
        return fail(error);
    }
    return workerArchive.run({
        mode: 'capture',
        target: approval.targetInstagramId,
        fail,
        ready: () => bound,
        async beginPreflightCapture() {
            if (role !== 'preflight') return fail();
            if (bound) return;
            try {
                await store.bindCapture(expected);
                bound = true;
            } catch (error) {
                return fail(error);
            }
        },
        async capture(kind, identity, value) {
            if (!bound) return fail();
            try {
                const key = inputKey(identity);
                await store.writeFragment({ kind, inputKey: key, value });
                const pointer = coverageKey(kind, identity, approval.targetInstagramId);
                if (pointer) await store.writeFragment({
                    kind: POINTER_KIND,
                    inputKey: pointer,
                    value: key,
                });
            } catch (error) {
                return fail(error);
            }
        },
        load: (kind, identity) => bound ? readArchiveInput(store, kind, identity) : fail(),
        async find(kind, identity) {
            if (!bound) return fail();
            try {
                return await store.readFragment({ kind, inputKey: inputKey(identity) });
            } catch (error) {
                return fail(error);
            }
        },
        async seal(coverage) {
            if (!bound || role !== 'paid') return fail();
            try {
                await verifyCoverage(store, coverage, approval.targetInstagramId);
                await store.writeFragment({
                    kind: COVERAGE_KIND,
                    inputKey: inputKey([approval.targetInstagramId]),
                    value: coverage.profileBatches,
                });
                await store.seal(verifyMediaSelectionMembership);
            } catch (error) {
                return fail(error);
            }
        },
    }, operation);
}
