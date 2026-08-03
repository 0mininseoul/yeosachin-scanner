import { AuthButtons } from '@/components/auth-buttons';
import {
    BrandMark,
    CaseCard,
    Eyebrow,
    Panel,
    TopBar,
} from '@/components/case-ui';

export function BetaTestLanding() {
    return (
        <div className="min-h-dvh">
            <TopBar right={<span className="num text-[10px] tracking-[0.18em] text-blood">BETA</span>} />
            <main data-amp-mask className="mx-auto max-w-[460px] px-5 pb-16 pt-10">
                <Eyebrow>무료 베타 판독</Eyebrow>
                <h1 className="mt-4 text-[30px] font-extrabold leading-[1.18] tracking-tight text-fg">
                    무료 베타 판독을<br />시작하세요
                </h1>
                <p className="mt-4 text-[14px] leading-relaxed text-fg-dim">
                    카카오 로그인 후 분석할 인스타그램 계정을 입력하면 바로 판독을 시작할 수 있어요.
                </p>

                <CaseCard bracket="var(--color-blood)" className="mt-9 overflow-hidden p-5">
                    <div className="flex items-center gap-3 border-b border-line pb-4">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-line bg-ink">
                            <BrandMark className="text-blood" />
                        </div>
                        <div>
                            <p className="eyebrow">BETA ACCESS</p>
                            <p className="mt-1 text-[13px] text-fg-dim">로그인 후 무료 판독 대상 확인</p>
                        </div>
                    </div>
                    <div className="pt-5">
                        <AuthButtons redirectTo="/betatest" />
                    </div>
                </CaseCard>

                <Panel className="mt-5 p-4">
                    <p className="eyebrow text-fg-dim">판독 절차</p>
                    <p className="mt-2 text-[13px] leading-relaxed text-fg-dim">
                        대상 계정 확인 · 내 계정 제외 · 무료 판독 시작
                    </p>
                </Panel>
            </main>
        </div>
    );
}
