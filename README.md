# Muli Ride (Cloudflare Pages + Functions + D1)
Customer, driver (#/driver) and admin (#/admin) apps in `public/index.html`; API in `functions/api/[[path]].js`.

## Deploy
1. `npm i -g wrangler && wrangler login`
2. `wrangler d1 create muli-ride` -> paste the `database_id` into `wrangler.toml`
3. `wrangler d1 execute muli-ride --remote --file=schema.sql`
4. `wrangler pages project create muli-ride --production-branch main`
5. Secrets: `wrangler pages secret put ADMIN_PASSWORD --project-name muli-ride` and `... TOKEN_SECRET ...` (use a long random string)
6. `wrangler pages deploy` (or connect this git repo in the dashboard: no build command, output dir `public`, then add the D1 binding `DB` and the two secrets under Settings)
7. Pages project -> Custom domains -> `muliride.sinfia.net` (auto if sinfia.net DNS is on Cloudflare; otherwise CNAME to `muli-ride.pages.dev`)
8. Open `/#/admin`, log in, load default locations, set fares, add drivers (phone + PIN).

## Notes
- Prices are computed on the server. Night surcharge uses Maldives time (UTC+5).
- Multi-island: every table has an `island` column; the API currently uses the constant `ISL='muli'`.
- Not included yet: push notifications, WhatsApp/SMS, online payment, per-island admins.
