import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import authRoutes from './src/routes/auth.js';
import pixRoutes from './src/routes/pix.js';
import walletRoutes from './src/routes/wallet.js';
import adminRoutes from './src/routes/admin.js';
import { setupSocketHandlers } from './src/game/socketHandler.js';
import { validateSupabaseToken } from './src/middleware/auth.js';
import { createRequestRateLimiter } from './src/middleware/rateLimit.js';

dotenv.config();

if (process.env.NODE_ENV === 'production') {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_ANON_KEY) {
    throw new Error('Supabase deve estar totalmente configurado em produção.');
  }
  if (process.env.PAYMENTS_ENABLED === 'true' && !process.env.PAYMENT_WEBHOOK_SECRET) {
    throw new Error('Pagamentos não podem ser ativados sem segredo de webhook.');
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
const allowedOrigins = Array.from(new Set([frontendUrl, 'http://localhost:3000', 'http://127.0.0.1:3000', 'https://localhost:3000']));
const authRateLimiter = createRequestRateLimiter({ windowMs: 60_000, max: 10, message: 'Muitas tentativas de autenticação. Tente novamente em alguns instantes.' });
const pixRateLimiter = createRequestRateLimiter({ windowMs: 60_000, max: 20, message: 'Muitas solicitações PIX. Tente novamente em alguns instantes.' });
const adminRateLimiter = createRequestRateLimiter({ windowMs: 60_000, max: 15, message: 'Muitas acessos ao painel. Tente novamente em alguns instantes.' });

// Configuração do Socket.io para conexões em tempo real
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error('CORS bloqueado para esta origem.'));
    },
    credentials: true,
    methods: ['GET', 'POST']
  }
});

// Middlewares
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS bloqueado para esta origem.'));
  },
  credentials: true
}));
app.use('/api/pix/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/auth', authRateLimiter);
app.use('/api/pix', pixRateLimiter);
app.use('/api/admin', adminRateLimiter);

// Servir arquivos estáticos do jogo e painel admin
app.use(express.static(path.join(__dirname, 'dist')));

// Rotas de API
app.use('/api/auth', authRoutes);
app.use('/api/pix', pixRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);

// Health check para Railway / Render
app.get('/api/health', (req, res) => {
  res.json({ status: 'online', time: new Date().toISOString() });
});

io.use(async (socket, next) => {
  try {
    const rawToken = socket.handshake.auth?.access_token || socket.handshake.headers?.authorization || '';
    const token = String(rawToken).replace(/^Bearer\s+/i, '').trim();

    if (!token) {
      return next(new Error('Token de acesso obrigatório.'));
    }

    const user = await validateSupabaseToken(token);
    socket.user = user;
    return next();
  } catch (err) {
    return next(new Error(err.message || 'Sessão inválida ou expirada.'));
  }
});

// Inicializar mecanismo do jogo multiplayer via WebSockets
setupSocketHandlers(io);

// Iniciar Servidor
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 SnakeCash Arena rodando na porta ${PORT}`);
  console.log(`🎮 Acesse o jogo em: http://localhost:${PORT}`);
  console.log(`🛡️  Acesse o painel admin em: http://localhost:${PORT}/admin.html`);
});
