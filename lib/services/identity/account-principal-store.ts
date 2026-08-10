import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const accountClassSchema = z.enum(['production', 'e2e_test']);
const trafficClassSchema = z.enum([
    'external',
    'operator',
    'e2e_test',
    'internal_tester',
]);
const lifecycleSchema = z.enum(['active', 'retired']);
const e2eTestRunnerPlanSchema = z.enum(['basic', 'standard']);

/**
 * Auth app_metadata is only mutable by trusted Auth administration. This v1
 * field identifies the dedicated E2E runner; the database principal remains
 * the separate, durable admission authority.
 */
export const E2E_TEST_RUNNER_APP_METADATA_KEY = 'analysis_test_runner_v1';
export type E2eTestRunnerPlan = z.infer<typeof e2eTestRunnerPlanSchema>;
export type E2eTestEntitlementPlan = E2eTestRunnerPlan | 'plus';

const socialProfileSchema = z.object({
    name: z.string().min(1).max(255).optional(),
    nickname: z.string().min(1).max(255).optional(),
    profile_image: z.string().min(1).max(4_096).optional(),
    gender: z.string().min(1).max(20).optional(),
    birthyear: z.string().min(1).max(4).optional(),
}).strict();

const kakaoProfileSchema = socialProfileSchema.extend({
    phone_number: z.string().min(1).max(50).nullable().optional(),
    phone_number_normalized: z.string().min(1).max(32).nullable().optional(),
    phone_number_verification_source: z.literal('kakao_rest_api')
        .nullable()
        .optional(),
    phone_number_verified_at: z.string()
        .datetime({ offset: true })
        .nullable()
        .optional(),
}).strict();

const accountPrincipalRowSchema = z.object({
    id: z.string().uuid(),
    email: z.string().min(1).max(255),
    provider: z.string().min(1).max(50),
    analysis_count: z.number().int().nonnegative(),
    is_paid_user: z.boolean(),
    is_unlimited: z.boolean(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }),
    name: z.string().max(255).nullable(),
    nickname: z.string().max(255).nullable(),
    profile_image: z.string().max(4_096).nullable(),
    gender: z.string().max(20).nullable(),
    birthyear: z.string().max(4).nullable(),
    account_class: accountClassSchema,
    traffic_class: trafficClassSchema,
    lifecycle: lifecycleSchema,
    first_paid_at: z.string().datetime({ offset: true }).nullable(),
    has_active_purchase: z.boolean(),
}).strict();

const kakaoUpsertResultSchema = z.object({
    id: z.string().uuid(),
    account_class: accountClassSchema,
    traffic_class: trafficClassSchema,
    lifecycle: lifecycleSchema,
}).strict();

const checkoutPhoneRowSchema = z.object({
    id: z.string().uuid(),
    provider: z.string().min(1).max(50),
    phone_number: z.string().min(1).max(50).nullable(),
    phone_number_normalized: z.string().min(1).max(32).nullable(),
    phone_number_verification_source: z.string().min(1).max(64).nullable(),
    phone_number_verified_at: z.string()
        .datetime({ offset: true })
        .nullable(),
}).strict();

const classificationRowSchema = z.object({
    id: z.string().uuid(),
    account_class: accountClassSchema,
    traffic_class: trafficClassSchema,
    lifecycle: lifecycleSchema,
    classification_version: z.string().min(1).max(64).nullable(),
}).strict();

const e2eTestRunnerRowSchema = z.object({
    runner_plan: e2eTestRunnerPlanSchema,
}).strict();

export type AccountPrincipal = z.infer<typeof accountPrincipalRowSchema>;
export type SocialAccountProfile = z.infer<typeof socialProfileSchema>;
export type KakaoAccountProfile = z.infer<typeof kakaoProfileSchema>;

type PersistenceCode =
    | 'ACCOUNT_RETIRED'
    | 'ACCOUNT_PRINCIPAL_PERSISTENCE_FAILED'
    | 'ACCOUNT_PRINCIPAL_RESULT_INVALID';

export class AccountPrincipalPersistenceError extends Error {
    readonly code: PersistenceCode;
    readonly databaseCode: string;

