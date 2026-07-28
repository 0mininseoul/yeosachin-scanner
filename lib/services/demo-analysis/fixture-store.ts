import 'server-only';

import { z } from 'zod';
import {
    analysisResultSummaryV1Schema,
    femaleResultRowV1Schema,
    privateResultRowV1Schema,
} from '@/lib/contracts/analysis-v2';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    AUTHORIZED_TEXT_DEMO_FIXTURE_VERSION,
    createDemoFixture,
    DEMO_FIXTURE_VERSION,
    LEGACY_DEMO_FIXTURE_VERSION,
    REDACTED_DEMO_FIXTURE_VERSION,
    type DemoFixture,
} from './demo-analysis';

const localDemoImage = z.string().regex(/^\/demo-avatars\/demo-v3-(?:target|female|private)-\d{3}\.webp$/);
const targetSchema = z.object({
    username: z.literal('junho_dem'),
    fullName: z.string().max(200).nullable(),
    bio: z.string().max(2_200).nullable(),
    profileImage: localDemoImage,
    followersCount: z.number().int().nonnegative(),
    followingCount: z.number().int().nonnegative(),
    isPrivate: z.literal(false),
}).strict();

export const demoFixturePayloadSchema = z.object({
    target: targetSchema,
    summary: analysisResultSummaryV1Schema.superRefine((value, context) => {
        if (value.targetInstagramId !== 'junho_dem') context.addIssue({ code: 'custom', message: 'fixture target must be junho_dem' });
        if (!localDemoImage.safeParse(value.targetProfileImage).success) context.addIssue({ code: 'custom', message: 'fixture summary image must be local' });
    }),
    public: z.array(femaleResultRowV1Schema).length(84),
    private: z.array(privateResultRowV1Schema).length(145),
}).strict().superRefine((value, context) => {
    const all = [...value.public, ...value.private];
    const identifiers = new Set<string>();
    all.forEach((account, index) => {
        if (!localDemoImage.safeParse(account.profileImage).success) {
            context.addIssue({ code: 'custom', path: [index < value.public.length ? 'public' : 'private', index], message: 'fixture images must be local blurred avatars' });
        }
        if (identifiers.has(account.instagramId)) context.addIssue({ code: 'custom', message: 'fixture Instagram IDs must be unique across public and private accounts' });
        identifiers.add(account.instagramId);
    });
    if (value.summary.publicMutuals !== 84 || value.summary.privateMutuals !== 145 || value.summary.screenedMutuals !== 84) {
        context.addIssue({ code: 'custom', message: 'fixture summary counts do not match its lists' });
    }
}).superRefine((value, context) => {
    // Dashboard text is presentation data; do not let it turn into an external link.
    if (/(?:https?:\/\/|www\.)/iu.test(JSON.stringify(value))) {
        context.addIssue({ code: 'custom', message: 'fixture payload contains an external URL' });
    }
});

export type DatabaseDemoFixture = Readonly<{
    version: string;
    target: z.infer<typeof targetSchema>;
    fixture: DemoFixture;
    payload?: z.infer<typeof demoFixturePayloadSchema>;
}>;

const staticVersions = new Set<string>([
    LEGACY_DEMO_FIXTURE_VERSION,
    AUTHORIZED_TEXT_DEMO_FIXTURE_VERSION,
    REDACTED_DEMO_FIXTURE_VERSION,
    DEMO_FIXTURE_VERSION,
]);

function staticFixture(version: string): DatabaseDemoFixture | null {
    if (!staticVersions.has(version)) return null;
    const fixture = createDemoFixture('historical-replay', version as typeof DEMO_FIXTURE_VERSION);
    return {
        version,
        target: {
            username: 'junho_dem', fullName: version === LEGACY_DEMO_FIXTURE_VERSION ? '준호의 공개 프로필' : '모의 분석용 공개 계정',
            bio: version === LEGACY_DEMO_FIXTURE_VERSION ? '사진과 일상을 기록하는 공개 프로필입니다.' : '산책과 사진을 기록하는 데모 프로필입니다.',
            profileImage: version === LEGACY_DEMO_FIXTURE_VERSION ? '/demo-avatars/synthetic-blurred-avatar-1-v1.png' : '/demo-avatars/demo-v3-target-000.webp',
            followersCount: 600, followingCount: 580, isPrivate: false,
        },
        fixture,
    };
}

/** A non-static version is authoritative only when its immutable DB row validates. */
export async function loadDemoFixtureForVersion(version: string): Promise<DatabaseDemoFixture | null> {
    const legacy = staticFixture(version);
    if (legacy) return legacy;
    const { data, error } = await supabaseAdmin
        .from('demo_analysis_fixtures')
        .select('version, status, payload')
        .eq('version', version)
        .in('status', ['published', 'retired'])
        .maybeSingle();
    if (error || !data || typeof data !== 'object') return null;
    const row = data as { version?: unknown; status?: unknown; payload?: unknown };
    if (row.version !== version || (row.status !== 'published' && row.status !== 'retired')) return null;
    const parsed = demoFixturePayloadSchema.safeParse(row.payload);
    if (!parsed.success) return null;
    return {
        version,
        target: parsed.data.target,
        fixture: { version, summary: parsed.data.summary, publicAccounts: parsed.data.public, privateAccounts: parsed.data.private },
        payload: parsed.data,
    };
}

export async function loadPublishedDemoFixture(): Promise<DatabaseDemoFixture | null> {
    const { data, error } = await supabaseAdmin.from('demo_analysis_fixtures')
        .select('version, status, payload').eq('status', 'published').maybeSingle();
    if (error || !data || typeof data !== 'object') return null;
    const row = data as { version?: unknown; status?: unknown; payload?: unknown };
    if (typeof row.version !== 'string' || row.status !== 'published') return null;
    const parsed = demoFixturePayloadSchema.safeParse(row.payload);
    return parsed.success ? {
        version: row.version, target: parsed.data.target,
        fixture: { version: row.version, summary: parsed.data.summary, publicAccounts: parsed.data.public, privateAccounts: parsed.data.private }, payload: parsed.data,
    } : null;
}
