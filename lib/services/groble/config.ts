import { z } from 'zod';
import type { PaidEarlybirdPlanId } from '@/lib/domain/earlybird/catalog';
import { parseGrobleSellerReference } from '@/lib/services/earlybird/seller-reference';

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

    const basicProductId = requiredValue(env, 'GROBLE_BASIC_PRODUCT_ID', productIdSchema);
    const standardProductId = requiredValue(env, 'GROBLE_STANDARD_PRODUCT_ID', productIdSchema);
    if (basicProductId === standardProductId) {
        throw new Error('GROBLE_PRODUCT_IDS_MUST_BE_DISTINCT');
    }
    const basicPaymentAddress = requiredValue(
        env,
        'GROBLE_BASIC_PAYMENT_ADDRESS',
        productIdSchema
    );
    const standardPaymentAddress = requiredValue(
        env,
        'GROBLE_STANDARD_PAYMENT_ADDRESS',
        productIdSchema
    );
    if (basicPaymentAddress === standardPaymentAddress) {
        throw new Error('GROBLE_PAYMENT_ADDRESSES_MUST_BE_DISTINCT');
    }

    return Object.freeze({
        productIds: Object.freeze({
            basic: basicProductId,
            standard: standardProductId,
        }),
        paymentAddresses: Object.freeze({
            basic: basicPaymentAddress,
            standard: standardPaymentAddress,
        }),
        webhookSecret: requiredValue(env, 'GROBLE_WEBHOOK_SECRET', secretSchema),
        webhookPreviousSecret: previousSecret,
    });
}

export function getGrobleCheckoutUrl(
    planId: PaidEarlybirdPlanId,
    sellerReference: string,
    config: GrobleConfig
): string {
    const parsedReference = parseGrobleSellerReference(sellerReference);
    if (!parsedReference) {
        throw new Error('INVALID_GROBLE_SELLER_REFERENCE');
    }
    const url = new URL(
        `https://groble.im/payment/${encodeURIComponent(config.paymentAddresses[planId])}`
    );
    url.searchParams.set('ref', parsedReference);
    return url.toString();
}
