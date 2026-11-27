import { qaDelivery } from './scope';
// Used only by the two bundled provider-boundary callers. Their real billing
// branch is unreachable because both SDKs are replaced when this image is built.
export function isDevUiDeploymentContext(): boolean {
    qaDelivery();
    return false;
}
