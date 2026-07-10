import { TopBar, Eyebrow } from '@/components/case-ui';

export default function TermsPage() {
    return (
        <div className="min-h-dvh">
            <TopBar />
            <main className="mx-auto max-w-[640px] px-5 py-10">
                <Eyebrow>법적 고지</Eyebrow>
                <h1 className="mt-3 text-[26px] font-extrabold tracking-tight text-fg">이용약관</h1>

                <div className="mt-8 space-y-6 text-[13px] leading-relaxed text-fg-dim [&_strong]:mb-1.5 [&_strong]:block [&_strong]:font-bold [&_strong]:text-fg">
                    <p>
                        <strong>제1조 (목적)</strong>
                        본 약관은 AI 위장 여사친 판독기(이하 &ldquo;회사&rdquo;)가 제공하는 서비스(이하 &ldquo;서비스&rdquo;)의 이용조건 및 절차, 회사와 회원 간의 권리, 의무 및 책임사항 등을 규정함을 목적으로 합니다.
                    </p>

                    <p>
                        <strong>제2조 (용어의 정의)</strong>
                        1. &ldquo;서비스&rdquo;란 회사가 제공하는 AI 기반 인스타그램 계정 분석 서비스를 의미합니다.
                        <br />2. &ldquo;이용자&rdquo;란 본 약관에 따라 회사가 제공하는 서비스를 이용하는 회원을 말합니다.
                    </p>

                    <p>
                        <strong>제3조 (서비스의 제공 및 변경)</strong>
                        1. 회사는 AI 기술을 활용하여 입력된 인스타그램 계정의 공개된 정보를 분석하고 리포트를 제공합니다.
                        <br />2. 분석 결과는 AI의 확률적 판단에 근거하며, 실제 사실과 다를 수 있습니다. 회사는 분석 결과의 정확성을 보증하지 않습니다.
                    </p>

                    <p>
                        <strong>제4조 (면책조항)</strong>
                        1. 본 서비스의 분석 결과는 재미와 참고 목적으로만 제공됩니다.
                        <br />2. 회사는 서비스 이용으로 인해 발생하는 이용자 간의 분쟁이나 오해, 피해에 대해 어떠한 법적 책임도 지지 않습니다.
                        <br />3. 이용자는 분석 결과를 타인의 명예를 훼손하거나 불법적인 목적으로 사용해서는 안 됩니다.
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
