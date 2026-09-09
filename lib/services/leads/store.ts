import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    captureTokenJourneyId,
    createOrReplayLandingLeadCapture,
    createOrReplayLandingLeadExclusion,
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

interface ExcludedLeadPrivacyBoundary {
    inputContext: 'excluded';
    sourcePreflightId: string;
    rawInput?: never;
    utmSource?: never;
    utmMedium?: never;
    utmCampaign?: never;
    utmContent?: never;
    utmTerm?: never;
    referrer?: never;
    userAgent?: never;
}

export type InsertLandingLeadInput = {
    instagramId: string;
} & (
    | (LandingLeadAttributionInput & {
        inputContext?: 'target';
        sourcePreflightId?: never;
        captureToken?: string;
        anonymousPrincipalHash?: string;
        journeyId?: string;
    })
    | ExcludedLeadPrivacyBoundary
);

export type StoredLandingLeadCapture = Readonly<{
    status: 'stored';
    captureToken: string;
    journeyId: string;
    created: boolean;
}>;

export async function insertLandingLead(
    input: InsertLandingLeadInput,
): Promise<void | StoredLandingLeadCapture> {
    if (input.inputContext === 'excluded') {
        try {
            const created = await createOrReplayLandingLeadExclusion(
                supabaseAdmin,
                input.sourcePreflightId,
                input.instagramId,
            );
            if (!created) {
                throw new LeadPersistenceError('landing lead exclusion target missing');
            }
            return;
        } catch (error) {
            if (error instanceof LeadPersistenceError) throw error;
            throw new LeadPersistenceError(error instanceof Error ? error.message : 'landing lead exclusion failed');
        }
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
        input_context: input.inputContext ?? 'target',
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
