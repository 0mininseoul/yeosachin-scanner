import { createHash } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;

export interface StableResultRevision {
    readonly requestId: string;
    readonly resultRevisionId: string;
    readonly imageManifestId: string;
    readonly candidateOrder: readonly string[];
    readonly payload: unknown;
}

export interface ResultReaderObservation extends StableResultRevision {
    readonly viewer: 'owner' | 'admin';
}

export class ResultEqualityError extends Error {
    constructor(readonly code: 'INVALID_REVISION' | 'REVISION_MISMATCH') {
        super(`RESULT_EQUALITY_${code}`);
        this.name = 'ResultEqualityError';
    }
}

function stable(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => [key, stable(item)]));
    }
    return value;
}

export function resultRevisionContentHash(revision: StableResultRevision): string {
    if (
        !UUID.test(revision.requestId)
        || !UUID.test(revision.resultRevisionId)
        || !UUID.test(revision.imageManifestId)
        || revision.candidateOrder.some(candidate => typeof candidate !== 'string' || candidate.length === 0)
    ) throw new ResultEqualityError('INVALID_REVISION');
    return createHash('sha256').update(JSON.stringify(stable({
        requestId: revision.requestId.toLowerCase(),
        resultRevisionId: revision.resultRevisionId.toLowerCase(),
        imageManifestId: revision.imageManifestId.toLowerCase(),
        candidateOrder: revision.candidateOrder,
        payload: revision.payload,
    })), 'utf8').digest('hex');
}

export function assertOwnerAdminResultEquality(
    owner: ResultReaderObservation,
    admin: ResultReaderObservation,
): string {
    if (owner.viewer !== 'owner' || admin.viewer !== 'admin') {
        throw new ResultEqualityError('INVALID_REVISION');
    }
    const ownerHash = resultRevisionContentHash(owner);
    const adminHash = resultRevisionContentHash(admin);
    if (ownerHash !== adminHash) throw new ResultEqualityError('REVISION_MISMATCH');
    return ownerHash;
}

export function isContentHash(value: unknown): value is string {
    return typeof value === 'string' && HASH.test(value);
}
