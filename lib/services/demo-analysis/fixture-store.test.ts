import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from } }));

import { loadDemoFixtureForVersion } from './fixture-store';
import { createDemoFixture, REDACTED_BIJECTIVE_DEMO_FIXTURE_VERSION } from './demo-analysis';

const version = 'operator-editable-fixture-v1';

function payload() {
    const source = createDemoFixture('fixture-source', REDACTED_BIJECTIVE_DEMO_FIXTURE_VERSION);
    return {
        target: {
            username: 'junho_dem', fullName: '모의 분석용 공개 계정', bio: '산책과 사진을 기록하는 데모 프로필입니다.',
            profileImage: '/demo-avatars/demo-v3-target-000.webp', followersCount: 600, followingCount: 580, isPrivate: false,
        },
        summary: source.summary,
        public: source.publicAccounts,
        private: source.privateAccounts,
    };
}

function v2Payload() {
    const source = createDemoFixture('fixture-source');
    return {
        target: {
            username: 'junho_dem', fullName: '김도윤', bio: null,
            profileImage: '/demo-avatars/demo-v3-target-000.webp', followersCount: 600, followingCount: 580, isPrivate: false,
        },
        summary: source.summary,
        public: source.publicAccounts,
        private: source.privateAccounts,
    };
}

function selectFixture(data: unknown, error: unknown = null) {
    const maybeSingle = vi.fn().mockResolvedValue({ data, error });
    const inStatus = vi.fn().mockReturnValue({ maybeSingle });
    const eqVersion = vi.fn().mockReturnValue({ in: inStatus });
    mocks.from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq: eqVersion }) });
    return { eqVersion, inStatus };
}

describe('database demo fixture loader', () => {
    beforeEach(() => vi.clearAllMocks());

    it('loads the exact published fixture version from the editable table', async () => {
        const chain = selectFixture({ version, status: 'published', payload: payload() });
        const fixture = await loadDemoFixtureForVersion(version);
        expect(fixture).toMatchObject({ version, fixture: { publicAccounts: expect.any(Array), privateAccounts: expect.any(Array) } });
        expect(fixture?.fixture.publicAccounts).toHaveLength(84);
        expect(chain.eqVersion).toHaveBeenCalledWith('version', version);
        expect(chain.inStatus).toHaveBeenCalledWith('status', ['published', 'retired']);
    });

    it('does not fall back to the static v4 fixture when its database version is unavailable', async () => {
        selectFixture(null);
        await expect(loadDemoFixtureForVersion(version)).resolves.toBeNull();
    });

    it('rejects a database payload with an external image URL', async () => {
        const invalid = payload();
        invalid.public[0] = { ...invalid.public[0]!, profileImage: 'https://instagram.example/avatar.jpg' };
        selectFixture({ version, status: 'published', payload: invalid });
        await expect(loadDemoFixtureForVersion(version)).resolves.toBeNull();
    });

    it('rejects external URLs anywhere in editable fixture text', async () => {
        const invalid = payload();
        invalid.target.bio = 'www.example.test';
        selectFixture({ version, status: 'published', payload: invalid });
        await expect(loadDemoFixtureForVersion(version)).resolves.toBeNull();
    });

    it('rejects non-synthetic v2 account bios while retaining the v1 replay schema', async () => {
        const invalid = v2Payload();
        invalid.public[0] = { ...invalid.public[0]!, bio: 'real-looking profile text' };
        selectFixture({ version: 'operator-editable-fixture-v2', status: 'published', payload: invalid });
        await expect(loadDemoFixtureForVersion('operator-editable-fixture-v2')).resolves.toBeNull();
    });

    it('never selects a published v1 payload for a new demo run', async () => {
        const maybeSingle = vi.fn().mockResolvedValue({ data: { version: 'operator-editable-fixture-v1', status: 'published', payload: payload() }, error: null });
        mocks.from.mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle }) }) });
        const { loadPublishedDemoFixture } = await import('./fixture-store');
        await expect(loadPublishedDemoFixture()).resolves.toBeNull();
    });
});
