# eKasi Kota Hub — Backend Architecture

## The core rule

**Orders can only be created by calling the `place-order` Edge Function.**
The `orders` table has no INSERT policy for `anon` or `authenticated` roles at all — only the service role (used inside the Edge Function) can write to it. This is what makes rate limiting and price validation actually enforceable, instead of client-side checks an attacker can just skip by calling the API directly.

Everything else (menu reads, owner dashboard reads/updates) goes through normal Supabase client calls, protected by Row Level Security.

## Auth model

- **Owner** — real Supabase Auth (magic link recommended over password, since it's one person logging in from a phone). Their `auth.users.id` is the same as their `owners.id`.
- **Customer** — no auth at all. The phone number they type is the identity anchor, same as before. Security comes from the Edge Function's rate limiting, not from a login wall — adding OTP here would be pure friction with no real payoff, since the function is the actual gatekeeper regardless of who's calling it.

## Deploy steps

1. Run `schema.sql` in the Supabase SQL editor.
2. Create the owner manually once: sign them up via Supabase Auth (dashboard or `signInWithOtp`), then insert a matching row into `owners` with their phone, wait time, and pay instructions.
3. Set Edge Function secrets:
   ```
   supabase secrets set FONNTE_TOKEN=your_fonnte_token
   ```
   (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are already available automatically inside Edge Functions.)
4. Deploy the function:
   ```
   supabase functions deploy place-order
   ```

## Client integration (replacing the old localStorage calls)

**Placing an order** (replaces `placeOrder()`):
```js
const { data, error } = await supabase.functions.invoke('place-order', {
  body: {
    owner_id: OWNER_ID,
    customer_name: name,
    customer_phone: phone,
    notes,
    payment_method: payment, // 'cash' | 'online'
    items: cart.map(i => ({ menu_item_id: i.id, qty: i.qty })),
  }
});

if (error) {
  // data.error will contain the message, e.g. rate limit or sold-out
} else {
  // data = { order_number, total_cents, wait_time_minutes, pay_instructions }
}
```

**Owner login** (replaces the PIN pad):
```js
await supabase.auth.signInWithOtp({ email: ownerEmail });
// owner clicks the magic link -> session is set automatically
```

**Owner dashboard reading orders** (RLS enforces they only see their own):
```js
const { data: orders } = await supabase
  .from('orders')
  .select('*, order_items(*)')
  .order('created_at', { ascending: false });
```

**Realtime new-order alert** (replaces the broken `storage` event listener — this one actually works across devices):
```js
supabase
  .channel('orders-channel')
  .on('postgres_changes',
    { event: 'INSERT', schema: 'public', table: 'orders', filter: `owner_id=eq.${OWNER_ID}` },
    (payload) => {
      playDing();
      renderOwnerOrders();
    }
  )
  .subscribe();
```

**Updating order status** (owner marks ready/done — direct table update, RLS-protected):
```js
await supabase.from('orders').update({ status: 'ready' }).eq('id', orderId);
```

## What this fixes vs. the old file

| Problem in the old version | Fixed by |
|---|---|
| PIN stored in plaintext localStorage, editable via devtools | Real Supabase Auth session for the owner |
| Client sets its own item prices when placing an order | Edge Function re-prices every item from `menu_items` server-side |
| No rate limiting — anyone can spam orders | `order_rate_limits` table checked inside the Edge Function before every insert |
| "Sync" only worked across tabs on the same device | Realtime Postgres subscription, works across any device |
| Fonnte/WhatsApp token would have to live in client JS | Called from inside the Edge Function, never shipped to the browser |

## Next decision point

Want me to rewrite `index__1_.html` itself to call this backend — swap out the PIN pad, the `localStorage` save/load, and `placeOrder()` for the Supabase client calls above? That's the next piece if you want to keep moving.
