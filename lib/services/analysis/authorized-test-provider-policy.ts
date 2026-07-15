import { z } from 'zod';
import type { PlanAccessMode } from '@/lib/domain/analysis/plan-catalog';
import {
    selectApifyApiToken,
    selectAnalysisV2ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/apify-relationship';
import {
    APIFY_CREDENTIAL_SLOTS,
    type ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/types';

export const AUTHORIZED_TEST_PROVIDER_POLICY_VERSION = 'authorized-free-e2e-v1' as const;

export const AUTHORIZED_TEST_PROVIDER_OPERATION_KINDS = [
    'target-profile',
    'relationship-followers',
    'relationship-following',
    'profile-fallback',
    'target-likers',
    'target-comments',
    'candidate-likers',
] as const;

export type AuthorizedTestProviderOperationKind =
    (typeof AUTHORIZED_TEST_PROVIDER_OPERATION_KINDS)[number];

const credentialSlotSchema = z.enum(APIFY_CREDENTIAL_SLOTS);
const operationSlotsSchema = z.object({
    'target-profile': credentialSlotSchema,
    'relationship-followers': credentialSlotSchema,
    'relationship-following': credentialSlotSchema,
    'profile-fallback': credentialSlotSchema,
    'target-likers': credentialSlotSchema,
    'target-comments': credentialSlotSchema,
    'candidate-likers': credentialSlotSchema,
}).strict().superRefine((slots, context) => {
    if (slots['target-profile'] !== slots['profile-fallback']) {
        context.addIssue({
            code: 'custom',
            message: 'Authorized profile test operations must use the same slot.',
        });
    }
    if (slots['relationship-followers'] === slots['relationship-following']) {
        context.addIssue({
            code: 'custom',
            message: 'Authorized relationship test operations must use different slots.',
        });
    }
    if (slots['target-likers'] === slots['candidate-likers']) {
        context.addIssue({
            code: 'custom',
            message: 'Authorized liker test operations must use different slots.',
        });
    }
});

export const authorizedTestProviderExecutionPolicySchema = z.object({
    mode: z.literal('test_operation_split'),
    policyVersion: z.literal(AUTHORIZED_TEST_PROVIDER_POLICY_VERSION),
    operationSlots: operationSlotsSchema,
}).strict();

export type AuthorizedTestProviderExecutionPolicy = z.infer<
    typeof authorizedTestProviderExecutionPolicySchema
>;

const SLOT_ENV_KEYS: Readonly<Record<AuthorizedTestProviderOperationKind, string>> = {
    'target-profile': 'ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT',
    'relationship-followers': 'ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWERS_SLOT',
    'relationship-following': 'ANALYSIS_V2_AUTHORIZED_TEST_RELATIONSHIP_FOLLOWING_SLOT',
    'profile-fallback': 'ANALYSIS_V2_AUTHORIZED_TEST_PROFILE_FALLBACK_SLOT',
    'target-likers': 'ANALYSIS_V2_AUTHORIZED_TEST_TARGET_LIKERS_SLOT',
    'target-comments': 'ANALYSIS_V2_AUTHORIZED_TEST_TARGET_COMMENTS_SLOT',
    'candidate-likers': 'ANALYSIS_V2_AUTHORIZED_TEST_CANDIDATE_LIKERS_SLOT',
};

function strictBoolean(value: string | undefined): boolean {
    const normalized = value?.trim().toLowerCase();
    if (!normalized || ['0', 'false', 'off', 'no'].includes(normalized)) return false;
    if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    throw new Error(
        'ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED must be boolean.'
    );
}

function normalizedUsername(value: string | undefined, key: string): string {
    const normalized = value?.trim().replace(/^@+/, '').toLowerCase();
    if (!normalized || !/^[a-z0-9._]{1,30}$/.test(normalized)) {
        throw new Error(`ANALYSIS_V2_AUTHORIZED_TEST_SHARD_CONFIG_ERROR: ${key}.`);
    }
    return normalized;
}

function normalizedUserId(value: string | undefined, key: string): string {
    const normalized = value?.trim().toLowerCase();
    if (
        !normalized
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            normalized
        )
    ) {
        throw new Error(`ANALYSIS_V2_AUTHORIZED_TEST_SHARD_CONFIG_ERROR: ${key}.`);
    }
    return normalized;
}

function configuredSlot(
    env: Record<string, string | undefined>,
    operation: AuthorizedTestProviderOperationKind
): ApifyCredentialSlot {
    const key = SLOT_ENV_KEYS[operation];
    const parsed = credentialSlotSchema.safeParse(env[key]?.trim().toLowerCase());
    if (!parsed.success) {
        throw new Error(`ANALYSIS_V2_AUTHORIZED_TEST_SHARD_CONFIG_ERROR: ${key}.`);
    }
    return parsed.data;
}

export function authorizedTestProviderShardingEnabled(
    env: Record<string, string | undefined> = process.env
): boolean {
    return strictBoolean(env.ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED);
}

/**
 * Returns a request-bound policy only for the exact allowlisted signed-test target.
 * Production and ordinary test requests keep the existing single-slot behavior.
 */
export function configuredAuthorizedTestProviderPolicy(
    input: { targetUsername: string; ownerUserId: string },
    env: Record<string, string | undefined> = process.env
): AuthorizedTestProviderExecutionPolicy | null {
    if (!authorizedTestProviderShardingEnabled(env)) return null;
    const configuredTarget = normalizedUsername(
        env.ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET,
        'ANALYSIS_V2_AUTHORIZED_TEST_SHARD_TARGET'
    );
    const normalizedTarget = normalizedUsername(input.targetUsername, 'targetUsername');
    if (configuredTarget !== normalizedTarget) return null;
    const configuredOwnerUserId = normalizedUserId(
        env.ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID,
        'ANALYSIS_V2_AUTHORIZED_TEST_OWNER_USER_ID'
    );
    const ownerUserId = normalizedUserId(input.ownerUserId, 'ownerUserId');
    if (configuredOwnerUserId !== ownerUserId) return null;

    return authorizedTestProviderExecutionPolicySchema.parse({
        mode: 'test_operation_split',
        policyVersion: AUTHORIZED_TEST_PROVIDER_POLICY_VERSION,
        operationSlots: Object.fromEntries(
            AUTHORIZED_TEST_PROVIDER_OPERATION_KINDS.map(operation => [
                operation,
                configuredSlot(env, operation),
            ])
        ),
    });
}

export function assertAuthorizedTestProviderCredentialsAvailable(
    rawPolicy: AuthorizedTestProviderExecutionPolicy,
    env: Record<string, string | undefined> = process.env
): AuthorizedTestProviderExecutionPolicy {
    const policy = authorizedTestProviderExecutionPolicySchema.parse(rawPolicy);
    for (const slot of new Set(Object.values(policy.operationSlots))) {
        void selectApifyApiToken(env, slot);
    }
    return policy;
}

export function resolveAnalysisV2ApifyCredentialSlot(input: {
    accessMode: PlanAccessMode;
    policy: AuthorizedTestProviderExecutionPolicy | null;
    operation: AuthorizedTestProviderOperationKind;
    env?: Record<string, string | undefined>;
}): ApifyCredentialSlot {
    if (input.policy === null) {
        return selectAnalysisV2ApifyCredentialSlot(input.env);
    }
    if (input.accessMode !== 'test_entitlement') {
        throw new Error('ANALYSIS_V2_AUTHORIZED_TEST_SHARD_SCOPE_ERROR');
    }
    const policy = assertAuthorizedTestProviderCredentialsAvailable(
        input.policy,
        input.env
    );
    return policy.operationSlots[input.operation];
}
