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
            profileSignalCount: 4,
        });
    });

    it('corroborates the reported band fixture from only club plus release evidence', () => {
        expect(screenAnalysisV2OfficialAccount({
            modelAccountContext: 'official_group_or_brand',
            fullName: 'Black Cherry Club',
            bio: 'Single [콜드브루] Out now',
        })).toEqual({
            accountContext: 'official_group_or_brand',
            exclusionReason: 'model_group_context_plus_profile_signals',
            profileSignalCount: 2,
        });
    });

    it.each([
        ['Sora Club', 'single today, I am out now shopping'],
        ['Sora Club', 'I am single today — out now shopping'],
        ['Sora Club', 'latest photos, out now'],
        ['Sora Club', 'listen now, single today'],
    ])('does not treat ordinary out-now language as music release evidence: %s / %s', (
        fullName,
        bio,
    ) => {
        expect(screenAnalysisV2OfficialAccount({
            modelAccountContext: 'official_group_or_brand',
            fullName,
            bio,
        })).toEqual({
            accountContext: 'uncertain',
            exclusionReason: null,
            profileSignalCount: 0,
        });
    });

    it.each([
        ['Black Cherry Club', 'Single   [ 콜드브루 ]   OUT NOW'],
        ['Night Club', 'EP “봄밤” out now'],
        ['Blue Club', 'Latest album Summer Tape available now'],
        ['Blue Club', 'New single Blue Hour streaming now'],
    ])('accepts high-confidence release syntax across spacing and Unicode variants: %s / %s', (
        fullName,
        bio,
    ) => {
        expect(screenAnalysisV2OfficialAccount({
            modelAccountContext: 'official_group_or_brand',
            fullName,
            bio,
        })).toEqual({
            accountContext: 'official_group_or_brand',
            exclusionReason: 'model_group_context_plus_profile_signals',
            profileSignalCount: 2,
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

    it.each([
        ['Running Club', 'weekend photos and coffee'],
        ['Book Club', 'my favorite album is on repeat'],
        ['Lunch Club', 'single person, not a group'],
        ['Black Cherry Clubhouse', 'Single [콜드브루] Out now'],
    ])('does not turn a personal club phrase into organization evidence: %s', (
        fullName,
        bio,
    ) => {
        expect(screenAnalysisV2OfficialAccount({
            modelAccountContext: 'official_group_or_brand',
            fullName,
            bio,
        })).toMatchObject({
            accountContext: 'uncertain',
            exclusionReason: null,
        });
    });

    it('never promotes profile text without model group evidence', () => {
        expect(screenAnalysisV2OfficialAccount({
            modelAccountContext: 'personal',
            fullName: 'Official Band Records',
            bio: 'new single out now',
        }).accountContext).toBe('uncertain');
    });

    it.each([
        'since recording',
        'recording communityservice',
        'accompany labelmaker',
        'homestudioish teammate',
        'officially collectivework',
        '소company원 개인일기',
    ])('does not count English organization substrings: %s', bio => {
        expect(screenAnalysisV2OfficialAccount({
            modelAccountContext: 'official_group_or_brand',
            fullName: 'A personal name',
            bio,
        })).toEqual({
            accountContext: 'uncertain',
            exclusionReason: null,
            profileSignalCount: 0,
        });
    });
});
