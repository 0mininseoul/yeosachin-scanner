import { describe, expect, it } from 'vitest';
import {
    AUTHORIZED_TEST_PROVIDER_OPERATION_KINDS,
    assertAuthorizedTestProviderCredentialsAvailable,
    authorizedTestProviderExecutionPolicySchema,
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
    APIFY_SENARY_API_TOKEN: 'senary-test-token',
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
        // The slot map covers exactly the seven authorized test operations. The provider
        // operation kinds add 'profile-repair', which owns no slot (it resolves through the
        // profile-fallback slot), so the two arrays diverge by exactly that one kind.
        expect(Object.keys(policy!.operationSlots).sort()).toEqual(
            [...AUTHORIZED_TEST_PROVIDER_OPERATION_KINDS].sort()
        );
        expect([...ANALYSIS_V2_PROVIDER_OPERATION_KINDS].sort()).toEqual(
            [...AUTHORIZED_TEST_PROVIDER_OPERATION_KINDS, 'profile-repair'].sort()
        );
    });

    it('keeps operationSlots a strict seven-key shape that excludes profile-repair', () => {
        // A policy persisted per request under the old shape must still parse unchanged.
        const storedSevenKeyPolicy = {
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
        };
        const parsed = authorizedTestProviderExecutionPolicySchema.parse(storedSevenKeyPolicy);
        expect(Object.keys(parsed.operationSlots)).toHaveLength(7);
        expect(Object.keys(parsed.operationSlots).sort()).toEqual(
            [...AUTHORIZED_TEST_PROVIDER_OPERATION_KINDS].sort()
        );

        // The tempting-but-wrong widening: adding profile-repair as an eighth slot must be
        // rejected. The slot map is persisted per request, so an eighth key would invalidate
        // every stored policy and every in-flight request. Repair uses the profile-fallback slot.
        const eightKeyPolicy = {
            ...storedSevenKeyPolicy,
            operationSlots: {
                ...storedSevenKeyPolicy.operationSlots,
                'profile-repair': 'primary',
            },
        };
        expect(
            authorizedTestProviderExecutionPolicySchema.safeParse(eightKeyPolicy).success
        ).toBe(false);

        // Dropping any one of the seven required keys must also be rejected.
        const sixKeySlots = Object.fromEntries(
            Object.entries(storedSevenKeyPolicy.operationSlots).filter(
                ([key]) => key !== 'candidate-likers'
            )
        );
        expect(
            authorizedTestProviderExecutionPolicySchema.safeParse({
                ...storedSevenKeyPolicy,
                operationSlots: sixKeySlots,
            }).success
        ).toBe(false);
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

    it('accepts the same-named senary credential and continues to reject septenary', () => {
        const senaryEnv = {
            ...authorizedEnv,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'senary',
        };
        const policy = configuredAuthorizedTestProviderPolicy(authorizedTarget, senaryEnv);
        expect(policy?.operationSlots['relationship-followers']).toBe('senary');
        expect(resolveAnalysisV2ApifyCredentialSlot({
            accessMode: 'test_entitlement',
            policy,
            operation: 'relationship-followers',
            env: senaryEnv,
        })).toBe('senary');

        expect(() => assertAuthorizedTestProviderCredentialsAvailable(policy!, {
            ...senaryEnv,
            APIFY_SENARY_API_TOKEN: '',
        })).toThrow('APIFY_SENARY_API_TOKEN');
        expect(() => configuredAuthorizedTestProviderPolicy(authorizedTarget, {
            ...senaryEnv,
            ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT: 'septenary',
        })).toThrow('ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT');
    });
});
