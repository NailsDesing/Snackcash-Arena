-- SnakeCash Arena: secure PIX order reconciliation, referral rewards and withdrawal validation.
-- Existing approved rows are preserved and are never re-credited by this migration.

alter table public.pix_transactions
  add column if not exists provider text not null default 'mercado_pago',
  add column if not exists provider_order_id text,
  add column if not exists provider_payment_id text,
  add column if not exists external_reference text,
  add column if not exists idempotency_key uuid,
  add column if not exists status_detail text,
  add column if not exists failure_reason text,
  add column if not exists webhook_received_at timestamptz,
  add column if not exists updated_at timestamptz not null default timezone('utc'::text, now());

create unique index if not exists pix_transactions_provider_order_id_key
  on public.pix_transactions(provider_order_id)
  where provider_order_id is not null;

create unique index if not exists pix_transactions_external_reference_key
  on public.pix_transactions(external_reference)
  where external_reference is not null;

create unique index if not exists pix_transactions_idempotency_key_key
  on public.pix_transactions(idempotency_key)
  where idempotency_key is not null;

create index if not exists pix_transactions_user_created_idx
  on public.pix_transactions(user_id, created_at desc);

create table if not exists public.referral_rewards (
  id uuid primary key default uuid_generate_v4(),
  referrer_user_id uuid not null references public.profiles(id) on delete cascade,
  referred_user_id uuid not null references public.profiles(id) on delete cascade,
  pix_transaction_id uuid not null references public.pix_transactions(id) on delete restrict,
  amount numeric(14,2) not null default 10.00 check (amount > 0),
  created_at timestamptz not null default timezone('utc'::text, now()),
  constraint referral_rewards_one_per_referred unique (referred_user_id),
  constraint referral_rewards_one_per_pix unique (pix_transaction_id),
  constraint referral_rewards_not_self check (referrer_user_id <> referred_user_id)
);

alter table public.referral_rewards enable row level security;

drop policy if exists "Users can view own referral rewards" on public.referral_rewards;
create policy "Users can view own referral rewards"
  on public.referral_rewards
  for select
  to authenticated
  using ((select auth.uid()) = referrer_user_id);

create index if not exists referral_rewards_referrer_created_idx
  on public.referral_rewards(referrer_user_id, created_at desc);

revoke all on table public.referral_rewards from anon, authenticated;
grant select on table public.referral_rewards to authenticated;
grant all on table public.referral_rewards to service_role;

