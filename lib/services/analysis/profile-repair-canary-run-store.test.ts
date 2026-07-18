import { describe, expect, it, vi } from 'vitest';
import {
    PROFILE_REPAIR_CANARY_ACTOR_ID,
    PROFILE_REPAIR_CANARY_VERSION,
    createProfileRepairCanaryRunStore,
    type StoredProfileRepairCanaryRun,
} from './profile-repair-canary-run-store';

const SOURCE_REQUEST_ID = '11111111-1111-4111-8111-111111111111';
const RESERVATION_TOKEN = '22222222-2222-4222-8222-222222222222';
const RUN_ID = 'CanaryRun12345678';
const NOW = '2026-07-18T03:00:00.000Z';

function row(
    state: StoredProfileRepairCanaryRun['state'] = 'starting',
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    const terminal = state === 'succeeded' || state === 'failed';
    const started = state === 'running' || terminal;
    return {
        sourceRequestId: SOURCE_REQUEST_ID,
        canaryVersion: PROFILE_REPAIR_CANARY_VERSION,
        repetition: 1,
        actorId: PROFILE_REPAIR_CANARY_ACTOR_ID,
        credentialSlot: 'tertiary',
        requestedCount: 15,
        maxChargeUsd: 0.05,
        reservationToken: RESERVATION_TOKEN,
        state,
        runId: started ? RUN_ID : null,
        terminalCount: terminal ? 15 : null,
        successCount: terminal ? 14 : null,
        unavailableCount: terminal ? 1 : null,
        incompleteCount: terminal ? 0 : null,
        otherFailureCount: terminal ? 0 : null,
        criticalRecoveredCount: terminal ? 1 : null,
        latencyMs: terminal ? 12_000 : null,
        gatePassed: terminal ? state === 'succeeded' : null,
        actualUsageUsd: null,
        costStatus: state === 'ambiguous' ? 'unknown' : 'conservative',
        reservedAt: NOW,
        runStartedAt: started ? NOW : null,
        ambiguousAt: state === 'ambiguous' ? NOW : null,
        terminalizedAt: terminal || state === 'ambiguous' ? NOW : null,
        usageReconciledAt: null,
        updatedAt: NOW,
        ...overrides,
    };
}

function clientWith(...responses: unknown[]) {
    const rpc = vi.fn();
    for (const response of responses) {
        rpc.mockResolvedValueOnce({ data: response, error: null });
    }
    return { rpc };
}

