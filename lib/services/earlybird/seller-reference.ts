export const GROBLE_SELLER_REFERENCE_PATTERN = /^ord\.[a-f0-9]{32}$/;

export function parseGrobleSellerReference(value: unknown): string | null {
    return typeof value === 'string' && GROBLE_SELLER_REFERENCE_PATTERN.test(value)
        ? value
        : null;
}
