import { describe, expect, it, vi } from 'vitest';
import {
    runGrobleV2ReleaseGate,
    type GrobleV2ReleaseGateInput,
} from './groble-v2-release-gate';

const ENV = {
    GROBLE_BASIC_PRODUCT_ID: 'legacy_basic_product',
    GROBLE_STANDARD_PRODUCT_ID: 'legacy_standard_product',
    GROBLE_BASIC_PAYMENT_ADDRESS: 'legacy-basic-address',
    GROBLE_STANDARD_PAYMENT_ADDRESS: 'legacy-standard-address',
    GROBLE_V2_BASIC_PRODUCT_ID: 'v2_basic_product',
    GROBLE_V2_STANDARD_PRODUCT_ID: 'v2_standard_product',
    GROBLE_V2_BASIC_PAYMENT_ADDRESS: 'v2-basic-address',
    GROBLE_V2_STANDARD_PAYMENT_ADDRESS: 'v2-standard-address',
};

const EXACT_BINDINGS = [
    {
        plan_id: 'basic',
        pricing_version: 'earlybird-2026-07-v1',
        product_id: ENV.GROBLE_BASIC_PRODUCT_ID,
        payment_address: ENV.GROBLE_BASIC_PAYMENT_ADDRESS,
        expected_amount_krw: 14_900,
        checkout_active: false,
    },
    {
        plan_id: 'standard',
        pricing_version: 'earlybird-2026-07-v1',
        product_id: ENV.GROBLE_STANDARD_PRODUCT_ID,
        payment_address: ENV.GROBLE_STANDARD_PAYMENT_ADDRESS,
        expected_amount_krw: 19_900,
        checkout_active: false,
    },
    {
        plan_id: 'basic',
        pricing_version: 'earlybird-2026-07-v2',
        product_id: ENV.GROBLE_V2_BASIC_PRODUCT_ID,
        payment_address: ENV.GROBLE_V2_BASIC_PAYMENT_ADDRESS,
        expected_amount_krw: 6_900,
        checkout_active: true,
    },
    {
        plan_id: 'standard',
        pricing_version: 'earlybird-2026-07-v2',
        product_id: ENV.GROBLE_V2_STANDARD_PRODUCT_ID,
        payment_address: ENV.GROBLE_V2_STANDARD_PAYMENT_ADDRESS,
        expected_amount_krw: 9_900,
        checkout_active: true,
    },
] as const;

function runGate(input: GrobleV2ReleaseGateInput) {
    return runGrobleV2ReleaseGate(input);
}

