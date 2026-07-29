import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NOINDEX_METADATA } from '@/lib/services/seo/discovery';

export const metadata: Metadata = NOINDEX_METADATA;

export default function LoginLayout({ children }: { children: ReactNode }) {
    return children;
}
