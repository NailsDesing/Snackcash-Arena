import test from 'node:test';
import assert from 'node:assert/strict';

import { createRequestRateLimiter } from '../src/middleware/rateLimit.js';
import { validateSupabaseToken, getBearerToken } from '../src/middleware/auth.js';

test('getBearerToken extrai o token do header Authorization', () => {
  const req = { headers: { authorization: 'Bearer abc123' } };
  assert.equal(getBearerToken(req), 'abc123');
});

test('rate limiter bloqueia após o limite de requisições', async () => {
  const limiter = createRequestRateLimiter({ windowMs: 60000, max: 2, message: 'muitas requisições' });
  const req = { ip: '127.0.0.1' };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };

  let nextCalled = 0;
  const next = () => { nextCalled += 1; };

  limiter(req, res, next);
  limiter(req, res, next);
  limiter(req, res, next);

  assert.equal(nextCalled, 2);
  assert.equal(res.statusCode, 429);
});

test('validateSupabaseToken rejeita token inválido', async () => {
  await assert.rejects(() => validateSupabaseToken('fake-token'), /Token|Sessão|invalid/i);
});
