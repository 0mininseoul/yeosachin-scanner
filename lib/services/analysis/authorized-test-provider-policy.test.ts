import { describe, expect, it } from 'vitest';
import {
    assertAuthorizedTestProviderCredentialsAvailable,
    configuredAuthorizedTestProviderPolicy,
    resolveAnalysisV2ApifyCredentialSlot,
} from './authorized-test-provider-policy';
import { ANALYSIS_V2_PROVIDER_OPERATION_KINDS } from './v2-provider-run-store';

const OWNER_USER_ID = '974247fa-8d0e-4ab7-b6d2-ddf256ad6bdd';
const OTHER_USER_ID = '123e4567-e89b-42d3-a456-426614174001';

const authorizedEnv = {
    ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'true',
    ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET: '0_min._.00',
    ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID: OWNER_USER_ID,
    ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'primary',
    ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'secondary',
    ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT: 'tertiary',
    ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT: 'quaternary',
    ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT: 'tertiary',
    ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT: 'quinary',
    APIFY_PRIMARY_API_TOKEN: 'primary-test-token',
    APIFY_SECONDARY_API_TOKEN: 'secondary-test-token',
    APIFY_TERTIARY_API_TOKEN: 'tertiary-test-token',
    APIFY_QUATERNARY_API_TOKEN: 'quaternary-test-token',
    APIFY_QUINARY_API_TOKEN: 'quinary-test-token',
} as const;

const authorizedTarget = {
    targetUsername: '0_min._.00',
    ownerUserId: OWNER_USER_ID,
};

describe('authorized analysis V2 test provider policy', () => {
    it('keeps the existing deployment-scoped single slot when the test flag is off', () => {
        expect(configuredAuthorizedTestProviderPolicy(authorizedTarget, {
            ...authorizedEnv,
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'false',
        })).toBeNull();
        expect(resolveAnalysisV2ApifyCredentialSlot({
            accessMode: 'production',
            policy: null,
            operation: 'relationship-followers',
            env: { ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary' },
        })).toBe('quinary');
    });

    it('builds an exact-target operation map and resolves signed test operations', () => {
        const policy = configuredAuthorizedTestProviderPolicy({
            targetUsername: '@0_MIN._.00',
            ownerUserId: OWNER_USER_ID.toUpperCase(),
        }, authorizedEnv);
        expect(policy).toEqual({
            mode: 'test_operation_split',
            policyVersion: 'authorized-free-e2e-v1',
            operationSlots: {
                'target-profile': 'tertiary',
                'relationship-followers': 'primary',
                'relationship-following': 'secondary',
                'profile-fallback': 'tertiary',
                'target-likers': 'quaternary',
                'target-comments': 'tertiary',
                'candidate-likers': 'quinary',
            },
        });
        expect(resolveAnalysisV2ApifyCredentialSlot({
            accessMode: 'test_entitlement',
            policy,
            operation: 'relationship-following',
            env: authorizedEnv,
        })).toBe('secondary');
        expect(configuredAuthorizedTestProviderPolicy({
            ...authorizedTarget,
            targetUsername: 'someone.else',
        }, authorizedEnv)).toBeNull();
        expect(configuredAuthorizedTestProviderPolicy({
            ...authorizedTarget,
            ownerUserId: OTHER_USER_ID,
        }, authorizedEnv)).toBeNull();
        expect([...ANALYSIS_V2_PROVIDER_OPERATION_KINDS].sort()).toEqual(
            Object.keys(policy!.operationSlots).sort()
        );
    });

    it('fails closed on malformed flags, slot maps, and production policy injection', () => {
        expect(() => configuredAuthorizedTestProviderPolicy(authorizedTarget, {
            ...authorizedEnv,
            ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED: 'sometimes',
        })).toThrow('must be boolean');
        expect(() => configuredAuthorizedTestProviderPolicy(authorizedTarget, {
            ...authorizedEnv,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT: 'primary',
        })).toThrow('different slots');

        const policy = configuredAuthorizedTestProviderPolicy(authorizedTarget, authorizedEnv);
        expect(() => resolveAnalysisV2ApifyCredentialSlot({
            accessMode: 'production',
            policy,
            operation: 'target-likers',
        })).toThrow('ANALYSIS_V2_AUTHORIZED_TEST_SHARD_SCOPE_ERROR');

        const envWithoutQuinary = { ...authorizedEnv, APIFY_QUINARY_API_TOKEN: '' };
        expect(() => assertAuthorizedTestProviderCredentialsAvailable(
            policy!,
            envWithoutQuinary
        )).toThrow('APIFY_QUINARY_API_TOKEN');
    });
});
