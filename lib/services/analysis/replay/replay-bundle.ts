import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
    close as closeDescriptor,
    constants as fileConstants,
    fstat as statDescriptor,
    openSync,
    write as writeDescriptor,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { link, lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import type { FileHandle as NodeFileHandle } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { replaySourceLineageSchema } from './replay-source-lineage';

const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_PLAINTEXT_BYTES = 256 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = Math.ceil(MAX_PLAINTEXT_BYTES * 4 / 3) + 4_096;
const MAX_MEDIA_BYTES = 192 * 1024 * 1024;
const MAX_PROFILES = 1_500;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const ENVELOPE_VERSION = 1;
const replayArtifactOwnershipBrand = Symbol('replay-artifact-ownership');

const jpegBase64Schema = z.string().min(4).max(12 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const usernameSchema = z.string().regex(/^[a-z0-9._]{1,30}$/);
const selectionIdSchema = z.string().min(1).max(255);
const canonicalMediaSchema = z.object({
    selectionId: selectionIdSchema,
    kind: z.enum(['profile', 'feed']),
    postId: z.string().min(1).max(200).optional(),
    caption: z.string().max(5_000).nullable().optional(),
    jpegBase64: jpegBase64Schema,
}).strict();
const bundleSchema = z.object({
    schemaVersion: z.literal(1),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    capture: z.object({
        requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        sourceLineage: replaySourceLineageSchema,
    }).strict(),
    profiles: z.array(z.object({
        ordinal: z.number().int().positive(),
        isPrivate: z.boolean(),
        username: usernameSchema,
        fullName: z.string().max(200).nullable(),
        bio: z.string().max(2_200).nullable().optional(),
        media: z.array(canonicalMediaSchema).max(12),
        triageSelectionIds: z.array(selectionIdSchema).max(9),
        featureSelectionIds: z.array(selectionIdSchema).max(12),
        resolverSelectionIds: z.array(selectionIdSchema).max(9),
        captions: z.array(z.object({
            evidenceRefId: z.string().min(1).max(240),
            selectionId: selectionIdSchema,
            text: z.string().max(5_000),
        }).strict()).max(11),
        coverage: z.object({
            selectedCount: z.number().int().min(0).max(12),
            normalizedCount: z.number().int().min(0).max(12),
            failures: z.array(z.object({
                selectionId: selectionIdSchema,
                reason: z.string().regex(/^[a-z_]{1,64}$/),
                disposition: z.enum(['transient', 'permanent']),
            }).strict()).max(12),
        }).strict(),
    }).strict()).max(MAX_PROFILES),
    evidence: z.object({
        relationship: z.array(z.object({
            username: usernameSchema,
            side: z.enum(['follower', 'following']),
            isPrivate: z.boolean(),
            isVerified: z.boolean(),
            fullName: z.string().max(200).nullable(),
            ordinal: z.number().int().positive(),
        }).strict()).max(5_000),
        targetInteractions: z.array(z.object({
            actorUsername: usernameSchema,
            postId: z.string().min(1).max(200),
            signal: z.enum(['target_post_like', 'target_post_comment']),
            sourceInteractionId: z.string().min(1).max(255),
            occurredAt: z.string().datetime({ offset: true }).nullable(),
            content: z.string().max(1_000).nullable(),
        }).strict()).max(10_000),
        reverseInteractions: z.array(z.object({
            candidateUsername: usernameSchema,
            postId: z.string().min(1).max(200),
            status: z.enum(['observed', 'not_observed', 'not_collected']),
        }).strict()).max(10_000),
    }).strict(),
}).strict();

export type AnalysisV2ReplayBundle = z.infer<typeof bundleSchema>;

export class AnalysisV2ReplayBundleError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'AnalysisV2ReplayBundleError';
    }
}

type ReplayArtifactIdentity = {
    readonly device: number;
    readonly inode: number;
};

