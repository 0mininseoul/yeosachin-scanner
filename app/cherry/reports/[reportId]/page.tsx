import { notFound } from 'next/navigation';
import { z } from 'zod';
import { CherryReportView } from '@/components/cherry/report-view';
import { CherryBar } from '@/components/cherry/shell';
import { CherrySignIn } from '@/components/cherry/sign-in';
import { loadMemberReport } from '@/lib/services/cherry/member';
import { cherryUser } from '@/lib/services/cherry/session';

export const dynamic = 'force-dynamic';

export default async function CherryReportPage({ params }: { params: Promise<{ reportId: string }> }) {
    const { reportId } = await params;
    if (!z.string().uuid().safeParse(reportId).success) notFound();
    const user = await cherryUser();
    if (!user) {
        return <main className="ch-column">
            <CherryBar />
            <CherrySignIn title="새 맞팔 리포트" lead="알림을 받은 카카오 계정으로 로그인하면 볼 수 있어요." redirectTo={`/cherry/reports/${reportId}`} />
        </main>;
    }
    const data = await loadMemberReport(reportId, user.id);
    if (!data) notFound();
    return <div className="ch-report"><main className="ch-column">
        <CherryBar link={{ href: '/cherry/home', label: '내 서비스' }} />
        <CherryReportView data={data} imagePath={(eventId, index) => `/api/cherry/images/${eventId}/${index}`} />
    </main></div>;
}
