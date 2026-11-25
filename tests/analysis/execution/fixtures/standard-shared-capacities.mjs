// Local PostgreSQL and queue fixture only. No deployment configuration imports this table.
export const sharedStandardCapacities = /** @type {const} */ ([
    { slots: 8, workers: 8, features: 6 },
    { slots: 48, workers: 16, features: 32 },
    { slots: 56, workers: 20, features: 40 },
    { slots: 64, workers: 24, features: 48 },
]);

/** @param {string | number} slots */
export function sharedStandardCapacity(slots) {
    const capacity = sharedStandardCapacities.find(candidate => String(candidate.slots) === String(slots));
    if (!capacity) throw new Error('Unknown shared Standard slot capacity (expected ' + sharedStandardCapacities.map(c => c.slots).join('|') + ')');
    return capacity;
}
