-- eKasi Kota Hub — Supabase Schema
-- Single-owner takeaway ordering backend.

create extension if not exists "pgcrypto";

-- Owners (one row per shop owner, linked to auth.users)
create table owners (
  id uuid primary key references auth.users(id) on delete cascade,
  phone text not null,                    -- WhatsApp number for owner notifications
  pay_instructions text default '',
  wait_time_minutes int default 15,
  shop_open boolean default true,
  created_at timestamptz default now()
);

-- Menu items
create table menu_items (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references owners(id) on delete cascade,
  name text not null,
  description text default '',
  emoji text default '🍽️',
  photo_url text,
  price_cents int not null check (price_cents >= 0),
  available boolean default true,
  sort_order int default 0,
  created_at timestamptz default now()
);

-- Orders (inserted ONLY by the place-order Edge Function,
-- using the service role key — never directly by a client)
create table orders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references owners(id) on delete cascade,
  order_number int not null,
  customer_name text not null,
  customer_phone text not null,
  notes text default '',
  payment_method text not null check (payment_method in ('cash','online')),
  status text not null default 'new' check (status in ('new','ready','done','cancelled')),
  total_cents int not null check (total_cents >= 0),
  wait_time_minutes int not null,
  created_at timestamptz default now()
);

-- Line items snapshot at time of order — price never changes retroactively
-- even if the menu price changes later.
create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  menu_item_id uuid references menu_items(id) on delete set null,
  name text not null,
  price_cents int not null,
  qty int not null check (qty > 0)
);

-- Rate limiting ledger — one row per order attempt, keyed by phone
create table order_rate_limits (
  id uuid primary key default gen_random_uuid(),
  customer_phone text not null,
  created_at timestamptz default now()
);
create index idx_rate_limits_phone_time on order_rate_limits (customer_phone, created_at);

-- Per-owner order number counter (atomic increment via function below)
create table order_counters (
  owner_id uuid primary key references owners(id) on delete cascade,
  last_number int not null default 0
);

create or replace function next_order_number(p_owner_id uuid)
returns int
language plpgsql
as $$
declare
  v_number int;
begin
  insert into order_counters (owner_id, last_number)
  values (p_owner_id, 1)
  on conflict (owner_id) do update set last_number = order_counters.last_number + 1
  returning last_number into v_number;
  return v_number;
end;
$$;

-- ROW LEVEL SECURITY
alter table owners enable row level security;
alter table menu_items enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table order_rate_limits enable row level security;
alter table order_counters enable row level security;

-- Owners: anyone can read (needed for the public menu page to show shop
-- status, wait time, and payment instructions — same info already shown
-- to any customer who places an order). Only the owner can update.
create policy "public reads owner shop info" on owners
  for select using (true);
create policy "owner updates own profile" on owners
  for update using (auth.uid() = id);

-- Menu: public can read available items, owner has full control of their own
create policy "public reads available menu" on menu_items
  for select using (available = true or auth.uid() = owner_id);
create policy "owner manages own menu" on menu_items
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- Orders: NO insert policy for anon/authenticated at all.
-- Every order must go through the place-order Edge Function (service role).
-- Owner can read and update status on their own orders. Customers read nothing directly.
create policy "owner reads own orders" on orders
  for select using (auth.uid() = owner_id);
create policy "owner updates own orders" on orders
  for update using (auth.uid() = owner_id);

create policy "owner reads own order items" on order_items
  for select using (
    exists (select 1 from orders o where o.id = order_items.order_id and o.owner_id = auth.uid())
  );

-- rate_limits and order_counters: no client access at all, service-role only
-- (no policies created = default deny for anon/authenticated roles)
