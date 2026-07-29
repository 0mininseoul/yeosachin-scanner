/**
 * Guard for the one-time privacy hardening that produced the committed demo
 * rasters. The source files are now the immutable output; rerunning a lossy
 * WebP encode would make the script non-deterministic and gradually degrade
 * them. Verify the committed set instead, then require an intentional new
 * migration/tool if the source assets ever need replacing.
 */
import { validateDemoAssetManifest } from '../lib/services/demo-analysis/demo-analysis';

async function blurCommittedDemoAvatars(): Promise<never> {
    await validateDemoAssetManifest();
    throw new Error('Demo avatar privacy blur is already baked; refusing to re-encode committed assets.');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
    blurCommittedDemoAvatars().catch(error => {
        process.stderr.write(`could not bake demo avatar privacy blur: ${String(error)}\n`);
        process.exitCode = 1;
    });
}

export { blurCommittedDemoAvatars };
