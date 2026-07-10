export const INSTAGRAM_USERNAME_MAX_LENGTH = 30;
export const INSTAGRAM_USERNAME_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export function isInstagramUsername(value: unknown): value is string {
    return typeof value === 'string' && INSTAGRAM_USERNAME_PATTERN.test(value);
}
