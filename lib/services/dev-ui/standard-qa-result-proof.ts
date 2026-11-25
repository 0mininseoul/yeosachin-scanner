import 'server-only';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { activeStandardQaCopyPolicy, type StandardQaCopyPolicy } from './standard-qa-copy';

// The registered copy has 225 images. Smaller sealed synthetic fixtures use this same verifier.
const maximumEntries = 225;
const digest = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const entriesSchema = z.array(z.object({ sourceFingerprint: digest, webpSha256: digest }).strict()).min(1).max(maximumEntries);
const manifestSchema = z.object({
    expectedRows: z.number().int().min(1).max(maximumEntries),
    imageCount: z.number().int().min(1).max(maximumEntries),
    orderedManifestHash: digest,
    imageInputs: z.array(z.tuple([z.enum(['target','female','private']), z.string().min(1).max(128), digest])).min(1).max(maximumEntries),
}).strict();
export type StandardQaResultProofEntry = Readonly<z.infer<typeof entriesSchema>[number]>;
type Binding = { grantId: string; target: string; expiresAt: number };
type Reader = {
    fingerprint: string;
    binding: Binding;
    readFragment(key: { kind: string; inputKey: string }): Promise<{ value: unknown } | null>;
};
type Backend = {
    openSealedArchive(): Promise<Reader | null>;
    readCopyOrigin(context: string): Promise<string | null>;
    readEnvelope(address: string): Promise<unknown>;
    writeEnvelope(address: string, entries: readonly StandardQaResultProofEntry[], beforeCreate: () => Promise<void>): Promise<void>;
};
function unavailable(): never { throw new Error('DEV_STANDARD_QA_RESULT_PROOF_UNAVAILABLE'); }
function key(value: unknown) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function entriesFrom(value: unknown): StandardQaResultProofEntry[] {
    const parsed = entriesSchema.safeParse(value);
    if (!parsed.success) return unavailable();
    return parsed.data;
}

async function verifyImages(reader: Reader, entries: readonly StandardQaResultProofEntry[]) {
    const manifest = await reader.readFragment({ kind: 'result-image-manifest-v1', inputKey: key([reader.binding.target]) });
    const parsed = manifestSchema.safeParse(manifest?.value);
    if (!parsed.success) return unavailable();
    const { imageInputs, orderedManifestHash, expectedRows, imageCount } = parsed.data;
    const count = entries.length;
    if (count !== expectedRows || count !== imageCount || count !== imageInputs.length) return unavailable();
    if (imageInputs[0]![0] !== 'target' || imageInputs[0]![1] !== 'target'
        || imageInputs.slice(1).some(([kind, locator]) => kind === 'target' || locator === 'target')
        || new Set(imageInputs.map(([kind, locator]) => key([kind,locator]))).size !== count) return unavailable();

    // The historical manifest hashes the actual signed URL fingerprint. Its imageInputs use
    // a separately projected archive URL, so those digests cannot be compared directly.
    const ordered = createHash('sha256').update('analysis-v2-result-image-manifest-v1\n');
    for (const [ordinal, [kind, locator]] of imageInputs.entries()) {
        ordered.update([kind, locator, String(ordinal), entries[ordinal]!.sourceFingerprint, ''].join('\n'));
    }
    if (ordered.digest('hex') !== orderedManifestHash) return unavailable();
    for (let offset = 0; offset < count; offset += 8) {
        await Promise.all(imageInputs.slice(offset, offset + 8).map(async (identity, index) => {
            const image = await reader.readFragment({ kind: 'result-image-v1', inputKey: key(identity) });
            const expected = entries[offset + index]!.webpSha256;
            const stored = image?.value as { sha256?: unknown; webp?: unknown } | null;
            if (!stored || stored.sha256 !== expected || typeof stored.webp !== 'string') return unavailable();
            const bytes = Buffer.from(stored.webp, 'base64');
            if (bytes.length < 12 || bytes.toString('base64') !== stored.webp || bytes.toString('ascii',0,4) !== 'RIFF'
                || bytes.toString('ascii',8,12) !== 'WEBP' || createHash('sha256').update(bytes).digest('hex') !== expected) return unavailable();
        }));
    }
}

/** Receives only dedicated proof-envelope operations from the private-copy store. */
export function createStandardQaResultProofAccess(backend: Backend, now: () => number) {
    async function bound(policy: StandardQaCopyPolicy) {
        const { context, binding } = activeStandardQaCopyPolicy(policy, now());
        const reader = await backend.openSealedArchive();
        if (!reader || reader.binding.grantId !== binding.grantId || reader.binding.target !== binding.target
            || reader.binding.expiresAt !== binding.expiresAt) return unavailable();
        const origin = await backend.readCopyOrigin(context);
        if (!origin) return unavailable();
        const address = key(['registered-result-stage/v1',context,origin,reader.fingerprint]);
        return { reader, address };
    }
    return {
        async readResultProof(policy: StandardQaCopyPolicy): Promise<readonly StandardQaResultProofEntry[]> {
            const { reader, address } = await bound(policy);
            const entries = entriesFrom(await backend.readEnvelope(address));
            await verifyImages(reader, entries);
            activeStandardQaCopyPolicy(policy, now());
            return entries;
        },
        async enrollResultProof(policy: StandardQaCopyPolicy, input: unknown) {
            const entries = entriesFrom(input);
            const { reader, address } = await bound(policy);
            await verifyImages(reader, entries);
            const check = async () => { activeStandardQaCopyPolicy(policy, now()); };
            await check();
            await backend.writeEnvelope(address, entries, check);
            await check();
            return entries.length;
        },
    };
}
type ResultProofAccess = ReturnType<typeof createStandardQaResultProofAccess>;
export function readStandardQaResultProof(policy: StandardQaCopyPolicy, destination: Pick<ResultProofAccess,'readResultProof'>) {
    return destination.readResultProof(policy);
}
export function enrollStandardQaResultProof(policy: StandardQaCopyPolicy, destination: Pick<ResultProofAccess,'enrollResultProof'>, input: unknown) {
    return destination.enrollResultProof(policy,input);
}
