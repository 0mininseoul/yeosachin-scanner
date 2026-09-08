import { runExclusionSupervisorWithStorage } from './exclusion-supervisor';
import type { ReservationStorage } from './exclusion';
import type { LegacyLockStorage } from './exclusion-bridge';

type ObjectValue = Readonly<{ generation: string; value: unknown }>;
type RawValue = Readonly<{ generation: string; body: string }>;

class MemoryStorage implements ReservationStorage, LegacyLockStorage {
    private readonly objects = new Map<string, ObjectValue>();
    private readonly rawObjects = new Map<string, RawValue>();
    private generation = 0;

    async get(key: string): Promise<ObjectValue | null> {
        return this.objects.get(key) ?? null;
    }

    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }): Promise<ObjectValue> {
        const current = this.objects.get(key);
        if (options.ifGenerationMatch === '0' ? current !== undefined : current?.generation !== options.ifGenerationMatch) {
            throw new Error('CAS');
        }
        const stored = { generation: String(++this.generation), value };
        this.objects.set(key, stored);
        return stored;
    }

    async delete(key: string, options: { ifGenerationMatch: string }): Promise<void> {
        const current = this.objects.get(key);
        if (!current || current.generation !== options.ifGenerationMatch) throw new Error('CAS');
        this.objects.delete(key);
    }

    async getRaw(key: string): Promise<RawValue | null> {
        return this.rawObjects.get(key) ?? null;
    }

    async putRaw(key: string, body: string, options: { ifGenerationMatch: '0' | string }): Promise<RawValue> {
        const current = this.rawObjects.get(key);
        if (options.ifGenerationMatch === '0' ? current !== undefined : current?.generation !== options.ifGenerationMatch) {
            throw new Error('CAS');
        }
        const stored = { generation: String(++this.generation), body };
        this.rawObjects.set(key, stored);
        return stored;
    }

    async deleteRaw(key: string, options: { ifGenerationMatch: string }): Promise<void> {
        const current = this.rawObjects.get(key);
        if (!current || current.generation !== options.ifGenerationMatch) throw new Error('CAS');
        this.rawObjects.delete(key);
    }
}

void runExclusionSupervisorWithStorage(process.argv.slice(2), () => new MemoryStorage()).catch(error => {
    const code = typeof error?.code === 'string' ? error.code : 'ADAPTER_REQUEST_INVALID';
    process.stdout.write('ERR ' + code + '\n');
    process.exitCode = 2;
});
