import { CHERRY_EVENTS, initAmplitude, markAnalyticsIdentityReady, trackEvent } from './analytics';
import { createClient } from '../supabase/client';
import { inject } from '@vercel/analytics';
import { isDevUiTelemetryDisabled } from '../constants/dev-ui';

if (!isDevUiTelemetryDisabled()) inject();

// Resolve the same user identity as the main app before initializing the shared SDK.
// This preserves a signed-in visitor's existing analytics identity.
void (async () => {
    try {
        const { data: { user } } = await createClient().auth.getUser();
        if (await initAmplitude(user?.id ?? null)) markAnalyticsIdentityReady();
    } catch {
        // Tracking is best-effort and must not affect reservations.
    }
})();
trackEvent(CHERRY_EVENTS.VIEWED);

document.addEventListener('click', event => {
    const target = event.target;
    if (target instanceof Element && target.closest('a[href="#waitlist"]')) {
        trackEvent(CHERRY_EVENTS.CTA_CLICKED);
    }
});
window.addEventListener('cherry-reservation-submitted', () => trackEvent(CHERRY_EVENTS.RESERVATION_SUBMITTED));
window.addEventListener('cherry-reservation-completed', () => trackEvent(CHERRY_EVENTS.RESERVATION_COMPLETED));
