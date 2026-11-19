import 'server-only';

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
    ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES,
    createGoogleCloudPrivateMediaObjectClient,
    isAnalysisV2DevLiveMediaBucketName,
    type AnalysisV2PrivateRetainedMediaObjectClient,
} from '@/lib/services/analysis/v2-media-artifact-store';
import { devStandardEvalBundleSchema, type DevStandardEvalBundle } from './standard-eval-types';

const SLOT_PATTERN = /^[a-f0-9]{32}$/;
const KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const APPROVAL_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const GENERATION_PATTERN = /^[1-9][0-9]{0,31}$/;
const SEAL_VERSION = 1;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const SEAL_OVERHEAD = 1 + NONCE_BYTES + TAG_BYTES;
const MARKER_BYTES = 32;
const RETENTION_MS = 24 * 60 * 60 * 1_000;
const PURPOSE_PREFIX = 'yeosachin-dev-standard-eval:v1';

type Purpose = 'binding' | 'bundle' | 'claim';
type CreateResult = Awaited<ReturnType<AnalysisV2PrivateRetainedMediaObjectClient['createRetained']>>;

function sha256(data: string | Buffer): string {
    return createHash('sha256').update(data).digest('hex');
}

function requireValidCreateResult(result: unknown): CreateResult {
    if (!result || typeof result !== 'object' || !('created' in result) || typeof result.created !== 'boolean'
        || !('generation' in result) || typeof result.generation !== 'string'
        || !GENERATION_PATTERN.test(result.generation) || result.generation.trim() !== result.generation) {
        throw new Error('DEV_STANDARD_EVAL_STORE_INVALID');
    }
    return { created: result.created, generation: result.generation };
}

