import { AuthButtons } from '@/components/auth-buttons';

export function CherrySignIn({ title, lead, redirectTo }: { title: string; lead: string; redirectTo: string }) {
    return <>
        <h1 className="ch-title">{title}</h1>
        <p className="ch-lead">{lead}</p>
        <div className="ch-form ch-kakao"><AuthButtons redirectTo={redirectTo} kakaoLabel="카카오로 로그인하기" /></div>
    </>;
}
