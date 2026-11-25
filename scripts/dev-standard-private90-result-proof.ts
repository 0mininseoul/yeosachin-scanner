import { open } from 'node:fs/promises';
import { openStandardQaCopyForJob } from '@/lib/services/dev-ui/standard-qa-copy-cloud';
import { enrollStandardQaResultProof, readStandardQaResultProof } from '@/lib/services/dev-ui/standard-qa-result-proof';

const maxInputBytes = 64 * 1024;
function unavailable(): never { throw new Error('DEV_STANDARD_QA_RESULT_PROOF_UNAVAILABLE'); }

async function readInput(): Promise<unknown> {
    const env = process.env.DEV_STANDARD_PRIVATE90_RESULT_PROOF;
    delete process.env.DEV_STANDARD_PRIVATE90_RESULT_PROOF;
    if (env !== undefined) {
        if (Buffer.byteLength(env) > maxInputBytes) return unavailable();
        return JSON.parse(env);
    }
    const file = await open('/var/run/dev-standard-result-proof/entries.json', 'r');
    const bytes = Buffer.alloc(maxInputBytes + 1);
    try {
        let length = 0;
        while (length <= maxInputBytes) {
            const { bytesRead } = await file.read(bytes,length,bytes.length-length,null);
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        if (length > maxInputBytes) return unavailable();
        return JSON.parse(bytes.toString('utf8',0,length));
    } finally {
        bytes.fill(0);
        await file.close();
    }
}

async function main() {
    const mode = process.argv[2];
    if (!process.env.CLOUD_RUN_JOB || process.env.DEPLOYMENT_ROLE !== 'dev' || process.argv.length !== 3
        || (mode !== '--enroll' && mode !== '--verify')) return unavailable();
    // Read mode opens the existing wrapped key; this job must never create another one or touch the live source.
    const { policy, destination } = await openStandardQaCopyForJob('read');
    let entries: number;
    if (mode === '--enroll') {
        const input = await readInput();
        if (!Array.isArray(input) || input.length !== 225) return unavailable();
        entries = await enrollStandardQaResultProof(policy, destination, input);
    } else {
        entries = (await readStandardQaResultProof(policy, destination)).length;
        if (entries !== 225) return unavailable();
    }
    console.log(JSON.stringify({ status: mode === '--enroll' ? 'enrolled' : 'verified', entries }));
}
main().catch(() => {
    console.error(JSON.stringify({ status:'unavailable', code:'DEV_STANDARD_QA_RESULT_PROOF_UNAVAILABLE' }));
    process.exitCode = 1;
});
