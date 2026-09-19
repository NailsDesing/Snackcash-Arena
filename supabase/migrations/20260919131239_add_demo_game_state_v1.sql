begin;

create table if not exists public.demo_game_state (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  balance numeric not null default 0.00,
  updated_at timestamp with time zone not null default timezone('utc'::text, now()),
  constraint demo_game_state_balance_check
    check (balance >= 0 and balance <= 100000 and balance = round(balance, 2))
);

alter table public.demo_game_state enable row level security;

revoke all on table public.demo_game_state from anon, authenticated;
grant select, insert on table public.demo_game_state to authenticated;
grant update (balance, updated_at) on public.demo_game_state to authenticated;

drop policy if exists "Users can view own demo state" on public.demo_game_state;
drop policy if exists "Users can create own demo state" on public.demo_game_state;
drop policy if exists "Users can update own demo state" on public.demo_game_state;

create policy "Users can view own demo state"
on public.demo_game_state for select to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create own demo state"
on public.demo_game_state for insert to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update own demo state"
on public.demo_game_state for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

insert into public.demo_game_state (user_id, balance)
select p.id, 0.00
from public.profiles p
on conflict (user_id) do nothing;

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

  insert into public.demo_game_state (user_id, balance)
  values (new.id, 0.00);

  return new;
end;
$function$;

revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;

commit;
