'use client';

import type { ReactNode } from 'react';
import type { Tone } from './console-data';

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
    return <span className={`ac-chip ac-t-${tone}`}><i aria-hidden="true" />{children}</span>;
}

export function Meter({ ratio, tone = 'accent' }: { ratio: number | null; tone?: Tone | 'accent' }) {
    if (ratio === null) return <span className="ac-meter ac-meter--unknown" aria-hidden="true" />;
    return <span className={`ac-meter ac-m-${tone}`} aria-hidden="true">
        <span style={{ width: `${Math.round(ratio * 100)}%` }} />
    </span>;
}

export function Card({ title, description, actions, children, className = '' }: {
    title?: ReactNode;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    return <section className={`ac-card ${className}`}>
        {title ? <header className="ac-card-h">
            <div><h2>{title}</h2>{description ? <p>{description}</p> : null}</div>
            {actions ? <div className="ac-card-actions">{actions}</div> : null}
        </header> : null}
        {children}
    </section>;
}

export function ErrorNotice({ message, onRetry }: { message: string | null; onRetry?: () => void }) {
    if (!message) return null;
    return <div className="ac-alert" role="alert">
        <span>{message}</span>
        {onRetry ? <button type="button" className="ac-btn ac-btn--sm" onClick={onRetry}>다시 시도</button> : null}
    </div>;
}

export function Loading({ label }: { label: string }) {
    return <p className="ac-loading" role="status">{label}</p>;
}

export function EmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
    return <tr><td colSpan={colSpan} className="ac-empty">{children}</td></tr>;
}

export function Segmented<T extends string>({ label, value, options, onChange }: {
    label: string;
    value: T;
    options: readonly { value: T; label: ReactNode }[];
    onChange: (value: T) => void;
}) {
    return <div className="ac-seg" role="group" aria-label={label}>
        {options.map(option => <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            className={value === option.value ? 'is-on' : undefined}
            onClick={() => onChange(option.value)}
        >{option.label}</button>)}
    </div>;
}

export function BrandMark({ size = 30 }: { size?: number }) {
    return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <rect width="24" height="24" rx="6" fill="#0c0a0b" />
        <circle cx="12" cy="12" r="7.4" stroke="#8a8784" strokeWidth="1.3" />
        <circle cx="12" cy="12" r="3.6" stroke="#f3efe9" strokeWidth="1.3" />
        <path d="M12 3.4v3.3M12 17.3v3.3M3.4 12h3.3M17.3 12h3.3" stroke="#f3efe9" strokeWidth="1.3" strokeLinecap="round" />
        <circle cx="12" cy="12" r="1.5" fill="#e4132a" />
    </svg>;
}
