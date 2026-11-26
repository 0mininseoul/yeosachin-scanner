import type { NextRequest } from 'next/server';
import { serveCherryLanding } from '@/lib/services/cherry/public-landing';

export function GET(request: NextRequest) {
    return serveCherryLanding(request, true);
}
