// Local PostgreSQL and queue fixture only. No deployment configuration imports this table.
export const sharedStandardCapacities = /** @type {const} */ ([
    { preset: '8', resolvers: 2, slots: 8, workers: 8, features: 6 },
    { preset: '48', resolvers: 6, slots: 48, workers: 16, features: 32 },
    { preset: '56', resolvers: 6, slots: 56, workers: 20, features: 40 },
    { preset: '64', resolvers: 6, slots: 64, workers: 24, features: 48 },
    { preset: '80', resolvers: 6, slots: 80, workers: 32, features: 70 },
    { preset: '80-r12', resolvers: 12, slots: 80, workers: 32, features: 70 },
    { preset: '112-r40', resolvers: 40, slots: 112, workers: 32, features: 70 },
    { preset: '8w-128-r48', resolvers: 48, slots: 128, workers: 8, features: 80 },
    { preset: '128-r48', resolvers: 48, slots: 128, workers: 40, features: 80 },
    // More than one HTTP delivery can share one instance. Its three process limiters remain shared.
    { preset: '8i-40q', resolvers: 48, slots: 128, workers: 40, instances: 8, cpu: 2, features: 80 },
    { preset: '18i-40q-f4', resolvers: 48, slots: 128, workers: 40, instances: 18, cpu: 1, features: 80, processFeatureSlots: 4 },
    { preset: '18i-40q', resolvers: 48, slots: 128, workers: 40, instances: 18, cpu: 1, features: 80 },
]);

/** @param {string | number} preset */
export function sharedStandardCapacity(preset) {
    const capacity = sharedStandardCapacities.find(candidate => candidate.preset === String(preset));
    if (!capacity) throw new Error('Unknown shared Standard slot capacity (expected ' + sharedStandardCapacities.map(c => c.preset).join('|') + ')');
    return capacity;
}
