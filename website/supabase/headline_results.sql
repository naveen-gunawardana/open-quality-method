-- Read-only, aggregate report. Uses all exposed browsers in this experiment.
-- Success means a locally validated patch, not TikTok upload quality.
with outcomes as (
  select e.variant, e.visitor,
    coalesce(bool_or(c.event = 'started'), false) as started,
    coalesce(bool_or(c.event = 'succeeded'), false) as succeeded,
    coalesce(bool_or(c.event = 'downloaded'), false) as downloaded
  from public.headline_exposures e
  left join public.conversion_analytics c
    on c.settings->'headline'->>'experiment' = e.experiment
    and c.settings->'headline'->>'visitor' = e.visitor::text
    and c.settings->'headline'->>'variant' = e.variant::text
    and c.created_at >= e.created_at
  where e.experiment = 'hero-headline-v1'
  group by e.variant, e.visitor
)
select v.variant,
  count(o.visitor) as exposed_browsers,
  count(*) filter (where o.started) as browsers_started,
  count(*) filter (where o.succeeded) as browsers_succeeded,
  count(*) filter (where o.downloaded) as browsers_downloaded,
  round(100.0 * count(*) filter (where o.succeeded) / nullif(count(o.visitor), 0), 2) as conversion_percent
from generate_series(0, 9) as v(variant)
left join outcomes o on o.variant = v.variant
group by v.variant order by v.variant;
