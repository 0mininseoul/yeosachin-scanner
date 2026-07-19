import { supabaseAdmin } from '@/lib/supabase/admin';

export class LeadPersistenceError extends Error {
    readonly code = 'LEAD_INSERT_FAILED' as const;
    constructor(message: string) {
        super(message);
        this.name = 'LeadPersistenceError';
    }
}

export interface InsertLandingLeadInput {
    instagramId: string;
    rawInput?: string;
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    referrer?: string;
    userAgent?: string;
}

export async function insertLandingLead(input: InsertLandingLeadInput): Promise<void> {
    const { error } = await supabaseAdmin.from('landing_leads').insert({
        instagram_id: input.instagramId,
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
