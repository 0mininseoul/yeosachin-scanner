import { describe, expect, it } from 'vitest';
import { getGrobleCheckoutUrl, readGrobleConfig } from './config';

const VALID_ENV = {
    GROBLE_BASIC_PRODUCT_ID: 'basic_product-01',
    GROBLE_STANDARD_PRODUCT_ID: 'standard_product-01',
    GROBLE_BASIC_PAYMENT_ADDRESS: 'basic-checkout-a1',
    GROBLE_STANDARD_PAYMENT_ADDRESS: 'standard-checkout-b2',
    GROBLE_V2_BASIC_PRODUCT_ID: 'basic_product-v2-01',
    GROBLE_V2_STANDARD_PRODUCT_ID: 'standard_product-v2-01',
    GROBLE_V2_BASIC_PAYMENT_ADDRESS: 'basic-checkout-v2-a1',
    GROBLE_V2_STANDARD_PAYMENT_ADDRESS: 'standard-checkout-v2-b2',
    GROBLE_WEBHOOK_SECRET: 'current-secret',
    GROBLE_WEBHOOK_PREVIOUS_SECRET: 'previous-secret',
};

describe('Groble server configuration', () => {
    it('requires immutable legacy and v2 product identities before checkout can open', () => {
        expect(() => readGrobleConfig({})).toThrow('GROBLE_BASIC_PRODUCT_ID');
        expect(() => readGrobleConfig({
            GROBLE_BASIC_PRODUCT_ID: 'basic',
            GROBLE_STANDARD_PRODUCT_ID: 'standard',
        })).toThrow('GROBLE_BASIC_PAYMENT_ADDRESS');
        expect(() => readGrobleConfig({
            GROBLE_BASIC_PRODUCT_ID: 'basic',
            GROBLE_STANDARD_PRODUCT_ID: 'standard',
            GROBLE_BASIC_PAYMENT_ADDRESS: 'basic-v1',
            GROBLE_STANDARD_PAYMENT_ADDRESS: 'standard-v1',
            GROBLE_WEBHOOK_SECRET: 'secret',
        })).toThrow('GROBLE_V2_BASIC_PRODUCT_ID');
    });

    it('rejects product IDs and payment addresses that could alter the checkout path', () => {
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_BASIC_PRODUCT_ID: '../basic?redirect=https://example.com',
        })).toThrow('GROBLE_BASIC_PRODUCT_ID');
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_BASIC_PAYMENT_ADDRESS: '../basic?redirect=https://example.com',
        })).toThrow('GROBLE_BASIC_PAYMENT_ADDRESS');
    });

    it('requires distinct product IDs and payment addresses for the two paid plans', () => {
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_STANDARD_PRODUCT_ID: VALID_ENV.GROBLE_BASIC_PRODUCT_ID,
        })).toThrow('GROBLE_PRODUCT_IDS_MUST_BE_DISTINCT');
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_STANDARD_PAYMENT_ADDRESS: VALID_ENV.GROBLE_BASIC_PAYMENT_ADDRESS,
        })).toThrow('GROBLE_PAYMENT_ADDRESSES_MUST_BE_DISTINCT');
    });

    it('fails closed when a v2 product or payment address reuses any legacy identity', () => {
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_V2_BASIC_PRODUCT_ID: VALID_ENV.GROBLE_BASIC_PRODUCT_ID,
        })).toThrow('GROBLE_PRODUCT_VERSION_REUSE');
        expect(() => readGrobleConfig({
            ...VALID_ENV,
            GROBLE_V2_STANDARD_PAYMENT_ADDRESS:
                VALID_ENV.GROBLE_STANDARD_PAYMENT_ADDRESS,
        })).toThrow('GROBLE_PAYMENT_ADDRESS_VERSION_REUSE');
    });

    it('builds checkout URLs only from the active v2 products and preserves legacy webhook IDs', () => {
        const config = readGrobleConfig(VALID_ENV);

        expect(getGrobleCheckoutUrl(
            'basic',
            'ord.0123456789abcdef0123456789abcdef',
            config
        )).toBe(
            'https://groble.im/payment/basic-checkout-v2-a1'
            + '?ref=ord.0123456789abcdef0123456789abcdef'
        );
        expect(getGrobleCheckoutUrl(
            'standard',
            'ord.fedcba9876543210fedcba9876543210',
            config
        )).toBe(
            'https://groble.im/payment/standard-checkout-v2-b2'
            + '?ref=ord.fedcba9876543210fedcba9876543210'
        );
        expect(config.productIds).toEqual({
            basic: 'basic_product-v2-01',
            standard: 'standard_product-v2-01',
        });
        expect(config.legacyProductIds).toEqual({
            basic: 'basic_product-01',
            standard: 'standard_product-01',
        });
    });

    it('rejects a checkout reference outside the server-issued format', () => {
        const config = readGrobleConfig(VALID_ENV);

        expect(() => getGrobleCheckoutUrl('basic', 'buyer@example.com', config))
            .toThrow('INVALID_GROBLE_SELLER_REFERENCE');
    });
});
