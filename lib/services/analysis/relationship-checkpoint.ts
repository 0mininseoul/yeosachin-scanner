import { z } from 'zod';
import { INSTAGRAM_USERNAME_PATTERN } from '@/lib/services/instagram/username';
import type { InstagramFollower } from '@/lib/types/instagram';

const followerSchema = z.object({
    username: z.string().trim().toLowerCase().regex(INSTAGRAM_USERNAME_PATTERN),
    fullName: z.string().max(200).optional(),
    profilePicUrl: z.string().min(1).max(8_192).optional(),
    isPrivate: z.boolean(),
    isVerified: z.boolean(),
}).strict();

const checkpointSchema = z.object({
    followers: z.array(followerSchema).max(1_000).optional(),
    following: z.array(followerSchema).max(1_000).optional(),
}).strict().refine(
    value => value.followers !== undefined || value.following !== undefined,
    'At least one relationship list must be checkpointed.'
);

export interface RelationshipCheckpoint {
    followers?: InstagramFollower[];
    following?: InstagramFollower[];
}

export function parseRelationshipCheckpoint(
    value: unknown,
    maximumPerList: number
): RelationshipCheckpoint | null {
    if (value === undefined || value === null) return null;
    if (!Number.isSafeInteger(maximumPerList) || maximumPerList < 1 || maximumPerList > 1_000) {
        throw new Error('ANALYSIS_CHECKPOINT_ERROR: invalid relationship checkpoint limit.');
    }
    const parsed = checkpointSchema.safeParse(value);
    if (
        !parsed.success
        || (parsed.data.followers?.length ?? 0) > maximumPerList
        || (parsed.data.following?.length ?? 0) > maximumPerList
    ) {
        throw new Error('ANALYSIS_CHECKPOINT_ERROR: relationship checkpoint is invalid.');
    }
    return parsed.data;
}
