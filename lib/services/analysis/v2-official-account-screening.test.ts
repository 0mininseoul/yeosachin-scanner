import { describe, expect, it } from 'vitest';
import { screenAnalysisV2OfficialAccount } from './v2-official-account-screening';

describe('screenAnalysisV2OfficialAccount', () => {
    it('requires model image/group evidence plus independent bio/name signals', () => {
        expect(screenAnalysisV2OfficialAccount({
            modelAccountContext: 'official_group_or_brand',
            fullName: 'Black Cherry Club',
            bio: 'Single [콜드브루] Out now · official band',
        })).toMatchObject({
            accountContext: 'official_group_or_brand',
            exclusionReason: 'model_group_context_plus_profile_signals',
            profileSignalCount: 3,
        });
    });

    it('does not exclude a personal account from one ambiguous club word', () => {
        expect(screenAnalysisV2OfficialAccount({
            modelAccountContext: 'official_group_or_brand',
            fullName: 'Sora club',
            bio: 'photos and coffee',
        })).toEqual({
            accountContext: 'uncertain',
            exclusionReason: null,
            profileSignalCount: 0,
        });
    });

    it('never promotes profile text without model group evidence', () => {
        expect(screenAnalysisV2OfficialAccount({
            modelAccountContext: 'personal',
            fullName: 'Official Band Records',
            bio: 'new single out now',
        }).accountContext).toBe('uncertain');
    });
});
