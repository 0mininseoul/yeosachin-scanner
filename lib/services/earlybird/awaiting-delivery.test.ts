import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));

import {
    AwaitingEarlybirdDeliveryLookupError,
    listAwaitingEarlybirdDeliveries,
} from './awaiting-delivery';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_USER_ID = '223e4567-e89b-42d3-a456-426614174000';
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174001';
const RESULT_ID = '123e4567-e89b-42d3-a456-426614174002';

function orderRow(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        user_id: USER_ID,
        target_instagram_id: 'target.account',
        plan_id: 'basic',
        result_request_id: null,
        paid_at: '2026-08-10T12:00:00.000Z',
        created_at: '2026-08-10T11:00:00.000Z',
        ...overrides,
    };
}

function queryBuilder(data: unknown, error: unknown = null) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        in: vi.fn().mockResolvedValue({ data, error }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return query;
}

describe('listAwaitingEarlybirdDeliveries', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('maps a valid paid row into the DTO', async () => {
        const query = queryBuilder([orderRow()]);
        mocks.from.mockReturnValue(query);

        const result = await listAwaitingEarlybirdDeliveries(USER_ID);

        expect(result).toEqual([{
            orderId: ORDER_ID,
            targetInstagramId: 'target.account',
            planId: 'basic',
            createdAt: '2026-08-10T12:00:00.000Z',
            resultRequestId: null,
        }]);
    });

    it('falls back to created_at when paid_at is null', async () => {
        const query = queryBuilder([orderRow({
            paid_at: null,
            result_request_id: RESULT_ID,
        })]);
        mocks.from.mockReturnValue(query);

        const result = await listAwaitingEarlybirdDeliveries(USER_ID);

        expect(result).toEqual([{
            orderId: ORDER_ID,
            targetInstagramId: 'target.account',
            planId: 'basic',
            createdAt: '2026-08-10T11:00:00.000Z',
            resultRequestId: RESULT_ID,
        }]);
    });

    it('excludes a row whose user_id does not match the requested userId', async () => {
        const query = queryBuilder([orderRow({ user_id: OTHER_USER_ID })]);
        mocks.from.mockReturnValue(query);

        const result = await listAwaitingEarlybirdDeliveries(USER_ID);

        expect(result).toEqual([]);
    });

    it('only requests paid + analysis_in_progress statuses via the query filter', async () => {
        const query = queryBuilder([]);
        mocks.from.mockReturnValue(query);

        await listAwaitingEarlybirdDeliveries(USER_ID);

        expect(mocks.from).toHaveBeenCalledWith('earlybird_orders');
        expect(query.eq).toHaveBeenCalledWith('user_id', USER_ID);
        expect(query.in).toHaveBeenCalledWith('status', ['paid', 'analysis_in_progress']);
    });

    it('throws a typed lookup error when the query reports an error', async () => {
        const query = queryBuilder(null, { message: 'boom' });
        mocks.from.mockReturnValue(query);

        await expect(listAwaitingEarlybirdDeliveries(USER_ID))
            .rejects.toBeInstanceOf(AwaitingEarlybirdDeliveryLookupError);
    });
});
