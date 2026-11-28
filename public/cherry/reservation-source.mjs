export const reservationSourceLabels = Object.freeze({
  threads: '스레드',
  everytime: '에타',
  x: 'X',
  // Instagram adds utm_source=ig to link-in-bio taps on its own.
  ig: '인스타그램',
});

/** @param {unknown} value */
export function parseReservationSource(value) {
  if (typeof value !== 'string' || !Object.hasOwn(reservationSourceLabels, value)) return undefined;
  return /** @type {keyof typeof reservationSourceLabels} */ (value);
}

/** @param {string} referrer */
export function sourceFromReferrer(referrer) {
  if (!referrer) return undefined;
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    const host = url.hostname;
    const matches = (/** @type {string} */ domain) => host === domain || host.endsWith(`.${domain}`);
    if (matches('threads.com') || matches('threads.net')) return 'threads';
    if (matches('everytime.kr')) return 'everytime';
    if (matches('x.com') || matches('twitter.com') || host === 't.co') return 'x';
    if (matches('instagram.com')) return 'ig';
  } catch {
    // Browsers may omit or redact referrer information.
  }
  return undefined;
}
