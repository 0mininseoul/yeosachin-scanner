import 'server-only';

import type { GenerateContentParameters } from '@google/genai';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import registry from '@/config/dev-ui-deployment.json';
import { browserDeploymentEnvironment, deploymentEnvironment } from '@/lib/constants/dev-ui';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { devLiveOwnerStartEnabled, readDevLiveApproval, type DevLiveApproval } from './live-approval';
import { devLiveWorkerRequestBoundary } from './live-runtime';
import { estimateDevLiveVertexReservation } from './live-vertex-reservation';

export const DEV_LIVE_BUDGET_UNAVAILABLE = 'DEV_LIVE_BUDGET_UNAVAILABLE';
export const DEV_LIVE_BUDGET_EXCEEDED = 'DEV_LIVE_BUDGET_EXCEEDED';
const MICRODOLLARS_PER_DOLLAR = 1_000_000;
const MICRODOLLARS_PER_CENT = 10_000;

// The approved provider set uses pay-per-event Actors. Never admit an unknown Actor.
const APIFY_ACTORS = new Set([
    'apify/instagram-profile-scraper',
    'apify/instagram-scraper',
    'scraping_solutions/instagram-scraper-followers-following-no-cookies',
    'datadoping/instagram-likes-scraper',
    'apify/instagram-comment-scraper',
]);

type Provider = 'apify' | 'vertex';
const workerApproval = new AsyncLocalStorage<DevLiveApproval>();

export function withDevLiveProviderApproval<T>(approval: DevLiveApproval | null, operation: () => T): T {
    return approval ? workerApproval.run(approval, operation) : operation();
}

export type DevLiveCostReservation = Readonly<{
    grantId: string;
    reservationId: string;
}>;

function micros(usd: number): number {
    const amount = Math.ceil(usd * MICRODOLLARS_PER_DOLLAR);
    if (!Number.isFinite(usd) || usd < 0 || !Number.isSafeInteger(amount) || amount > 5_000_000) {
        throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    }
    return amount;
}

function assertRegisteredDevDatabase(): void {
    // Use a dynamic key for the runtime value and check against the public URL
    // compiled into this Dev build as well as the registered Dev database.
    const runtime = deploymentEnvironment().NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
    const built = browserDeploymentEnvironment().NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, '');
    if (!runtime || runtime !== built
        || !registry.deployments.some(entry => runtime === `https://${entry.supabaseProjectRef}.supabase.co`)) {
        throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    }
}

function grantArguments(approval: DevLiveApproval) {
    assertRegisteredDevDatabase();
    return {
        p_grant_id: approval.id,
        p_approved_at: approval.approvedAt,
        p_expires_at: approval.expiresAt,
        p_apify_limit_micros: approval.apifyMaxCents * MICRODOLLARS_PER_CENT,
        p_ai_limit_micros: approval.aiMaxCents * MICRODOLLARS_PER_CENT,
    };
}

async function budgetRpc(name: string, args: Record<string, string | number>): Promise<unknown> {
    try {
        const { data, error } = await supabaseAdmin.rpc(name, args);
        if (!error) return data;
    } catch {
        // The caller only needs the stable budget error, never a database response.
    }
    throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
}

/** Before enqueue, prove the grant and installed Dev budget schema are eligible. */
export async function assertDevLiveBudgetAvailable(approval: DevLiveApproval): Promise<void> {
    const version = await budgetRpc('dev_live_budget_check_v1', grantArguments(approval));
    if (version !== 1) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
}

/** Each provider entry point independently verifies it is a registered Dev worker. */
export function requireDevLiveProviderApproval(): DevLiveApproval {
    const role = process.env.DEV_LIVE_WORKLOAD;
    const url = role === 'preflight'
        ? `${process.env.DEV_LIVE_PREFLIGHT_ORIGIN}/api/analysis/preflight/worker`
        : `${process.env.DEV_LIVE_PAID_ORIGIN}/api/analysis/v2/worker`;
    const approval = devLiveOwnerStartEnabled() ? workerApproval.getStore() : readDevLiveApproval();
    if (!approval || Date.now() >= Date.parse(approval.expiresAt) || devLiveWorkerRequestBoundary({ url, method: 'POST' }) !== 'dev-worker') {
        throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    }
    return approval;
}

async function reserve(approval: DevLiveApproval, provider: Provider, capUsd: number): Promise<DevLiveCostReservation> {
    const amount = micros(capUsd);
    if (amount < 1) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    const reservationId = randomUUID();
    const reserved = await budgetRpc('dev_live_budget_reserve_v1', {
        ...grantArguments(approval),
        p_reservation_id: reservationId,
        p_provider: provider,
        p_amount_micros: amount,
    });
    if (reserved === false) throw new Error(DEV_LIVE_BUDGET_EXCEEDED);
    if (reserved !== true) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    return { grantId: approval.id, reservationId };
}

export async function reserveDevLiveApifyStart(approval: DevLiveApproval, actorId: string, capUsd: number): Promise<void> {
    if (!APIFY_ACTORS.has(actorId)) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    await reserve(approval, 'apify', capUsd);
}

export function reserveDevLiveVertexAttempt(
    approval: DevLiveApproval,
    request: GenerateContentParameters,
    location: string,
): Promise<DevLiveCostReservation> {
    const cap = estimateDevLiveVertexReservation(request, location);
    if (!cap) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
    return reserve(approval, 'vertex', cap.totalCostUsd);
}

/** Settle complete provider usage or a confirmed zero charge. Unknown costs retain the whole reservation. */
export async function settleDevLiveVertexAttempt(reservation: DevLiveCostReservation, actualUsd: number): Promise<void> {
    assertRegisteredDevDatabase();
    const settled = await budgetRpc('dev_live_budget_settle_vertex_v1', {
        p_grant_id: reservation.grantId,
        p_reservation_id: reservation.reservationId,
        // An unusually high amount still has to reach SQL so it can freeze the grant.
        p_actual_micros: micros(Math.min(actualUsd, 5)),
    });
    if (settled !== true) throw new Error(DEV_LIVE_BUDGET_UNAVAILABLE);
}
