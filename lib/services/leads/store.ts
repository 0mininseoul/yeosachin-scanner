import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    captureTokenJourneyId,
    createOrReplayLandingLeadCapture,
    hashCaptureToken,
    type LandingLeadJourneyClaim,
} from '@/lib/services/landing/landing-lead-journey';

export class LeadPersistenceError extends Error {
    readonly code = 'LEAD_INSERT_FAILED' as const;
    constructor(message: string) {
        super(message);
        this.name = 'LeadPersistenceError';
    }
}

interface LandingLeadAttributionInput {
    rawInput?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    referrer?: string;
    userAgent?: string;
}

export type InsertLandingLeadInput = {
    instagramId: string;
} & LandingLeadAttributionInput & {
    // Excluded rows are created only inside the atomic preflight exclusion RPC.
    // Keep this target-only at the type boundary, then retain a runtime fence
    // for untyped callers and stale mixed-version code.
    inputContext?: 'target';
    sourcePreflightId?: never;
    captureToken?: string;
    anonymousPrincipalHash?: string;
    journeyId?: string;
};

export type StoredLandingLeadCapture = Readonly<{
    status: 'stored';
    captureToken: string;
    journeyId: string;
    created: boolean;
}>;

export async function insertLandingLead(
    input: InsertLandingLeadInput,
): Promise<void | StoredLandingLeadCapture> {
    const requestedContext = (input as unknown as { inputContext?: unknown }).inputContext;
    if (requestedContext !== undefined && requestedContext !== 'target') {
        throw new LeadPersistenceError(
            'excluded landing leads require the atomic preflight exclusion decision',
        );
    }

    if (input.captureToken && input.anonymousPrincipalHash) {
        try {
            const journeyId = input.journeyId ?? captureTokenJourneyId(hashCaptureToken(input.captureToken));
            const captured: LandingLeadJourneyClaim = await createOrReplayLandingLeadCapture(
                supabaseAdmin,
                {
                    journeyId,
                    instagramId: input.instagramId,
                    inputContext: 'target',
                    anonymousPrincipalHash: input.anonymousPrincipalHash,
                    captureTokenHash: hashCaptureToken(input.captureToken),
                },
            );
            return {
                status: 'stored',
                captureToken: input.captureToken,
                journeyId: captured.journeyId,
                created: captured.created,
            };
        } catch (error) {
            throw new LeadPersistenceError(error instanceof Error ? error.message : 'landing lead capture failed');
        }
    }

    const { error } = await supabaseAdmin.from('landing_leads').insert({
        instagram_id: input.instagramId,
        input_context: 'target',
        source_preflight_id: input.sourcePreflightId,
        raw_input: input.rawInput,
        utm_source: input.utmSource,
        utm_medium: input.utmMedium,
        utm_campaign: input.utmCampaign,
        utm_content: input.utmContent,
        utm_term: input.utmTerm,
        referrer: input.referrer,
        user_agent: input.userAgent,
    });
    if (error) {
        throw new LeadPersistenceError(error.message ?? 'landing lead insert failed');
    }
}
