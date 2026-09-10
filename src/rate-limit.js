import { performance } from 'node:perf_hooks';

export function createRateLimiter({ limit = 120, windowMs = 60000, maxKeys = 10000, clock = () => performance.now() } = {}) {
  for (const [name, value, maximum] of [['limit', limit, 1000000], ['windowMs', windowMs, 3600000], ['maxKeys', maxKeys, 100000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid rate-limit ${name}`);
  }
  const buckets = new Map();
  return (key) => {
    const now = clock();
    // Fixed expiry and insertion order allow cleanup without scanning active entries.
    for (const [oldKey, bucket] of buckets) {
      if (bucket.expires > now) break;
      buckets.delete(oldKey);
    }
    let bucket = buckets.get(key);
    if (!bucket) {
      if (buckets.size >= maxKeys) {
        return Math.max(1, Math.ceil((buckets.values().next().value.expires - now) / 1000));
      }
      bucket = { count: 0, expires: now + windowMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.expires - now) / 1000));
    bucket.count += 1;
    return 0;
  };
}