export type ReplayArtifactOwnership = ReplayArtifactIdentity & {
    readonly path: string;
    readonly [replayArtifactOwnershipBrand]: true;
};

type ActiveReplayArtifactCreation = {
    readonly path: string;
    readonly handle: ReplayArtifactFileHandle;
    identity?: ReplayArtifactIdentity;
    aborted: boolean;
    cleanup?: Promise<void>;
};

type ReplayArtifactCreationState = {
    active?: ActiveReplayArtifactCreation;
};

export interface ReplayArtifactCreationScope {
    cleanupActive(): Promise<void>;
}

export interface ReplayArtifactWriteDependencies {
    scope?: ReplayArtifactCreationScope;
    writeFile?: (handle: ReplayArtifactFileHandle, bytes: Buffer) => Promise<void>;
    close?: (handle: ReplayArtifactFileHandle) => Promise<void>;
}

export interface ReplayArtifactReadDependencies {
    readFile?: (handle: NodeFileHandle, path: string) => Promise<Buffer>;
}

const replayArtifactCreationStates = new WeakMap<ReplayArtifactCreationScope, ReplayArtifactCreationState>();

export interface ReplayArtifactFileHandle {
    stat(): Promise<Stats>;
    writeFile(bytes: Buffer): Promise<void>;
    close(): Promise<void>;
}

function bundleError(code: string): never {
    throw new AnalysisV2ReplayBundleError(code);
}

function validatePathSuffix(path: string, suffix: '.enc' | '.key'): void {
    if (!path || basename(path).length <= suffix.length || !path.endsWith(suffix)) {
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');
    }
}

async function assertPrivateFile(path: string): Promise<void> {
    let file;
    try { file = await lstat(path); } catch { bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_MISSING'); }
    if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0) {
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PERMISSIONS');
    }
}

function identityOf(file: { dev: number; ino: number }): ReplayArtifactIdentity {
    return { device: file.dev, inode: file.ino };
}

function sameIdentity(left: ReplayArtifactIdentity, right: ReplayArtifactIdentity): boolean {
    return left.device === right.device && left.inode === right.inode;
}

function ownershipToken(
    path: string,
    identity: ReplayArtifactIdentity,
): ReplayArtifactOwnership {
    return Object.freeze({
        path: resolve(path),
        ...identity,
        [replayArtifactOwnershipBrand]: true as const,
    });
}

async function restoreUnownedQuarantine(
    quarantinePath: string,
    originalPath: string,
): Promise<void> {
    try {
        await link(quarantinePath, originalPath);
    } catch {
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_OWNERSHIP_RACE');
    }
    await unlink(quarantinePath);
}

async function unlinkIfIdentityMatches(
    path: string,
    identity: ReplayArtifactIdentity,
    beforeDelete?: (path: string) => Promise<void>,
): Promise<void> {
    let file;
    try {
        file = await lstat(path);
    } catch (error) {
        if (
            error instanceof Error
            && 'code' in error
            && error.code === 'ENOENT'
        ) return;
        throw error;
    }
    if (
        !file.isFile()
        || file.isSymbolicLink()
        || !sameIdentity(identity, identityOf(file))
    ) return;
    await beforeDelete?.(path);
    const quarantinePath = join(
        dirname(path),
        `.analysis-v2-replay-delete-${randomBytes(16).toString('hex')}.tmp`,
    );
    try {
        await rename(path, quarantinePath);
    } catch (error) {
        if (
            error instanceof Error
            && 'code' in error
            && error.code === 'ENOENT'
        ) return;
        throw error;
    }
    const moved = await lstat(quarantinePath);
    if (
        !moved.isFile()
        || moved.isSymbolicLink()
        || !sameIdentity(identity, identityOf(moved))
    ) {
        await restoreUnownedQuarantine(quarantinePath, path);
        return;
    }
    await unlink(quarantinePath);
}

