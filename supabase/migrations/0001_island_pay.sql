-- Island Pay ledger foundation. Monetary values are integer minor units.
create extension if not exists pgcrypto;

create table if not exists public.ip_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists public.ip_customer_balances (
  user_id uuid not null references auth.users(id),
  currency char(3) not null,
  available_minor bigint not null default 0 check (available_minor >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, currency)
);

create table if not exists public.ip_deposits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id),
  provider text not null,
  provider_payment_id text not null,
  currency char(3) not null,
  gross_minor bigint not null check (gross_minor > 0),
  customer_credit_minor bigint not null check (customer_credit_minor >= 0),
  company_fee_minor bigint not null check (company_fee_minor >= 0),
  status text not null default 'pending'
    check (status in ('pending','succeeded','failed','reversed','refunded')),
  provider_event_id text unique,
  created_at timestamptz not null default now(),
  succeeded_at timestamptz,
  unique(provider, provider_payment_id),
  check (customer_credit_minor + company_fee_minor = gross_minor)
);

create table if not exists public.ip_company_balances (
  currency char(3) primary key,
  available_minor bigint not null default 0 check (available_minor >= 0),
  withdrawn_minor bigint not null default 0 check (withdrawn_minor >= 0),
  updated_at timestamptz not null default now()
);

create table if not exists public.ip_ledger (
  id uuid primary key default gen_random_uuid(),
  deposit_id uuid references public.ip_deposits(id),
  user_id uuid references auth.users(id),
  currency char(3) not null,
  account_type text not null check (account_type in ('customer_credit','company_revenue','company_withdrawal','reversal')),
  entry_type text not null check (entry_type in ('credit','debit')),
  amount_minor bigint not null check (amount_minor > 0),
  memo text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.ip_withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  currency char(3) not null,
  amount_minor bigint not null check (amount_minor > 0),
  destination_type text not null check (destination_type in ('bank','crypto')),
  destination_label text not null,
  status text not null default 'requested'
    check (status in ('requested','approved','processing','paid','rejected','failed')),
  requested_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  provider_reference text
);

create table if not exists public.ip_email_events (
  id uuid primary key default gen_random_uuid(),
  recipient text not null,
  event_type text not null,
  related_id uuid,
  status text not null default 'queued',
  created_at timestamptz not null default now()
);

-- RLS: customers can read only their own balances/deposits/ledger.
alter table public.ip_profiles enable row level security;
alter table public.ip_customer_balances enable row level security;
alter table public.ip_deposits enable row level security;
alter table public.ip_ledger enable row level security;
alter table public.ip_company_balances enable row level security;
alter table public.ip_withdrawal_requests enable row level security;
alter table public.ip_email_events enable row level security;

create policy "profile self read" on public.ip_profiles for select
  using (auth.uid() = user_id);
create policy "balance self read" on public.ip_customer_balances for select
  using (auth.uid() = user_id);
create policy "deposit self read" on public.ip_deposits for select
  using (auth.uid() = user_id);
create policy "ledger self read" on public.ip_ledger for select
  using (auth.uid() = user_id);
-- No client-side write policies. Server functions use service role.

-- Atomically applies a provider-confirmed successful deposit.
create or replace function public.ip_apply_successful_deposit(
  p_provider text,
  p_provider_payment_id text,
  p_provider_event_id text,
  p_user_id uuid,
  p_currency char(3),
  p_gross_minor bigint
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_credit bigint;
  v_fee bigint;
  v_deposit_id uuid;
  v_existing public.ip_deposits%rowtype;
begin
  if p_gross_minor <= 0 then raise exception 'Invalid deposit amount'; end if;
  if p_currency !~ '^[A-Z]{3}$' then raise exception 'Invalid currency'; end if;

  -- Integer half-up rounding for 8.88% fee.
  v_fee := (p_gross_minor * 888 + 5000) / 10000;
  v_credit := p_gross_minor - v_fee;

  insert into public.ip_deposits(
    user_id, provider, provider_payment_id, currency, gross_minor,
    customer_credit_minor, company_fee_minor, status, provider_event_id, succeeded_at
  ) values (
    p_user_id, p_provider, p_provider_payment_id, p_currency, p_gross_minor,
    v_credit, v_fee, 'succeeded', p_provider_event_id, now()
  )
  on conflict (provider, provider_payment_id) do nothing
  returning id into v_deposit_id;

  if v_deposit_id is null then
    select * into v_existing from public.ip_deposits
      where provider = p_provider and provider_payment_id = p_provider_payment_id
      for update;
    if v_existing.status = 'succeeded' then
      return jsonb_build_object('duplicate', true, 'deposit_id', v_existing.id);
    end if;
    raise exception 'Existing deposit requires manual reconciliation';
  end if;

  insert into public.ip_customer_balances(user_id, currency, available_minor)
    values (p_user_id, p_currency, v_credit)
    on conflict (user_id, currency) do update
      set available_minor = ip_customer_balances.available_minor + excluded.available_minor,
          updated_at = now();

  insert into public.ip_company_balances(currency, available_minor)
    values (p_currency, v_fee)
    on conflict (currency) do update
      set available_minor = ip_company_balances.available_minor + excluded.available_minor,
          updated_at = now();

  insert into public.ip_ledger(deposit_id,user_id,currency,account_type,entry_type,amount_minor,memo)
    values
      (v_deposit_id,p_user_id,p_currency,'customer_credit','credit',v_credit,'91.12% customer credit allocation'),
      (v_deposit_id,null,p_currency,'company_revenue','credit',v_fee,'8.88% Island Pay gross platform fee');

  return jsonb_build_object(
    'duplicate', false, 'deposit_id', v_deposit_id,
    'customer_credit_minor', v_credit, 'company_fee_minor', v_fee
  );
end;
$$;

revoke all on function public.ip_apply_successful_deposit(text,text,text,uuid,char,bigint) from public, anon, authenticated;
grant execute on function public.ip_apply_successful_deposit(text,text,text,uuid,char,bigint) to service_role;

-- Company balance is server/admin-only. No customer SELECT policy is created.
