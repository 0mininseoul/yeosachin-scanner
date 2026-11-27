'use client';

import { createContext, useActionState, useContext, useId, useState, type ReactNode } from 'react';
import { signInForCherryReview, signInForPgReview } from '@/app/login/pg-review/actions';
import { CHERRY_REVIEW_CHECKOUT_URL } from '@/lib/constants/cherry-public-url';
import { PrimaryButton } from './case-ui';

const EmailLoginContext = createContext(false);
const inputClass = 'mt-1.5 min-h-11 w-full border border-line bg-ink px-3 text-sm text-fg';

export function EmailLoginAvailability({ enabled, children }: { enabled: boolean; children: ReactNode }) {
    return <EmailLoginContext.Provider value={enabled}>{children}</EmailLoginContext.Provider>;
}

const emailButtonStyle = 'min-h-12 w-full border border-line bg-ink px-4 py-3.5 text-sm font-bold text-fg transition-colors hover:border-fg-dim';

export function CherryReviewEmailLink() {
    if (!useContext(EmailLoginContext)) return null;
    return <a href={CHERRY_REVIEW_CHECKOUT_URL} className={`mt-2.5 block text-center ${emailButtonStyle}`}>이메일로 로그인</a>;
}

export function EmailLogin({ product = 'analyzer', initiallyExpanded = false }: {
    product?: 'analyzer' | 'cherry';
    initiallyExpanded?: boolean;
} = {}) {
    const enabled = useContext(EmailLoginContext);
    const [expanded, setExpanded] = useState(initiallyExpanded);
    const formId = useId();
    const isCherry = product === 'cherry';
    const [error, signIn, pending] = useActionState(
        (_previous: string | null, form: FormData) => isCherry ? signInForCherryReview(form) : signInForPgReview(form),
        null,
    );

    if (!enabled) return null;

    return (
        <div className="mt-2.5">
            {!initiallyExpanded && <button
                type="button"
                aria-expanded={expanded}
                aria-controls={formId}
                disabled={pending}
                onClick={() => setExpanded(!expanded)}
                className={emailButtonStyle}
            >
                이메일로 로그인
            </button>}
            <form id={formId} action={signIn} hidden={!expanded} data-amp-mask className="mt-4 space-y-3">
                <label className={isCherry ? 'ch-checkout-field' : 'block text-sm text-fg'}>
                    이메일
                    <input name="email" type="email" autoComplete="username" maxLength={254}
                        required className={isCherry ? 'ch-input' : inputClass} />
                </label>
                <label className={isCherry ? 'ch-checkout-field' : 'block text-sm text-fg'}>
                    비밀번호
                    <input name="password" type="password" autoComplete="current-password" maxLength={256}
                        required className={isCherry ? 'ch-input' : inputClass} />
                </label>
                {error && <p role="alert" className={isCherry ? 'ch-error' : 'text-sm text-blood'}>{error}</p>}
                {isCherry
                    ? <button type="submit" className="ch-button" disabled={pending}>{pending ? '로그인 중…' : '로그인'}</button>
                    : <PrimaryButton type="submit" disabled={pending}>{pending ? '로그인 중…' : '로그인'}</PrimaryButton>}
            </form>
        </div>
    );
}
