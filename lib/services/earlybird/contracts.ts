import { z } from 'zod';

const uuidSchema = z.string().uuid();

export const earlybirdCheckoutRequestSchema = z.object({
    preflightId: uuidSchema,
    planId: z.enum(['basic', 'standard', 'plus']),
    disclosureAccepted: z.literal(true),
});

export const earlybirdWaitlistRequestSchema = z.object({
    preflightId: uuidSchema,
    planId: z.literal('plus'),
});

export type EarlybirdCheckoutRequest = z.infer<typeof earlybirdCheckoutRequestSchema>;
export type EarlybirdWaitlistRequest = z.infer<typeof earlybirdWaitlistRequestSchema>;

export function isSameOriginMutation(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (!origin) return false;
    try {
        return new URL(origin).origin === new URL(request.url).origin;
    } catch {
        return false;
    }
}

export function isJsonRequest(request: Request): boolean {
    return request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
        === 'application/json';
}
