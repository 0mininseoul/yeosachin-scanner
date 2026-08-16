import { areMateriallyNearDuplicatePublicCopies } from './public-copy-quality';

const BANNED_GEMINI_CANDIDATE_COPY = /(?:사진에서\s*이야기를\s*지어내지\s*않고|이름으로\s*확인되는\s*범위만\s*차분히|취향의\s*흐름|확인되지\s*않았다|알\s*수\s*없다|수집\s*범위|공개\s*자료만으로는)/u;

export type GeminiCandidateCopyOverview = Readonly<{
    candidateKey: string;
    overview: string;
}>;

/** Shared public-copy guard for the canary and the retained-evidence batch. */
export function assertGeminiCandidateCopyOverview(value: string): void {
    if (BANNED_GEMINI_CANDIDATE_COPY.test(value)) {
        throw new Error('GEMINI_CANDIDATE_COPY_BANNED_TEXT');
    }
}

/** Rejects exact and materially template-like cross-candidate summaries. */
export function assertDistinctGeminiCandidateCopyOverviews(
    rows: readonly GeminiCandidateCopyOverview[],
): void {
    for (const row of rows) assertGeminiCandidateCopyOverview(row.overview);
    for (let left = 0; left < rows.length; left += 1) {
        for (let right = left + 1; right < rows.length; right += 1) {
            if (areMateriallyNearDuplicatePublicCopies(rows[left]!.overview, rows[right]!.overview)) {
                throw new Error('GEMINI_CANDIDATE_COPY_DUPLICATE');
            }
        }
    }
}
