import crypto from 'crypto';

const unavailable = () => {
  throw new Error('Nenhum provedor de pagamento real foi configurado.');
};

export async function createPixPayment() {
  return unavailable();
}

export async function getPaymentStatus() {
  return unavailable();
}

export function verifyPaymentWebhookSignature(rawBody, signature, secret) {
  if (!rawBody || !signature || !secret) return false;
  const normalized = String(signature).trim().replace(/^v1:/i, '');
  if (!/^[a-f0-9]+$/i.test(normalized)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(normalized, 'hex');
  return provided.length === expected.length && crypto.timingSafeEqual(expected, provided);
}