import { withVerifiedDevStandardArchive } from '@/lib/services/dev-ui/standard-archive-runtime';

async function main(): Promise<void> {
    const target = process.env.DEV_LIVE_STANDARD_TARGET;
    if (process.argv.length !== 3 || process.argv[2] !== '--verify' || !target) {
        throw new Error('DEV_STANDARD_ARCHIVE_ARGUMENTS_INVALID');
    }
    await withVerifiedDevStandardArchive(target, coverage => {
        console.log(JSON.stringify({ status: 'verified', profileBatches: coverage.profileBatches.length }));
    });
}

main().catch(() => {
    console.error(JSON.stringify({ status: 'unavailable', code: 'DEV_STANDARD_ARCHIVE_UNAVAILABLE' }));
    process.exitCode = 1;
});
