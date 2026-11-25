import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { StandardQaFixtureOperation } from '@/lib/services/dev-ui/standard-archive-runtime';
import { analysisV2CandidateId } from '@/lib/services/analysis/v2-ai-scoring-executors';
import { deriveAnalysisV2MutualRows } from '@/lib/services/analysis/v2-evidence-store';
import { archiveMediaUrlAnchor } from '@/lib/services/dev-ui/standard-archive-media-identity';
import { resultImageArchiveIdentity, type ResultImageCaptureSource } from '@/lib/services/media/result-image-capture';

const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const key = (parts: readonly unknown[]) => digest(JSON.stringify(parts));
const kindSchema = z.enum(['target', 'female', 'private']);
const manifestSchema = z.object({ orderedManifestHash: hash, imageInputs: z.array(z.tuple([kindSchema, z.string(), hash])).min(1) });
const anchorPath = /^(\/__dev_qa_archive\/v1\/)[a-f0-9]{64}(\.[a-z0-9]{1,5})?$/;
const entrySchema = z.object({ sourceFingerprint: hash, webpSha256: hash }).strict();
type Proof = z.infer<typeof entrySchema>;
type Kind = ResultImageCaptureSource['kind'];
type Reader = Parameters<StandardQaFixtureOperation<unknown>>[1];
const relationship = z.object({ rows: z.array(z.object({
    username: z.string(), isPrivate: z.boolean(), isVerified: z.boolean(), fullName: z.string().nullable(), profilePicUrl: z.string().nullable(),
})) });

function reject(): never { throw new Error('PRIVATE90_RESULT_STAGE_PROOF_INVALID'); }

// Recreate the original ordered-manifest commitment from the registry's fingerprint
// receipts. The original URLs are intentionally unavailable to this isolated reader.
function orderedHash(images: readonly (readonly [Kind, string, string])[], proofs: readonly Proof[]) {
    const hash = createHash('sha256').update('analysis-v2-result-image-manifest-v1\n');
    images.forEach(([kind, locator], i) => hash.update([kind, locator, String(i), proofs[i]!.sourceFingerprint, ''].join('\n')));
    return hash.digest('hex');
}

export async function private90StageImages(input: {
    reader: Reader; target: string; batches: readonly number[]; proof: unknown;
}) {
    async function read(kind: string, inputKey: string) {
        const fragment = await input.reader.readFragment({ kind, inputKey });
        return fragment ? fragment.value : reject();
    }
    async function pointed(kind: string, ordinal: number | string) {
        const pointer = hash.parse(await read('capture-coverage-v1', key([kind, ordinal])));
        return { pointer, value: await read(kind, pointer) };
    }
    try {
        const proof = z.array(entrySchema).max(50_001).parse(input.proof);
        const manifest = manifestSchema.parse(await read('result-image-manifest-v1', key([input.target])));
        if (manifest.imageInputs.length !== proof.length || orderedHash(manifest.imageInputs, proof) !== manifest.orderedManifestHash) reject();
        const anchors = new Map<string, string>();
        const index = (kind: Kind, locator: string) => JSON.stringify([kind, locator]);
        const remember = (kind: Kind, locator: string, url: string | null | undefined) => {
            if (!url) return;
            if (url !== archiveMediaUrlAnchor(url) || anchors.has(index(kind, locator))) reject();
            anchors.set(index(kind, locator), url);
        };
        const formal = z.object({ profile: z.object({ username: z.string(), profilePicUrl: z.string().nullish() }) })
            .parse(await read('formal-target-profile-v2', key([input.target])));
        if (formal.profile.username !== input.target) reject();
        remember('target', 'target', formal.profile.profilePicUrl);
        for (const batch of input.batches) {
            const { value, pointer } = await pointed('candidate-profile-batch-v1', batch);
            const rows = z.array(z.object({ outcome: z.object({ requestedUsername: z.string(), status: z.string() }),
                profile: z.object({ username: z.string(), isPrivate: z.boolean(), profilePicUrl: z.string().nullish() }).optional() })).parse(value);
            if (pointer !== key([input.target, batch, ...rows.map(row => row.outcome.requestedUsername)])) reject();
            for (const { outcome, profile } of rows) {
                if (outcome.status !== 'success' || !profile || profile.isPrivate) continue;
                if (profile.username !== outcome.requestedUsername) reject();
                remember('female', analysisV2CandidateId(profile.username), profile.profilePicUrl);
            }
        }
        const relationshipSides = await Promise.all((['followers', 'following'] as const).map(async side => {
            const { value } = await pointed('relationship-side-v1', side);
            return relationship.parse(value).rows;
        }));
        // The detailed public limit and optional excluded username do not determine the
        // source URL of an individual private member. Apply the production mutual join.
        const mutual = deriveAnalysisV2MutualRows({ followers: relationshipSides[0]!, following: relationshipSides[1]!,
            excludedUsername: null, detailedMutualLimit: 300 });
        for (const row of mutual) if (row.isPrivate) remember('private', analysisV2CandidateId(row.username), row.profilePicUrl);
        const verified = new Map<string, { projected: string; stage: string }>();
        const seen = new Set<string>();
        const direct = { target: 0, female: 0, private: 0 };
        // readStandardQaResultProof has verified every original WebP byte and hash
        // against this ordinal-bound manifest. Restore only the independent result-stage input.
        for (const [ordinal, identity] of manifest.imageInputs.entries()) {
            const [kind, locator, expected] = identity;
            const k = index(kind, locator);
            if (seen.has(k) || (kind === 'target') !== (ordinal === 0 && locator === 'target')) reject();
            seen.add(k);
            const projected = anchors.get(k) ?? reject();
            const source = { kind, candidateLocator: locator, sortOrdinal: ordinal, sourceUrl: projected };
            if (resultImageArchiveIdentity(source)[2] === expected) direct[kind]++;
            const url = new URL(projected);
            const path = anchorPath.exec(url.pathname) ?? reject();
            url.pathname = path[1]! + proof[ordinal]!.sourceFingerprint + (path[2] ?? '');
            // The target never passes through the result-store URL canonicalizer.
            const stage = kind === 'target' ? projected : url.href;
            if (resultImageArchiveIdentity({ ...source, sourceUrl: stage })[2] !== expected) reject();
            verified.set(k, { projected, stage });
        }
        if (direct.target !== 1) reject();
        const applied = new Set<string>();
        return {
            counts: () => ({
                stageProofRows: verified.size, stageProofOriginalHash: 1, stageProofDirectTarget: direct.target,
                stageProofDirectPublic: direct.female, stageProofDirectPrivate: direct.private,
                stageProofDirectDrift: verified.size - direct.target - direct.female - direct.private,
                stageProofRowsApplied: applied.size,
            }),
            project(kind: 'female' | 'private', locator: string, projected: string | null) {
                const k = index(kind, locator);
                const record = verified.get(k);
                if (!record || record.projected !== projected) return reject();
                applied.add(k);
                return record.stage;
            },
        };
    } catch { return reject(); }
}