create or replace function public.reconcile_mercado_pago_order(
  p_provider_order_id text,
  p_external_reference text,
  p_provider_payment_id text,
  p_order_status text,
  p_status_detail text,
  p_paid_amount numeric,
  p_paid_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_pix public.pix_transactions%rowtype;
  v_normalized_status text;
  v_new_balance numeric(14,2);
  v_referrer_id uuid;
  v_reward_id uuid;
begin
  if nullif(pg_catalog.btrim(p_external_reference), '') is null then
    raise exception 'Referência externa obrigatória.';
  end if;
  if nullif(pg_catalog.btrim(p_provider_order_id), '') is null then
    raise exception 'Identificador da ordem obrigatório.';
  end if;

  select * into v_pix
  from public.pix_transactions
  where external_reference = p_external_reference
  for update;

  if not found then
    raise exception 'Transação PIX não encontrada.';
  end if;

  if v_pix.provider_order_id is not null
     and v_pix.provider_order_id <> p_provider_order_id then
    raise exception 'A ordem recebida não corresponde à transação.';
  end if;

  if p_order_status = 'processed' and p_status_detail = 'accredited' then
    if p_paid_amount is null or round(p_paid_amount, 2) <> round(v_pix.amount, 2) then
      update public.pix_transactions
      set provider_order_id = coalesce(provider_order_id, p_provider_order_id),
          provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
          status = 'failed',
          status_detail = 'amount_mismatch',
          failure_reason = 'Valor confirmado pelo provedor não corresponde ao valor solicitado.',
          webhook_received_at = timezone('utc'::text, now()),
          updated_at = timezone('utc'::text, now())
      where id = v_pix.id;
      raise exception 'Valor pago divergente.';
    end if;

    if v_pix.status = 'approved' then
      return jsonb_build_object(
        'transaction_id', v_pix.id,
        'status', 'approved',
        'credited', false,
        'idempotent', true
      );
    end if;

    update public.pix_transactions
    set provider_order_id = p_provider_order_id,
        provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
        status = 'approved',
        status_detail = p_status_detail,
        failure_reason = null,
        paid_at = coalesce(p_paid_at, timezone('utc'::text, now())),
        webhook_received_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    where id = v_pix.id;

    v_new_balance := public.credit_wallet(
      v_pix.user_id,
      v_pix.amount,
      'pix_deposit',
      'Depósito PIX confirmado: ' || p_provider_order_id
    );

    -- Referral reward: exactly once, only after the referred player deposits over R$30.
    if v_pix.amount > 30 then
      select referrer.id into v_referrer_id
      from public.profiles referred
      join public.profiles referrer
        on referrer.referral_code = referred.referred_by
      where referred.id = v_pix.user_id
        and referrer.id <> referred.id
      limit 1;

      if v_referrer_id is not null then
        insert into public.referral_rewards(
          referrer_user_id, referred_user_id, pix_transaction_id, amount
        )
        values (v_referrer_id, v_pix.user_id, v_pix.id, 10.00)
        on conflict (referred_user_id) do nothing
        returning id into v_reward_id;

        if v_reward_id is not null then
          perform public.credit_wallet(
            v_referrer_id,
            10.00,
            'referral_bonus',
            'Bônus por indicação qualificada: ' || v_pix.user_id::text
          );

          update public.profiles
          set referral_count = coalesce(referral_count, 0) + 1,
              referral_earnings = coalesce(referral_earnings, 0) + 10.00,
              updated_at = timezone('utc'::text, now())
          where id = v_referrer_id;
        end if;
      end if;
    end if;

    return jsonb_build_object(
      'transaction_id', v_pix.id,
      'status', 'approved',
      'credited', true,
      'balance', v_new_balance,
      'referral_rewarded', v_reward_id is not null
    );
  end if;

  v_normalized_status := case
    when p_order_status in ('action_required', 'created') then 'pending'
    when p_order_status in ('processing', 'processed') then 'processing'
    when p_order_status in ('cancelled', 'canceled') then 'cancelled'
    when p_order_status = 'expired' then 'expired'
    when p_order_status in ('failed', 'rejected') then 'rejected'
    else 'pending'
  end;

  -- An approved transaction can never be downgraded by a delayed webhook.
  if v_pix.status <> 'approved' then
    update public.pix_transactions
    set provider_order_id = coalesce(provider_order_id, p_provider_order_id),
        provider_payment_id = coalesce(p_provider_payment_id, provider_payment_id),
        status = v_normalized_status,
        status_detail = p_status_detail,
        webhook_received_at = timezone('utc'::text, now()),
        updated_at = timezone('utc'::text, now())
    where id = v_pix.id;
  end if;

  return jsonb_build_object(
    'transaction_id', v_pix.id,
    'status', case when v_pix.status = 'approved' then 'approved' else v_normalized_status end,
    'credited', false
  );
end;
$function$;

revoke all on function public.reconcile_mercado_pago_order(text,text,text,text,text,numeric,timestamptz)
  from public, anon, authenticated;
grant execute on function public.reconcile_mercado_pago_order(text,text,text,text,text,numeric,timestamptz)
  to service_role;

create or replace function public.create_withdrawal_request(
  p_user_id uuid,
  p_amount numeric,
  p_pix_key text,
  p_pix_key_type text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_balance numeric(14,2);
  v_request_id uuid;
begin
  if p_user_id is null then raise exception 'Usuário obrigatório.'; end if;
  if p_amount is null or p_amount < 30 or p_amount > 100000 or p_amount <> round(p_amount, 2) then
    raise exception 'O saque deve ser entre R$ 30,00 e R$ 100.000,00, com no máximo 2 casas decimais.';
  end if;
  if nullif(pg_catalog.btrim(p_pix_key), '') is null or char_length(pg_catalog.btrim(p_pix_key)) > 180 then
    raise exception 'Chave PIX inválida.';
  end if;
  if upper(p_pix_key_type) not in ('CPF','CNPJ','EMAIL','TELEFONE','ALEATORIA') then
    raise exception 'Tipo de chave PIX inválido.';
  end if;

  select balance into v_balance
  from public.wallets
  where user_id = p_user_id
  for update;

  if not found then raise exception 'Carteira não encontrada.'; end if;
  if v_balance < p_amount then raise exception 'Saldo insuficiente.'; end if;

  update public.wallets
  set balance = balance - p_amount,
      locked_balance = locked_balance + p_amount,
      updated_at = timezone('utc'::text, now())
  where user_id = p_user_id;

  insert into public.withdraw_requests(user_id, amount, pix_key, pix_key_type, status)
  values (p_user_id, p_amount, pg_catalog.btrim(p_pix_key), upper(p_pix_key_type), 'pending')
  returning id into v_request_id;

  insert into public.balance_logs(
    user_id, amount, balance_before, balance_after, operation_type, description
  ) values (
    p_user_id, -p_amount, v_balance, v_balance - p_amount,
    'withdraw_reserve', 'Saldo reservado para saque ' || v_request_id::text
  );

  return v_request_id;
end;
$function$;

revoke all on function public.create_withdrawal_request(uuid,numeric,text,text)
  from public, anon, authenticated;
grant execute on function public.create_withdrawal_request(uuid,numeric,text,text)
  to service_role;
