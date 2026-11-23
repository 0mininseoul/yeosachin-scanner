import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';
import './cherry.css';

export const metadata: Metadata = {
    ...NOINDEX_METADATA,
    title: '체리 · 남친 맞팔 알리미',
    description: '등록한 공개 계정의 새 맞팔을 확인해 알려드려요.',
    openGraph: null,
    twitter: null,
    manifest: null,
    icons: { icon: '/cherry/logo.png', apple: '/cherry/logo.png' },
};
export const viewport: Viewport = { themeColor: '#fcfaf6', width: 'device-width', initialScale: 1 };

export default function CherryLayout({ children }: { children: ReactNode }) {
    return <div className="ch-app">{children}</div>;
}
