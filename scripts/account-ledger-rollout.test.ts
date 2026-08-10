import { describe, expect, it, vi } from 'vitest';

import {
    ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION,
    ACCOUNT_LEDGER_COMMAND_VERSION,
    ACCOUNT_LEDGER_EXPECTED_LEGACY_E2E_COUNT,
    createLegacyCandidateHmac,
    parseAccountLedgerRolloutArgs,
    runAccountLedgerRollout,
    type AccountLedgerRolloutDependencies,
} from './account-ledger-rollout';

const LEGACY_IDS = Object.freeze(Array.from(
    { length: ACCOUNT_LEDGER_EXPECTED_LEGACY_E2E_COUNT },
    (_, index) => `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
));
const OPERATOR_ID = '20000000-0000-4000-8000-000000000001';
const INTERNAL_TESTER_ID = '30000000-0000-4000-8000-000000000001';
const AUDIT_SECRET = Buffer.alloc(32, 7).toString('base64url');
const EXPECTED_HMAC = createLegacyCandidateHmac(LEGACY_IDS, AUDIT_SECRET);
const PLAN_ASSIGNMENTS = Object.freeze(Array.from({ length: 50 }, (_, index) => ({
    account_id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
})));

function createDependencies(
    overrides: Partial<AccountLedgerRolloutDependencies> = {},
) {
    const reports: unknown[] = [];
    const keychainValues: Record<string, string | null> = {
        'audit-secret-v1': AUDIT_SECRET,
        'expected-legacy-e2e-hmac-v1': EXPECTED_HMAC,
        'operator-account-id-v1': OPERATOR_ID,
        'internal-tester-account-ids-v1': JSON.stringify([INTERNAL_TESTER_ID]),
        'e2e-runner-basic-v1': null,
        'e2e-runner-standard-v1': null,
    };
    const dependencies: AccountLedgerRolloutDependencies = {
        keychain: {
            read: vi.fn(async (account: string) => keychainValues[account] ?? null),
            write: vi.fn(async () => undefined),
        },
        ledger: {
            getRolloutState: vi.fn(async () => ({ state: 'pending' as const, commandVersion: null })),
            listLegacyE2eCandidateIds: vi.fn(async () => [...LEGACY_IDS].reverse()),
            buildClassificationPlan: vi.fn(async () => ({
                assignments: PLAN_ASSIGNMENTS,
                totalCount: 50,
                legacyE2eCount: ACCOUNT_LEDGER_EXPECTED_LEGACY_E2E_COUNT,
                operatorCount: 1,
                internalTesterCount: 1,
                productionExternalCount: 31,
            })),
            applyClassificationPlan: vi.fn(async () => ({
                updatedCount: 50,
                evidenceCount: 1,
                paidAccountCount: 1,
            })),
            provisionRunner: vi.fn(async input => ({
                runnerPlan: input.runnerPlan,
                created: true,
            })),
            listRunnerPlans: vi.fn(async () => ['basic', 'standard']),
        },
        auth: {
            createUser: vi.fn(async input => ({
                id: input.runnerPlan === 'basic'
                    ? '40000000-0000-4000-8000-000000000001'
                    : '40000000-0000-4000-8000-000000000002',
                appMetadata: { analysis_test_runner_v1: input.runnerPlan },
            })),
            getUser: vi.fn(async () => null),
            findUserByEmail: vi.fn(async () => null),
        },
        report: value => reports.push(value),
        randomBytes: size => Buffer.alloc(size, 9),
        ...overrides,
    };
    return { dependencies, reports };
}

describe('account-ledger rollout command', () => {
    it('defaults to a read-only audit and rejects mutation modes without an exact confirmation', async () => {
        expect(parseAccountLedgerRolloutArgs([])).toEqual({ mode: 'audit' });
        expect(() => parseAccountLedgerRolloutArgs(['--mode', 'apply'])).toThrow(
            ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION,
        );
        expect(() => parseAccountLedgerRolloutArgs([
            '--mode', 'apply', ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION,
            ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION,
        ])).toThrow(ACCOUNT_LEDGER_ACTIVATION_CONFIRMATION);

        const { dependencies } = createDependencies();
        await runAccountLedgerRollout({ mode: 'audit' }, dependencies);
        expect(dependencies.ledger.applyClassificationPlan).not.toHaveBeenCalled();
        expect(dependencies.auth.createUser).not.toHaveBeenCalled();
    });

    it('rejects candidate count or HMAC drift before creating a plan or mutation', async () => {
        const countDrift = createDependencies({
            ledger: {
                ...createDependencies().dependencies.ledger,
                listLegacyE2eCandidateIds: vi.fn(async () => LEGACY_IDS.slice(1)),
            },
        });
        await expect(runAccountLedgerRollout({ mode: 'audit' }, countDrift.dependencies))
            .rejects.toThrow('ACCOUNT_LEDGER_LEGACY_CANDIDATE_COUNT_MISMATCH');
        expect(countDrift.dependencies.ledger.buildClassificationPlan).not.toHaveBeenCalled();

        const hmacDrift = createDependencies({
            keychain: {
                read: vi.fn(async (account: string) => account === 'expected-legacy-e2e-hmac-v1'
                    ? Buffer.alloc(32, 8).toString('base64url')
                    : (({
                        'audit-secret-v1': AUDIT_SECRET,
                        'operator-account-id-v1': OPERATOR_ID,
                        'internal-tester-account-ids-v1': JSON.stringify([INTERNAL_TESTER_ID]),
                    } as Record<string, string | null>)[account] ?? null)),
                write: vi.fn(async () => undefined),
            },
        });
        await expect(runAccountLedgerRollout({ mode: 'audit' }, hmacDrift.dependencies))
            .rejects.toThrow('ACCOUNT_LEDGER_LEGACY_CANDIDATE_HMAC_MISMATCH');
        expect(hmacDrift.dependencies.ledger.buildClassificationPlan).not.toHaveBeenCalled();
    });

    it('builds a bounded classification plan and emits aggregate-only reports', async () => {
        const { dependencies, reports } = createDependencies();

        await runAccountLedgerRollout({ mode: 'plan' }, dependencies);

        expect(dependencies.ledger.buildClassificationPlan).toHaveBeenCalledWith({
            legacyCandidateIds: [...LEGACY_IDS],
            operatorAccountIds: [OPERATOR_ID],
            internalTesterAccountIds: [INTERNAL_TESTER_ID],
        });
        const stdout = JSON.stringify(reports);
        for (const forbidden of [
            ...LEGACY_IDS,
            OPERATOR_ID,
            INTERNAL_TESTER_ID,
            AUDIT_SECRET,
            EXPECTED_HMAC,
        ]) {
            expect(stdout).not.toContain(forbidden);
        }
    });

    it('applies a verified pending plan once and treats the matching active command as idempotent', async () => {
        const pending = createDependencies();
        await runAccountLedgerRollout({
            mode: 'apply',
            confirmed: true,
        }, pending.dependencies);
        expect(pending.dependencies.ledger.applyClassificationPlan).toHaveBeenCalledWith({
            assignments: PLAN_ASSIGNMENTS,
            commandVersion: ACCOUNT_LEDGER_COMMAND_VERSION,
            activatePaidEver: true,
        });

        const active = createDependencies({
            ledger: {
                ...createDependencies().dependencies.ledger,
                getRolloutState: vi.fn(async () => ({
                    state: 'active' as const, commandVersion: ACCOUNT_LEDGER_COMMAND_VERSION,
                })),
            },
        });
        await runAccountLedgerRollout({ mode: 'apply', confirmed: true }, active.dependencies);
        expect(active.dependencies.ledger.listLegacyE2eCandidateIds).not.toHaveBeenCalled();
        expect(active.dependencies.ledger.applyClassificationPlan).not.toHaveBeenCalled();
    });

    it('provisions exactly the immutable Basic and Standard runner pair after activation', async () => {
        const { dependencies, reports } = createDependencies({
            ledger: {
                ...createDependencies().dependencies.ledger,
                getRolloutState: vi.fn(async () => ({
                    state: 'active' as const, commandVersion: ACCOUNT_LEDGER_COMMAND_VERSION,
                })),
            },
        });

        await runAccountLedgerRollout({ mode: 'provision', confirmed: true }, dependencies);

        expect(dependencies.auth.createUser).toHaveBeenCalledTimes(2);
        expect(dependencies.auth.createUser).toHaveBeenNthCalledWith(1,
            expect.objectContaining({
                runnerPlan: 'basic',
                appMetadata: { analysis_test_runner_v1: 'basic' },
            }));
        expect(dependencies.auth.createUser).toHaveBeenNthCalledWith(2,
            expect.objectContaining({
                runnerPlan: 'standard',
                appMetadata: { analysis_test_runner_v1: 'standard' },
            }));
        expect(dependencies.ledger.provisionRunner).toHaveBeenCalledWith(expect.objectContaining({
            runnerPlan: 'basic', commandVersion: ACCOUNT_LEDGER_COMMAND_VERSION,
        }));
        expect(dependencies.ledger.provisionRunner).toHaveBeenCalledWith(expect.objectContaining({
            runnerPlan: 'standard', commandVersion: ACCOUNT_LEDGER_COMMAND_VERSION,
        }));
        expect(JSON.stringify(reports)).not.toContain('analysis_test_runner_v1');
    });

    it('rejects runner metadata drift and a non-exact runner registry before reporting provision success', async () => {
        const metadataDrift = createDependencies({
            ledger: {
                ...createDependencies().dependencies.ledger,
                getRolloutState: vi.fn(async () => ({
                    state: 'active' as const, commandVersion: ACCOUNT_LEDGER_COMMAND_VERSION,
                })),
            },
            auth: {
                ...createDependencies().dependencies.auth,
                createUser: vi.fn(async input => ({
                    id: '40000000-0000-4000-8000-000000000001',
                    appMetadata: { analysis_test_runner_v1: input.runnerPlan === 'basic' ? 'standard' : 'basic' },
                })),
            },
        });
        await expect(runAccountLedgerRollout({ mode: 'provision', confirmed: true }, metadataDrift.dependencies))
            .rejects.toThrow('ACCOUNT_LEDGER_E2E_RUNNER_METADATA_MISMATCH');

        const registryDrift = createDependencies({
            ledger: {
                ...createDependencies().dependencies.ledger,
                getRolloutState: vi.fn(async () => ({
                    state: 'active' as const, commandVersion: ACCOUNT_LEDGER_COMMAND_VERSION,
                })),
                listRunnerPlans: vi.fn(async () => ['basic']),
            },
        });
        await expect(runAccountLedgerRollout({ mode: 'provision', confirmed: true }, registryDrift.dependencies))
            .rejects.toThrow('ACCOUNT_LEDGER_E2E_RUNNER_REGISTRY_MISMATCH');
    });
});
