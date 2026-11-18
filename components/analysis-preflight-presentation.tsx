import Image from 'next/image';
import { BrandMark, CaseCard, Eyebrow, Panel, PrimaryButton } from '@/components/case-ui';
import type { PreflightStatusV1 } from '@/lib/contracts/analysis-v2';

export function AnalysisTargetHeading() {
    return <>
        <Eyebrow>판독 의뢰서 · 대상 지정</Eyebrow>
        <h1 className="mt-3 text-[26px] font-extrabold leading-snug text-fg">
            누구를 판독할까요?
        </h1>
        <p className="mt-2 text-[14px] text-fg-dim">
            남자친구의 인스타그램 아이디를 입력해주세요.
        </p>
    </>;
}

interface AnalysisInstagramInputProps {
    id: string;
    label: string;
    labelClassName?: string;
    placeholder: string;
    value: string;
    onChange: (value: string) => void;
    onEnter?: () => void;
}

export function AnalysisInstagramInput({
    id, label, labelClassName = 'eyebrow mb-3 block', placeholder, value, onChange, onEnter,
}: AnalysisInstagramInputProps) {
    return <>
        <label htmlFor={id} className={labelClassName}>
            {label}
        </label>
        <div className="relative" data-amp-mask>
            <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-fg-dim">@</span>
            <input
                id={id}
                type="text"
                value={value}
                onChange={event => onChange(event.target.value)}
                onKeyDown={event => {
                    if (event.key === 'Enter') onEnter?.();
                }}
                placeholder={placeholder}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className="w-full border border-line bg-ink py-3.5 pl-9 pr-4 text-[15px] text-fg placeholder-fg-mute transition-colors focus:border-blood focus:outline-none"
            />
        </div>
    </>;
}

interface AnalysisPreflightHeadingProps {
    exclusionDecided: boolean;
    ready: boolean;
    bliteResultShown: boolean;
    onChangeTarget: () => void;
}

export function AnalysisPreflightHeading({
    exclusionDecided, ready, bliteResultShown, onChangeTarget,
}: AnalysisPreflightHeadingProps) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div>
                {!bliteResultShown && (
                    <Eyebrow>{exclusionDecided ? '판독 의뢰서 · 대상 확인' : '판독 의뢰서 · 본인 제외'}</Eyebrow>
                )}
                <h1 className={`${bliteResultShown ? '' : 'mt-3 '}text-[24px] font-extrabold leading-snug text-fg`}>
                    {!exclusionDecided
                        ? '본인 계정은 먼저 제외해주세요'
                        : ready
                            ? '판독 대상을 확인했어요'
                            : '대상 계정을 확인하고 있어요'}
                </h1>
            </div>
            <button
                type="button"
                onClick={onChangeTarget}
                className="shrink-0 text-[12px] font-medium text-fg-mute underline underline-offset-4 hover:text-fg"
            >
                대상 변경
            </button>
        </div>
    );
}

interface AnalysisExclusionPanelProps {
    value: string;
    onChange: (value: string) => void;
    onExclude: () => void;
    onSkip: () => void;
    saving: boolean;
    disabled?: boolean;
    error?: string | null;
}

export function AnalysisExclusionPanel({
    value, onChange, onExclude, onSkip, saving, disabled = false, error,
}: AnalysisExclusionPanelProps) {
    return (
        <Panel className="mt-6 p-5">
            <p className="text-[13px] leading-relaxed text-fg-dim">
                본인 계정은 위장여사친 후보에서 처음부터 제외합니다.
            </p>
            <AnalysisInstagramInput
                id="girlfriend-instagram"
                label="본인 인스타그램 아이디"
                labelClassName="eyebrow mb-3 mt-4 block"
                value={value}
                onChange={onChange}
                onEnter={() => {
                    if (!disabled && !saving) onExclude();
                }}
                placeholder="my_username"
            />
            {error && (
                <p data-amp-mask className="mt-4 border-l-2 border-blood pl-3 text-[13px] leading-relaxed text-blood-2" role="alert">
                    {error}
                </p>
            )}
            <div className="mt-5 space-y-2.5">
                <PrimaryButton
                    onClick={onExclude}
                    disabled={!value.trim() || saving || disabled}
                >
                    {saving ? '제외 계정 저장 중…' : '내 계정 제외하기'}
                </PrimaryButton>
                <button
                    type="button"
                    onClick={onSkip}
                    disabled={saving || disabled}
                    className="w-full border border-line-2 px-4 py-3 text-[13px] font-bold text-fg-dim transition-colors hover:bg-panel hover:text-fg disabled:opacity-50"
                >
                    본인 계정 제외 안 함
                </button>
            </div>
        </Panel>
    );
}

type ReadyTarget = Extract<PreflightStatusV1, { status: 'ready' }>['target'];

export function AnalysisTargetCard({ target }: { target: ReadyTarget }) {
    return (
        <CaseCard
            bracket="var(--color-blood)"
            className="mt-7 overflow-hidden"
            data-precheckout-target-card
        >
            <div className="flex items-start gap-4 p-5" data-amp-block>
                <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-full border border-line-2 bg-panel">
                    {target.profileImage ? (
                        <Image
                            src={target.profileImage}
                            alt={`@${target.username} 프로필`}
                            fill
                            sizes="64px"
                            unoptimized
                            className="object-cover"
                        />
                    ) : (
                        <div className="flex h-full w-full items-center justify-center">
                            <BrandMark size={25} className="text-fg-mute" />
                        </div>
                    )}
                </div>
                <div className="min-w-0 flex-1">
                    <span className="eyebrow">판독 대상 확인</span>
                    <h2 className="mt-1 truncate text-[19px] font-extrabold text-fg">
                        @{target.username}
                    </h2>
                    {target.fullName && (
                        <p className="mt-0.5 truncate text-[13px] text-fg-dim">
                            {target.fullName}
                        </p>
                    )}
                    {target.bio && (
                        <p className="mt-1.5 line-clamp-2 whitespace-pre-line text-[12px] leading-relaxed text-fg-mute">
                            {target.bio}
                        </p>
                    )}
                </div>
            </div>
            <div className="grid grid-cols-2 border-t border-line">
                <div className="border-r border-line px-4 py-3 text-center">
                    <p className="num text-[17px] font-extrabold text-fg">
                        {target.followersCount.toLocaleString('ko-KR')}
                    </p>
                    <p className="mt-0.5 text-[11px] text-fg-mute">팔로워</p>
                </div>
                <div className="px-4 py-3 text-center">
                    <p className="num text-[17px] font-extrabold text-fg">
                        {target.followingCount.toLocaleString('ko-KR')}
                    </p>
                    <p className="mt-0.5 text-[11px] text-fg-mute">팔로잉</p>
                </div>
            </div>
        </CaseCard>
    );
}
