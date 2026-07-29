import { describe, expect, it } from 'vitest';

import { blurCommittedDemoAvatars } from './blur-demo-v3-avatars';

describe('committed demo avatar privacy hardening', () => {
    it('refuses a rerun after verifying the already-baked assets', async () => {
        await expect(blurCommittedDemoAvatars()).rejects.toThrow(/already baked/i);
    });
});
