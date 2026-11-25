import { resultImageArchiveIdentity, type ResultImageCaptureSource } from '@/lib/services/media/result-image-capture';

type Identity = ReturnType<typeof resultImageArchiveIdentity>;

export function private90ImageScope(manifest: readonly Identity[], fixedPublic?: ReadonlySet<string>) {
    const planned = new Set<string>();
    const byLocator = new Map<string, Set<string | null>>();
    const key = (kind: string, locator: string) => JSON.stringify([kind, locator]);
    for (const [kind, locator, fingerprint] of manifest) {
        const index = key(kind, locator);
        if (kind !== 'female' || !fixedPublic || fixedPublic.has(locator)) planned.add(index);
        const fingerprints = byLocator.get(index) ?? new Set();
        fingerprints.add(fingerprint);
        byLocator.set(index, fingerprints);
    }
    return (sources: readonly ResultImageCaptureSource[]) => {
        const byKind = { target: 0, female: 0, private: 0 };
        const exact = { ...byKind };
        const missing = { ...byKind };
        const drift = { ...byKind };
        let ambiguous = 0;
        let nullMismatch = 0;
        const actual = new Set<string>();
        let duplicate = 0;
        for (const source of sources) {
            const [kind, locator, fingerprint] = resultImageArchiveIdentity(source);
            const member = key(kind, locator);
            if (actual.has(member)) duplicate++;
            actual.add(member);
            const recorded = byLocator.get(member);
            byKind[kind]++;
            if (!recorded) missing[kind]++;
            else if (recorded.size !== 1) ambiguous++;
            else if (recorded.has(fingerprint)) exact[kind]++;
            else {
                drift[kind]++;
                if (fingerprint === null || recorded.has(null)) nullMismatch++;
            }
        }
        return {
            imageScopeCompared: 1, imageScopeExpected: manifest.length, imageScopePlanned: planned.size,
            imageScopePlanMissing: [...planned].filter(member => !actual.has(member)).length,
            imageScopePlanExtra: [...actual].filter(member => !planned.has(member)).length,
            imageScopePlanDuplicate: duplicate,
            imageTargetRequests: byKind.target, imagePublicRequests: byKind.female, imagePrivateRequests: byKind.private,
            imageTargetExact: exact.target, imagePublicExact: exact.female, imagePrivateExact: exact.private,
            imageTargetAbsent: missing.target, imagePublicAbsent: missing.female, imagePrivateAbsent: missing.private,
            imageTargetDrift: drift.target, imagePublicDrift: drift.female, imagePrivateDrift: drift.private,
            imageScopeAmbiguous: ambiguous, imageScopeNullMismatch: nullMismatch,
            imageScopeMismatched: sources.length - exact.target - exact.female - exact.private,
        };
    };
}
