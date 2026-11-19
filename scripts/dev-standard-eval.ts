import { createDevStandardEvalStore } from '@/lib/services/dev-ui/standard-eval-store';
import {
    generateDevStandardEvalFeature,
    runDevStandardEval,
} from '@/lib/services/dev-ui/standard-eval-runner';

async function main() {
    const [command, ...rest] = process.argv.slice(2);
    if (rest.length || (command !== '--status' && command !== '--compare')) {
        throw new Error('DEV_STANDARD_EVAL_INVALID_COMMAND');
    }
    const {
        DEV_LIVE_STANDARD_EVAL_BUCKET: bucketName,
        DEV_LIVE_STANDARD_EVAL_SLOT: slot,
        DEV_LIVE_STANDARD_EVAL_KEY: key,
    } = process.env;
    if (!bucketName || !slot || !key) throw new Error('DEV_STANDARD_EVAL_CONFIG_INVALID');
    const store = createDevStandardEvalStore({ bucketName, slot, key });
    const bundle = await store.load();
    if (!bundle) {
        console.log(JSON.stringify({ status: 'capture_pending' }));
        if (command === '--compare') process.exitCode = 1;
        return;
    }
    if (command === '--status') {
        console.log(JSON.stringify({ status: 'capture_ready', candidates: bundle.candidates.length }));
        return;
    }
    if (process.env.GOOGLE_CLOUD_PROJECT !== 'gen-lang-client-0311522474'
        || process.env.GOOGLE_CLOUD_LOCATION !== 'global') {
        throw new Error('DEV_STANDARD_EVAL_VERTEX_CONFIG_INVALID');
    }
    // This command emits one safe receipt. Existing SDK and worker debug logs
    // are irrelevant to the offline evaluation and must stay out of the receipt.
    const { debug, error, info, log, warn } = console;
    const quiet = () => undefined;
    Object.assign(console, { debug: quiet, error: quiet, info: quiet, log: quiet, warn: quiet });
    try {
        const result = await runDevStandardEval({
            bundle,
            generate: generateDevStandardEvalFeature,
            beforeDispatch: async () => {
                if (!await store.claimEvaluation()) throw new Error('DEV_STANDARD_EVAL_ALREADY_STARTED');
            },
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
        Object.assign(console, { debug, error, info, log, warn });
    }
}

main().catch(error => {
    const code = error instanceof Error && /^DEV_STANDARD_EVAL_[A-Z_]{1,64}$/.test(error.message)
        ? error.message : 'DEV_STANDARD_EVAL_FAILED';
    console.error(JSON.stringify({ status: 'failed', code }));
    process.exitCode = 1;
});
