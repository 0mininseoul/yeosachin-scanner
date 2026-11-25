interface ActorWaiter {
    limit: number;
    resolve(): void;
}

export class ApifyActorSemaphore {
    private active = 0;
    private readonly queue: ActorWaiter[] = [];

    async run<T>(limit: number, task: () => Promise<T>): Promise<T> {
        await this.acquire(limit);
        try {
            return await task();
        } finally {
            this.active--;
            this.drain();
        }
    }

    private acquire(limit: number): Promise<void> {
        if (this.queue.length === 0 && this.active < limit) {
            this.active++;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.queue.push({ limit, resolve });
        });
    }

    private drain(): void {
        while (this.queue.length > 0 && this.active < this.queue[0].limit) {
            const waiter = this.queue.shift();
            if (!waiter) return;
            this.active++;
            waiter.resolve();
        }
    }
}

const processActorSemaphore = new ApifyActorSemaphore();

export function getApifyActorSemaphore() {
    return processActorSemaphore;
}
