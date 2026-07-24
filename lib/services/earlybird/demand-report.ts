import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const nonNegativeIntegerSchema = z.number().int().nonnegative().safe();
const dateOnlySchema = z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(value => {
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(parsed.valueOf())
            && parsed.toISOString().slice(0, 10) === value;
    }, 'invalid calendar date');

function planDemandSchema(planId: 'basic' | 'standard') {
    return z.object({
        planId: z.literal(planId),
        confirmedPaymentCount: nonNegativeIntegerSchema,
        confirmedGrossKrw: nonNegativeIntegerSchema,
        remainingSlots: nonNegativeIntegerSchema,
    }).strict();
}

export const earlybirdDemandSummarySchema = z.object({
    startDate: dateOnlySchema,
    endDateExclusive: dateOnlySchema,
    referenceConfirmedPaymentCount: nonNegativeIntegerSchema,
    referenceConfirmedGrossKrw: nonNegativeIntegerSchema,
    unconfirmedPaidOrderCount: nonNegativeIntegerSchema,
    refundLiabilityCount: nonNegativeIntegerSchema,
    overdueFulfillmentCount: nonNegativeIntegerSchema,
    pendingCheckoutCount: nonNegativeIntegerSchema,
    plusWaitlistCount: nonNegativeIntegerSchema,
    plans: z.tuple([
        planDemandSchema('basic'),
        planDemandSchema('standard'),
    ]),
}).strict();

export const earlybirdDemandRangeSchema = z.object({
    startDate: dateOnlySchema,
    endDateExclusive: dateOnlySchema,
}).strict().superRefine((range, context) => {
    const start = Date.parse(`${range.startDate}T00:00:00.000Z`);
    const end = Date.parse(`${range.endDateExclusive}T00:00:00.000Z`);
    const days = (end - start) / 86_400_000;
    if (days < 1 || days > 90) {
        context.addIssue({
            code: 'custom',
            message: 'date range must be between 1 and 90 days',
        });
    }
});

export type EarlybirdDemandSummary = Readonly<
    z.infer<typeof earlybirdDemandSummarySchema>
>;
export type EarlybirdDemandRange = Readonly<
    z.infer<typeof earlybirdDemandRangeSchema>
>;

export interface EarlybirdDemandReportDependencies {
    rpc(
        name: 'load_earlybird_demand_summary',
        args: {
            p_start_date: string;
            p_end_date_exclusive: string;
        }
    ): PromiseLike<{ data: unknown; error: unknown }>;
}

export class EarlybirdDemandReportError extends Error {
    readonly code: string;

    constructor(code: string) {
        super(code);
        this.name = 'EarlybirdDemandReportError';
        this.code = code;
    }
}

export function parseEarlybirdDemandRange(value: unknown): EarlybirdDemandRange {
    const parsed = earlybirdDemandRangeSchema.safeParse(value);
    if (!parsed.success) {
        throw new EarlybirdDemandReportError('EARLYBIRD_DEMAND_RANGE_INVALID');
    }
    return Object.freeze(parsed.data);
}

function defaultDependencies(): EarlybirdDemandReportDependencies {
    return {
        rpc: (name, args) => supabaseAdmin.rpc(name, args),
    };
}

export async function loadEarlybirdDemandSummary(
    value: unknown,
    dependencies: EarlybirdDemandReportDependencies = defaultDependencies()
): Promise<EarlybirdDemandSummary> {
    const range = parseEarlybirdDemandRange(value);
    const { data, error } = await dependencies.rpc(
        'load_earlybird_demand_summary',
        {
            p_start_date: range.startDate,
            p_end_date_exclusive: range.endDateExclusive,
        }
    );
    if (error) {
        throw new EarlybirdDemandReportError('EARLYBIRD_DEMAND_REPORT_FAILED');
    }
    const parsed = earlybirdDemandSummarySchema.safeParse(data);
    if (!parsed.success
        || parsed.data.startDate !== range.startDate
        || parsed.data.endDateExclusive !== range.endDateExclusive) {
        throw new EarlybirdDemandReportError('EARLYBIRD_DEMAND_REPORT_INVALID');
    }
    return Object.freeze({
        ...parsed.data,
        plans: Object.freeze(
            parsed.data.plans.map(plan => Object.freeze({ ...plan }))
        ) as EarlybirdDemandSummary['plans'],
    });
}
