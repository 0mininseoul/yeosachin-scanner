import { CHERRY_EVENTS, initAmplitude, markAnalyticsIdentityReady, trackEvent } from './analytics';
import { createClient } from '../supabase/client';
import { inject } from '@vercel/analytics';
import { isDevUiTelemetryDisabled } from '../constants/dev-ui';

if (!isDevUiTelemetryDisabled()) inject();

// Resolve the same user identity as the main app before initializing the shared SDK.
// This preserves a signed-in visitor's existing analytics identity.
void (async () => {
    try {
        const auth = createClient().auth;
        let { data: { user }, error } = await auth.getUser();
        if (error && error.name !== 'AuthSessionMissingError') {
            ({ data: { user }, error } = await auth.getUser());
        }
        // A transient auth failure must not be mistaken for logout: that would reset
        // an existing signed-in analytics identity and its device.
        if (error && error.name !== 'AuthSessionMissingError') return;
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
