import 'server-only';

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createDevStandardArchiveStore, createDevStandardQaCopyStore } from './standard-archive-store';
import { openVerifiedStandardQaArchive, withSealedStandardQaFixture, type StandardQaFixtureOperation } from './standard-archive-runtime';

const DAY_MS = 86_400_000;
const COPY_CONCURRENCY = 4;
// Only the normalized fragments approved for the Standard fixture may move into
// this separate retention period. Future capture types need an explicit decision.
const COPY_FRAGMENT_KINDS = new Set([
    'preflight-profile-v1', 'preflight-blite-policy-v1', 'preflight-blite-outcome-v1',
    'fresh-profile-v1', 'relationship-side-v1', 'formal-target-profile-v2', 'target-evidence-v1',
    'candidate-profile-batch-v1', 'source-profile-proof-v1', 'reverse-coverage-v1',
    'ai-image', 'ai-image-selection-v1', 'result-image-v1', 'result-image-manifest-v1',
    'capture-coverage-v1', 'capture-summary-v1',
]);
const uuidV4 = z.string().uuid({ version: 'v4' });
const approvedCopy = z.object({
    approval: uuidV4,
    sourceApproval: uuidV4,
    target: z.string().regex(/^[a-z0-9._]{1,30}$/),
    approvedAt: z.string().datetime({ precision: 3 }),
    days: z.literal(90),
}).strict();

type LiveStore = ReturnType<typeof createDevStandardArchiveStore>;
type PrivateStore = ReturnType<typeof createDevStandardQaCopyStore>;
export type StandardQaCopyPolicy = z.infer<typeof approvedCopy>;

function unavailable(): never {
    throw new Error('DEV_STANDARD_QA_COPY_UNAVAILABLE');
}

export function standardQaCopyPolicyWindow(value: unknown) {
    const parsed = approvedCopy.safeParse(value);
    if (!parsed.success || parsed.data.approval === parsed.data.sourceApproval) return unavailable();
    const policy = parsed.data;
    const starts = Date.parse(policy.approvedAt);
    const expiresAt = starts + policy.days * DAY_MS;
    // Fixed field order binds the independent consent and purpose to the wrapped data key.
    const context = createHash('sha256').update(JSON.stringify([
        'dev-standard-private-qa-copy/v1', policy.approval, policy.sourceApproval,
        policy.target, policy.approvedAt, policy.days,
    ])).digest('hex');
    return { policy, context, binding: { grantId: policy.approval, target: policy.target, expiresAt } };
}

export function activeStandardQaCopyPolicy(value: unknown, now = Date.now()) {
    const parsed = standardQaCopyPolicyWindow(value);
    if (!Number.isSafeInteger(now) || now < Date.parse(parsed.policy.approvedAt) || now >= parsed.binding.expiresAt) {
        return unavailable();
    }
    return parsed;
}

export async function exportStandardQaCopy(
    policy: StandardQaCopyPolicy, source: LiveStore, destination: PrivateStore, now = Date.now,
) {
    const { binding, context } = activeStandardQaCopyPolicy(policy, now());
    const { reader, coverage } = await openVerifiedStandardQaArchive(policy.target, source);
    if (reader.binding.grantId !== policy.sourceApproval || reader.binding.expiresAt <= now()) return unavailable();
    const members = reader.members();
    if (members.some(member => !COPY_FRAGMENT_KINDS.has(member.kind))) return unavailable();
    await destination.bindCapture(binding);
    await destination.bindCopyOrigin(context, reader.fingerprint);

    for (let at = 0; at < members.length; at += COPY_CONCURRENCY) {
        activeStandardQaCopyPolicy(policy, now());
        const completed = await Promise.allSettled(members.slice(at, at + COPY_CONCURRENCY).map(async member => {
            const stored = await reader.readFragment(member);
            if (!stored) return unavailable();
            await destination.writeFragment({ ...member, value: stored.value });
        }));
        if (completed.some(result => result.status === 'rejected')) return unavailable();
    }

    // The source reader verifies every decrypted value against the digest from its seal.
    // Publish a destination seal only for that exact set; interrupted copies stay unreadable.
    await destination.seal(async draft => {
        activeStandardQaCopyPolicy(policy, now());
        if (reader.binding.expiresAt <= now() || draft.members().length !== members.length
            || JSON.stringify(draft.members()) !== JSON.stringify(members)
            || await destination.readCopyOrigin(context) !== reader.fingerprint) return unavailable();
    });
    return { fragments: members.length, profileBatches: coverage.profileBatches.length, expiresAt: binding.expiresAt };
}

export async function withVerifiedStandardQaCopy<T>(
    policy: StandardQaCopyPolicy, copy: PrivateStore,
    operation: StandardQaFixtureOperation<T>, now = Date.now,
): Promise<T> {
    const { binding, context } = activeStandardQaCopyPolicy(policy, now());
    const current = await copy.readBinding();
    if (current?.target !== binding.target || current.grantId !== binding.grantId
        || current.expiresAt !== binding.expiresAt || !(await copy.readCopyOrigin(context))) return unavailable();
    return withSealedStandardQaFixture(policy.target, copy, operation);
}
