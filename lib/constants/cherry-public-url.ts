export const CHERRY_PUBLIC_HOST = 'cherry.yeosachin.com';
export const CHERRY_PUBLIC_URL = `https://${CHERRY_PUBLIC_HOST}/`;
export const CHERRY_LANDING_PATH = '/cherry-public-landing';

export const CHERRY_REVIEW_CHECKOUT_PATH = '/checkout';
export const CHERRY_REVIEW_CHECKOUT_URL = new URL(CHERRY_REVIEW_CHECKOUT_PATH, CHERRY_PUBLIC_URL).href;
