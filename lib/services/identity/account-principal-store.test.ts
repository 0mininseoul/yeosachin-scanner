import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    rpc: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: mocks.rpc },
}));

import {
    AccountPrincipalPersistenceError,
    ensureAccountPrincipal,
    loadAccountCheckoutPhone,
    loadAccountClassification,
    loadE2eTestRunnerPlan,
    loadAccountPrincipal,
    requireActiveAccountClassification,
    requireActiveAccountSession,
    requireActiveE2eTestAccount,
    requireActiveE2eTestRunner,
    upsertKakaoAccountProfile,
} from './account-principal-store';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const principalRow = Object.freeze({
    id: USER_ID,
    email: 'user@example.com',
    provider: 'kakao',
    analysis_count: 1,
    is_paid_user: true,
    is_unlimited: false,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    name: 'Name',
    nickname: null,
    profile_image: null,
    gender: 'female',
    birthyear: '2000',
    account_class: 'production',
    traffic_class: 'external',
    lifecycle: 'active',
    first_paid_at: '2026-08-08T12:41:00.000Z',
    has_active_purchase: true,
});

describe('account principal RPC store', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('loads one active principal through the stable bridge and accepts no row', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [principalRow], error: null })
            .mockResolvedValueOnce({ data: [], error: null });

        await expect(loadAccountPrincipal(USER_ID)).resolves.toEqual(principalRow);
        await expect(loadAccountPrincipal(USER_ID)).resolves.toBeNull();
        expect(mocks.rpc).toHaveBeenNthCalledWith(
            1,
            'load_account_principal_v1',
            { p_user_id: USER_ID },
        );
    });

    it('ensures a principal with only the approved social profile patch', async () => {
        mocks.rpc.mockResolvedValue({ data: [principalRow], error: null });

        await expect(ensureAccountPrincipal({
            userId: USER_ID,
            email: 'user@example.com',
            provider: 'kakao',
            profile: { name: 'Name', profile_image: 'https://example.com/a.jpg' },
        })).resolves.toEqual(principalRow);

        expect(mocks.rpc).toHaveBeenCalledWith(
            'ensure_account_principal_v1',
            {
                p_user_id: USER_ID,
                p_email: 'user@example.com',
                p_provider: 'kakao',
                p_profile: {
                    name: 'Name',
                    profile_image: 'https://example.com/a.jpg',
                },
            },
        );
    });

    it('synchronizes Kakao profile fields without accepting classification fields', async () => {
        mocks.rpc.mockResolvedValue({
            data: [{
                id: USER_ID,
                account_class: 'production',
                traffic_class: 'external',
                lifecycle: 'active',
            }],
            error: null,
        });

        await expect(upsertKakaoAccountProfile({
            userId: USER_ID,
            email: 'user@example.com',
            profile: {
                name: 'Name',
                phone_number: '+82 10-1234-5678',
                phone_number_normalized: '+821012345678',
                phone_number_verification_source: 'kakao_rest_api',
                phone_number_verified_at: '2026-08-10T00:00:00.000Z',
            },
        })).resolves.toEqual({
            id: USER_ID,
            account_class: 'production',
            traffic_class: 'external',
            lifecycle: 'active',
        });

        expect(mocks.rpc).toHaveBeenCalledWith(
            'upsert_kakao_account_profile_v1',
            expect.objectContaining({
                p_user_id: USER_ID,
                p_email: 'user@example.com',
                p_profile: expect.not.objectContaining({
                    account_class: expect.anything(),
                    traffic_class: expect.anything(),
                    lifecycle: expect.anything(),
                }),
            }),
        );
    });

    it('loads checkout phone and classification through bounded result schemas', async () => {
        mocks.rpc
            .mockResolvedValueOnce({
                data: [{
                    id: USER_ID,
                    provider: 'kakao',
                    phone_number: '+82 10-1234-5678',
                    phone_number_normalized: '+821012345678',
                    phone_number_verification_source: 'kakao_rest_api',
                    phone_number_verified_at: '2026-08-10T00:00:00.000Z',
                }],
                error: null,
            })
            .mockResolvedValueOnce({
                data: [{
                    id: USER_ID,
                    account_class: 'e2e_test',
                    traffic_class: 'internal_tester',
                    lifecycle: 'retired',
                    classification_version: 'account-ledger-v1',
                }],
                error: null,
            });

        await expect(loadAccountCheckoutPhone(USER_ID)).resolves.toEqual({
            userId: USER_ID,
            provider: 'kakao',
            phoneNumber: '+82 10-1234-5678',
            phoneNumberNormalized: '+821012345678',
            verificationSource: 'kakao_rest_api',
            verifiedAt: '2026-08-10T00:00:00.000Z',
        });
        await expect(loadAccountClassification(USER_ID)).resolves.toEqual({
            userId: USER_ID,
            accountClass: 'e2e_test',
            trafficClass: 'internal_tester',
            lifecycle: 'retired',
            classificationVersion: 'account-ledger-v1',
        });
    });

    it('fails closed when an account is missing or retired before application admission', async () => {
        const activeClassification = {
            id: USER_ID,
            account_class: 'production',
            traffic_class: 'external',
            lifecycle: 'active',
            classification_version: 'account-ledger-v1',
        };
        mocks.rpc
            .mockResolvedValueOnce({ data: [activeClassification], error: null })
            .mockResolvedValueOnce({ data: [], error: null })
            .mockResolvedValueOnce({
                data: [{
                    ...activeClassification,
                    lifecycle: 'retired',
                }],
                error: null,
            });

        await expect(requireActiveAccountClassification(USER_ID)).resolves.toEqual({
            userId: USER_ID,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
        await expect(requireActiveAccountClassification(USER_ID)).rejects.toMatchObject({
            name: 'AccountPrincipalAdmissionError',
            code: 'ACCOUNT_ADMISSION_DENIED',
        });
        await expect(requireActiveAccountClassification(USER_ID)).rejects.toMatchObject({
            name: 'AccountPrincipalAdmissionError',
            code: 'ACCOUNT_ADMISSION_DENIED',
        });
    });

    it.each(['google', 'kakao'] as const)(
        'bootstraps a missing %s OAuth principal before admitting the first session',
        async provider => {
            mocks.rpc
                .mockResolvedValueOnce({ data: [], error: null })
                .mockResolvedValueOnce({ data: [principalRow], error: null })
                .mockResolvedValueOnce({
                    data: [{
                        id: USER_ID,
                        account_class: 'production',
                        traffic_class: 'external',
                        lifecycle: 'active',
                        classification_version: 'runtime_default_v1',
                    }],
                    error: null,
                });

            await expect(requireActiveAccountSession({
                id: USER_ID,
                email: 'first-login@example.com',
                app_metadata: { provider },
            })).resolves.toMatchObject({
                userId: USER_ID,
                accountClass: 'production',
                trafficClass: 'external',
                lifecycle: 'active',
            });

            expect(mocks.rpc).toHaveBeenNthCalledWith(
                2,
                'ensure_account_principal_v1',
                {
                    p_user_id: USER_ID,
                    p_email: 'first-login@example.com',
                    p_provider: provider,
                    p_profile: {},
                },
            );
        },
    );

    it('does not infer a production principal when first-session provider metadata is not approved', async () => {
        mocks.rpc.mockResolvedValueOnce({ data: [], error: null });

        await expect(requireActiveAccountSession({
            id: USER_ID,
            email: 'first-login@example.com',
            app_metadata: { provider: 'unknown-provider' },
        })).rejects.toMatchObject({
            name: 'AccountPrincipalAdmissionError',
            code: 'ACCOUNT_ADMISSION_DENIED',
        });
        expect(mocks.rpc).toHaveBeenCalledTimes(1);
    });

    it('admits test capability only for an active E2E principal', async () => {
        const activeE2eClassification = {
            id: USER_ID,
            account_class: 'e2e_test',
            traffic_class: 'e2e_test',
            lifecycle: 'active',
            classification_version: 'account-ledger-v1',
        };
        mocks.rpc
            .mockResolvedValueOnce({ data: [activeE2eClassification], error: null })
            .mockResolvedValueOnce({
                data: [{
                    ...activeE2eClassification,
                    account_class: 'production',
                    traffic_class: 'external',
                }],
                error: null,
            });

        await expect(requireActiveE2eTestAccount(USER_ID)).resolves.toMatchObject({
            accountClass: 'e2e_test',
            trafficClass: 'e2e_test',
            lifecycle: 'active',
        });
        await expect(requireActiveE2eTestAccount(USER_ID)).rejects.toMatchObject({
            name: 'AccountPrincipalAdmissionError',
            code: 'ACCOUNT_ADMISSION_DENIED',
        });
    });

    it('requires immutable runner metadata to agree with the signed entitlement plan', async () => {
        const activeE2eClassification = {
            id: USER_ID,
            account_class: 'e2e_test',
            traffic_class: 'e2e_test',
            lifecycle: 'active',
            classification_version: 'account-ledger-v1',
        };
        mocks.rpc
            .mockResolvedValueOnce({ data: [activeE2eClassification], error: null })
            .mockResolvedValueOnce({ data: [{ runner_plan: 'basic' }], error: null })
            .mockResolvedValueOnce({ data: [activeE2eClassification], error: null })
            .mockResolvedValueOnce({ data: [activeE2eClassification], error: null });

        await expect(requireActiveE2eTestRunner({
            id: USER_ID,
            app_metadata: { analysis_test_runner_v1: 'basic' },
        }, 'basic')).resolves.toMatchObject({ runnerPlan: 'basic' });
        await expect(requireActiveE2eTestRunner({
            id: USER_ID,
            app_metadata: { analysis_test_runner_v1: 'basic' },
        }, 'standard')).rejects.toMatchObject({
            name: 'AccountPrincipalAdmissionError',
            code: 'ACCOUNT_ADMISSION_DENIED',
        });
        await expect(requireActiveE2eTestRunner({
            id: USER_ID,
            app_metadata: { analysis_test_runner_v1: 'unrecognized' },
        })).rejects.toMatchObject({
            name: 'AccountPrincipalAdmissionError',
            code: 'ACCOUNT_ADMISSION_DENIED',
        });
    });

    it('fails closed on malformed or failed RPC results without exposing database details', async () => {
        mocks.rpc
            .mockResolvedValueOnce({ data: [{ id: USER_ID }], error: null })
            .mockResolvedValueOnce({
                data: null,
                error: {
                    code: 'P0001',
                    message: 'private phone and email must not escape',
                },
            });

        await expect(loadAccountPrincipal(USER_ID)).rejects.toEqual(
            expect.objectContaining({
                name: 'AccountPrincipalPersistenceError',
                code: 'ACCOUNT_PRINCIPAL_RESULT_INVALID',
            }),
        );
        const failure = await loadAccountPrincipal(USER_ID).catch(error => error);
        expect(failure).toBeInstanceOf(AccountPrincipalPersistenceError);
        expect(String(failure)).not.toContain('private phone');
        expect(String(failure)).not.toContain('email');
    });

    it('fails closed when immutable Auth runner metadata is no longer backed by the registry', async () => {
        const activeE2eClassification = {
            id: USER_ID,
            account_class: 'e2e_test',
            traffic_class: 'e2e_test',
            lifecycle: 'active',
            classification_version: 'account-ledger-v1',
        };
        mocks.rpc
            .mockResolvedValueOnce({ data: [], error: null })
            .mockResolvedValueOnce({ data: [activeE2eClassification], error: null })
            .mockResolvedValueOnce({ data: [], error: null });

        await expect(loadE2eTestRunnerPlan(USER_ID)).resolves.toBeNull();
        await expect(requireActiveE2eTestRunner({
            id: USER_ID,
            app_metadata: { analysis_test_runner_v1: 'basic' },
        }, 'basic')).rejects.toMatchObject({
            name: 'AccountPrincipalAdmissionError',
            code: 'ACCOUNT_ADMISSION_DENIED',
        });
        expect(mocks.rpc).toHaveBeenLastCalledWith(
            'load_e2e_test_runner_v1',
            { p_user_id: USER_ID },
        );
    });
});