async function cleanupActiveCreation(record: ActiveReplayArtifactCreation): Promise<void> {
    if (record.cleanup) return record.cleanup;
    record.aborted = true;
    record.cleanup = (async () => {
        let identity = record.identity;
        if (!identity) {
            try {
                identity = identityOf(await record.handle.stat());
                record.identity = identity;
            } catch {
                // Without a matching file identity, deleting by path would be unsafe.
            }
        }
        try {
            await record.handle.close();
        } catch {
            // An interrupted or failed close still permits identity-checked unlink.
        }
        if (identity) await unlinkIfIdentityMatches(record.path, identity);
    })();
    return record.cleanup;
}

export function createReplayArtifactCreationScope(): ReplayArtifactCreationScope {
    const state: ReplayArtifactCreationState = {};
    const scope: ReplayArtifactCreationScope = {
        cleanupActive: async () => {
            const record = state.active;
            if (!record) return;
            await cleanupActiveCreation(record);
            if (state.active === record) state.active = undefined;
        },
    };
    replayArtifactCreationStates.set(scope, state);
    return scope;
}

function creationState(scope: ReplayArtifactCreationScope): ReplayArtifactCreationState {
    const state = replayArtifactCreationStates.get(scope);
    if (!state) bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_OWNERSHIP_INVALID');
    return state;
}

function openExclusiveReplayArtifact(path: string): ReplayArtifactFileHandle {
    const descriptor = openSync(path, 'wx', 0o600);
    let closed = false;
    return {
        stat: () => new Promise<Stats>((resolveStat, rejectStat) => {
            statDescriptor(descriptor, (error, file) => {
                if (error) rejectStat(error);
                else resolveStat(file);
            });
        }),
        writeFile: async bytes => {
            let offset = 0;
            while (offset < bytes.byteLength) {
                const written = await new Promise<number>((resolveWrite, rejectWrite) => {
                    writeDescriptor(
                        descriptor,
                        bytes,
                        offset,
                        bytes.byteLength - offset,
                        null,
                        (error, count) => {
                            if (error) rejectWrite(error);
                            else resolveWrite(count);
                        },
                    );
                });
                if (written <= 0) bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_WRITE_FAILED');
                offset += written;
            }
        },
        close: () => {
            if (closed) return Promise.resolve();
            closed = true;
            return new Promise<void>((resolveClose, rejectClose) => {
                closeDescriptor(descriptor, error => {
                    if (error) rejectClose(error);
                    else resolveClose();
                });
            });
        },
    };
}

async function securelyCreateReplayArtifact(
    path: string,
    bytes: Buffer,
    dependencies: ReplayArtifactWriteDependencies = {},
): Promise<ReplayArtifactOwnership> {
    const scope = dependencies.scope ?? createReplayArtifactCreationScope();
    const state = creationState(scope);
    if (state.active) bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_CREATION_ACTIVE');
    // A synchronous O_EXCL open makes ownership visible to signal cleanup before
    // the event loop can dispatch a signal between file creation and registration.
    const handle = openExclusiveReplayArtifact(path);
    const record: ActiveReplayArtifactCreation = { path: resolve(path), handle, aborted: false };
    state.active = record;
    try {
        record.identity = identityOf(await handle.stat());
        if (record.aborted) bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_CREATION_INTERRUPTED');
        await (dependencies.writeFile ?? ((file, payload) => file.writeFile(payload)))(handle, bytes);
        if (record.aborted) bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_CREATION_INTERRUPTED');
        await (dependencies.close ?? (file => file.close()))(handle);
        if (record.aborted) bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_CREATION_INTERRUPTED');
        state.active = undefined;
        return ownershipToken(record.path, record.identity);
    } catch (error) {
        await cleanupActiveCreation(record);
        if (state.active === record) state.active = undefined;
        throw error;
    }
}

async function assertPrivateDirectory(path: string): Promise<void> {
    const directory = await stat(path);
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) {
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PERMISSIONS');
    }
}

