import { isInstagramUsername } from '../username';
import {
    buildApifyProfileAttemptResults,
    parseApifyProfileDataset,
    waitForSettledApifyProfileDataset,
} from './apify';
import {
    startOrResumeApifyActor,
    type ApifyClientLike,
} from './apify-relationship';
import { profileAttemptLatency } from './profile-attempt';
import type {
    ApifyCredentialSlot,
    ProfileAttemptResult,
    ProviderCallContext,
} from './types';

export const REPLACEMENT_PROFILE_ACTOR = Object.freeze({
    actorId: 'apify/instagram-scraper',
    build: '0.0.692',
    inputContractVersion: 1,
    outputContractVersion: 1,
    estimatedResultCostUsd: 0.0027,
});

const REPLACEMENT_PROFILE_TIMEOUT_SECS = 60;
const REPLACEMENT_PROFILE_MAX_ITEMS = 30;
const REPLACEMENT_PROFILE_MAX_CHARGE_USD = 0.09;
const REPLACEMENT_PROFILE_DATASET_READ_RETRIES = 2;
const REPLACEMENT_PROFILE_DATASET_RETRY_BASE_DELAY_MS = 250;

function canonicalUsernames(usernames: readonly string[]): string[] {
    if (usernames.length === 0) {
        throw new Error('SCRAPING_CONFIG_ERROR: replacement profile input is empty.');
    }
    if (usernames.length > REPLACEMENT_PROFILE_MAX_ITEMS) {
        throw new Error('SCRAPING_CONFIG_ERROR: replacement profile input exceeds 30 items.');
    }
    const canonical = usernames.map((username) => username.trim().toLowerCase());
    if (canonical.some(username => !isInstagramUsername(username))) {
        throw new Error('SCRAPING_CONFIG_ERROR: invalid replacement profile username.');
    }
    if (new Set(canonical).size !== canonical.length) {
        throw new Error('SCRAPING_CONFIG_ERROR: duplicate replacement profile username.');
    }
    return canonical;
}

export function buildReplacementProfileInput(usernames: readonly string[]) {
    const canonical = canonicalUsernames(usernames);
    return {
        directUrls: canonical.map(username => `https://www.instagram.com/${username}/`),
        resultsType: 'details' as const,
    };
}

function assertCostFence(requestedCount: number, maxTotalChargeUsd: number): void {
    if (
        !Number.isFinite(maxTotalChargeUsd)
        || maxTotalChargeUsd <= 0
        || maxTotalChargeUsd > REPLACEMENT_PROFILE_MAX_CHARGE_USD
    ) {
        throw new Error('SCRAPING_BUDGET_ERROR: invalid replacement profile maximum charge.');
    }
    const estimatedCost = requestedCount * REPLACEMENT_PROFILE_ACTOR.estimatedResultCostUsd;
    if (estimatedCost > maxTotalChargeUsd + Number.EPSILON) {
        throw new Error(
            'SCRAPING_BUDGET_ERROR: replacement profile estimated cost exceeds the hard cap.'
        );
    }
}

function assertDurableIdentity(input: {
    credentialSlot: ApifyCredentialSlot;
    maxTotalChargeUsd: number;
    context?: ProviderCallContext;
}): void {
    if (
        input.context?.credentialSlot !== undefined
        && input.context.credentialSlot !== input.credentialSlot
    ) {
        throw new Error('SCRAPING_RUN_CHECKPOINT_ERROR: credential slot does not match.');
    }
    if (
        input.context?.maxChargeUsd !== undefined
        && input.context.maxChargeUsd !== input.maxTotalChargeUsd
    ) {
        throw new Error('SCRAPING_RUN_CHECKPOINT_ERROR: maximum charge does not match.');
    }
}

function assertDeadlineNotExhausted(deadlineAtMs?: number): void {
    if (
        deadlineAtMs !== undefined
        && (!Number.isFinite(deadlineAtMs) || Date.now() >= deadlineAtMs)
    ) {
        throw new Error('SCRAPING_INVOCATION_DEADLINE_ERROR');
    }
}

function hasDurableRun(context?: ProviderCallContext): boolean {
    return Boolean(context?.resumeRunId || context?.onRunStarted);
}

function isFatalDatasetError(error: unknown): error is Error {
    return error instanceof Error && [
        'SCRAPING_SCHEMA_ERROR:',
        'SCRAPING_CONFIG_ERROR:',
        'SCRAPING_BUDGET_ERROR:',
    ].some(prefix => error.message.startsWith(prefix));
}

interface RunReplacementProfileDetailsInput {
    client: ApifyClientLike;
    usernames: readonly string[];
    credentialSlot: ApifyCredentialSlot;
    maxTotalChargeUsd: number;
    context?: ProviderCallContext;
}

