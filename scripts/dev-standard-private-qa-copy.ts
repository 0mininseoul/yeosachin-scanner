import { createDevStandardArchiveStore } from '@/lib/services/dev-ui/standard-archive-store';
import { openStandardQaCopyForJob, verifyExpiredStandardQaCopy } from '@/lib/services/dev-ui/standard-qa-copy-cloud';
import { exportStandardQaCopy, withVerifiedStandardQaCopy } from '@/lib/services/dev-ui/standard-qa-copy';

function required(name: string) {
    const value = process.env[name];
    if (!value) throw new Error('QA_COPY_CONFIGURATION_INVALID');
    return value;
}

async function main() {
    const command = process.argv[2];
    if (process.argv.length === 3 && (command === '--verify-revoked' || command === '--verify-deleted')) {
        const mode = command === '--verify-revoked' ? 'revoked' : 'deleted';
        const status = await verifyExpiredStandardQaCopy(mode);
        console.log(JSON.stringify({ status }));
        if (status === 'versions_absent_soft_delete_unverified') process.exitCode = 2;
        return;
    }
    if ((command !== '--export' && command !== '--verify') || process.argv.length !== 3) {
        throw new Error('QA_COPY_ARGUMENT_INVALID');
    }
    const { destination, policy } = await openStandardQaCopyForJob(command === '--export' ? 'export' : 'read');
    if (command === '--export') {
        const source = createDevStandardArchiveStore({
            bucketName: required('DEV_LIVE_STANDARD_ARCHIVE_BUCKET'), slot: required('DEV_LIVE_STANDARD_ARCHIVE_SLOT'),
            key: required('DEV_LIVE_STANDARD_ARCHIVE_KEY'),
        });
        const result = await exportStandardQaCopy(policy, source, destination);
        console.log(JSON.stringify({ status: 'copied', ...result }));
    }
    await withVerifiedStandardQaCopy(policy, destination, coverage => {
        console.log(JSON.stringify({ status: 'verified', profileBatches: coverage.profileBatches.length }));
    });
}
main().catch(() => {
    console.error(JSON.stringify({ status: 'unavailable', code: 'DEV_STANDARD_QA_COPY_UNAVAILABLE' }));
    process.exitCode = 1;
});