    constructor(code: PersistenceCode, databaseCode: string = 'unknown') {
        super(code);
        this.name = 'AccountPrincipalPersistenceError';
        this.code = code;
        this.databaseCode = databaseCode;
    }
}

export class AccountPrincipalAdmissionError extends Error {
    readonly code = 'ACCOUNT_ADMISSION_DENIED';

    constructor() {
        super('ACCOUNT_ADMISSION_DENIED');
        this.name = 'AccountPrincipalAdmissionError';
    }
}

const SAFE_DATABASE_CODE = /^(?:[0-9A-Z]{5}|PGRST[0-9]{3})$/;

function boundedDatabaseCode(error: unknown): string {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return 'unknown';
    }
    const code = String(error.code).toUpperCase();
    return SAFE_DATABASE_CODE.test(code) ? code : 'unknown';
}

function persistenceCode(error: unknown): PersistenceCode {
    if (
        typeof error === 'object'
        && error !== null
        && 'message' in error
        && String(error.message).includes('ACCOUNT_RETIRED')
    ) return 'ACCOUNT_RETIRED';
    return 'ACCOUNT_PRINCIPAL_PERSISTENCE_FAILED';
}

async function rpcSingle<T>(
    functionName: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    nullable: boolean,
): Promise<T | null> {
    const { data, error } = await supabaseAdmin.rpc(functionName, params);
    if (error) {
        throw new AccountPrincipalPersistenceError(
            persistenceCode(error),
            boundedDatabaseCode(error),
        );
    }
    const rows = z.array(z.unknown()).max(1).safeParse(data);
    if (!rows.success) {
        throw new AccountPrincipalPersistenceError(
            'ACCOUNT_PRINCIPAL_RESULT_INVALID',
        );
    }
    if (rows.data.length === 0) {
        if (nullable) return null;
        throw new AccountPrincipalPersistenceError(
            'ACCOUNT_PRINCIPAL_RESULT_INVALID',
        );
    }
    const parsed = schema.safeParse(rows.data[0]);
    if (!parsed.success) {
        throw new AccountPrincipalPersistenceError(
            'ACCOUNT_PRINCIPAL_RESULT_INVALID',
        );
    }
    return parsed.data;
}

export async function loadAccountPrincipal(
    userId: string,
): Promise<AccountPrincipal | null> {
    return rpcSingle(
        'load_account_principal_v1',
        { p_user_id: userId },
        accountPrincipalRowSchema,
        true,
    );
}

export async function ensureAccountPrincipal(input: {
    userId: string;
    email: string;
    provider: 'google' | 'kakao';
    profile: SocialAccountProfile;
}): Promise<AccountPrincipal> {
    const profile = socialProfileSchema.parse(input.profile);
    const result = await rpcSingle(
        'ensure_account_principal_v1',
        {
            p_user_id: input.userId,
            p_email: input.email,
            p_provider: input.provider,
            p_profile: profile,
        },
        accountPrincipalRowSchema,
        false,
    );
    if (!result) {
        throw new AccountPrincipalPersistenceError(
            'ACCOUNT_PRINCIPAL_RESULT_INVALID',
        );
    }
    return result;
}

export async function upsertKakaoAccountProfile(input: {
    userId: string;
    email: string | null;
    profile: KakaoAccountProfile;
}) {
    const profile = kakaoProfileSchema.parse(input.profile);
    const result = await rpcSingle(
        'upsert_kakao_account_profile_v1',
        {
            p_user_id: input.userId,
            p_email: input.email,
            p_profile: profile,
        },
        kakaoUpsertResultSchema,
        false,
    );
    if (!result) {
        throw new AccountPrincipalPersistenceError(
            'ACCOUNT_PRINCIPAL_RESULT_INVALID',
        );
    }
    return result;
}

export async function loadAccountCheckoutPhone(userId: string) {
    const row = await rpcSingle(
        'load_account_checkout_phone_v1',
        { p_user_id: userId },
        checkoutPhoneRowSchema,
        true,
    );
    if (!row) return null;
    return Object.freeze({
        userId: row.id,
        provider: row.provider,
        phoneNumber: row.phone_number,
        phoneNumberNormalized: row.phone_number_normalized,
        verificationSource: row.phone_number_verification_source,
        verifiedAt: row.phone_number_verified_at,
    });
}

