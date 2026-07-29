export function serializeJsonLd(data: unknown): string {
    const serialized = JSON.stringify(data);
    if (serialized === undefined) {
        throw new TypeError('JSON-LD data must be JSON serializable');
    }
    return serialized.replace(/</g, '\\u003c');
}

export function JsonLd({ data }: { data: unknown }) {
    return (
        <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
        />
    );
}
