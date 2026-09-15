import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    logout: vi.fn(),
    push: vi.fn(),
    storage: {},
}));

vi.mock('next/navigation', () => ({
    useRouter: () => ({ push: mocks.push }),
}));
vi.mock('@/lib/services/pending-analysis-target', () => ({
    availablePendingTargetStorage: () => mocks.storage,
    signOutAndClearPendingAnalysisTarget: mocks.logout,
}));

import { LogoutButton } from '@/components/logout-button';

type LogoutButtonElement = ReactElement<{
    onClick: () => Promise<void>;
}>;

describe('LogoutButton', () => {
    beforeEach(() => {
        mocks.logout.mockReset();
        mocks.push.mockReset();
    });

    it('does not navigate when browser sign out fails', async () => {
        mocks.logout.mockResolvedValue(false);
        const button = LogoutButton() as LogoutButtonElement;

        await button.props.onClick();

        expect(mocks.logout).toHaveBeenCalledWith(mocks.storage);
        expect(mocks.push).not.toHaveBeenCalled();
    });

    it('waits for successful identity cleanup before navigating home', async () => {
        let resolveLogout!: (success: boolean) => void;
        mocks.logout.mockReturnValue(new Promise<boolean>((resolve) => {
            resolveLogout = resolve;
        }));
        const button = LogoutButton() as LogoutButtonElement;

        const click = button.props.onClick();
        expect(mocks.push).not.toHaveBeenCalled();

        resolveLogout(true);
        await click;

        expect(mocks.push).toHaveBeenCalledWith('/');
    });
});
