// node --env-file=<server env file> scripts/headline-report.mjs [ISO cohort start]
// Prints aggregates only, never browser IDs or network hashes.
import { createClient } from '@supabase/supabase-js';
const since=process.argv[2] ?? '2026-11-18T00:00:00Z';
if(!Number.isFinite(Date.parse(since))) throw new Error('Pass an ISO cohort start timestamp');
const db=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
async function rows(table,columns,order) {
  const result=[];
  for(let offset=0;;offset+=1000) {
    const {data,error}=await db.from(table).select(columns).gte('created_at',since).order(order).range(offset,offset+999);
    if(error) throw new Error(error.message);
    result.push(...data);
    if(data.length<1000) return result;
  }
}
const exposures=(await rows('headline_exposures','experiment,visitor,variant,created_at','visitor')).filter(r=>r.experiment==='hero-headline-v1');
const events=await rows('conversion_analytics','settings,event,created_at','id');
const byVisitor=new Map(exposures.map(e=>[e.visitor,e]));
const funnel=Array.from({length:10},(_,variant)=>({variant,exposed:new Set(),started:new Set(),succeeded:new Set(),downloaded:new Set()}));
for(const e of exposures) funnel[e.variant]?.exposed.add(e.visitor);
for(const e of events) {
  const h=e.settings?.headline,exposure=byVisitor.get(h?.visitor);
  if(!exposure || h.experiment!==exposure.experiment || h.variant!==exposure.variant || e.created_at<exposure.created_at) continue;
  if(['started','succeeded','downloaded'].includes(e.event)) funnel[exposure.variant][e.event].add(h.visitor);
}
const rate=(n,d)=>d ? +(100*n/d).toFixed(2) : null;
function wilson(n,d) {
  if(!d) return null;
  const z=1.96,p=n/d,den=1+z*z/d,center=(p+z*z/(2*d))/den,margin=z*Math.sqrt(p*(1-p)/d+z*z/(4*d*d))/den;
  return [+(100*(center-margin)).toFixed(2),+(100*(center+margin)).toFixed(2)];
}
console.log(JSON.stringify({experiment:'hero-headline-v1',since,asOf:new Date().toISOString(),
  metric:'Browsers with a locally successful patch / exposed browsers',
  note:'Browser IDs are not unique people. Direct /convert visits are excluded. Success is local validation, not TikTok retention. Repeats count once. Recent visitors have less follow-up time. Storage clearing and blocked reporting affect results. Ten arms need sufficient traffic and multiple-comparison-aware analysis before declaring a winner.',
  variants:funnel.map(r=>({variant:r.variant,exposed:r.exposed.size,started:r.started.size,succeeded:r.succeeded.size,downloaded:r.downloaded.size,
    startRatePct:rate(r.started.size,r.exposed.size),conversionRatePct:rate(r.succeeded.size,r.exposed.size),
    conversionRate95Pct:wilson(r.succeeded.size,r.exposed.size),downloadRatePct:rate(r.downloaded.size,r.exposed.size)}))},null,2));
