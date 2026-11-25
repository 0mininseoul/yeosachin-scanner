import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DEV_STANDARD_REVERSE_INPUT_COMMITMENT as proofDomain, type currentDevStandardArchive } from '@/lib/services/dev-ui/standard-archive-runtime';
import { ANALYSIS_V2_MAX_REVERSE_CANDIDATES as maxCandidates, ANALYSIS_V2_REVERSE_LIKE_LIMIT as limit } from './v2-apify-operation-costs';
import type { AnalysisV2ReverseLikeCollectionInput, AnalysisV2ReverseLikeCollectionResult } from './v2-ai-scoring-executors';

const kind = 'reverse-coverage-v1';
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const evidence = z.object({
    scopeHash: sha,
    results: z.array(z.object({
        candidateId: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        status: z.enum(['observed', 'not_observed', 'not_collected']),
    }).strict()).max(maxCandidates),
}).strict();
const inputProof = z.object({
    hashes: z.array(sha).max(maxCandidates),
    shortlist: z.array(sha).max(maxCandidates),
    commitment: sha,
}).strict();

type Archive = NonNullable<ReturnType<typeof currentDevStandardArchive>>;
type Candidate = Required<AnalysisV2ReverseLikeCollectionInput>;

function digest(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function tuple(row: Candidate) {
    return [row.candidateId, row.postUrl, row.declaredLikesCount, row.declaredLikesCountKnown];
}
function scopeHash(target: string, rows: readonly Candidate[]) {
    const sorted = [...rows].sort((a, b) => a.candidateId.localeCompare(b.candidateId));
    return digest([target, limit, sorted.map(tuple)]);
}
function memberHash(target: string, id: string) {
    return digest(['reverse-shortlist-member/v1', target, id]);
}
function commitment(target: string, source: z.infer<typeof evidence>, hashes: readonly string[], shortlist: readonly string[]) {
    return digest([proofDomain, target, limit, source.scopeHash, shortlist,
        source.results.map(({ candidateId, status }, i) => [candidateId, status, hashes[i]])]);
}
function validateStatus(archive: Archive, row: Candidate, status: AnalysisV2ReverseLikeCollectionResult['status']) {
    if (status === 'not_observed' && (!row.declaredLikesCountKnown || row.declaredLikesCount > limit)) archive.fail();
}

export async function captureDevStandardReverseLikes(
    archive: Archive, target: string, rows: readonly Candidate[], shortlistIds: readonly string[], results: readonly AnalysisV2ReverseLikeCollectionResult[],
) {
    const source = {
        scopeHash: scopeHash(target, rows),
        results: results.map(({ candidateId, status }) => ({ candidateId, status })),
    };
    if (rows.length !== results.length || rows.some((row, i) => row.candidateId !== results[i]!.candidateId)) return archive.fail();
    const hashes = rows.map(row => digest(tuple(row)));
    const shortlist = shortlistIds.map(id => memberHash(target, id)).sort();
    // This subkey does not create or replace the coverage pointer for [target].
    // The legacy fragment stays readable. No post URLs or liker records are added.
    await archive.capture(kind, [proofDomain, target], { hashes, shortlist, commitment: commitment(target, source, hashes, shortlist) });
    await archive.capture(kind, [target], source);
}

export async function replayDevStandardReverseLikes(
    archive: Archive, target: string, rows: readonly Candidate[], shortlistIds: readonly string[],
    legacyInputs?: (ids: readonly string[]) => readonly Candidate[],
) {
    const parsed = evidence.safeParse(await archive.load(kind, [target]));
    if (!parsed.success) return archive.fail();
    const source = parsed.data;
    const byId = new Map(source.results.map(row => [row.candidateId, row.status]));
    if (byId.size !== source.results.length || (!byId.size && scopeHash(target, []) !== source.scopeHash)) return archive.fail();
    const actualHash = scopeHash(target, rows);
    const exact = actualHash === source.scopeHash;
    if (exact && (rows.length !== byId.size || rows.some(row => !byId.has(row.candidateId)))) return archive.fail();
    const saved = await archive.find(kind, [proofDomain, target]);
    const original = new Map<string, string>();
    // Older captures can prove only the original post-query members. New captures
    // also commit the complete shortlist, including members without a post.
    let sourceMembers = new Set([...byId.keys()].map(id => memberHash(target, id)));
    let replayMembers = new Set(rows.map(row => memberHash(target, row.candidateId)));
    if (saved) {
        const proof = inputProof.safeParse(saved.value);
        if (!proof.success || proof.data.hashes.length !== byId.size
            || new Set(proof.data.hashes).size !== byId.size
            || commitment(target, source, proof.data.hashes, proof.data.shortlist) !== proof.data.commitment) return archive.fail();
        const members = new Set(proof.data.shortlist);
        if (members.size !== proof.data.shortlist.length || [...sourceMembers].some(id => !members.has(id))
            || proof.data.shortlist.some((id, i, list) => i > 0 && list[i - 1]! >= id)) return archive.fail();
        sourceMembers = members;
        replayMembers = new Set(shortlistIds.map(id => memberHash(target, id)));
        source.results.forEach((row, index) => original.set(row.candidateId, proof.data.hashes[index]!));
        if (exact && rows.some(row => original.get(row.candidateId) !== digest(tuple(row)))) return archive.fail();
        // If every original member is present with its original input, their legacy
        // aggregate must also agree, even if the new scope has added candidates.
        const matchedOriginal = rows.filter(row => original.get(row.candidateId) === digest(tuple(row)));
        if (matchedOriginal.length === byId.size && scopeHash(target, matchedOriginal) !== source.scopeHash) return archive.fail();
    } else if (!exact) {
        // Legacy captures did not store individual commitments. Only a complete
        // reconstruction of the historical aggregate authenticates any shared input.
        const shared = rows.filter(row => byId.has(row.candidateId));
        const historical = shared.length === byId.size && scopeHash(target, shared) === source.scopeHash
            ? shared : legacyInputs?.([...byId.keys()]) ?? [];
        const ids = new Set(historical.map(row => row.candidateId));
        if (ids.size !== historical.length || historical.some(row => !byId.has(row.candidateId))
            || new Set(historical.map(row => row.postUrl)).size !== historical.length) return archive.fail();
        if (ids.size === byId.size) {
            if (scopeHash(target, historical) !== source.scopeHash) return archive.fail();
            for (const row of historical) {
                validateStatus(archive, row, byId.get(row.candidateId)!);
                original.set(row.candidateId, digest(tuple(row)));
            }
        }
    }
    const added = [...replayMembers].filter(id => !sourceMembers.has(id)).length;
    const removed = [...sourceMembers].filter(id => !replayMembers.has(id)).length;
    const queried = new Set(rows.map(row => row.candidateId));
    let unverified = [...byId.keys()].filter(id => (
        replayMembers.has(memberHash(target, id)) && !queried.has(id)
    )).length;
    const results = rows.map(row => {
        const historicalStatus = byId.get(row.candidateId);
        let status: AnalysisV2ReverseLikeCollectionResult['status'] = 'not_collected';
        if (historicalStatus === undefined) {
            if (sourceMembers.has(memberHash(target, row.candidateId))) unverified++;
        }
        else if (!exact && original.get(row.candidateId) !== digest(tuple(row))) unverified++;
        else {
            validateStatus(archive, row, historicalStatus);
            status = historicalStatus;
        }
        return Object.freeze({ candidateId: row.candidateId, status });
    });
    return Object.freeze({
        operationKey: rows.length ? `archive-candidate-likers:${actualHash}` : null,
        results: Object.freeze(results),
        ...(added || removed || unverified ? { replayScopeDelta: Object.freeze({ added, removed, unverified }) } : {}),
    });
}
