import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const contractPath = 'lib/contracts/apify-account-credit-inventory.ts';
const workbenchPath = 'app/admin/analysis-audit/workbench.tsx';

describe('shared Apify inventory contract', () => {
    it('stays client-safe and does not depend on provider or beta server modules', async () => {
        const source = readFileSync(contractPath, 'utf8');
        expect(source).not.toMatch(/apify-client/);
        expect(source).not.toMatch(/beta-apify-credit-pool/);

        const shared = await import('./apify-account-credit-inventory');
        expect(shared.apifyAccountCreditInventoryRowSchema).toBeDefined();
        expect(shared.apifyAccountCreditInventorySchema).toBeDefined();
    });

    it('keeps the client workbench on the shared contract import', () => {
        const workbench = readFileSync(workbenchPath, 'utf8');
        expect(workbench).toContain('@/lib/contracts/apify-account-credit-inventory');
        expect(workbench).not.toContain('@/lib/services/analysis/apify-account-credit-inventory');
    });

    it('is the exact schema re-exported by the server inventory module', async () => {
        const shared = await import('./apify-account-credit-inventory');
        const server = await import('@/lib/services/analysis/apify-account-credit-inventory');

        expect(server.apifyAccountCreditInventorySchema)
            .toBe(shared.apifyAccountCreditInventorySchema);
    });
});
