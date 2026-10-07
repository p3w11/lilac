'use strict';

/** Небольшой лимит запросов в памяти: защита от перебора паролей и спама. */

const buckets = new Map();

function hit(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return { ok: true, left: limit - 1 };
  }
  b.count += 1;
  return {
    ok: b.count <= limit,
    left: Math.max(0, limit - b.count),
    retryIn: b.reset - now,
  };
}

// Чистим протухшие записи, чтобы память не росла
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (now > b.reset) buckets.delete(key);
}, 60_000).unref();

module.exports = { hit };
