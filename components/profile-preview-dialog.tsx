'use client';

import { useEffect, useRef } from 'react';

export interface InternalProfilePreview {
    instagramId: string;
    fullName?: string;
    profileImage?: string;
    bio?: string;
    overview?: string;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
    return [...container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter(element => !element.hasAttribute('hidden'));
}

export function ProfilePreviewDialog({
    profile,
    onClose,
    avatar,
}: {
    profile: InternalProfilePreview;
    onClose: () => void;
    avatar?: React.ReactNode;
}) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        const restoreFocusTo = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        closeButtonRef.current?.focus();

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onClose();
                return;
            }
            if (event.key !== 'Tab' || !dialogRef.current) return;
            const elements = focusableElements(dialogRef.current);
            if (elements.length === 0) {
                event.preventDefault();
                dialogRef.current.focus();
                return;
            }
            const first = elements[0]!;
            const last = elements.at(-1)!;
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            restoreFocusTo?.focus();
        };
    }, [onClose]);

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/80 p-5">
            <div
                ref={dialogRef}
                className="w-full max-w-sm border border-line bg-ink-2 p-5 shadow-2xl"
                role="dialog"
                aria-modal="true"
                aria-labelledby="profile-preview-title"
                tabIndex={-1}
            >
                <div data-amp-block className="flex items-start gap-3">
                    {avatar && <div className="relative h-12 w-12 shrink-0 overflow-hidden border border-line bg-panel">{avatar}</div>}
                    <div className="min-w-0 flex-1">
                        <p id="profile-preview-title" className="truncate text-[15px] font-bold text-fg">@{profile.instagramId}</p>
                        {profile.fullName && <p className="mt-0.5 text-[12px] text-fg-dim">{profile.fullName}</p>}
                    </div>
                    <button ref={closeButtonRef} type="button" onClick={onClose} aria-label="프로필 정보 닫기" className="text-[12px] font-bold text-fg-dim hover:text-fg">닫기</button>
                </div>
                {(profile.bio || profile.overview) && (
                    <p data-amp-block className="mt-4 text-[12px] leading-relaxed text-fg-dim">{profile.overview || profile.bio}</p>
                )}
            </div>
        </div>
    );
}
