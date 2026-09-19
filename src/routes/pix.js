import express from 'express';
import { createPixPayment, getPaymentStatus, verifyPaymentWebhookSignature } from '../services/paymentProvider.js';
import { supabase, creditUserWallet } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { createRequestRateLimiter } from '../middleware/rateLimit.js';

const router = express.Router();
const pixRateLimiter = createRequestRateLimiter({ windowMs: 60_000, max: 20, message: 'Muitas requisições PIX. Tente novamente em alguns instantes.' });
const ensurePaymentsEnabled = (_req, res, next) => {
  if (process.env.PAYMENTS_ENABLED !== 'true') return res.status(503).json({ error: 'Pagamentos reais estão desativados.' });
  return next();
};

router.use(pixRateLimiter);

/**
 * POST /api/pix/create
 * Cria uma nova cobrança PIX
 */
router.post('/create', requireAuth, ensurePaymentsEnabled, async (req, res) => {
  try {
    const userId = req.user?.id;
    const { amount, email, name } = req.body;

    if (!userId || userId === 'anon') {
      return res.status(401).json({ error: 'Sessão inválida para gerar cobrança PIX.' });
    }

    const parsedAmount = Number(amount);
    if (!parsedAmount || parsedAmount <= 0 || parsedAmount > 500) {
      return res.status(400).json({ error: 'Valor de depósito inválido.' });
    }

    const payment = await createPixPayment({
      amount: parsedAmount,
      email: email || 'jogador@snakecash.com',
      name: name || 'Jogador SnakeCash',
      description: `SnakeCash Arena - Recarga de R$ ${parsedAmount.toFixed(2)}`,
      externalReference: userId
    });

    // Se conectado ao Supabase e houver userId, registrar no banco
    if (supabase && userId && userId !== 'anon') {
      await supabase.from('pix_transactions').insert({
        user_id: userId,
        mp_payment_id: payment.paymentId,
        amount: parsedAmount,
        status: payment.status,
        qr_code: payment.qrCode,
        qr_code_base64: payment.qrCodeBase64,
        expires_at: payment.expiresAt
      });
    }

    return res.json({
      success: true,
      paymentId: payment.paymentId,
      amount: payment.amount,
      status: payment.status,
      qrCode: payment.qrCode,
      qrCodeBase64: payment.qrCodeBase64,
      expiresAt: payment.expiresAt,
      mock: payment.mock || false
    });
  } catch (err) {
    console.error('❌ Erro ao gerar PIX:', err);
    return res.status(500).json({ error: 'Falha ao gerar cobrança PIX.', details: err.message });
  }
});

/**
 * POST /api/pix/webhook
 * Recebe notificações automáticas do Mercado Pago
 */