export function createDevStandardEvalStore(input: {
    bucketName: string;
    slot: string;
    key: string;
    objects?: AnalysisV2PrivateRetainedMediaObjectClient;
    now?: () => number;
}) {
    if (!isAnalysisV2DevLiveMediaBucketName(input.bucketName)
        || typeof input.slot !== 'string' || input.slot.length !== 32 || !SLOT_PATTERN.test(input.slot)
        || typeof input.key !== 'string' || !KEY_PATTERN.test(input.key)) {
        throw new Error('DEV_STANDARD_EVAL_STORE_CONFIG');
    }
    const key = Buffer.from(input.key, 'base64');
    if (key.length !== 32 || key.toString('base64') !== input.key) {
        throw new Error('DEV_STANDARD_EVAL_STORE_CONFIG');
    }
    const objects = input.objects ?? createGoogleCloudPrivateMediaObjectClient({ bucketName: input.bucketName });
    const now = input.now ?? Date.now;
    const domain = `${PURPOSE_PREFIX}\n${input.bucketName}\n${input.slot}`;
    const slotHash = sha256(`${domain}\nslot`);

    function objectName(purpose: Purpose): string {
        // The bundle lifespan must not permit rebinding or consuming a slot again.
        const prefix = purpose === 'bundle' ? 'analysis-v2-dev-eval' : 'analysis-v2-dev-eval-control';
        return `${prefix}/${slotHash}/${sha256(`${domain}\n${purpose}`)}.bin`;
    }

    function aad(purpose: Purpose): Buffer {
        return Buffer.from(`${domain}\n${purpose}`, 'utf8');
    }

    function bindingMarker(approvalId: string): Buffer {
        if (typeof approvalId !== 'string' || approvalId.length !== 36 || !APPROVAL_PATTERN.test(approvalId)) {
            throw new Error('DEV_STANDARD_EVAL_STORE_INVALID');
        }
        return createHmac('sha256', key).update(aad('binding')).update('\n').update(approvalId).digest();
    }

    function validateBundle(value: unknown): DevStandardEvalBundle {
        const parsed = devStandardEvalBundleSchema.safeParse(value);
        if (!parsed.success) throw new Error('DEV_STANDARD_EVAL_STORE_INVALID');
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0 || parsed.data.expiresAt - time > RETENTION_MS) {
            throw new Error('DEV_STANDARD_EVAL_STORE_INVALID');
        }
        if (parsed.data.expiresAt <= time) throw new Error('DEV_STANDARD_EVAL_STORE_EXPIRED');
        return parsed.data;
    }

    async function readBytes(purpose: Purpose, maxBytes: number): Promise<Buffer | null> {
        let bytes: Buffer | null;
        try {
            bytes = await objects.readRetained({ objectName: objectName(purpose), maximumBytes: maxBytes });
        } catch {
            throw new Error('DEV_STANDARD_EVAL_STORE_UNAVAILABLE');
        }
        if (bytes !== null && (!Buffer.isBuffer(bytes) || bytes.length > maxBytes)) {
            throw new Error('DEV_STANDARD_EVAL_STORE_INVALID');
        }
        return bytes;
    }

    function createBytes(purpose: Purpose, bytes: Buffer): Promise<CreateResult> {
        return objects.createRetained({
            objectName: objectName(purpose),
            bytes,
            contentSha256: sha256(bytes),
            contentType: 'application/octet-stream',
        });
    }

    async function readBinding(): Promise<Buffer | null> {
        const marker = await readBytes('binding', MARKER_BYTES);
        if (marker !== null && marker.length !== MARKER_BYTES) throw new Error('DEV_STANDARD_EVAL_STORE_INVALID');
        return marker;
    }

    async function ownsRun(approvalId: string): Promise<boolean> {
        const expected = bindingMarker(approvalId);
        const existing = await readBinding();
        return existing !== null && timingSafeEqual(existing, expected);
    }

    async function bindRun(approvalId: string): Promise<boolean> {
        const expected = bindingMarker(approvalId);
        const existing = await readBinding();
        if (existing !== null) return timingSafeEqual(existing, expected);

        let result: CreateResult;
        try {
            result = await createBytes('binding', expected);
        } catch {
            const raced = await readBinding();
            if (raced === null) throw new Error('DEV_STANDARD_EVAL_STORE_UNAVAILABLE');
            return timingSafeEqual(raced, expected);
        }
        if (requireValidCreateResult(result).created) return true;
        return ownsRun(approvalId);
    }

    async function load(): Promise<DevStandardEvalBundle | null> {
        const bytes = await readBytes('bundle', ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES);
        if (bytes === null) return null;
        if (bytes.length <= SEAL_OVERHEAD || bytes[0] !== SEAL_VERSION) {
            throw new Error('DEV_STANDARD_EVAL_STORE_INVALID');
        }
        let parsed: unknown;
        try {
            const nonceEnd = 1 + NONCE_BYTES;
            const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, nonceEnd));
            decipher.setAAD(aad('bundle'));
            decipher.setAuthTag(bytes.subarray(nonceEnd, SEAL_OVERHEAD));
            const plaintext = Buffer.concat([decipher.update(bytes.subarray(SEAL_OVERHEAD)), decipher.final()]);
            parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
        } catch {
            throw new Error('DEV_STANDARD_EVAL_STORE_INVALID');
        }
        return validateBundle(parsed);
    }

    function assertExactRetry(existing: DevStandardEvalBundle, expected: string): void {
        if (JSON.stringify(existing) !== expected) throw new Error('DEV_STANDARD_EVAL_STORE_CONFLICT');
    }

    async function seal(bundle: DevStandardEvalBundle): Promise<void> {
        const encoded = JSON.stringify(validateBundle(bundle));
        if (Buffer.byteLength(encoded, 'utf8') + SEAL_OVERHEAD > ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES) {
            throw new Error('DEV_STANDARD_EVAL_STORE_INVALID');
        }
        if (await readBinding() === null) throw new Error('DEV_STANDARD_EVAL_STORE_UNBOUND');
        const existing = await load();
        if (existing !== null) return assertExactRetry(existing, encoded);

        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv('aes-256-gcm', key, nonce);
        cipher.setAAD(aad('bundle'));
        const ciphertext = Buffer.concat([cipher.update(encoded, 'utf8'), cipher.final()]);
        const bytes = Buffer.concat([Buffer.from([SEAL_VERSION]), nonce, cipher.getAuthTag(), ciphertext]);

        let result: CreateResult;
        try {
            result = await createBytes('bundle', bytes);
        } catch {
            const raced = await load();
            if (raced === null) throw new Error('DEV_STANDARD_EVAL_STORE_UNAVAILABLE');
            return assertExactRetry(raced, encoded);
        }
        if (requireValidCreateResult(result).created) return;
        const retained = await load();
        if (retained === null) throw new Error('DEV_STANDARD_EVAL_STORE_UNAVAILABLE');
        assertExactRetry(retained, encoded);
    }

    async function claimEvaluation(): Promise<boolean> {
        if (await load() === null) return false;
        const marker = createHmac('sha256', key).update(aad('claim')).digest();
        let result: CreateResult;
        try {
            result = await createBytes('claim', marker);
        } catch {
            // A lost creation response might already have consumed the slot.
            throw new Error('DEV_STANDARD_EVAL_STORE_UNAVAILABLE');
        }
        return requireValidCreateResult(result).created;
    }

    return { bindRun, ownsRun, seal, load, claimEvaluation };
}
