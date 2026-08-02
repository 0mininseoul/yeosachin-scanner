import { redirect } from 'next/navigation';
import { BetaTestClient } from './betatest-client';
import { createClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    betaTestFreePoolEnabled,
    ensureBetaTestAccess,
} from '@/lib/services/analysis/betatest-access';

function unavailablePage() {
    return (
        <main className="mx-auto flex min-h-dvh max-w-[500px] items-center px-5">
            <section className="w-full border border-line bg-ink p-6 text-center">
                <p className="text-[15px] font-semibold text-fg">베타 테스트를 이용할 수 없습니다.</p>
                <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
                    이용 가능 여부를 확인한 뒤 다시 시도해주세요.
                </p>
            </section>
        </main>
    );
}

export default async function BetaTestPage() {
    const supabase = await createClient();
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
        redirect('/login?redirectTo=%2Fbetatest');
    }

    if (!betaTestFreePoolEnabled() || !await ensureBetaTestAccess(supabaseAdmin, user.id)) {
        return unavailablePage();
    }

    return <BetaTestClient />;
}