describe('profile repair canary run store', () => {
    it('reserves the deterministic row before start with only fixed billing identity', async () => {
        const client = clientWith({ created: true, run: row() });
        const store = createProfileRepairCanaryRunStore(client, {
            randomUUID: () => RESERVATION_TOKEN,
        });

        await expect(store.reserve({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            credentialSlot: 'tertiary',
        })).resolves.toMatchObject({
            created: true,
            run: {
                sourceRequestId: SOURCE_REQUEST_ID,
                canaryVersion: 'profile-repair-canary-v1',
                repetition: 1,
                actorId: 'apify/instagram-profile-scraper',
                requestedCount: 15,
                maxChargeUsd: 0.05,
                state: 'starting',
                runId: null,
            },
        });
        expect(client.rpc).toHaveBeenCalledWith(
            'reserve_analysis_v2_profile_repair_canary_run',
            {
                p_source_request_id: SOURCE_REQUEST_ID,
                p_repetition: 1,
                p_credential_slot: 'tertiary',
                p_reservation_token: RESERVATION_TOKEN,
            }
        );
        expect(JSON.stringify(client.rpc.mock.calls)).not.toMatch(
            /username|email|url|payload|api.?token|input.?hash|fingerprint/i
        );
    });

    it('loads, checkpoints, and resumes only the confirmed run identity', async () => {
        const running = row('running');
        const client = clientWith(running, running);
        const store = createProfileRepairCanaryRunStore(client);

        await expect(store.load({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
        })).resolves.toMatchObject({ state: 'running', runId: RUN_ID });
        await expect(store.checkpointStarted({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            reservationToken: RESERVATION_TOKEN,
            runId: RUN_ID,
        })).resolves.toMatchObject({ state: 'running', runId: RUN_ID });
        expect(client.rpc.mock.calls).toEqual([
            ['load_analysis_v2_profile_repair_canary_run', {
                p_source_request_id: SOURCE_REQUEST_ID,
                p_repetition: 1,
            }],
            ['checkpoint_analysis_v2_profile_repair_canary_run_started', {
                p_source_request_id: SOURCE_REQUEST_ID,
                p_repetition: 1,
                p_reservation_token: RESERVATION_TOKEN,
                p_run_id: RUN_ID,
            }],
        ]);
    });

    it('marks an unconfirmed start ambiguous without accepting a run id', async () => {
        const client = clientWith(row('ambiguous'));
        const store = createProfileRepairCanaryRunStore(client);

        await expect(store.markAmbiguous({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            reservationToken: RESERVATION_TOKEN,
        })).resolves.toMatchObject({
            state: 'ambiguous',
            runId: null,
            costStatus: 'unknown',
        });
    });

    it('terminalizes safe counts idempotently and reconciles bounded actual usage', async () => {
        const terminal = row('succeeded');
        const reconciled = row('succeeded', {
            actualUsageUsd: 0.04,
            costStatus: 'actual',
            usageReconciledAt: NOW,
        });
        const client = clientWith(terminal, terminal, reconciled);
        const store = createProfileRepairCanaryRunStore(client);
        const terminalInput = {
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1 as const,
            reservationToken: RESERVATION_TOKEN,
            runId: RUN_ID,
            state: 'succeeded' as const,
            terminalCount: 15,
            successCount: 14,
            unavailableCount: 1,
            incompleteCount: 0,
            otherFailureCount: 0,
            criticalRecoveredCount: 1,
            latencyMs: 12_000,
            gatePassed: true,
        };

        await expect(store.terminalize(terminalInput)).resolves.toMatchObject({
            state: 'succeeded',
            costStatus: 'conservative',
        });
        await expect(store.terminalize(terminalInput)).resolves.toMatchObject({
            state: 'succeeded',
        });
        await expect(store.reconcileUsage({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            reservationToken: RESERVATION_TOKEN,
            runId: RUN_ID,
            actualUsageUsd: 0.04,
        })).resolves.toMatchObject({
            state: 'succeeded',
            actualUsageUsd: 0.04,
            costStatus: 'actual',
        });
    });

    it('rejects unsafe counts, costs, and mutable canary identity locally', async () => {
        const client = clientWith();
        const store = createProfileRepairCanaryRunStore(client);

        await expect(store.reserve({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 3 as 1,
            credentialSlot: 'primary',
        })).rejects.toThrow('VALIDATION');
        await expect(store.terminalize({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            reservationToken: RESERVATION_TOKEN,
            runId: RUN_ID,
            state: 'succeeded',
            terminalCount: 15,
            successCount: 15,
            unavailableCount: 1,
            incompleteCount: 0,
            otherFailureCount: 0,
            criticalRecoveredCount: 1,
            latencyMs: 1,
            gatePassed: true,
        })).rejects.toThrow('VALIDATION');
        await expect(store.terminalize({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            reservationToken: RESERVATION_TOKEN,
            runId: RUN_ID,
            state: 'succeeded',
            terminalCount: 15,
            successCount: 13,
            unavailableCount: 1,
            incompleteCount: 1,
            otherFailureCount: 0,
            criticalRecoveredCount: 1,
            latencyMs: 1,
            gatePassed: true,
        })).rejects.toThrow('VALIDATION');
        await expect(store.reconcileUsage({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            reservationToken: RESERVATION_TOKEN,
            runId: RUN_ID,
            actualUsageUsd: 0.051,
        })).rejects.toThrow('VALIDATION');
        expect(client.rpc).not.toHaveBeenCalled();
    });

    it('fails closed on conflicting terminal writes without surfacing provider detail', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: {
                code: 'P0001',
                message: 'PROFILE_REPAIR_CANARY_RUN_TERMINAL_CONFLICT private detail',
            },
        });
        const store = createProfileRepairCanaryRunStore({ rpc });

        await expect(store.terminalize({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
            reservationToken: RESERVATION_TOKEN,
            runId: RUN_ID,
            state: 'failed',
            terminalCount: 15,
            successCount: 13,
            unavailableCount: 1,
            incompleteCount: 1,
            otherFailureCount: 0,
            criticalRecoveredCount: 1,
            latencyMs: 12_000,
            gatePassed: false,
        })).rejects.toEqual(new Error('PROFILE_REPAIR_CANARY_RUN_TERMINAL_CONFLICT'));
    });

    it('drops any unexpected sensitive fields returned by the database', async () => {
        const client = clientWith(row('succeeded', {
            username: 'sensitive.user',
            url: 'https://example.test/private',
            providerMessage: 'private provider detail',
            inputHash: 'a'.repeat(64),
        }));
        const store = createProfileRepairCanaryRunStore(client);

        const loaded = await store.load({
            sourceRequestId: SOURCE_REQUEST_ID,
            repetition: 1,
        });
        expect(JSON.stringify(loaded)).not.toMatch(
            /sensitive|username|url|provider.*message|input.?hash/i
        );
    });
});