async function assertExplicitReplayTempDirectory(path: string): Promise<void> {
    let directory: string;
    let temporaryRoot: string;
    try {
        [directory, temporaryRoot] = await Promise.all([realpath(path), realpath(tmpdir())]);
    } catch { bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID'); }
    if (directory === temporaryRoot || !directory.startsWith(`${temporaryRoot}${sep}`)) {
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');
    }
    await assertPrivateDirectory(directory);
}

function hash(value: Buffer): string {
    return createHash('sha256').update(value).digest('hex');
}

function canonicalPayload(
    bundle: AnalysisV2ReplayBundle,
    now: number,
    allowExpired = false,
): Buffer {
    const parsed = bundleSchema.safeParse(bundle);
    if (!parsed.success) bundleError('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
    const created = Date.parse(parsed.data.createdAt);
    const expires = Date.parse(parsed.data.expiresAt);
    if (
        !Number.isFinite(created)
        || !Number.isFinite(expires)
        || expires <= created
        || expires - created > MAX_TTL_MS
        || (!allowExpired && expires <= now)
    ) {
        bundleError('ANALYSIS_V2_REPLAY_BUNDLE_EXPIRED');
    }
    let mediaBytes = 0;
    for (const profile of parsed.data.profiles) {
        for (const media of profile.media) {
            mediaBytes += Buffer.byteLength(media.jpegBase64, 'base64');
            if (mediaBytes > MAX_MEDIA_BYTES) bundleError('ANALYSIS_V2_REPLAY_BUNDLE_LIMIT');
        }
    }
    const payload = Buffer.from(JSON.stringify(parsed.data), 'utf8');
    if (payload.byteLength > MAX_PLAINTEXT_BYTES) bundleError('ANALYSIS_V2_REPLAY_BUNDLE_LIMIT');
    return payload;
}

function envelope(payload: Buffer, key: Buffer): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.from(JSON.stringify({
        v: ENVELOPE_VERSION,
        iv: iv.toString('base64'),
        tag: tag.toString('base64'),
        ciphertext: encrypted.toString('base64'),
        sha256: hash(payload),
    }), 'utf8');
}

function decryptEnvelope(raw: Buffer, key: Buffer): Buffer {
    let parsed: { v: number; iv: string; tag: string; ciphertext: string; sha256: string };
    try { parsed = JSON.parse(raw.toString('utf8')) as typeof parsed; } catch { return bundleError('ANALYSIS_V2_REPLAY_BUNDLE_AUTH_FAILED'); }
    if (parsed.v !== ENVELOPE_VERSION || !/^[a-f0-9]{64}$/.test(parsed.sha256 ?? '')) {
        return bundleError('ANALYSIS_V2_REPLAY_BUNDLE_AUTH_FAILED');
    }
    try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parsed.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
        const payload = Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, 'base64')), decipher.final()]);
        if (hash(payload) !== parsed.sha256) return bundleError('ANALYSIS_V2_REPLAY_BUNDLE_AUTH_FAILED');
        return payload;
    } catch { return bundleError('ANALYSIS_V2_REPLAY_BUNDLE_AUTH_FAILED'); }
}

