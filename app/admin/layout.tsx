import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { NOINDEX_ROBOTS } from '@/lib/services/seo/discovery';

export const metadata: Metadata = {
    robots: NOINDEX_ROBOTS,
};

export default function AdminLayout({ children }: { children: ReactNode }) {
    return children;
}
