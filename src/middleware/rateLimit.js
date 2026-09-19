const stores = new Map();

export function createRequestRateLimiter({
  windowMs = 60_000,
  max = 15,
  message = 'Muitas requisições. Tente novamente em alguns instantes.'
} = {}) {
  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const now = Date.now();
    const current = stores.get(ip);

    if (!current || now - current.windowStart > windowMs) {
      stores.set(ip, { count: 1, windowStart: now });
      return next();
    }

    current.count += 1;
    if (current.count > max) {
      return res.status(429).json({ error: message });
    }

    return next();
  };
}

export const defaultRateLimiter = createRequestRateLimiter();