async function readPrivateReplayArtifact(
    path: string,
    maxBytes: number,
    limitCode: string,
    dependencies: ReplayArtifactReadDependencies = {},
): Promise<{ bytes: Buffer; ownership: ReplayArtifactOwnership }> {
    let handle;
    try {
        handle = await open(
            path,
            fileConstants.O_RDONLY | (fileConstants.O_NOFOLLOW ?? 0),
        );
    } catch (error) {
        if (
            error instanceof Error
            && 'code' in error
            && error.code === 'ENOENT'
        ) bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_MISSING');
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PERMISSIONS');
    }
    try {
        const file = await handle.stat();
        if (!file.isFile() || (file.mode & 0o077) !== 0) {
            bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PERMISSIONS');
        }
        if (file.size > maxBytes) bundleError(limitCode);
        const identity = identityOf(file);
        return {
            bytes: await (
                dependencies.readFile
                ?? (async (fileHandle: NodeFileHandle) => {
                    const bytes = Buffer.alloc(file.size);
                    let offset = 0;
                    while (offset < bytes.byteLength) {
                        const result = await fileHandle.read(
                            bytes,
                            offset,
                            bytes.byteLength - offset,
                            offset,
                        );
                        if (result.bytesRead === 0) break;
                        offset += result.bytesRead;
                    }
                    return offset === bytes.byteLength
                        ? bytes
                        : bytes.subarray(0, offset);
                })
            )(handle, path),
            ownership: ownershipToken(path, identity),
        };
    } finally {
        await handle.close();
    }
}

async function readKey(
    keyPath: string,
    dependencies: ReplayArtifactReadDependencies = {},
): Promise<{ key: Buffer; ownership: ReplayArtifactOwnership }> {
    validatePathSuffix(keyPath, '.key');
    const artifact = await readPrivateReplayArtifact(
        keyPath,
        KEY_BYTES,
        'ANALYSIS_V2_REPLAY_KEY_INVALID',
        dependencies,
    );
    if (artifact.bytes.byteLength !== KEY_BYTES) bundleError('ANALYSIS_V2_REPLAY_KEY_INVALID');
    return { key: artifact.bytes, ownership: artifact.ownership };
}

export async function createReplayKeyFile(
    keyPath: string,
    dependencies: ReplayArtifactWriteDependencies = {},
): Promise<ReplayArtifactOwnership> {
    validatePathSuffix(keyPath, '.key');
    await assertExplicitReplayTempDirectory(dirname(keyPath));
    return securelyCreateReplayArtifact(keyPath, randomBytes(KEY_BYTES), dependencies);
}

export async function writeReplayBundle(input: {
    bundle: AnalysisV2ReplayBundle;
    bundlePath: string;
    keyPath: string;
    now?: number;
    artifactWrite?: ReplayArtifactWriteDependencies;
}): Promise<ReplayArtifactOwnership> {
    validatePathSuffix(input.bundlePath, '.enc');
    const now = input.now ?? Date.now();
    const payload = canonicalPayload(input.bundle, now);
    const { key } = await readKey(input.keyPath);
    await assertExplicitReplayTempDirectory(dirname(input.bundlePath));
    return securelyCreateReplayArtifact(
        input.bundlePath,
        envelope(payload, key),
        input.artifactWrite,
    );
}

export type AuthenticatedReplayBundle = {
    bundle: AnalysisV2ReplayBundle;
    expired: boolean;
    ownedBundle: ReplayArtifactOwnership;
    ownedKey: ReplayArtifactOwnership;
};

