export * from '@/lib/services/instagram/providers/selfhosted';
import { profileItem, target } from '../../tests/analysis/execution/fixtures/standard-providers';
import { qaDelivery } from './scope';

export async function getSelfHostedProfileSummary(name: string) {
    qaDelivery();
    if (name !== target) throw new Error('DEV_STANDARD_QA_PROFILE_OUTSIDE_FIXTURE');
    const item = profileItem(target, 1, 601);
    return { username: target, followersCount: item.followersCount, followingCount: item.followsCount, postsCount: item.postsCount,
        isPrivate: false, isVerified: false, fullName: item.fullName, bio: item.biography, profilePicUrl: item.profilePicUrl };
}
export const getSelfHostedAdmissionProfileSummary = getSelfHostedProfileSummary;
