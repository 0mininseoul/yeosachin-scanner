'use client';

import { useRouter } from 'next/navigation';
import {
    availablePendingTargetStorage,
    signOutAndClearPendingAnalysisTarget,
} from '@/lib/services/pending-analysis-target';

export function LogoutButton() {
    const router = useRouter();

    const handleLogout = async () => {
        try {
            const signedOut = await signOutAndClearPendingAnalysisTarget(
                availablePendingTargetStorage(),
            );
            if (signedOut) router.push('/');
        } catch (cause) {
            console.error('Logout failed:', cause);
        }
    };

    return (
        <button
            type="button"
            onClick={handleLogout}
            className="text-[13px] font-medium text-fg-dim transition-colors hover:text-fg"
        >
            로그아웃
        </button>
    );
}
