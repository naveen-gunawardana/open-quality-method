-- Apply before deploying hero-headline-v1. Independent of the public patch counter.
create table if not exists public.headline_exposures (
  experiment text not null check (experiment = 'hero-headline-v1'),
  visitor uuid not null,
  variant smallint not null check (variant between 0 and 9),
  network_hash text not null,
  created_at timestamptz not null default now(),
  primary key (experiment, visitor)
);
create index if not exists headline_exposures_network_time on public.headline_exposures(network_hash, created_at);
alter table public.headline_exposures enable row level security;
revoke all on public.headline_exposures from anon, authenticated;
grant select, insert on public.headline_exposures to service_role;
