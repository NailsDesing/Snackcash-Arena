import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('saque usa RPC atômica e não insere solicitação diretamente', async () => {
  const source = await read('src/routes/wallet.js');
  assert.match(source, /createWithdrawalRequestTx\(req\.user\.id/);
  assert.doesNotMatch(source, /from\(['"]withdraw_requests['"]\)\.insert/);
  assert.match(source, /WITHDRAWALS_ENABLED/);
});

test('entrada na arena usa identidade autenticada do socket', async () => {
  const source = await read('src/game/GameRoom.js');
  assert.match(source, /const userId = socket\.user\?\.id/);
  assert.doesNotMatch(source, /addPlayer\(socket, \{ userId,/);
  assert.match(source, /activeUserIds/);
});

test('cashout possui trava contra chamadas concorrentes', async () => {
  const source = await read('src/game/GameRoom.js');
  assert.match(source, /player\.cashoutInProgress/);
  assert.match(source, /finally \{\s*player\.cashoutInProgress = false/);
});

test('painel exige papel admin em app_metadata', async () => {
  const middleware = await read('src/middleware/auth.js');
  const admin = await read('src/routes/admin.js');
  assert.match(middleware, /app_metadata\?\.role !== 'admin'/);
  assert.match(admin, /requireAdmin/);
  assert.doesNotMatch(admin, /ADMIN_SECRET_KEY/);
});

test('dinheiro real permanece desligado por flags explícitas', async () => {
  const pix = await read('src/routes/pix.js');
  const wallet = await read('src/routes/wallet.js');
  assert.match(pix, /PAYMENTS_ENABLED !== 'true'/);
  assert.match(wallet, /WITHDRAWALS_ENABLED !== 'true'/);
});

test('SQL reserva saldo e restringe RPCs financeiras ao service_role', async () => {
  const sql = await read('supabase_security_hardening.sql');
  assert.match(sql, /locked_balance = locked_balance \+ p_amount/);
  assert.match(sql, /grant execute on function public\.create_withdrawal_request.*service_role/i);
  assert.match(sql, /revoke all on function public\.credit_wallet.*anon, authenticated/i);
});