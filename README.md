# eKasi Kota Hub

A kota & chips ordering app for a Soweto takeaway shop. Customers browse the menu and place orders from their phone; the owner manages the menu, order queue, and shop status from the same page. Orders are validated, rate-limited, and priced entirely server-side — the client never touches anything sensitive.

## What's in this repo

| File | Purpose |
|---|---|
| `index.html` | The whole front end — customer ordering flow and owner dashboard, single static file, no build step |
| `schema.sql` | Supabase Postgres schema, Row Level Security policies, and the order-numbering function |
| `place-order.ts` | Supabase Edge Function — the only path that can create an order; handles rate limiting, server-side pricing, and the WhatsApp notification |
| `backend-architecture.md` | How the pieces fit together, plus the client-side snippets that call them |

## Setup (before this will actually work)

1. Create a Supabase project.
2. Run `schema.sql` in the Supabase SQL editor.
3. Create yourself as the owner: sign up once via `supabase.auth.signInWithOtp()`, grab your `auth.users.id` from the dashboard, then insert a matching row into `owners` with your phone number, wait time, and payment instructions.
4. Deploy the Edge Function:
   ```
   supabase functions deploy place-order
   supabase secrets set FONNTE_TOKEN=your_fonnte_token
   ```
5. Open `index.html` and fill in the three config values near the top of the `<script>` block:
   ```js
   var SUPABASE_URL = 'your-project-url';
   var SUPABASE_ANON_KEY = 'your-anon-key';
   var OWNER_ID = 'your-owner-uuid';
   ```

Full detail on each step is in `backend-architecture.md`.

## A note on the config values above

The anon key is meant to be exposed client-side — Row Level Security on the database is what actually protects the data, not keeping that key secret. It's fine for this to be visible in `index.html`, including in a public repo.

**The one key that must never appear in this repo, anywhere, in any commit:** `SUPABASE_SERVICE_ROLE_KEY`. That one bypasses RLS entirely. It only ever lives in Supabase's Edge Function secrets (`supabase secrets set`), never in a file.

## Testing

Since `index.html` is a static file with no build step, the fastest way to get a shareable test link is GitHub Pages:

1. Push this repo to GitHub.
2. Go to **Settings > Pages** on the repo.
3. Under "Build and deployment," set source to **Deploy from a branch**, branch `main`, folder `/root`.
4. GitHub gives you a URL like `https://yourusername.github.io/repo-name/` — that's your live test link.

## Known limitations (by design, for now)

- Menu photos are stored as compressed base64 data URLs directly in the database rather than in object storage. Fine at small scale; move to Supabase Storage if photo volume grows.
- Customer ordering has no login — the phone number typed at checkout is the identity anchor. Security comes from the Edge Function's server-side rate limiting and validation, not from an auth wall.
