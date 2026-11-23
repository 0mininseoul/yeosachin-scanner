import 'server-only';

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import {
    ANALYSIS_V2_DEV_ARCHIVE_MAX_FRAGMENTS,
    ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES,
    createGoogleCloudPrivateMediaObjectClient,
    isAnalysisV2DevLiveMediaBucketName,
    type AnalysisV2DevArchiveObjectClient,
} from '@/lib/services/analysis/v2-media-artifact-store';

const DOMAIN = 'yeosachin-dev-standard-archive:v1';
const VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
const MAX_METADATA_BYTES = 1024;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const VERIFY_CONCURRENCY = 8;
const MAX_JSON_DEPTH = 24;
const SLOT_PATTERN = /^[a-f0-9]{32}$/;
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const GRANT_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const TARGET_PATTERN = /^[a-z0-9._]{1,30}$/;
const KIND_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const FRAGMENT_NAME_PATTERN = /^([a-z][a-z0-9_-]{0,63})\/([a-f0-9]{64})\.bin$/;

export const DEV_STANDARD_ARCHIVE_MAX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export type DevStandardArchiveBinding = Readonly<{
    grantId: string;
    target: string;
    expiresAt: number;
}>;

type FragmentIdentity = Readonly<{ kind: string; inputKey: string }>;
type ArchiveReference = Readonly<{ objectName: string; aad: Buffer }>;
type StoredValue = Readonly<{ value: unknown }>;
type StoredObject = StoredValue & Readonly<{ ciphertextSha256: string }>;
type ManifestEntry = readonly [kind: string, inputKey: string, ciphertextSha256: string];
type SealedManifest = Readonly<{
    binding: DevStandardArchiveBinding;
    fragments: readonly ManifestEntry[];
}>;

function invalid(): never {
    throw new Error('DEV_STANDARD_ARCHIVE_STORE_INVALID');
}