/** Runs or resumes exactly one pinned public-profile details Actor. External cleanup is owned by
 * the orchestrator after it durably checkpoints the returned terminal outcomes and cost. */
export async function runReplacementProfileDetails(
    input: RunReplacementProfileDetailsInput
): Promise<ProfileAttemptResult[]> {
    const startedAt = Date.now();
    const usernames = canonicalUsernames(input.usernames);
    assertCostFence(usernames.length, input.maxTotalChargeUsd);
    assertDurableIdentity(input);
    assertDeadlineNotExhausted(input.context?.invocationDeadlineAtMs);

    input.context?.recordUsage({ request_count: 1 });
    const run = await startOrResumeApifyActor(
        input.client,
        REPLACEMENT_PROFILE_ACTOR.actorId,
        buildReplacementProfileInput(usernames),
        {
            logicalProvider: 'apify',
            credentialSlot: input.credentialSlot,
            actorBuild: REPLACEMENT_PROFILE_ACTOR.build,
            requireExplicitRestrictedAccess: true,
            timeoutSecs: REPLACEMENT_PROFILE_TIMEOUT_SECS,
            invocationWaitLimitSecs: REPLACEMENT_PROFILE_TIMEOUT_SECS,
            maxItems: usernames.length,
            maxTotalChargeUsd: input.maxTotalChargeUsd,
        },
        input.context
    );

    if (run.status !== 'SUCCEEDED') {
        throw new Error(
            `SCRAPING_ERROR: replacement profile Actor status=${run.status}`
        );
    }
    if (run.buildNumber !== REPLACEMENT_PROFILE_ACTOR.build) {
        throw new Error('SCRAPING_SCHEMA_ERROR: replacement profile Actor build drift.');
    }
    if (run.generalAccess !== 'RESTRICTED') {
        throw new Error(
            'SCRAPING_ACCESS_ERROR: replacement profile Actor run is not restricted.'
        );
    }
    if (
        run.usageTotalUsd !== undefined
        && (
            typeof run.usageTotalUsd !== 'number'
            || !Number.isFinite(run.usageTotalUsd)
            || run.usageTotalUsd < 0
        )
    ) {
        throw new Error('SCRAPING_SCHEMA_ERROR: replacement profile Actor cost is invalid.');
    }
    if (
        typeof run.usageTotalUsd === 'number'
        && run.usageTotalUsd > input.maxTotalChargeUsd + Number.EPSILON
    ) {
        throw new Error('SCRAPING_BUDGET_ERROR: replacement profile Actor exceeded its hard cap.');
    }
    if (!run.defaultDatasetId) {
        throw new Error(
            'SCRAPING_SCHEMA_ERROR: replacement profile Actor has no default dataset.'
        );
    }

    let page: Awaited<ReturnType<ReturnType<ApifyClientLike['dataset']>['listItems']>>;
    try {
        page = await waitForSettledApifyProfileDataset(
            input.client,
            run.defaultDatasetId,
            usernames.length,
            {
                datasetReadRetries: REPLACEMENT_PROFILE_DATASET_READ_RETRIES,
                datasetRetryBaseDelayMs:
                    REPLACEMENT_PROFILE_DATASET_RETRY_BASE_DELAY_MS,
                strictEnvelope: true,
            },
            input.context?.invocationDeadlineAtMs
        );
    } catch (error) {
        if (isFatalDatasetError(error)) throw error;
        if (hasDurableRun(input.context)) {
            throw new Error(
                'SCRAPING_RUN_PENDING_ERROR: replacement profile dataset is not yet readable; retry the checkpointed run.'
            );
        }
        if (
            error instanceof Error
            && error.message.startsWith('SCRAPING_INCOMPLETE_ERROR:')
        ) {
            throw error;
        }
        throw new Error('SCRAPING_ERROR: replacement profile dataset read failed.');
    }
    if (
        !Array.isArray(page.items)
        || !Number.isInteger(page.total)
        || page.total < 0
        || page.total > usernames.length
        || page.items.length !== page.total
    ) {
        throw new Error('SCRAPING_SCHEMA_ERROR: replacement profile dataset did not settle.');
    }

    const estimatedCostUsd = Number((
        page.items.length * REPLACEMENT_PROFILE_ACTOR.estimatedResultCostUsd
    ).toFixed(12));
    input.context?.recordUsage({
        raw_result_count: page.items.length,
        estimated_cost_usd: estimatedCostUsd,
    });
    const parsed = parseApifyProfileDataset(page.items, usernames);
    const results = buildApifyProfileAttemptResults(
        usernames,
        parsed,
        profileAttemptLatency(startedAt)
    );
    input.context?.recordUsage({
        result_count: results.filter(result => result.outcome.status === 'success').length,
    });
    return results;
}
