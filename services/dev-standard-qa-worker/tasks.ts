import { CloudTasksClient as ActualCloudTasksClient } from '@google-cloud/tasks';
// Use the official REST transport so every outbound socket has the configured
// Google API hostname, including when Cloud Run uses IPv4.
export class CloudTasksClient extends ActualCloudTasksClient {
    constructor(options?: ConstructorParameters<typeof ActualCloudTasksClient>[0]) {
        super({ ...options, fallback: 'rest' });
    }
}
