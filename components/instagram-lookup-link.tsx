'use client';

const IOS_INSTAGRAM_URL = 'instagram://app';
const ANDROID_INSTAGRAM_URL = 'intent://instagram.com/#Intent;scheme=https;package=com.instagram.android;end';

export function InstagramLookupLink() {
    const openInstagramApp = () => {
        const isAndroid = /android/i.test(navigator.userAgent);
        window.location.assign(isAndroid ? ANDROID_INSTAGRAM_URL : IOS_INSTAGRAM_URL);
    };

    return (
        <button
            type="button"
            onClick={openInstagramApp}
            className="group flex min-h-10 items-center justify-end gap-1.5 px-1 text-[12px] text-fg-mute transition-colors hover:text-fg-dim focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blood"
        >
            <span>아이디가 기억 안 나나요?</span>
            <span className="font-semibold text-fg-dim transition-colors group-hover:text-blood">
                Instagram에서 찾기
                <span
                    aria-hidden="true"
                    className="ml-1 inline-block transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
                >
                    ↗
                </span>
            </span>
        </button>
    );
}
