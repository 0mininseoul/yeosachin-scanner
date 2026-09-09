import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EpochError } from './contracts';
import { runExclusionLauncherWithSupervisor } from './exclusion-launcher';

const fixtureSupervisor = resolve(dirname(fileURLToPath(import.meta.url)), 'exclusion-supervisor.fixture.ts');
const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';

if (import.meta.url === invokedScript) {
    void runExclusionLauncherWithSupervisor(process.argv.slice(2), fixtureSupervisor).catch((error: unknown) => {
        if (error instanceof EpochError) {
            process.stderr.write(error.code + '\n');
        } else {
            process.stderr.write('ADAPTER_REQUEST_INVALID\n');
        }
        process.exitCode = 2;
    });
}
