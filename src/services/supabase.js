import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';

export const supabase = supabaseUrl && supabaseServiceKey
  ? createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export const supabaseAuth = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

if (supabase) console.log('✅ Supabase conectado com sucesso (Service Role).');
else console.warn('⚠️ Supabase administrativo não configurado. Operações financeiras reais estão indisponíveis.');

function requireFinancialDatabase() {
  if (!supabase) throw new Error('Banco financeiro indisponível. Operação recusada.');
}

export async function creditUserWallet(userId, amount, operation, description) {
  requireFinancialDatabase();
  const { data, error } = await supabase.rpc('credit_wallet', { p_user_id: userId, p_amount: amount, p_operation: operation, p_description: description });
  if (error) throw error;
  return { success: true, balance: data };
}

export async function debitUserWallet(userId, amount, operation, description) {
  requireFinancialDatabase();
  const { data, error } = await supabase.rpc('debit_wallet', { p_user_id: userId, p_amount: amount, p_operation: operation, p_description: description });
  if (error) throw error;
  return { success: true, balance: data };
}

export async function createWithdrawalRequestTx(userId, amount, pixKey, pixKeyType) {
  requireFinancialDatabase();
  const { data, error } = await supabase.rpc('create_withdrawal_request', { p_user_id: userId, p_amount: amount, p_pix_key: pixKey, p_pix_key_type: pixKeyType });
  if (error) throw error;
  return { success: true, id: data };
}

export async function rejectWithdrawalRequestTx(requestId, reason) {
  requireFinancialDatabase();
  const { data, error } = await supabase.rpc('reject_withdrawal_request', { p_request_id: requestId, p_rejection_reason: reason || 'Recusado pelo administrador' });
  if (error) throw error;
  return { success: true, id: data };
}

export async function approveWithdrawalRequestTx(requestId) {
  requireFinancialDatabase();
  const { data, error } = await supabase.rpc('approve_withdrawal_request', { p_request_id: requestId });
  if (error) throw error;
  return { success: true, id: data };
}