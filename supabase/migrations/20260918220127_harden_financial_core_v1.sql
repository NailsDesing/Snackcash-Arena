begin;

-- Harden financial functions: fixed search_path and server-only execution.
create or replace function public.credit_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_operation character varying,
  p_description text default null
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_balance numeric(14,2);
  v_new_balance numeric(14,2);
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'O valor do crédito deve ser positivo e ter no máximo 2 casas decimais.';
  end if;
  if p_operation is null or char_length(btrim(p_operation)) not between 1 and 80 then
    raise exception 'Tipo de operação inválido.';
  end if;

  select balance into v_old_balance
  from public.wallets
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Carteira não encontrada.';
  end if;

  v_new_balance := v_old_balance + p_amount;

  update public.wallets
  set balance = v_new_balance,
      total_deposited = case
        when p_operation = 'pix_deposit' then total_deposited + p_amount
        else total_deposited
      end,
      updated_at = timezone('utc'::text, now())
  where user_id = p_user_id;

  insert into public.balance_logs
    (user_id, amount, balance_before, balance_after, operation_type, description)
  values
    (p_user_id, p_amount, v_old_balance, v_new_balance, p_operation, p_description);

  return v_new_balance;
end;
$function$;

create or replace function public.debit_wallet(
  p_user_id uuid,
  p_amount numeric,
  p_operation character varying,
  p_description text default null
)
returns numeric
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_old_balance numeric(14,2);
  v_new_balance numeric(14,2);
begin
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
    raise exception 'O valor do débito deve ser positivo e ter no máximo 2 casas decimais.';
  end if;
  if p_operation is null or char_length(btrim(p_operation)) not between 1 and 80 then
    raise exception 'Tipo de operação inválido.';
  end if;

  select balance into v_old_balance
  from public.wallets
  where user_id = p_user_id
  for update;

  if not found then
    raise exception 'Carteira não encontrada.';
  end if;
  if v_old_balance < p_amount then
    raise exception 'Saldo insuficiente.';
  end if;

  v_new_balance := v_old_balance - p_amount;

  update public.wallets
  set balance = v_new_balance,
      updated_at = timezone('utc'::text, now())
  where user_id = p_user_id;

  insert into public.balance_logs
    (user_id, amount, balance_before, balance_after, operation_type, description)
  values
    (p_user_id, -p_amount, v_old_balance, v_new_balance, p_operation, p_description);

  return v_new_balance;
end;
$function$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_name text;
  v_ref_code text;
  v_referred_by text;
begin
  v_name := coalesce(
    nullif(btrim(new.raw_user_meta_data->>'name'), ''),
    split_part(new.email, '@', 1)
  );
  v_referred_by := nullif(btrim(new.raw_user_meta_data->>'referred_by'), '');
  v_ref_code := 'SC' || upper(substring(new.id::text from 1 for 6));

  insert into public.profiles (id, name, email, referral_code, referred_by)
  values (new.id, v_name, new.email, v_ref_code, v_referred_by);

  insert into public.wallets (user_id, balance)
  values (new.id, 0.00);

  return new;
end;
$function$;

revoke all on function public.credit_wallet(uuid,numeric,character varying,text) from public, anon, authenticated;
revoke all on function public.debit_wallet(uuid,numeric,character varying,text) from public, anon, authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;
grant execute on function public.credit_wallet(uuid,numeric,character varying,text) to service_role;
grant execute on function public.debit_wallet(uuid,numeric,character varying,text) to service_role;

-- Least-privilege table access. Financial writes remain server-side.
revoke all on table
  public.profiles,
  public.wallets,
  public.pix_transactions,
  public.withdraw_requests,
  public.matches,
  public.balance_logs
from anon, authenticated;

grant select on table
  public.profiles,
  public.wallets,
  public.pix_transactions,
  public.withdraw_requests,
  public.matches,
  public.balance_logs
to authenticated;

grant update (name, avatar_url) on public.profiles to authenticated;

-- Replace policies with authenticated-only, optimized ownership checks.
drop policy if exists "Users can view own profile" on public.profiles;
drop policy if exists "Users can update own profile" on public.profiles;
drop policy if exists "Users can view own wallet" on public.wallets;
drop policy if exists "Users can view own pix transactions" on public.pix_transactions;
drop policy if exists "Users can view own withdraw requests" on public.withdraw_requests;
drop policy if exists "Users can insert withdraw requests" on public.withdraw_requests;
drop policy if exists "Users can view own matches" on public.matches;
drop policy if exists "Users can view own balance logs" on public.balance_logs;