router.post('/webhook', ensurePaymentsEnabled, async (req, res) => {
  try {
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const payload = Buffer.isBuffer(req.body) ? JSON.parse(rawBody.toString()) : (req.body || {});
    const { type, data, action } = payload;
    const query = req.query;
    const signature = req.headers['x-signature'];
    const secret = process.env.PAYMENT_WEBHOOK_SECRET;

    if (!secret) return res.status(503).send('webhook não configurado');
    if (!verifyPaymentWebhookSignature(rawBody, signature, secret)) return res.status(401).send('assinatura inválida');

    const paymentId = data?.id || query['data.id'] || query.id;
    const eventType = type || query.type || query.topic;

    if (eventType === 'payment' && paymentId) {
      const paymentInfo = await getPaymentStatus(paymentId);

      if (paymentInfo && paymentInfo.status === 'approved') {
        const amount = Number(paymentInfo.transaction_amount || paymentInfo.amount || 0);
        const userId = paymentInfo.external_reference;

        console.log(`💰 PIX Aprovado! ID: ${paymentId}, Valor: R$ ${amount}, Usuário: ${userId}`);

        if (supabase) {
          const { data: existingTransaction } = await supabase
            .from('pix_transactions')
            .select('id, user_id, amount, status')
            .eq('mp_payment_id', paymentId)
            .maybeSingle();

          if (existingTransaction?.status === 'approved') {
            return res.status(200).send('OK');
          }

          const { data: updatedTransaction, error: updateError } = await supabase
            .from('pix_transactions')
            .update({ status: 'approved', paid_at: new Date().toISOString() })
            .eq('mp_payment_id', paymentId)
            .eq('status', 'pending')
            .select('user_id, amount');

          if (updateError) throw updateError;
          if (!updatedTransaction || updatedTransaction.length === 0) {
            return res.status(200).send('OK');
          }

          const creditedUserId = updatedTransaction[0].user_id;
          const creditedAmount = Number(updatedTransaction[0].amount || amount || 0);

          await creditUserWallet(creditedUserId, creditedAmount, 'pix_deposit', `Depósito PIX aprovado (ID: ${paymentId})`);

          const { data: profile } = await supabase
            .from('profiles')
            .select('referred_by')
            .eq('id', creditedUserId)
            .single();

          if (profile?.referred_by && creditedAmount >= 30) {
            const { data: inviter } = await supabase
              .from('profiles')
              .select('id, referral_earnings, referral_count')
              .eq('referral_code', profile.referred_by)
              .single();

            if (inviter) {
              const { data: bonusHistory } = await supabase
                .from('balance_logs')
                .select('id')
                .eq('user_id', inviter.id)
                .eq('operation_type', 'referral_bonus')
                .like('description', `%${creditedUserId}%`)
                .maybeSingle();

              if (!bonusHistory) {
                await creditUserWallet(inviter.id, 10.00, 'referral_bonus', `Bônus por indicação do jogador ${creditedUserId}`);
                await supabase.from('profiles').update({
                  referral_count: (inviter.referral_count || 0) + 1,
                  referral_earnings: Number(inviter.referral_earnings || 0) + 10.00
                }).eq('id', inviter.id);
              }
            }
          }
        }
      }
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('❌ Erro no webhook PIX:', err);
    return res.status(500).send('falha temporária');
  }
});

/**
 * GET /api/pix/status/:paymentId
 * Consulta o status atual de uma cobrança
 */
router.get('/status/:paymentId', requireAuth, async (req, res) => {
  try {
    const { paymentId } = req.params;

    if (supabase) {
      const { data } = await supabase
        .from('pix_transactions')
        .select('status, amount, paid_at')
        .eq('mp_payment_id', paymentId)
        .eq('user_id', req.user.id)
        .maybeSingle();

      if (data) {
        return res.json({ status: data.status, amount: data.amount, paidAt: data.paid_at });
      }
      return res.status(404).json({ error: 'Cobrança não encontrada.' });
    }

    const payment = await getPaymentStatus(paymentId);
    return res.json({ status: payment.status || 'pending', amount: payment.transaction_amount });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao verificar status.', details: err.message });
  }
});

/**
 * POST /api/pix/simulate-payment/:paymentId
 * Rota útil para testes em desenvolvimento: aprova um PIX fictício
 */
router.post('/simulate-payment/:paymentId', requireAuth, async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Simulação de pagamento está desativada em produção.' });
    }

    if (process.env.ALLOW_PIX_SIMULATION !== 'true') {
      return res.status(403).json({ error: 'Simulação PIX desabilitada. Ative ALLOW_PIX_SIMULATION=true em desenvolvimento.' });
    }

    const { paymentId } = req.params;
    const userId = req.user?.id;
    const { amount } = req.body;

    if (!userId || userId === 'anon') {
      return res.status(401).json({ error: 'Sessão inválida para simular pagamento.' });
    }

    const value = Number(amount) || 20;

    if (supabase) {
      const { data: existingTransaction } = await supabase
        .from('pix_transactions')
        .select('id, status')
        .eq('mp_payment_id', paymentId)
        .eq('user_id', req.user.id)
        .maybeSingle();

      if (!existingTransaction) return res.status(404).json({ error: 'Cobrança de teste não encontrada para esta conta.' });
      if (existingTransaction.status === 'approved') {
        return res.json({ success: true, message: 'Pagamento já foi processado anteriormente.', idempotent: true });
      }

      const { data: updatedTransaction, error: updateError } = await supabase
        .from('pix_transactions')
        .update({ status: 'approved', paid_at: new Date().toISOString() })
        .eq('mp_payment_id', paymentId)
        .eq('user_id', req.user.id)
        .eq('status', 'pending')
        .select('user_id, amount');

      if (updateError) throw updateError;
      if (!updatedTransaction || updatedTransaction.length === 0) {
        return res.json({ success: true, message: 'Pagamento já foi processado anteriormente.', idempotent: true });
      }

      await creditUserWallet(updatedTransaction[0].user_id, Number(updatedTransaction[0].amount || value), 'pix_deposit', `Depósito de teste aprovado (ID: ${paymentId})`);
    }

    return res.json({ success: true, message: `PIX de R$ ${value.toFixed(2)} simulado e aprovado com sucesso!` });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao simular aprovação.', details: err.message });
  }
});

export default router;
