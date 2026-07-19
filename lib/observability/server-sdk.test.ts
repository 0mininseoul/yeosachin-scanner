import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const AXIOM_ENV_NAMES = ['AXIOM_TOKEN', 'AXIOM_DATASET', 'AXIOM_ORG_ID'] as const;
const ORIGINAL_AXIOM_ENV = Object.fromEntries(
    AXIOM_ENV_NAMES.map(name => [name, process.env[name]]),
);
const ORIGINAL_BIGINT_TO_JSON = Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON');

function importAxiomSdkInFreshProcess(moduleKind: 'esm' | 'cjs') {
    const loadSdk = moduleKind === 'esm'
        ? "await import('@axiomhq/js');"
        : "require('@axiomhq/js');";
    const result = spawnSync(
        process.execPath,
        [
            ...(moduleKind === 'esm' ? ['--input-type=module'] : []),
            '-e',
            `
                delete BigInt.prototype.toJSON;
                ${loadSdk}
                const hasToJson = Object.prototype.hasOwnProperty.call(
                    BigInt.prototype,
                    'toJSON',
                );
                let stringifies = false;
                try {
                    JSON.stringify(1n);
                    stringifies = true;
                } catch (error) {
                    if (!(error instanceof TypeError)) throw error;
                }
                process.stdout.write(JSON.stringify({ hasToJson, stringifies }));
            `,
        ],
        {
            cwd: process.cwd(),
            encoding: 'utf8',
        },
    );

    return {
        status: result.status,
        stderr: result.stderr,
        observation: result.stdout ? JSON.parse(result.stdout) : undefined,
    };
}

function restoreBigIntToJson(): void {
    if (ORIGINAL_BIGINT_TO_JSON) {
        Object.defineProperty(BigInt.prototype, 'toJSON', ORIGINAL_BIGINT_TO_JSON);
    } else {
        Reflect.deleteProperty(BigInt.prototype, 'toJSON');
    }
}

beforeEach(() => {
    for (const name of AXIOM_ENV_NAMES) delete process.env[name];
    Reflect.deleteProperty(BigInt.prototype, 'toJSON');
    vi.resetModules();
});

afterEach(() => {
    restoreBigIntToJson();
    for (const name of AXIOM_ENV_NAMES) {
        const original = ORIGINAL_AXIOM_ENV[name];
        if (original === undefined) delete process.env[name];
        else process.env[name] = original;
    }
});

describe('Axiom SDK runtime boundary', () => {
    it('does not mutate BigInt.prototype when observability is disabled at import time', async () => {
        expect(Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON')).toBeUndefined();

        await import('./server');

        expect(Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON')).toBeUndefined();
    });

    it('never mutates BigInt JSON behavior during configured SDK initialization', async () => {
        process.env.AXIOM_TOKEN = 'test-token';
        process.env.AXIOM_DATASET = 'test-dataset';
        process.env.AXIOM_ORG_ID = 'test-org';
        const { flushOperationalLogs } = await import('./server');

        const initialization = flushOperationalLogs();
        await import('@axiomhq/js');

        expect(Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON')).toBeUndefined();
        expect(() => JSON.stringify(BigInt(1))).toThrow(TypeError);

        await initialization;
        expect(Object.getOwnPropertyDescriptor(BigInt.prototype, 'toJSON')).toBeUndefined();
        expect(() => JSON.stringify(BigInt(1))).toThrow(TypeError);
    });

    it.each(['esm', 'cjs'] as const)(
        'keeps native BigInt JSON behavior through the %s package export',
        moduleKind => {
            const result = importAxiomSdkInFreshProcess(moduleKind);

            expect(result.status, result.stderr).toBe(0);
            expect(result.observation).toEqual({
                hasToJson: false,
                stringifies: false,
            });
        },
    );

    it('uses the installed transport debug threshold semantics', async () => {
        const [{ Axiom }, { AxiomJSTransport }] = await Promise.all([
            import('@axiomhq/js'),
            import('@axiomhq/logging'),
        ]);
        const axiom = new Axiom({ token: 'test-token', orgId: 'test-org' });
        const ingest = vi.spyOn(axiom, 'ingest').mockImplementation(() => undefined);
        const log = { level: 'debug', message: 'debug.checked', fields: {} };

        new AxiomJSTransport({ axiom, dataset: 'test-dataset' }).log([log]);
        expect(ingest).not.toHaveBeenCalled();

        new AxiomJSTransport({
            axiom,
            dataset: 'test-dataset',
            logLevel: 'debug',
        }).log([log]);
        expect(ingest).toHaveBeenCalledWith('test-dataset', [log]);
    });
});