create policy "Users can view own profile"
on public.profiles for select to authenticated
using ((select auth.uid()) = id);

create policy "Users can update own profile"
on public.profiles for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

create policy "Users can view own wallet"
on public.wallets for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can view own pix transactions"
on public.pix_transactions for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can view own withdraw requests"
on public.withdraw_requests for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can view own matches"
on public.matches for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can view own balance logs"
on public.balance_logs for select to authenticated
using ((select auth.uid()) = user_id);

-- Cover ownership filters and foreign keys.
create index if not exists balance_logs_user_created_idx
  on public.balance_logs (user_id, created_at desc);
create index if not exists matches_user_created_idx
  on public.matches (user_id, created_at desc);
create index if not exists pix_transactions_user_created_idx
  on public.pix_transactions (user_id, created_at desc);
create index if not exists withdraw_requests_user_created_idx
  on public.withdraw_requests (user_id, created_at desc);
create index if not exists profiles_referred_by_idx
  on public.profiles (referred_by) where referred_by is not null;

-- Remove indexes duplicated by existing UNIQUE constraints.
drop index if exists public.idx_profiles_email;
drop index if exists public.idx_profiles_referral_code;
drop index if exists public.idx_wallets_user_id;
drop index if exists public.idx_pix_mp_id;

-- Add data-integrity checks without changing existing values.
do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.profiles'::regclass
      and conname='profiles_referral_values_check'
  ) then
    alter table public.profiles
      add constraint profiles_referral_values_check
      check (
        coalesce(referral_count,0) >= 0
        and coalesce(referral_earnings,0) >= 0
        and coalesce(referral_earnings,0) = round(coalesce(referral_earnings,0),2)
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.wallets'::regclass
      and conname='wallets_money_integrity_check'
  ) then
    alter table public.wallets
      add constraint wallets_money_integrity_check
      check (
        balance >= 0 and locked_balance >= 0
        and total_deposited >= 0 and total_withdrawn >= 0
        and balance = round(balance,2)
        and locked_balance = round(locked_balance,2)
        and total_deposited = round(total_deposited,2)
        and total_withdrawn = round(total_withdrawn,2)
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.pix_transactions'::regclass
      and conname='pix_transactions_integrity_check'
  ) then
    alter table public.pix_transactions
      add constraint pix_transactions_integrity_check
      check (
        amount > 0
        and amount = round(amount,2)
        and status in ('pending','approved','rejected','cancelled','expired')
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.withdraw_requests'::regclass
      and conname='withdraw_requests_integrity_check'
  ) then
    alter table public.withdraw_requests
      add constraint withdraw_requests_integrity_check
      check (
        amount >= 30
        and amount = round(amount,2)
        and status in ('pending','processing','approved','rejected','cancelled')
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.matches'::regclass
      and conname='matches_nonnegative_values_check'
  ) then
    alter table public.matches
      add constraint matches_nonnegative_values_check
      check (
        snake_tier >= 0
        and final_mass >= 0
        and coalesce(amount_cashed_out,0) >= 0
        and coalesce(amount_cashed_out,0) = round(coalesce(amount_cashed_out,0),2)
        and coalesce(duration_seconds,0) >= 0
      ) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid='public.balance_logs'::regclass
      and conname='balance_logs_integrity_check'
  ) then
    alter table public.balance_logs
      add constraint balance_logs_integrity_check
      check (
        balance_before >= 0
        and balance_after >= 0
        and amount = round(amount,2)
        and balance_before = round(balance_before,2)
        and balance_after = round(balance_after,2)
        and balance_after = balance_before + amount
        and char_length(btrim(operation_type)) between 1 and 80
      ) not valid;
  end if;
end;
$constraints$;

alter table public.profiles validate constraint profiles_referral_values_check;
alter table public.wallets validate constraint wallets_money_integrity_check;
alter table public.pix_transactions validate constraint pix_transactions_integrity_check;
alter table public.withdraw_requests validate constraint withdraw_requests_integrity_check;
alter table public.matches validate constraint matches_nonnegative_values_check;
alter table public.balance_logs validate constraint balance_logs_integrity_check;

commit;
