import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

const MAX_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_PROFILES = 1_500;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;

const jpegBase64Schema = z.string().min(4).max(12 * 1024 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/);
const bundleSchema = z.object({
    schemaVersion: z.literal(1),
    createdAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    capture: z.object({ requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/), plan: z.literal('standard') }).strict(),
    profiles: z.array(z.object({
        ordinal: z.number().int().positive(),
        isPrivate: z.boolean(),
        bio: z.string().max(2_200).nullable().optional(),
        media: z.array(z.object({
            selectionId: z.string().min(1).max(255),
            caption: z.string().max(5_000).nullable().optional(),
            jpegBase64: jpegBase64Schema,
        }).strict()).max(12),
    }).strict()).max(MAX_PROFILES),
    evidence: z.object({
        relationship: z.array(z.record(z.string(), z.unknown())).max(5_000),
        targetInteractions: z.array(z.record(z.string(), z.unknown())).max(10_000),
        reverseInteractions: z.array(z.record(z.string(), z.unknown())).max(10_000),
    }).strict(),
}).strict();

export type AnalysisV2ReplayBundle = z.infer<typeof bundleSchema>;

export class AnalysisV2ReplayBundleError extends Error {
    constructor(readonly code: string) {
        super(code);
        this.name = 'AnalysisV2ReplayBundleError';
    }
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

function canonicalPayload(bundle: AnalysisV2ReplayBundle, now: number): Buffer {
    const parsed = bundleSchema.safeParse(bundle);
    if (!parsed.success) bundleError('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
    const created = Date.parse(parsed.data.createdAt);
    const expires = Date.parse(parsed.data.expiresAt);
    if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || expires - created > MAX_TTL_MS || expires <= now) {
        bundleError('ANALYSIS_V2_REPLAY_BUNDLE_EXPIRED');
    }
    const payload = Buffer.from(JSON.stringify(parsed.data), 'utf8');
    if (payload.byteLength > MAX_BUNDLE_BYTES) bundleError('ANALYSIS_V2_REPLAY_BUNDLE_LIMIT');
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

async function readKey(keyPath: string): Promise<Buffer> {
    validatePathSuffix(keyPath, '.key');
    await assertPrivateFile(keyPath);
    const key = await readFile(keyPath);
    if (key.byteLength !== KEY_BYTES) bundleError('ANALYSIS_V2_REPLAY_KEY_INVALID');
    return key;
}

export async function createReplayKeyFile(keyPath: string): Promise<void> {
    validatePathSuffix(keyPath, '.key');
    await assertExplicitReplayTempDirectory(dirname(keyPath));
    const handle = await open(keyPath, 'wx', 0o600);
    try { await handle.writeFile(randomBytes(KEY_BYTES)); } finally { await handle.close(); }
}

export async function writeReplayBundle(input: {
    bundle: AnalysisV2ReplayBundle;
    bundlePath: string;
    keyPath: string;
    now?: number;
}): Promise<void> {
    validatePathSuffix(input.bundlePath, '.enc');
    const now = input.now ?? Date.now();
    const payload = canonicalPayload(input.bundle, now);
    const key = await readKey(input.keyPath);
    await assertExplicitReplayTempDirectory(dirname(input.bundlePath));
    const handle = await open(input.bundlePath, 'wx', 0o600);
    try { await handle.writeFile(envelope(payload, key)); } finally { await handle.close(); }
}

export async function readReplayBundle(input: {
    bundlePath: string;
    keyPath: string;
    now?: number;
}): Promise<AnalysisV2ReplayBundle> {
    validatePathSuffix(input.bundlePath, '.enc');
    await assertExplicitReplayTempDirectory(dirname(input.bundlePath));
    await assertPrivateFile(input.bundlePath);
    const raw = await readFile(input.bundlePath);
    if (raw.byteLength > MAX_BUNDLE_BYTES) bundleError('ANALYSIS_V2_REPLAY_BUNDLE_LIMIT');
    const decrypted = decryptEnvelope(raw, await readKey(input.keyPath));
    let json: unknown;
    try { json = JSON.parse(decrypted.toString('utf8')); } catch { return bundleError('ANALYSIS_V2_REPLAY_BUNDLE_INVALID'); }
    const parsed = bundleSchema.safeParse(json);
    if (!parsed.success) bundleError('ANALYSIS_V2_REPLAY_BUNDLE_INVALID');
    canonicalPayload(parsed.data, input.now ?? Date.now());
    return parsed.data;
}

/** Deletes exactly a validated pair of files; it never recursively removes a directory. */
export async function removeReplayArtifacts(input: { bundlePath: string; keyPath: string }): Promise<void> {
    validatePathSuffix(input.bundlePath, '.enc');
    validatePathSuffix(input.keyPath, '.key');
    if (dirname(resolve(input.bundlePath)) !== dirname(resolve(input.keyPath))) {
        bundleError('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');
    }
    for (const path of [input.bundlePath, input.keyPath]) {
        await assertPrivateFile(path);
        await unlink(path);
    }
}
