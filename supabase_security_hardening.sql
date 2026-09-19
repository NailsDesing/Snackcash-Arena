-- SnakeCash Arena - endurecimento financeiro
-- Execute este arquivo no SQL Editor após supabase_schema.sql.

create or replace function public.create_withdrawal_request(
  p_user_id uuid,
  p_amount numeric(10,2),
  p_pix_key text,
  p_pix_key_type text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance numeric(10,2);
  v_locked numeric(10,2);
  v_request_id uuid;
begin
  if p_amount < 30 then raise exception 'O valor mínimo de saque é R$ 30,00.'; end if;
  if nullif(btrim(p_pix_key), '') is null then raise exception 'Chave PIX obrigatória.'; end if;
  if upper(p_pix_key_type) not in ('CPF','CNPJ','EMAIL','TELEFONE','ALEATORIA') then raise exception 'Tipo de chave PIX inválido.'; end if;

  select balance, locked_balance into v_balance, v_locked
  from public.wallets where user_id = p_user_id for update;
  if not found then raise exception 'Carteira não encontrada.'; end if;
  if v_balance < p_amount then raise exception 'Saldo insuficiente.'; end if;

  update public.wallets
  set balance = balance - p_amount,
      locked_balance = locked_balance + p_amount,
      updated_at = pg_catalog.now()
  where user_id = p_user_id;

  insert into public.withdraw_requests(user_id, amount, pix_key, pix_key_type, status)
  values (p_user_id, p_amount, btrim(p_pix_key), upper(p_pix_key_type), 'pending')
  returning id into v_request_id;

  insert into public.balance_logs(user_id, amount, balance_before, balance_after, operation_type, description)
  values (p_user_id, -p_amount, v_balance, v_balance - p_amount, 'withdraw_reserve', 'Saldo reservado para saque ' || v_request_id::text);

  return v_request_id;
end;
$$;

create or replace function public.reject_withdrawal_request(
  p_request_id uuid,
  p_rejection_reason text default 'Recusado pelo administrador'
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.withdraw_requests%rowtype;
  v_balance numeric(10,2);
begin
  select * into v_request from public.withdraw_requests where id = p_request_id for update;
  if not found then raise exception 'Solicitação de saque não encontrada.'; end if;
  if v_request.status <> 'pending' then raise exception 'Solicitação já processada.'; end if;

  select balance into v_balance from public.wallets where user_id = v_request.user_id for update;
  if not found then raise exception 'Carteira não encontrada.'; end if;

  update public.wallets
  set balance = balance + v_request.amount,
      locked_balance = locked_balance - v_request.amount,
      updated_at = pg_catalog.now()
  where user_id = v_request.user_id and locked_balance >= v_request.amount;
  if not found then raise exception 'Reserva financeira inconsistente.'; end if;

  update public.withdraw_requests
  set status = 'rejected', processed_at = pg_catalog.now(), rejection_reason = coalesce(nullif(btrim(p_rejection_reason), ''), 'Recusado pelo administrador')
  where id = p_request_id;

  insert into public.balance_logs(user_id, amount, balance_before, balance_after, operation_type, description)
  values (v_request.user_id, v_request.amount, v_balance, v_balance + v_request.amount, 'withdraw_refund', 'Saque recusado ' || p_request_id::text);
  return p_request_id;
end;
$$;

create or replace function public.approve_withdrawal_request(p_request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request public.withdraw_requests%rowtype;
begin
  select * into v_request from public.withdraw_requests where id = p_request_id for update;
  if not found then raise exception 'Solicitação de saque não encontrada.'; end if;
  if v_request.status <> 'pending' then raise exception 'Solicitação já processada.'; end if;

  update public.wallets
  set locked_balance = locked_balance - v_request.amount,
      total_withdrawn = total_withdrawn + v_request.amount,
      updated_at = pg_catalog.now()
  where user_id = v_request.user_id and locked_balance >= v_request.amount;
  if not found then raise exception 'Reserva financeira inconsistente.'; end if;

  update public.withdraw_requests set status = 'approved', processed_at = pg_catalog.now() where id = p_request_id;
  return p_request_id;
end;
$$;

-- As RPCs financeiras só podem ser chamadas pelo backend com service_role.
revoke all on function public.credit_wallet(uuid,numeric,character varying,text) from public, anon, authenticated;
revoke all on function public.debit_wallet(uuid,numeric,character varying,text) from public, anon, authenticated;
revoke all on function public.create_withdrawal_request(uuid,numeric,text,text) from public, anon, authenticated;
revoke all on function public.reject_withdrawal_request(uuid,text) from public, anon, authenticated;
revoke all on function public.approve_withdrawal_request(uuid) from public, anon, authenticated;
grant execute on function public.credit_wallet(uuid,numeric,character varying,text) to service_role;
grant execute on function public.debit_wallet(uuid,numeric,character varying,text) to service_role;
grant execute on function public.create_withdrawal_request(uuid,numeric,text,text) to service_role;
grant execute on function public.reject_withdrawal_request(uuid,text) to service_role;
grant execute on function public.approve_withdrawal_request(uuid) to service_role;

alter function public.credit_wallet(uuid,numeric,character varying,text) set search_path = '';
alter function public.debit_wallet(uuid,numeric,character varying,text) set search_path = '';
alter function public.handle_new_user() set search_path = '';
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- Jogadores não podem alterar indicação, e-mail ou métricas financeiras pelo Data API.
revoke update on public.profiles from authenticated;
grant update(name, avatar_url, updated_at) on public.profiles to authenticated;