/** Only a PostgreSQL-confirmed rollback before Vertex dispatch can issue this signal. */
export class DevLiveVertexBudgetReservationPendingError extends Error {
    constructor() {
        super('DEV_LIVE_VERTEX_BUDGET_RESERVATION_PENDING');
        this.name = 'DevLiveVertexBudgetReservationPendingError';
    }
}
