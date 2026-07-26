import { z } from 'zod';
import type { PaidEarlybirdPlanId } from '@/lib/domain/earlybird/catalog';
import { parseGrobleSellerReference } from '@/lib/services/earlybird/seller-reference';

const productIdSchema = z.string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/);

const secretSchema = z.string().min(1).max(1_024);

export type GrobleProductLineageConfig = Readonly<{
    productIds: Readonly<Record<PaidEarlybirdPlanId, string>>;
    paymentAddresses: Readonly<Record<PaidEarlybirdPlanId, string>>;
    legacyProductIds: Readonly<Record<PaidEarlybirdPlanId, string>>;
    legacyPaymentAddresses: Readonly<Record<PaidEarlybirdPlanId, string>>;
}>;

export type GrobleConfig = GrobleProductLineageConfig & Readonly<{
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

export function readGrobleProductLineageConfig(
    env: Environment = process.env
): GrobleProductLineageConfig {
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

    const v2BasicProductId = requiredValue(
        env,
        'GROBLE_V2_BASIC_PRODUCT_ID',
        productIdSchema
    );
    const v2StandardProductId = requiredValue(
        env,
        'GROBLE_V2_STANDARD_PRODUCT_ID',
        productIdSchema
    );
    if (v2BasicProductId === v2StandardProductId) {
        throw new Error('GROBLE_PRODUCT_IDS_MUST_BE_DISTINCT');
    }
    if (
        [basicProductId, standardProductId].includes(v2BasicProductId)
        || [basicProductId, standardProductId].includes(v2StandardProductId)
    ) {
        throw new Error('GROBLE_PRODUCT_VERSION_REUSE');
    }

    const v2BasicPaymentAddress = requiredValue(
        env,
        'GROBLE_V2_BASIC_PAYMENT_ADDRESS',
        productIdSchema
    );
    const v2StandardPaymentAddress = requiredValue(
        env,
        'GROBLE_V2_STANDARD_PAYMENT_ADDRESS',
        productIdSchema
    );
    if (v2BasicPaymentAddress === v2StandardPaymentAddress) {
        throw new Error('GROBLE_PAYMENT_ADDRESSES_MUST_BE_DISTINCT');
    }
    if (
        [basicPaymentAddress, standardPaymentAddress]
            .includes(v2BasicPaymentAddress)
        || [basicPaymentAddress, standardPaymentAddress]
            .includes(v2StandardPaymentAddress)
    ) {
        throw new Error('GROBLE_PAYMENT_ADDRESS_VERSION_REUSE');
    }
    const allIdentifiers = [
        basicProductId,
        standardProductId,
        basicPaymentAddress,
        standardPaymentAddress,
        v2BasicProductId,
        v2StandardProductId,
        v2BasicPaymentAddress,
        v2StandardPaymentAddress,
    ];
    if (new Set(allIdentifiers).size !== allIdentifiers.length) {
        throw new Error('GROBLE_IDENTIFIERS_MUST_BE_GLOBALLY_DISTINCT');
    }

    return Object.freeze({
        productIds: Object.freeze({
            basic: v2BasicProductId,
            standard: v2StandardProductId,
        }),
        paymentAddresses: Object.freeze({
            basic: v2BasicPaymentAddress,
            standard: v2StandardPaymentAddress,
        }),
        legacyProductIds: Object.freeze({
            basic: basicProductId,
            standard: standardProductId,
        }),
        legacyPaymentAddresses: Object.freeze({
            basic: basicPaymentAddress,
            standard: standardPaymentAddress,
        }),
    });
}

export function readGrobleConfig(env: Environment = process.env): GrobleConfig {
    const previousSecretValue = env.GROBLE_WEBHOOK_PREVIOUS_SECRET?.trim();
    const previousSecret = previousSecretValue
        ? requiredValue(env, 'GROBLE_WEBHOOK_PREVIOUS_SECRET', secretSchema)
        : null;
    const lineage = readGrobleProductLineageConfig(env);

    return Object.freeze({
        ...lineage,
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
