import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    selectApifyApiToken,
} from '@/lib/services/instagram/providers/apify-relationship';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import { createReplayReadonlyApifyClient } from '@/lib/services/analysis/replay/replay-live-source';
import {
    assembleFirstPaymentConciergeSource,
    firstPaymentConciergeRecoverySourceSchema,
    loadFirstPaymentConciergeDatasets,
} from '@/lib/services/analysis/first-payment-concierge-source';
import {
    captureFirstPaymentConciergeAiBundle,
    createFirstPaymentConciergePublication,
    firstPaymentConciergeSafeFailureCode,
} from '@/lib/services/analysis/first-payment-concierge';

let recoveryStage = 'startup';

const slots = new Set<ApifyCredentialSlot>([
    'primary',
    'secondary',
    'tertiary',
    'quaternary',
    'quinary',
    'senary',
    'septenary',
]);

const publicationResultSchema = z.object({
    completed: z.literal(true),
    requestId: z.string().uuid(),
    resultPath: z.string().regex(/^\/result\/[0-9a-f-]{36}$/),
}).strict();

const statusSchema = publicationResultSchema.extend({
    requestStatus: z.literal('completed'),
    orderStatus: z.literal('completed'),
    fulfillmentStatus: z.literal('completed'),
    femaleRows: z.number().int().min(0).max(130),
    privateRows: z.literal(48),
}).strict();

async function rpc(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const { data, error } = await supabaseAdmin.rpc(name, params);
    if (error) throw new Error(`FIRST_PAYMENT_CONCIERGE_RPC_${name.toUpperCase()}_FAILED`);
    return data;
}

function sourceOnly(): boolean {
    return process.env.FIRST_PAYMENT_CONCIERGE_SOURCE_ONLY?.trim().toLowerCase()
        === 'true';
}

function publishAuthorized(): boolean {
    return process.env.FIRST_PAYMENT_CONCIERGE_CONFIRM_PUBLISH?.trim().toLowerCase()
        === 'true';
}

async function main(): Promise<void> {
    recoveryStage = 'source_descriptor';
    const descriptor = firstPaymentConciergeRecoverySourceSchema.parse(
        await rpc('read_earlybird_v211_concierge_recovery_source'),
    );
    const clients = new Map<string, ReturnType<typeof createReplayReadonlyApifyClient>>();
    recoveryStage = 'source_datasets';
    const datasets = await loadFirstPaymentConciergeDatasets({
        descriptor,
        clientForSlot(slot) {
            if (!slots.has(slot as ApifyCredentialSlot)) {
                throw new Error('FIRST_PAYMENT_CONCIERGE_CREDENTIAL_SLOT_INVALID');
            }
            const existing = clients.get(slot);
            if (existing) return existing;
            const client = createReplayReadonlyApifyClient(
                selectApifyApiToken(process.env, slot as ApifyCredentialSlot),
            );
            clients.set(slot, client);
            return client;
        },
    });
    recoveryStage = 'source_assembly';
    const source = assembleFirstPaymentConciergeSource({ descriptor, runs: datasets });
    const sourceMetric = {
        state: 'source_ready',
        descriptorHash: source.descriptorHash,
        datasets: datasets.length,
        followersCollected: source.followersCollected,
        followingCollected: source.followingCollected,
        mutuals: source.mutualRows.length,
        publicProfiles: source.publicProfiles.length,
        publicUnavailable: source.publicUnavailableRows.length,
        privateProfiles: source.privateRows.length,
        targetInteractions: source.targetInteractions.length,
    };
    if (sourceOnly()) {
        console.log(JSON.stringify(sourceMetric));
        return;
    }
    if (!publishAuthorized()) {
        throw new Error('FIRST_PAYMENT_CONCIERGE_EXPLICIT_PUBLISH_REQUIRED');
    }

    recoveryStage = 'media_capture';
    const captured = await captureFirstPaymentConciergeAiBundle({ source });
    recoveryStage = 'ai_and_publication_compose';
    const publication = await createFirstPaymentConciergePublication({
        source,
        captured,
    });
    recoveryStage = 'atomic_publication';
    const applied = publicationResultSchema.parse(await rpc(
        'publish_earlybird_v211_first_payment_concierge',
        {
            p_descriptor_hash: publication.payload.descriptorHash,
            p_evidence_hash: publication.payload.evidenceHash,
            p_payload: publication.payload,
        },
    ));
    recoveryStage = 'publication_verification';
    const status = statusSchema.parse(await rpc(
        'read_earlybird_v211_concierge_publication_status',
    ));
    if (
        status.requestId !== applied.requestId
        || status.resultPath !== applied.resultPath
        || status.femaleRows !== publication.payload.counts.female
    ) {
        throw new Error('FIRST_PAYMENT_CONCIERGE_PUBLICATION_VERIFICATION_FAILED');
    }
    console.log(JSON.stringify({
        state: 'completed',
        descriptorHash: publication.payload.descriptorHash,
        evidenceHash: publication.payload.evidenceHash,
        semanticInputFingerprint: publication.payload.semanticInputFingerprint,
        mediaUnavailable: publication.payload.counts.mediaUnavailableCount,
        analysisUnavailable: publication.payload.counts.analysisUnavailableCount,
        male: publication.payload.counts.male,
        female: publication.payload.counts.female,
        unknown: publication.payload.counts.unknown,
        resultPath: status.resultPath,
    }));
}

main().catch(error => {
    console.error(JSON.stringify({
        state: 'failed',
        stage: recoveryStage,
        code: firstPaymentConciergeSafeFailureCode(error),
    }));
    process.exitCode = 1;
});
