import { supabaseAdmin } from '@/lib/supabase/admin';

export class ResultFeedbackPersistenceError extends Error {
    readonly code = 'RESULT_FEEDBACK_INSERT_FAILED' as const;
    constructor(message: string) {
        super(message);
        this.name = 'ResultFeedbackPersistenceError';
    }
}

export interface InsertResultFeedbackInput {
    requestId: string;
    userId: string;
    body: string;
    userAgent?: string;
}

export async function insertResultFeedback(input: InsertResultFeedbackInput): Promise<void> {
    const { error } = await supabaseAdmin.from('result_feedback').insert({
        request_id: input.requestId,
        user_id: input.userId,
        body: input.body,
        user_agent: input.userAgent,
    });
    if (error) {
        throw new ResultFeedbackPersistenceError(error.message ?? 'result feedback insert failed');
    }
}