export async function readAuthenticatedReplayBundle(input: {
    bundlePath: string;
    keyPath: string;
    now?: number;
    artifactRead?: ReplayArtifactReadDependencies;
}): Promise<AuthenticatedReplayBundle> {
    validatePathSuffix(input.bundlePath, '.enc');
    validatePathSuffix(input.keyPath, '.key');
    if (dirname(resolve(input.bundlePath)) !== dirname(resolve(input.keyPath))) {
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');
    }
    await assertExplicitReplayTempDirectory(dirname(input.bundlePath));
    const bundleArtifact = await readPrivateReplayArtifact(
        input.bundlePath,
        MAX_ENVELOPE_BYTES,
        'ANALYSIS_V2_REPLAY_BUNDLE_LIMIT',
        input.artifactRead,
    );
    const raw = bundleArtifact.bytes;
    const keyArtifact = await readKey(input.keyPath, input.artifactRead);
    const decrypted = decryptEnvelope(raw, keyArtifact.key);
    let json: unknown;
    try { json = JSON.parse(decrypted.toString('utf8')); } catch { return bundleError('ANALYSIS_V2_REPLAY_BUNDLE_INVALID'); }
    const parsed = bundleSchema.safeParse(json);
    if (!parsed.success) bundleError('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
    const now = input.now ?? Date.now();
    canonicalPayload(parsed.data, now, true);
    return {
        bundle: parsed.data,
        expired: Date.parse(parsed.data.expiresAt) <= now,
        ownedBundle: bundleArtifact.ownership,
        ownedKey: keyArtifact.ownership,
    };
}

export async function readReplayBundle(input: {
    bundlePath: string;
    keyPath: string;
    now?: number;
}): Promise<AnalysisV2ReplayBundle> {
    const authenticated = await readAuthenticatedReplayBundle(input);
    if (authenticated.expired) bundleError('ANALYSIS_V2_REPLAY_BUNDLE_EXPIRED');
    return authenticated.bundle;
}

/**
 * Deletes the operator-selected paths intentionally. Runtime and TTL cleanup
 * must use removeOwnedReplayArtifacts with authenticated inode tokens instead.
 */
export async function removeReplayArtifacts(input: { bundlePath: string; keyPath: string }): Promise<void> {
    validatePathSuffix(input.bundlePath, '.enc');
    validatePathSuffix(input.keyPath, '.key');
    if (dirname(resolve(input.bundlePath)) !== dirname(resolve(input.keyPath))) {
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');
    }
    await assertExplicitReplayTempDirectory(dirname(input.bundlePath));
    for (const path of [input.bundlePath, input.keyPath]) {
        try {
            await assertPrivateFile(path);
        } catch (error) {
            if (
                error instanceof AnalysisV2ReplayBundleError
                && error.code === 'ANALYSIS_V2_REPLAY_ARTIFACT_MISSING'
            ) continue;
            throw error;
        }
        await unlink(path);
    }
}

/** Deletes only the exact files created by the current capture attempt. */
export async function removeOwnedReplayArtifacts(input: {
    bundlePath: string;
    keyPath: string;
    ownedBundle?: ReplayArtifactOwnership;
    ownedKey?: ReplayArtifactOwnership;
    beforeOwnedArtifactDelete?: (path: string) => Promise<void>;
}): Promise<void> {
    validatePathSuffix(input.bundlePath, '.enc');
    validatePathSuffix(input.keyPath, '.key');
    if (dirname(resolve(input.bundlePath)) !== dirname(resolve(input.keyPath))) {
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');
    }
    await assertExplicitReplayTempDirectory(dirname(input.bundlePath));
    const ownedArtifacts = [
        ...(input.ownedBundle ? [{ expectedPath: input.bundlePath, ownership: input.ownedBundle }] : []),
        ...(input.ownedKey ? [{ expectedPath: input.keyPath, ownership: input.ownedKey }] : []),
    ];
    for (const { expectedPath, ownership } of ownedArtifacts) {
        if (
            ownership[replayArtifactOwnershipBrand] !== true
            || ownership.path !== resolve(expectedPath)
        ) {
            bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_OWNERSHIP_INVALID');
        }
        await unlinkIfIdentityMatches(
            expectedPath,
            ownership,
            input.beforeOwnedArtifactDelete,
        );
    }
}

/** Removes only a caller-selected pair whose authenticated bundle is past its TTL. */
export async function removeExpiredReplayArtifacts(input: {
    bundlePath: string;
    keyPath: string;
    now?: number;
    beforeOwnedArtifactRemoval?: () => Promise<void>;
}): Promise<boolean> {
    const authenticated = await readAuthenticatedReplayBundle(input);
    if (!authenticated.expired) return false;
    await input.beforeOwnedArtifactRemoval?.();
    await removeOwnedReplayArtifacts({
        bundlePath: input.bundlePath,
        keyPath: input.keyPath,
        ownedBundle: authenticated.ownedBundle,
        ownedKey: authenticated.ownedKey,
    });
    return true;
}
