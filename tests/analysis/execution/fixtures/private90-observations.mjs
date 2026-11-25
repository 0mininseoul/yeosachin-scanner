const phases = ['reader', 'source_ledger', 'fixed_model', 'admission', 'worker', 'result', 'owner_image', 'complete'];

const causes = ['none', 'reader_verification', 'source_receipts', 'source_admission', 'sealed_model_inputs',
    'missing_keyed_media', 'model_routing', 'preflight_admission', 'worker_stage', 'timeout', 'ledger_mismatch',
    'publication_count', 'page_count', 'image_read', 'image_format', 'owner_access', 'network_denied'];

export function newPrivate90Observations() {
    return {
        phase: 'reader', cause: 'reader_verification', profileBatches: 0, completedProfileBatches: 0, publicProfilesInspected: 0, missingFeatureInputs: 0,
        targetImages: 0, publicRows: 0, privateRows: 0, publicImages: 0, privateImages: 0,
        resultPages: 0, imageGets: 0, webpVerified: 0, sourceReceipts: 0, workerJobs: 0, duplicateDeliveries: 0,
        providerCountersActive: 0, apifyCalls: 0, sourceDownloads: 0, fixedVertexCalls: 0, published: 0, readyImages: 0,
        ownerResult: 0, ownerImage: 0, otherResult: 0, otherImage: 0, anonymousResult: 0, anonymousImage: 0,
    };
}

// This is the only data permitted through the private child-to-parent descriptor.
export function safePrivate90Observations(value) {
    const result = newPrivate90Observations();
    if (!value || !phases.includes(value.phase) || !causes.includes(value.cause)) return null;
    for (const key of Object.keys(result)) {
        if (key === 'phase' || key === 'cause') continue;
        if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 1_000_000) return null;
        result[key] = value[key];
    }
    result.phase = value.phase;
    result.cause = value.cause;
    return result;
}
