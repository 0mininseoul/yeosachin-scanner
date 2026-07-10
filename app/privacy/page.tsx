import { TopBar, Eyebrow } from '@/components/case-ui';

export default function PrivacyPage() {
    return (
        <div className="min-h-dvh">
            <TopBar />
            <main className="mx-auto max-w-[640px] px-5 py-10">
                <Eyebrow>법적 고지</Eyebrow>
                <h1 className="mt-3 text-[26px] font-extrabold tracking-tight text-fg">개인정보처리방침</h1>

                <div className="mt-8 space-y-6 text-[13px] leading-relaxed text-fg-dim [&_strong]:mb-1.5 [&_strong]:block [&_strong]:font-bold [&_strong]:text-fg">
                    <p>
                        <strong>1. 개인정보의 수집 항목 및 목적</strong>
                        회사는 서비스 제공을 위해 최소한의 개인정보를 수집합니다.
                        <br />- 수집 항목: (로그인 시) 이메일 주소, 프로필 사진, 닉네임 / (분석 시) 입력된 인스타그램 ID
                        <br />- 수집 목적: 서비스 제공, 회원 식별, 분석 결과 생성 및 관리
                    </p>

                    <p>
                        <strong>2. 개인정보의 보유 및 이용 기간</strong>
                        이용자의 개인정보는 서비스 이용 목적이 달성된 후 지체 없이 파기합니다. 단, 관계 법령에 따라 보존할 필요가 있는 경우 해당 기간 동안 보관합니다.
                    </p>

                    <p>
                        <strong>3. 제3자 제공</strong>
                        회사는 이용자의 동의 없이 개인정보를 외부에 제공하지 않습니다. 단, AI 분석을 위해 입력된 공개 인스타그램 데이터는 LLM(Gemini) 처리에 활용될 수 있습니다.
                    </p>

                    <p>
                        <strong>4. 이용자의 권리</strong>
                        이용자는 언제든지 자신의 개인정보 조회를 요청하거나 회원 탈퇴를 통해 개인정보 수집 이용 동의를 철회할 수 있습니다.
                    </p>

                    <p className="border-t border-line pt-5 text-[12px] text-fg-mute">
                        공고일자: 2026년 1월 23일
                        <br />시행일자: 2026년 1월 23일
                    </p>
                </div>
            </main>
        </div>
    );
}
