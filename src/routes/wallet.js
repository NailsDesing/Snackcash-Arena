import express from 'express';
import { supabase, creditUserWallet, createWithdrawalRequestTx } from '../services/supabase.js';
import { requireAuth } from '../middleware/auth.js';
import { createRequestRateLimiter } from '../middleware/rateLimit.js';

const router = express.Router();
router.use(createRequestRateLimiter({ windowMs: 60_000, max: 20, message: 'Muitas requisições de carteira. Tente novamente em alguns instantes.' }));
router.use(requireAuth);

router.post('/demo-credit', async (req, res) => {
  try {
    if (process.env.NODE_ENV === 'production' || process.env.ENABLE_DEMO_CREDITS !== 'true') {
      return res.status(403).json({ error: 'Créditos de teste estão desativados.' });
    }
    const value = Math.round(Number(req.body.amount) * 100) / 100;
    if (!Number.isFinite(value) || value <= 0 || value > 50) return res.status(400).json({ error: 'Crédito de teste deve ficar entre R$ 0,01 e R$ 50,00.' });
    await creditUserWallet(req.user.id, value, 'demo_credit', `Crédito de demonstração (R$ ${value.toFixed(2)})`);
    const { data, error } = await supabase.from('wallets').select('balance').eq('user_id', req.user.id).single();
    if (error) throw error;
    return res.json({ success: true, balance: Number(data.balance) });
  } catch (err) {
    return res.status(500).json({ error: 'Falha ao adicionar crédito de teste.', details: err.message });
  }
});

router.get('/balance/:userId', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Carteira indisponível.' });
    const { data, error } = await supabase.from('wallets').select('balance, locked_balance').eq('user_id', req.user.id).single();
    if (error) throw error;
    return res.json({ balance: Number(data.balance), locked: Number(data.locked_balance) });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao carregar carteira.', details: err.message });
  }
});

router.post('/withdraw', async (req, res) => {
  try {
    if (process.env.WITHDRAWALS_ENABLED !== 'true') return res.status(503).json({ error: 'Saques reais estão temporariamente desativados.' });
    const value = Math.round(Number(req.body.amount) * 100) / 100;
    const pixKey = String(req.body.pixKey || '').trim();
    const pixKeyType = String(req.body.pixKeyType || '').trim().toUpperCase();
    if (!Number.isFinite(value) || value < 30) return res.status(400).json({ error: 'O valor mínimo de saque é R$ 30,00.' });
    if (!pixKey || !['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA'].includes(pixKeyType)) return res.status(400).json({ error: 'Chave PIX ou tipo inválido.' });
    const result = await createWithdrawalRequestTx(req.user.id, value, pixKey, pixKeyType);
    return res.json({ success: true, message: 'Saque solicitado e saldo reservado.', requestId: result.id });
  } catch (err) {
    const status = /Saldo insuficiente|Carteira/.test(err.message) ? 400 : 500;
    return res.status(status).json({ error: err.message || 'Falha ao processar saque.' });
  }
});

router.get('/history/:userId', async (req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Histórico indisponível.' });
    const { data, error } = await supabase.from('balance_logs').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
    if (error) throw error;
    return res.json({ logs: data });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar histórico.', details: err.message });
  }
});

export default router;