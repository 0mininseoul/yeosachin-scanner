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

/**
 * V2.11's pre-feature guard is intentionally narrower than the scored-account
 * override above: it only uses independently corroborated profile text and
 * never changes the stored account context.  It exists solely to avoid paying
 * for an opportunistic resolver on a plainly collective account when triage
 * happened to call it personal.
 */
export function hasAnalysisV2PreFeatureOfficialSignals(input: {
    fullName: string | null;
    bio: string | null;
}): boolean {
    return profileSignalCount({
        // This enables the deliberately guarded `Club + real release` pair,
        // while ordinary personal-club language still produces zero signals.
        modelAccountContext: 'official_group_or_brand',
        fullName: input.fullName,
        bio: input.bio,
    }) >= 2;
}

const ORGANIZATION_PATTERNS: readonly RegExp[] = [
    /(?:(?<![\p{L}\p{N}_])(?:official|company|corporation|inc\.?|ltd\.?|agency|studio|label|records?)(?![\p{L}\p{N}_])|공식)/iu,
    /(?:(?<![\p{L}\p{N}_])(?:band|team|crew|collective|community)(?![\p{L}\p{N}_])|밴드|팀|크루|커뮤니티|프로젝트)/iu,
    /(?:(?<![\p{L}\p{N}_])(?:booking|shop|store)(?![\p{L}\p{N}_])|공연|예매|예약|문의|상품)/iu,
];
const AMBIGUOUS_CLUB_NAME_PATTERN =
    /(?<![\p{L}\p{N}_])club(?![\p{L}\p{N}_])/iu;
const MUSIC_RELEASE_PATTERN =
    /(?:(?<![\p{L}\p{N}_])(?:single|album|ep)\s*(?:\[[^\]\n]{1,120}\]|["'“‘][^"'“”‘’\n]{1,120}["'”’])\s*(?:[-–—·|:]\s*)?(?:is\s+)?out\s+now(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?:new|latest)\s+(?:single|album|ep)(?![\p{L}\p{N}_])[^\n]{0,120}?(?:out\s+now|released?|available(?:\s+now)?|stream(?:ing)?(?:\s+now)?|listen(?:\s+now)?)(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?:stream|listen\s+to)\s+(?:the\s+)?(?:new|latest)?\s*(?:single|album|ep)(?![\p{L}\p{N}_])|(?:신곡|새\s*(?:싱글|앨범|ep)|싱글|앨범|ep)[^\n]{0,80}?(?:발매|공개|스트리밍|듣기)|(?:발매|스트리밍|듣기)[^\n]{0,40}?(?:신곡|싱글|앨범|ep))/iu;

function normalized(value: string | null | undefined, maximum: number): string {
    return value?.normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, maximum) ?? '';
}

function profileSignalCount(input: {
    modelAccountContext: 'personal' | 'individual_creator' | 'official_group_or_brand' | 'uncertain';
    fullName: string | null;
    bio: string | null;
}): number {
    const fullName = normalized(input.fullName, 240);
    const bio = normalized(input.bio, 2_200);
    const sources = [fullName, bio].filter(Boolean);
    const explicitSignals = ORGANIZATION_PATTERNS.reduce((count, pattern) => (
        count + Number(sources.some(source => pattern.test(source)))
    ), Number(sources.some(source => MUSIC_RELEASE_PATTERN.test(source))));
    const guardedClubSignal = input.modelAccountContext === 'official_group_or_brand'
        && AMBIGUOUS_CLUB_NAME_PATTERN.test(fullName)
        && MUSIC_RELEASE_PATTERN.test(bio);
    return explicitSignals + Number(guardedClubSignal);
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
