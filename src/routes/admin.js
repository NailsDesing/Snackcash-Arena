import express from 'express';
import { supabase, supabaseAuth, approveWithdrawalRequestTx, rejectWithdrawalRequestTx } from '../services/supabase.js';
import { requireAdmin } from '../middleware/auth.js';
import { createRequestRateLimiter } from '../middleware/rateLimit.js';

const router = express.Router();
router.use(createRequestRateLimiter({ windowMs: 60_000, max: 15, message: 'Muitas tentativas de login/admin. Tente novamente em alguns instantes.' }));

router.post('/login', async (req, res) => {
  try {
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!email || !password) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    if (!supabaseAuth) return res.status(503).json({ error: 'Autenticação administrativa indisponível.' });
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error || !data?.session || data.user?.app_metadata?.role !== 'admin') {
      if (data?.session) await supabaseAuth.auth.signOut();
      return res.status(401).json({ error: 'Credenciais administrativas inválidas.' });
    }
    return res.json({ success: true, token: data.session.access_token, expiresIn: data.session.expires_in, admin: true });
  } catch (err) {
    return res.status(500).json({ error: 'Falha ao autenticar administrador.', details: err.message });
  }
});

router.get('/metrics', requireAdmin, async (_req, res) => {
  try {
    if (!supabase) return res.status(503).json({ error: 'Banco indisponível.' });
    const [{ count: totalPlayers }, { data: balances }, { data: pending }] = await Promise.all([
      supabase.from('profiles').select('*', { count: 'exact', head: true }),
      supabase.from('wallets').select('balance'),
      supabase.from('withdraw_requests').select('amount').eq('status', 'pending')
    ]);
    return res.json({
      totalPlayers: totalPlayers || 0,
      totalBalance: (balances || []).reduce((sum, item) => sum + Number(item.balance || 0), 0),
      pendingWithdrawalsCount: (pending || []).length,
      pendingWithdrawalsTotal: (pending || []).reduce((sum, item) => sum + Number(item.amount || 0), 0)
    });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao carregar métricas.', details: err.message });
  }
});

router.get('/withdrawals', requireAdmin, async (req, res) => {
  try {
    let query = supabase.from('withdraw_requests').select('*, profiles(name, email)').order('created_at', { ascending: false });
    if (req.query.status && req.query.status !== 'all') query = query.eq('status', req.query.status);
    const { data, error } = await query;
    if (error) throw error;
    return res.json({ withdrawals: data });
  } catch (err) {
    return res.status(500).json({ error: 'Erro ao buscar saques.', details: err.message });
  }
});

router.post('/withdrawals/:id/action', requireAdmin, async (req, res) => {
  try {
    if (!['approve', 'reject'].includes(req.body.action)) return res.status(400).json({ error: 'Ação inválida.' });
    if (req.body.action === 'approve') await approveWithdrawalRequestTx(req.params.id);
    else await rejectWithdrawalRequestTx(req.params.id, req.body.reason);
    return res.json({ success: true, message: req.body.action === 'approve' ? 'Saque marcado como aprovado.' : 'Saque recusado e saldo devolvido.' });
  } catch (err) {
    const status = /processad|encontrad/i.test(err.message) ? 409 : 500;
    return res.status(status).json({ error: err.message || 'Falha ao processar ação.' });
  }
});

export default router;