function hash(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

/** Restrict the plaintext to bounded-depth JSON with deterministic object key order. */
function canonicalJson(value: unknown, depth = 0): string {
    if (depth > MAX_JSON_DEPTH) return invalid();
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return invalid();
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${Array.from(value, item => canonicalJson(item, depth + 1)).join(',')}]`;
    }
    if (typeof value !== 'object') return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().map(name => {
        if (name === '__proto__' || name === 'prototype' || name === 'constructor') return invalid();
        return `${JSON.stringify(name)}:${canonicalJson(record[name], depth + 1)}`;
    });
    return `{${entries.join(',')}}`;
}

function encode(value: unknown, maximumBytes: number): Buffer {
    let serialized: string;
    try {
        serialized = canonicalJson(value);
    } catch {
        return invalid();
    }
    if (Buffer.byteLength(serialized, 'utf8') + ENVELOPE_BYTES > maximumBytes) return invalid();
    return Buffer.from(serialized, 'utf8');
}

export function createDevStandardArchiveStore(input: {
    bucketName: string;
    slot: string;
    key: string;
    objects?: AnalysisV2DevArchiveObjectClient;
    now?: () => number;
}) {
    if (!isAnalysisV2DevLiveMediaBucketName(input.bucketName)
        || typeof input.slot !== 'string' || !SLOT_PATTERN.test(input.slot)
        || typeof input.key !== 'string' || !KEY_PATTERN.test(input.key)) {
        throw new Error('DEV_STANDARD_ARCHIVE_STORE_CONFIG');
    }
    const key = Buffer.from(input.key, 'base64');
    if (key.length !== 32 || key.toString('base64') !== input.key) {
        throw new Error('DEV_STANDARD_ARCHIVE_STORE_CONFIG');
    }

    const objects = input.objects ?? createGoogleCloudPrivateMediaObjectClient({ bucketName: input.bucketName });
    const now = input.now ?? Date.now;
    const scope = [DOMAIN, input.bucketName, input.slot];
    const slotHash = hash(JSON.stringify(scope));
    const archivePrefix = `analysis-v2-dev-standard-archive/${slotHash}/`;
    const fragmentPrefix = `${archivePrefix}fragment/`;

    function reference(...address: readonly string[]): ArchiveReference {
        const aad = Buffer.from(JSON.stringify([...scope, ...address]), 'utf8');
        return {
            objectName: `${archivePrefix}${hash(aad)}.bin`,
            aad,
        };
    }
    const bindingRef = reference('binding');
    const sealRef = reference('seal');

    function fragmentKey(identity: FragmentIdentity): string {
        if (typeof identity.kind !== 'string' || !KIND_PATTERN.test(identity.kind)
            || typeof identity.inputKey !== 'string' || !DIGEST_PATTERN.test(identity.inputKey)) {
            return invalid();
        }
        return `${identity.kind}/${identity.inputKey}`;
    }

    function fragmentRef(binding: DevStandardArchiveBinding, identity: FragmentIdentity): ArchiveReference {
        const objectName = `${fragmentPrefix}${fragmentKey(identity)}.bin`;
        const lineage = hash(encode(binding, MAX_METADATA_BYTES));
        return { ...reference('fragment', lineage, identity.kind, identity.inputKey), objectName };
    }

    function validateBinding(value: unknown): DevStandardArchiveBinding {
        if (!value || typeof value !== 'object' || Array.isArray(value)
            || Object.keys(value).sort().join(',') !== 'expiresAt,grantId,target') return invalid();
        const { grantId, target, expiresAt } = value as Partial<DevStandardArchiveBinding>;
        const time = now();
        if (typeof grantId !== 'string' || !GRANT_PATTERN.test(grantId)
            || typeof target !== 'string' || !TARGET_PATTERN.test(target)
            || typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)
            || !Number.isSafeInteger(time) || time < 0 || expiresAt - time > DEV_STANDARD_ARCHIVE_MAX_RETENTION_MS) {
            return invalid();
        }
        if (expiresAt <= time) throw new Error('DEV_STANDARD_ARCHIVE_STORE_EXPIRED');
        return Object.freeze({ grantId, target, expiresAt });
    }

    async function read(ref: ArchiveReference, maximumBytes: number): Promise<StoredObject | null> {
        let bytes: Buffer | null;
        try {
            bytes = await objects.readRetained({ objectName: ref.objectName, maximumBytes });
        } catch {
            throw new Error('DEV_STANDARD_ARCHIVE_STORE_UNAVAILABLE');
        }
        if (bytes === null) return null;
        if (!Buffer.isBuffer(bytes) || bytes.length <= ENVELOPE_BYTES
            || bytes.length > maximumBytes || bytes[0] !== VERSION) return invalid();
        try {
            const nonceEnd = 1 + NONCE_BYTES;
            const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, nonceEnd));
            decipher.setAAD(ref.aad);
            decipher.setAuthTag(bytes.subarray(nonceEnd, ENVELOPE_BYTES));
            const plaintext = Buffer.concat([
                decipher.update(bytes.subarray(ENVELOPE_BYTES)),
                decipher.final(),
            ]);
            const value: unknown = JSON.parse(plaintext.toString('utf8'));
            if (!encode(value, maximumBytes).equals(plaintext)) return invalid();
            return { value, ciphertextSha256: hash(bytes) };
        } catch {
            return invalid();
        }
    }

    function assertEqual(existing: StoredValue, expected: Buffer, maximumBytes: number): void {
        if (!encode(existing.value, maximumBytes).equals(expected)) {
            throw new Error('DEV_STANDARD_ARCHIVE_STORE_CONFLICT');
        }
    }

    async function persist(
        ref: ArchiveReference,
        value: unknown,
        maximumBytes: number,
        beforeCreate?: () => Promise<void>,
    ): Promise<void> {
        const expected = encode(value, maximumBytes);
        const existing = await read(ref, maximumBytes);
        if (existing !== null) return assertEqual(existing, expected, maximumBytes);
        await beforeCreate?.();

        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(ref.aad);
        const ciphertext = Buffer.concat([cipher.update(expected), cipher.final()]);
        const bytes = Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]);

        try {
            const result = await objects.createRetained({
                objectName: ref.objectName,
                bytes,
                contentSha256: hash(bytes),
                contentType: 'application/octet-stream',
            });
            if (result.created === true && /^[1-9][0-9]{0,31}$/.test(result.generation)) return;
        } catch {
            // A conditional create can race, or commit before its response is lost.
        }
        const committed = await read(ref, maximumBytes);
        if (committed === null) throw new Error('DEV_STANDARD_ARCHIVE_STORE_UNAVAILABLE');
        assertEqual(committed, expected, maximumBytes);
    }

    async function readBinding(): Promise<DevStandardArchiveBinding | null> {
        const stored = await read(bindingRef, MAX_METADATA_BYTES);
        return stored === null ? null : validateBinding(stored.value);
    }

    async function requireBinding(): Promise<DevStandardArchiveBinding> {
        const binding = await readBinding();
        if (binding === null) throw new Error('DEV_STANDARD_ARCHIVE_STORE_UNBOUND');
        return binding;
    }

    async function readManifest(): Promise<SealedManifest | null> {
        const stored = await read(sealRef, MAX_MANIFEST_BYTES);
        if (stored === null) return null;
        const value = stored.value as Partial<SealedManifest> | null;
        if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'binding,fragments'
            || !Array.isArray(value.fragments) || value.fragments.length === 0
            || value.fragments.length > ANALYSIS_V2_DEV_ARCHIVE_MAX_FRAGMENTS) return invalid();
        const sealed = validateBinding(value.binding);
        const binding = await requireBinding();
        assertEqual({ value: sealed }, encode(binding, MAX_METADATA_BYTES), MAX_METADATA_BYTES);
        let previousKey = '';
        for (const entry of value.fragments) {
            if (!Array.isArray(entry) || entry.length !== 3
                || typeof entry[2] !== 'string' || !DIGEST_PATTERN.test(entry[2])) return invalid();
            const key = fragmentKey({ kind: entry[0], inputKey: entry[1] });
            if (key <= previousKey) return invalid();
            previousKey = key;
        }
        return { binding, fragments: value.fragments };
    }

    async function readSeal(): Promise<DevStandardArchiveBinding | null> {
        return (await readManifest())?.binding ?? null;
    }

    async function snapshotFragments(binding: DevStandardArchiveBinding): Promise<ManifestEntry[]> {
        let names: string[];
        try {
            names = await objects.listRetained({
                prefix: fragmentPrefix,
                maximumCount: ANALYSIS_V2_DEV_ARCHIVE_MAX_FRAGMENTS,
            });
        } catch {
            throw new Error('DEV_STANDARD_ARCHIVE_STORE_UNAVAILABLE');
        }
        if (!Array.isArray(names) || names.length === 0
            || names.length > ANALYSIS_V2_DEV_ARCHIVE_MAX_FRAGMENTS
            || names.some(name => typeof name !== 'string')
            || new Set(names).size !== names.length) return invalid();
        const identities = [...names].sort().map(name => {
            if (!name.startsWith(fragmentPrefix)) return invalid();
            const match = FRAGMENT_NAME_PATTERN.exec(name.slice(fragmentPrefix.length));
            if (!match) return invalid();
            return { kind: match[1]!, inputKey: match[2]! };
        });
        const fragments: ManifestEntry[] = [];
        for (let offset = 0; offset < identities.length; offset += VERIFY_CONCURRENCY) {
            fragments.push(...await Promise.all(identities.slice(offset, offset + VERIFY_CONCURRENCY).map(
                async (identity): Promise<ManifestEntry> => {
                    const stored = await read(fragmentRef(binding, identity), ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES);
                    if (!stored) return invalid();
                    return [identity.kind, identity.inputKey, stored.ciphertextSha256];
                },
            )));
        }
        return fragments;
    }

    async function readSealedMember(
        binding: DevStandardArchiveBinding,
        identity: FragmentIdentity,
        expectedDigest: string,
    ): Promise<StoredValue> {
        validateBinding(binding);
        const stored = await read(fragmentRef(binding, identity), ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES);
        if (!stored || stored.ciphertextSha256 !== expectedDigest) return invalid();
        validateBinding(binding);
        return { value: stored.value };
    }

    function archiveView(manifest: SealedManifest) {
        const membership = new Map(manifest.fragments.map(([kind, inputKey, digest]) => (
            [fragmentKey({ kind, inputKey }), digest] as const
        )));
        return {
            binding: manifest.binding,
            inputKeys(kind: string): readonly string[] {
                return manifest.fragments.filter(entry => entry[0] === kind).map(entry => entry[1]);
            },
            async readFragment(identity: FragmentIdentity): Promise<StoredValue | null> {
                validateBinding(manifest.binding);
                const digest = membership.get(fragmentKey(identity));
                return digest === undefined ? null : readSealedMember(manifest.binding, identity, digest);
            },
        };
    }

    return {
        async bindCapture(value: DevStandardArchiveBinding): Promise<DevStandardArchiveBinding> {
            const binding = validateBinding(value);
            await persist(bindingRef, binding, MAX_METADATA_BYTES);
            return binding;
        },
        readBinding,
        async writeFragment(fragment: FragmentIdentity & { value: unknown }): Promise<void> {
            const binding = await requireBinding();
            await persist(fragmentRef(binding, fragment), fragment.value, ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES, async () => {
                // The capture coordinator must await all fragment writes before sealing.
                if (await readSeal() !== null) throw new Error('DEV_STANDARD_ARCHIVE_STORE_SEALED');
            });
        },
        /** Looks up capture progress. Sealed replay reads from openSealedArchive. */
        async readFragment(identity: FragmentIdentity): Promise<StoredValue | null> {
            const binding = await requireBinding();
            const stored = await read(fragmentRef(binding, identity), ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES);
            return stored === null ? null : { value: stored.value };
        },
        async seal(
            validate?: (archive: ReturnType<typeof archiveView>) => Promise<void>,
        ): Promise<DevStandardArchiveBinding> {
            const existing = await readManifest();
            if (existing !== null) {
                await validate?.(archiveView(existing));
                return existing.binding;
            }
            const binding = await requireBinding();
            const fragments = await snapshotFragments(binding);
            validateBinding(binding);
            const manifest = { binding, fragments };
            await validate?.(archiveView(manifest));
            await persist(sealRef, manifest, MAX_MANIFEST_BYTES);
            return binding;
        },
        readSeal,
        async openSealedArchive() {
            const manifest = await readManifest();
            return manifest ? archiveView(manifest) : null;
        },
        async verifySealedMembership(): Promise<DevStandardArchiveBinding | null> {
            const manifest = await readManifest();
            if (!manifest) return null;
            for (let offset = 0; offset < manifest.fragments.length; offset += VERIFY_CONCURRENCY) {
                await Promise.all(manifest.fragments.slice(offset, offset + VERIFY_CONCURRENCY).map(
                    ([kind, inputKey, digest]) => readSealedMember(manifest.binding, { kind, inputKey }, digest),
                ));
            }
            return validateBinding(manifest.binding);
        },
    };
}
