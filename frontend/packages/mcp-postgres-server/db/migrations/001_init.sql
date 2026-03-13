-- Initial schema and seed data for MCP demo database.

-- Domain types
create type order_status as enum ('pending', 'paid', 'shipped', 'cancelled');

-- Tables
create table if not exists public.users (
    id serial primary key,
    name text not null,
    email text unique,
    created_at timestamptz default now()
);

create table if not exists public.orders (
    id serial primary key,
    user_id int not null references public.users(id),
    amount numeric(10,2) not null,
    status order_status not null default 'pending',
    created_at timestamptz default now()
);

-- Seed data
insert into public.users (name, email)
values
    ('Alice', 'alice@example.com'),
    ('Bob', 'bob@example.com'),
    ('Carol', 'carol@example.com')
on conflict do nothing;

insert into public.orders (user_id, amount, status)
values
    (1, 120.50, 'paid'),
    (1, 75.00, 'shipped'),
    (2, 32.25, 'pending')
on conflict do nothing;