describe('Groble v2 release gate', () => {
    it('fails before migration unless writes are paused and all eight identifiers exist', async () => {
        await expect(runGate({
            phase: 'pre-migration',
            confirmCheckoutWritesPaused: false,
            env: ENV,
        })).rejects.toThrow('GROBLE_V2_MAINTENANCE_CONFIRMATION_REQUIRED');

        await expect(runGate({
            phase: 'pre-migration',
            confirmCheckoutWritesPaused: true,
            env: {
                ...ENV,
                GROBLE_V2_STANDARD_PAYMENT_ADDRESS: undefined,
            },
        })).rejects.toThrow('GROBLE_V2_STANDARD_PAYMENT_ADDRESS');

        await expect(runGate({
            phase: 'pre-migration',
            confirmCheckoutWritesPaused: true,
            env: {
                ...ENV,
                GROBLE_V2_STANDARD_PAYMENT_ADDRESS:
                    ENV.GROBLE_BASIC_PRODUCT_ID,
            },
        })).rejects.toThrow(
            'GROBLE_IDENTIFIERS_MUST_BE_GLOBALLY_DISTINCT'
        );
    });

    it('passes the pre-migration phase without touching the database', async () => {
        const loadDatabaseState = vi.fn();

        await expect(runGate({
            phase: 'pre-migration',
            confirmCheckoutWritesPaused: true,
            env: ENV,
            loadDatabaseState,
        })).resolves.toEqual({
            phase: 'pre-migration',
            status: 'passed',
        });
        expect(loadDatabaseState).not.toHaveBeenCalled();
    });

    it('requires exactly four historical/active bindings before deploy', async () => {
        const loadDatabaseState = vi.fn().mockResolvedValue({
            bindings: EXACT_BINDINGS,
            pendingOldLineageCount: 0,
            historicalProductEvidence: [],
        });

        await expect(runGate({
            phase: 'pre-deploy',
            confirmCheckoutWritesPaused: true,
            env: ENV,
            loadDatabaseState,
        })).resolves.toEqual({
            phase: 'pre-deploy',
            status: 'passed',
        });
        expect(loadDatabaseState).toHaveBeenCalledOnce();
    });

    it.each([
        ['missing row', EXACT_BINDINGS.slice(0, 3)],
        ['extra row', [...EXACT_BINDINGS, EXACT_BINDINGS[0]]],
        ['wrong active state', EXACT_BINDINGS.map((row, index) => (
            index === 3 ? { ...row, checkout_active: false } : row
        ))],
        ['wrong Standard amount', EXACT_BINDINGS.map((row, index) => (
            index === 3 ? { ...row, expected_amount_krw: 19_900 } : row
        ))],
    ])('blocks deploy for %s', async (_label, bindings) => {
        await expect(runGate({
            phase: 'pre-deploy',
            confirmCheckoutWritesPaused: true,
            env: ENV,
            loadDatabaseState: vi.fn().mockResolvedValue({
                bindings,
                pendingOldLineageCount: 0,
                historicalProductEvidence: [],
            }),
        })).rejects.toThrow('GROBLE_V2_DB_BINDINGS_MISMATCH');
    });

    it('blocks deploy while any old-product v1 or v2 pending order remains', async () => {
        await expect(runGate({
            phase: 'pre-deploy',
            confirmCheckoutWritesPaused: true,
            env: ENV,
            loadDatabaseState: vi.fn().mockResolvedValue({
                bindings: EXACT_BINDINGS,
                pendingOldLineageCount: 1,
                historicalProductEvidence: [],
            }),
        })).rejects.toThrow('GROBLE_V2_PENDING_OLD_LINEAGE_REMAINS');
    });

    it('does not self-confirm an env typo that was copied into all four DB bindings', async () => {
        const typoEnv = {
            ...ENV,
            GROBLE_BASIC_PRODUCT_ID: 'legacy_basic_env_typo',
        };
        const typoBindings = EXACT_BINDINGS.map(row => (
            row.plan_id === 'basic'
            && row.pricing_version === 'earlybird-2026-07-v1'
                ? { ...row, product_id: typoEnv.GROBLE_BASIC_PRODUCT_ID }
                : row
        ));

        await expect(runGate({
            phase: 'pre-deploy',
            confirmCheckoutWritesPaused: true,
            env: typoEnv,
            loadDatabaseState: vi.fn().mockResolvedValue({
                bindings: typoBindings,
                pendingOldLineageCount: 0,
                historicalProductEvidence: [{
                    source: 'order',
                    plan_id: 'basic',
                    product_id: 'legacy_basic_product',
                }],
            }),
        })).rejects.toThrow(
            'GROBLE_V2_HISTORICAL_PRODUCT_EVIDENCE_MISMATCH'
        );
    });

    it('validates webhook-only evidence and rejects cross-plan ambiguity', async () => {
        await expect(runGate({
            phase: 'pre-deploy',
            confirmCheckoutWritesPaused: true,
            env: ENV,
            loadDatabaseState: vi.fn().mockResolvedValue({
                bindings: EXACT_BINDINGS,
                pendingOldLineageCount: 0,
                historicalProductEvidence: [{
                    source: 'webhook',
                    plan_id: null,
                    product_id: 'legacy_unknown_product',
                }],
            }),
        })).rejects.toThrow(
            'GROBLE_V2_HISTORICAL_PRODUCT_EVIDENCE_MISMATCH'
        );

        await expect(runGate({
            phase: 'pre-deploy',
            confirmCheckoutWritesPaused: true,
            env: ENV,
            loadDatabaseState: vi.fn().mockResolvedValue({
                bindings: EXACT_BINDINGS,
                pendingOldLineageCount: 0,
                historicalProductEvidence: [
                    {
                        source: 'order',
                        plan_id: 'basic',
                        product_id: 'legacy_basic_product',
                    },
                    {
                        source: 'webhook',
                        plan_id: 'standard',
                        product_id: 'legacy_basic_product',
                    },
                ],
            }),
        })).rejects.toThrow(
            'GROBLE_V2_HISTORICAL_PRODUCT_EVIDENCE_AMBIGUOUS'
        );
    });

    it('never hides historical evidence merely because an env typo marks it active', async () => {
        const typoEnv = {
            ...ENV,
            GROBLE_BASIC_PRODUCT_ID: 'legacy_basic_env_typo',
        };
        const typoBindings = EXACT_BINDINGS.map(row => (
            row.plan_id === 'basic'
            && row.pricing_version === 'earlybird-2026-07-v1'
                ? { ...row, product_id: typoEnv.GROBLE_BASIC_PRODUCT_ID }
                : row
        ));

        await expect(runGate({
            phase: 'pre-deploy',
            confirmCheckoutWritesPaused: true,
            env: typoEnv,
            loadDatabaseState: vi.fn().mockResolvedValue({
                bindings: typoBindings,
                pendingOldLineageCount: 0,
                historicalProductEvidence: [{
                    source: 'order',
                    plan_id: 'basic',
                    product_id: ENV.GROBLE_V2_BASIC_PRODUCT_ID,
                }],
            }),
        })).rejects.toThrow(
            'GROBLE_V2_HISTORICAL_PRODUCT_EVIDENCE_MISMATCH'
        );
    });
});
