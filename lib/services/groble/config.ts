import { z } from 'zod';
import type { PaidEarlybirdPlanId } from '@/lib/domain/earlybird/catalog';

const productIdSchema = z.string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/);

const secretSchema = z.string().min(1).max(1_024);

export type GrobleConfig = Readonly<{
    productIds: Readonly<Record<PaidEarlybirdPlanId, string>>;
    paymentAddresses: Readonly<Record<PaidEarlybirdPlanId, string>>;
    webhookSecret: string;
    webhookPreviousSecret: string | null;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

function requiredValue(
    env: Environment,
    name: string,
    schema: z.ZodType<string>
): string {
    const parsed = schema.safeParse(env[name]);
    if (!parsed.success) {
        throw new Error(`${name} is missing or invalid.`);
    }
    return parsed.data;
}

export function readGrobleConfig(env: Environment = process.env): GrobleConfig {
    const previousSecretValue = env.GROBLE_WEBHOOK_PREVIOUS_SECRET?.trim();
    const previousSecret = previousSecretValue
        ? requiredValue(env, 'GROBLE_WEBHOOK_PREVIOUS_SECRET', secretSchema)
        : null;

    return Object.freeze({
        productIds: Object.freeze({
            basic: requiredValue(env, 'GROBLE_BASIC_PRODUCT_ID', productIdSchema),
            standard: requiredValue(env, 'GROBLE_STANDARD_PRODUCT_ID', productIdSchema),
        }),
        paymentAddresses: Object.freeze({
            basic: requiredValue(env, 'GROBLE_BASIC_PAYMENT_ADDRESS', productIdSchema),
            standard: requiredValue(env, 'GROBLE_STANDARD_PAYMENT_ADDRESS', productIdSchema),
        }),
        webhookSecret: requiredValue(env, 'GROBLE_WEBHOOK_SECRET', secretSchema),
        webhookPreviousSecret: previousSecret,
    });
}

export function getGrobleCheckoutUrl(
    planId: PaidEarlybirdPlanId,
    config: GrobleConfig
): string {
    return `https://groble.im/payment/${encodeURIComponent(config.paymentAddresses[planId])}`;
}
