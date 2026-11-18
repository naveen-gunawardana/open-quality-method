# Homepage headline experiment v1

Only the homepage H1 text changes. Equal 10% allocation using cryptographic random assignment, sticky in this browser's localStorage. The current wording is the control. No query-string override or public results endpoint. Disabled storage gets the control and is excluded. Crawlers and the initial server-rendered page retain the original heading.

| Arm | Headline |
| --- | --- |
| 0 | Stop TikTok from compressing your video. |
| 1 | The first free 4K TikTok upload method. |
| 2 | Your 4K video. Ready for TikTok. |
| 3 | Upload to TikTok. Keep it in 4K. |
| 4 | Better TikTok quality. Zero upload fees. |
| 5 | 4K TikTok uploads. A free method. |
| 6 | Stop blurry uploads. Start with OQM. |
| 7 | Your edits deserve better TikTok quality. |
| 8 | 1080p. 4K. 60 fps. One free upload method. |
| 9 | A free upload method. Built for TikTok editors. |

Arm 1 uses the owner's supplied claim that OQM is the first free 4K method; this implementation does not independently establish that historical claim. Upload wording expresses the product proposition, not a guarantee of TikTok retention.

## Rollout

1. Apply `supabase/headline_exposures.sql` in the production Supabase SQL editor. It adds one RLS-protected server-only table and does not touch the patch counter or conversion schema.
2. Deploy the code. GET `/api/experiments/headline` must return 204. While storage is unavailable (503), all visitors see the control and no assignments are created.
3. Confirm a visible homepage generates POST 204 and exactly one exposure row per experiment/browser. Reload retains the same headline. Hidden tabs and below-the-fold headings do not record new exposure until visible.
4. Start a patch via `/convert`. Its existing analytics events should contain `settings.headline` with matching experiment, visitor and variant. Direct converter visits without prior exposure are not assigned.
5. Run the read-only `supabase/headline_results.sql`, or use `node --env-file=<server env file> scripts/headline-report.mjs [ISO cohort start]` for aggregate funnel results and per-arm Wilson intervals. Do not put credentials in the repository or paste them into a chat.

Primary metric: exposed browsers with at least one `succeeded` conversion / exposed browsers. Secondary: browsers starting a run and clicking download / exposed browsers. Repeats and comparison outputs count once per browser. These are browser identities, not people; storage clearing and separate devices create new identities. Successful patches mean local checks passed, not TikTok retention. Missing reports, blockers, and exposure-write failures can reduce coverage.

Keep allocation and wording fixed during measurement. Ten arms split traffic substantially. Review sample counts and follow-up time before comparing; the intervals are per-arm uncertainty estimates, not a multiple-comparison-adjusted winner declaration. Do not automatically promote a winner from sparse results. Change the experiment ID and table constraints for a new test; do not reuse v1 for different text. To stop immediately, return 503 from the readiness GET; historical results remain available.
