import Link from 'next/link';
import { CherryBar } from '@/components/cherry/shell';

export default function CherryNotFound() {
    return <main className="ch-column">
        <CherryBar />
        <h1 className="ch-title">볼 수 없는 페이지예요</h1>
        <p className="ch-lead">리포트는 알림을 받은 카카오 계정으로 로그인해야 볼 수 있어요.</p>
        <div className="ch-form"><Link href="/cherry/home" className="ch-button">내 서비스로 가기</Link></div>
    </main>;
}