export async function loadAccountClassification(userId: string) {
    const row = await rpcSingle(
        'load_account_classification_v1',
        { p_user_id: userId },
        classificationRowSchema,
        true,
    );
    if (!row) return null;
    return Object.freeze({
        userId: row.id,
        accountClass: row.account_class,
        trafficClass: row.traffic_class,
        lifecycle: row.lifecycle,
        classificationVersion: row.classification_version,
    });
}

export async function requireActiveAccountClassification(userId: string) {
    const classification = await loadAccountClassification(userId);
    if (!classification || classification.lifecycle !== 'active') {
        throw new AccountPrincipalAdmissionError();
    }
    return classification;
}

/**
 * Authenticated page/session entry point. A legitimate first Google/Kakao
 * session may not have a users row yet, so bootstrap that service-owned row
 * through the same RPC used by /api/user/me, then apply the normal active
 * classification guard. Unknown providers and missing email fail closed; in
 * particular, this helper does not infer E2E status from an unapproved
 * metadata convention.
 */
export async function requireActiveAccountSession(user: {
    id: string;
    email?: string | null;
    app_metadata?: Record<string, unknown> | null;
}) {
    const existing = await loadAccountClassification(user.id);
    if (existing) {
        if (existing.lifecycle !== 'active') {
            throw new AccountPrincipalAdmissionError();
        }
        return existing;
    }

    const provider = user.app_metadata?.provider;
    if (
        !user.email
        || (provider !== 'google' && provider !== 'kakao')
    ) {
        throw new AccountPrincipalAdmissionError();
    }

    await ensureAccountPrincipal({
        userId: user.id,
        email: user.email,
        provider,
        profile: {},
    });

    return requireActiveAccountClassification(user.id);
}

export async function requireActiveE2eTestAccount(userId: string) {
    const classification = await requireActiveAccountClassification(userId);
    if (
        classification.accountClass !== 'e2e_test'
        || classification.trafficClass !== 'e2e_test'
    ) {
        throw new AccountPrincipalAdmissionError();
    }
    return classification;
}

/**
 * The registry is the durable counterpart to Auth app_metadata. Returning no
 * row on a metadata/registry disagreement keeps test capability fail-closed.
 */
export async function loadE2eTestRunnerPlan(userId: string): Promise<E2eTestRunnerPlan | null> {
    const row = await rpcSingle(
        'load_e2e_test_runner_v1',
        { p_user_id: userId },
        e2eTestRunnerRowSchema,
        true,
    );
    return row?.runner_plan ?? null;
}

/**
 * Test capability requires two independent, server-verified facts:
 * 1. the service-only principal classification is active E2E traffic; and
 * 2. Auth app_metadata names one of the dedicated Basic/Standard runners.
 *
 * The signed entitlement remains the cryptographic source of the preflight,
 * user, and selected-plan binding. This guard adds the runner-to-plan binding
 * before either route persists or consumes that capability.
 */
export async function requireActiveE2eTestRunner(
    user: {
        id: string;
        app_metadata?: Record<string, unknown> | null;
    },
    expectedPlan?: E2eTestEntitlementPlan,
) {
    const classification = await requireActiveE2eTestAccount(user.id);
    const runnerPlan = e2eTestRunnerPlanSchema.safeParse(
        user.app_metadata?.[E2E_TEST_RUNNER_APP_METADATA_KEY],
    );

    if (
        !runnerPlan.success
        || (expectedPlan !== undefined && runnerPlan.data !== expectedPlan)
    ) {
        throw new AccountPrincipalAdmissionError();
    }

    const registryPlan = await loadE2eTestRunnerPlan(user.id);
    if (registryPlan !== runnerPlan.data) {
        throw new AccountPrincipalAdmissionError();
    }

    return Object.freeze({
        ...classification,
        runnerPlan: runnerPlan.data,
    });
}
