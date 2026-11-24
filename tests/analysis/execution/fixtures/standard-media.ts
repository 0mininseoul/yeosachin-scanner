import sharp from 'sharp';
import type {
    AnalysisV2PrivateMediaObjectClient,
    AnalysisV2PrivateRetainedMediaObjectClient,
} from '@/lib/services/analysis/v2-media-artifact-store';

export function createFixtureObjects(): AnalysisV2PrivateMediaObjectClient &
    AnalysisV2PrivateRetainedMediaObjectClient {
    const objects = new Map<string, Buffer>();
    async function create({ objectName, bytes }: { objectName: string; bytes: Buffer }) {
        const created = !objects.has(objectName);
        if (created) objects.set(objectName, Buffer.from(bytes));
        return { created, generation: '1' };
    }
    return {
        create,
        createRetained: create,
        read: async ({ objectName }) => {
            const value = objects.get(objectName);
            if (!value) throw new Error('Missing synthetic media');
            return value;
        },
        readRetained: async ({ objectName }) => objects.get(objectName) ?? null,
        delete: async ({ objectName }) => {
            objects.delete(objectName);
        },
    };
}

export type FixtureR2Command = {
    constructor: { name: string };
    input: { Key: string; Body?: Uint8Array; Metadata?: Record<string, string> };
};
export function createFixtureR2() {
    const objects = new Map<string, { bytes: Buffer; metadata: Record<string, string> }>();
    return async (command: FixtureR2Command) => {
        const { Key, Body, Metadata } = command.input;
        if (command.constructor.name === 'PutObjectCommand' && Body) {
            objects.set(Key, { bytes: Buffer.from(Body), metadata: Metadata ?? {} });
            return {};
        }
        const item = objects.get(Key);
        if (!item) throw new Error('Missing synthetic result object');
        const metadata = {
            ContentLength: item.bytes.length,
            ContentType: 'image/webp',
            Metadata: item.metadata,
        };
        if (command.constructor.name === 'HeadObjectCommand') return metadata;
        if (command.constructor.name === 'GetObjectCommand')
            return {
                ...metadata,
                Body: { transformToByteArray: async () => Uint8Array.from(item.bytes) },
            };
        throw new Error('Unexpected synthetic object operation');
    };
}

export const makeSourcePng = () =>
    sharp({ create: { width: 64, height: 64, channels: 3, background: '#366b64' } })
        .png()
        .toBuffer();
