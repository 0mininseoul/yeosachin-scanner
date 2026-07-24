import { supabaseAdmin } from '@/lib/supabase/admin';

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
    })
    | ExcludedLeadPrivacyBoundary
);

export async function insertLandingLead(input: InsertLandingLeadInput): Promise<void> {
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
