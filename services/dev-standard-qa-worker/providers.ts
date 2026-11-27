import { createCloudSyntheticApify } from '../../tests/analysis/execution/fixtures/standard-cloud-apify';
import { createGcsSyntheticApifyStore, syntheticCloudBucket } from '../../tests/analysis/execution/fixtures/standard-cloud-apify-store';
import { qaDelivery } from './scope';

// Each SDK operation reads the current verified delivery. No provider credential
// or endpoint is accepted by this implementation.
export class ApifyClient {
    private client() {
        const scope = qaDelivery();
        return createCloudSyntheticApify({
            store: createGcsSyntheticApifyStore({ bucket: syntheticCloudBucket, waveDigest: scope.wave }),
            operationKey: () => scope.logicalKey,
            durationMs: () => scope.role === 'paid' ? Math.round(401_674 / 16 * 1.25) : 0,
        });
    }
    actor(actor: string) { return this.client().actor(actor); }
    run(id: string) { return this.client().run(id); }
    dataset(id: string) { return this.client().dataset(id); }
    user(): never { throw new Error('DEV_STANDARD_QA_PROVIDER_INVENTORY_DISABLED'); }
}
export class ApifyApiError extends Error {
    readonly statusCode?: number;
    readonly errorType?: string;
    constructor(info: { statusCode?: number; errorType?: string }) {
        super('DEV_STANDARD_QA_APIFY_ERROR'); this.statusCode = info.statusCode; this.errorType = info.errorType;
    }
}
export class Resend {
    get emails(): never { throw new Error('DEV_STANDARD_QA_EMAIL_DISABLED'); }
}
