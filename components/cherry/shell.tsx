import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';

export function CherryBar({ link }: { link?: { href: string; label: string } }) {
    return <header className="ch-bar">
        <Link href="/cherry" className="ch-brand" prefetch={false}>
            <Image src="/cherry/logo.png" alt="" width={30} height={30} unoptimized />체리
        </Link>
        {link ? <Link href={link.href} className="ch-bar-link" prefetch={false}>{link.label}</Link> : null}
    </header>;
}

export function CherryFace({ src, name, open }: { src: string | null; name: string; open?: boolean }) {
    if (open) return <span className="ch-face ch-face--open" aria-hidden="true">?</span>;
    return <span className="ch-face">
        {src
            // Member images need a session cookie, so the image optimizer cannot fetch them.
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={src} alt={`${name} 프로필 사진`} loading="lazy" />
            : <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}
    </span>;
}

/** Two accounts on one stem: the mutual follow itself. */
export function CherryPair({ left, right }: { left: ReactNode; right: ReactNode }) {
    return <div className="ch-pair">
        <svg viewBox="0 0 188 150" aria-hidden="true">
            <path d="M42 70C46 40 76 14 108 10M146 56C144 36 130 18 108 10" fill="none" stroke="#5c7a3a" strokeWidth="5" strokeLinecap="round" />
            <path d="M108 10c14-12 34-11 48 0-14 9-33 11-48 0Z" fill="#7a9a4b" />
        </svg>
        {left}
        {right}
    </div>;
}
