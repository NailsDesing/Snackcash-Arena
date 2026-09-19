import express from 'express';
import { supabase } from '../services/supabase.js';
import { createRequestRateLimiter } from '../middleware/rateLimit.js';

const router = express.Router();
const authRateLimiter = createRequestRateLimiter({ windowMs: 60_000, max: 10, message: 'Muitas tentativas de cadastro/login. Tente novamente em alguns instantes.' });

router.use(authRateLimiter);

/**
 * POST /api/auth/register
 */
router.post('/register', async (req, res) => {
  try {
    const { name, email, password, referredBy } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Nome, e-mail e senha são obrigatórios.' });
    }

    if (!supabase) {
      return res.json({
        success: true,
        user: { id: 'mock_' + Date.now(), name, email, referral_code: 'SCMOCK' }
      });
    }

    // 1. Criar usuário no Supabase Auth
    const { data: authData, error: authError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
          referred_by: referredBy || null
        }
      }
    });

    if (authError) {
      return res.status(400).json({ error: authError.message });
    }

    const user = authData.user;

    // Buscar perfil criado pelo trigger
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: profile?.name || name,
        email: user.email,
        referral_code: profile?.referral_code || ('SC' + user.id.substring(0, 6).toUpperCase()),
        balance: 0
      },
      session: authData.session
    });
  } catch (err) {
    console.error('❌ Erro no cadastro:', err);
    return res.status(500).json({ error: 'Falha ao realizar cadastro.', details: err.message });
  }
});

/**
 * POST /api/auth/login
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
    }

    if (!supabase) {
      return res.json({
        success: true,
        user: { id: 'mock_' + Date.now(), name: email.split('@')[0], email, referral_code: 'SCMOCK', balance: 20 }
      });
    }

    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (authError) {
      return res.status(400).json({ error: 'E-mail ou senha incorretos.' });
    }

    const user = authData.user;

    // Buscar perfil e carteira no Supabase
    const [{ data: profile }, { data: wallet }] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', user.id).maybeSingle(),
      supabase.from('wallets').select('*').eq('user_id', user.id).maybeSingle()
    ]);

    return res.json({
      success: true,
      user: {
        id: user.id,
        name: profile?.name || user.email.split('@')[0],
        email: user.email,
        referral_code: profile?.referral_code || ('SC' + user.id.substring(0, 6).toUpperCase()),
        balance: Number(wallet?.balance || 0)
      },
      session: authData.session
    });
  } catch (err) {
    console.error('❌ Erro no login:', err);
    return res.status(500).json({ error: 'Falha ao autenticar.', details: err.message });
  }
});

export default router;
