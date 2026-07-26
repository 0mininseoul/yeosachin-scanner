/**
 * Conservative local corroboration for an AI-proposed official account context.
 *
 * This does not infer gender or replace model evidence. It merely prevents a
 * single ambiguous word (for example "club") from removing a personal account
 * from the v2.4 personal-risk ranking. The model's accountContext evidence is
 * treated as the visual/logo-or-group signal; two independent name/bio signals
 * are still required before the exclusion is applied.
 */
export type AnalysisV2OfficialExclusionReason =
    | 'model_group_context_plus_profile_signals';

export interface AnalysisV2OfficialAccountScreening {
    accountContext: 'official_group_or_brand' | 'uncertain';
    exclusionReason: AnalysisV2OfficialExclusionReason | null;
    profileSignalCount: number;
}

const ORGANIZATION_PATTERNS: readonly RegExp[] = [
    /(?:(?<![\p{L}\p{N}_])(?:official|company|corporation|inc\.?|ltd\.?|agency|studio|label|records?)(?![\p{L}\p{N}_])|공식)/iu,
    /(?:(?<![\p{L}\p{N}_])(?:band|team|crew|collective|community)(?![\p{L}\p{N}_])|밴드|팀|크루|커뮤니티|프로젝트)/iu,
    /(?:(?<![\p{L}\p{N}_])(?:out\s+now|new\s+(?:single|album|release)|release|booking|shop|store)(?![\p{L}\p{N}_])|발매|신곡|공연|예매|예약|문의|상품)/iu,
];

function normalized(value: string | null | undefined, maximum: number): string {
    return value?.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum) ?? '';
}

function profileSignalCount(input: { fullName: string | null; bio: string | null }): number {
    const sources = [normalized(input.fullName, 240), normalized(input.bio, 2_200)].filter(Boolean);
    return ORGANIZATION_PATTERNS.reduce((count, pattern) => (
        count + Number(sources.some(source => pattern.test(source)))
    ), 0);
}

export function screenAnalysisV2OfficialAccount(input: {
    modelAccountContext: 'personal' | 'individual_creator' | 'official_group_or_brand' | 'uncertain';
    fullName: string | null;
    bio: string | null;
}): AnalysisV2OfficialAccountScreening {
    const signals = profileSignalCount(input);
    const excluded = input.modelAccountContext === 'official_group_or_brand'
        && signals >= 2;
    return Object.freeze({
        accountContext: excluded ? 'official_group_or_brand' : 'uncertain',
        exclusionReason: excluded
            ? 'model_group_context_plus_profile_signals'
            : null,
        profileSignalCount: signals,
    });
}
