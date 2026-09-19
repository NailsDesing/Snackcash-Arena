import { supabase } from '../services/supabase.js';

export function getBearerToken(req) {
  const authHeader = req?.headers?.authorization;
  if (!authHeader || typeof authHeader !== 'string') return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export async function validateSupabaseToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') throw new Error('Token de acesso ausente.');
  const normalizedToken = rawToken.trim();
  if (!normalizedToken) throw new Error('Token de acesso inválido.');

  if (!supabase) {
    if (process.env.NODE_ENV !== 'production' && process.env.ALLOW_MOCK_AUTH === 'true' && /^(mock_|demo_)/.test(normalizedToken)) {
      const userId = normalizedToken.replace(/^(mock_|demo_)/, '');
      return { id: userId || 'local-dev-user', email: `${userId || 'local-dev-user'}@local.dev` };
    }
    throw new Error('Sessão inválida. Configure Supabase para autenticar usuários.');
  }

  const { data, error } = await supabase.auth.getUser(normalizedToken);
  if (error || !data?.user) throw new Error(error?.message || 'Sessão inválida ou expirada.');
  return { id: data.user.id, email: data.user.email, user: data.user };
}

export async function requireAuth(req, res, next) {
  try {
    const token = getBearerToken(req) || req.headers['x-access-token'];
    if (!token) return res.status(401).json({ error: 'Token de acesso obrigatório.' });
    const user = await validateSupabaseToken(token);
    req.user = user;
    req.userId = user.id;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.', details: err.message });
  }
}

export async function requireAdmin(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: 'Token administrativo obrigatório.' });
    const user = await validateSupabaseToken(token);
    if (user.user?.app_metadata?.role !== 'admin') {
      return res.status(403).json({ error: 'Esta conta não possui permissão administrativa.' });
    }
    req.user = user;
    req.userId = user.id;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Sessão administrativa inválida ou expirada.', details: err.message });
  }
}