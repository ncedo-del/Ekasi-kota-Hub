// supabase/functions/place-order/index.ts
//
// This is the ONLY door into the orders table. It runs with the service
// role key (server-side, never exposed to the browser) and does everything
// the old client-side code trusted blindly: validates the shop is open,
// re-prices every item from the database, enforces rate limits, and
// sends the WhatsApp notification with a token that never touches the client.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

const RATE_LIMIT_WINDOW_MINUTES = 10;
const RATE_LIMIT_MAX_ORDERS = 3;

Deno.serve(async (req) => {
  try {
    const body = await req.json();
    const { owner_id, customer_name, customer_phone, notes, payment_method, items } = body;

    if (!owner_id || !customer_name || !customer_phone || !payment_method || !Array.isArray(items) || items.length === 0) {
      return json({ error: "Missing required fields" }, 400);
    }
    const cleanPhone = String(customer_phone).replace(/\D/g, "");
    if (!/^\d{9,15}$/.test(cleanPhone)) {
      return json({ error: "Invalid phone number" }, 400);
    }
    if (!["cash", "online"].includes(payment_method)) {
      return json({ error: "Invalid payment method" }, 400);
    }

    // Rate limit: max N orders per phone number per time window
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString();
    const { count, error: rlError } = await supabaseAdmin
      .from("order_rate_limits")
      .select("*", { count: "exact", head: true })
      .eq("customer_phone", cleanPhone)
      .gte("created_at", windowStart);

    if (rlError) return json({ error: "Rate limit check failed" }, 500);
    if ((count ?? 0) >= RATE_LIMIT_MAX_ORDERS) {
      return json({ error: "Too many orders placed recently. Please wait a few minutes." }, 429);
    }

    // Shop must be open
    const { data: owner, error: ownerError } = await supabaseAdmin
      .from("owners")
      .select("*")
      .eq("id", owner_id)
      .single();

    if (ownerError || !owner) return json({ error: "Shop not found" }, 404);
    if (!owner.shop_open) return json({ error: "Shop is currently closed" }, 400);

    // Re-price every item server-side — never trust client-sent prices
    const menuIds = items.map((i: any) => i.menu_item_id);
    const { data: menuItems, error: menuError } = await supabaseAdmin
      .from("menu_items")
      .select("*")
      .in("id", menuIds)
      .eq("owner_id", owner_id);

    if (menuError) return json({ error: "Menu lookup failed" }, 500);

    const menuMap = new Map((menuItems ?? []).map((m: any) => [m.id, m]));
    let total_cents = 0;
    const orderItemRows: any[] = [];

    for (const reqItem of items) {
      const menuItem: any = menuMap.get(reqItem.menu_item_id);
      if (!menuItem) return json({ error: `Item not found: ${reqItem.menu_item_id}` }, 400);
      if (!menuItem.available) return json({ error: `${menuItem.name} is sold out` }, 400);

      const qty = parseInt(reqItem.qty, 10);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 50) {
        return json({ error: "Invalid quantity" }, 400);
      }

      total_cents += menuItem.price_cents * qty;
      orderItemRows.push({
        menu_item_id: menuItem.id,
        name: menuItem.name,
        price_cents: menuItem.price_cents,
        qty,
      });
    }

    // Atomic order number
    const { data: orderNumber, error: numError } = await supabaseAdmin
      .rpc("next_order_number", { p_owner_id: owner_id });

    if (numError) return json({ error: "Could not assign order number" }, 500);

    // Insert order
    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .insert({
        owner_id,
        order_number: orderNumber,
        customer_name: String(customer_name).trim().slice(0, 100),
        customer_phone: cleanPhone,
        notes: String(notes ?? "").trim().slice(0, 500),
        payment_method,
        total_cents,
        wait_time_minutes: owner.wait_time_minutes,
        status: "new",
      })
      .select()
      .single();

    if (orderError || !order) return json({ error: "Could not create order" }, 500);

    // Insert line items
    await supabaseAdmin
      .from("order_items")
      .insert(orderItemRows.map((r) => ({ ...r, order_id: order.id })));

    // Log this attempt for rate limiting
    await supabaseAdmin.from("order_rate_limits").insert({ customer_phone: cleanPhone });

    // Notify owner via WhatsApp (Fonnte) — token lives server-side only
    await notifyOwnerWhatsApp(owner, order, orderItemRows);

    return json({
      order_number: order.order_number,
      total_cents: order.total_cents,
      wait_time_minutes: order.wait_time_minutes,
      pay_instructions: payment_method === "online" ? owner.pay_instructions : null,
    }, 200);

  } catch (e) {
    console.error(e);
    return json({ error: "Unexpected server error" }, 500);
  }
});

async function notifyOwnerWhatsApp(owner: any, order: any, items: any[]) {
  const fonnteToken = Deno.env.get("FONNTE_TOKEN");
  if (!fonnteToken || !owner.phone) return;

  const itemsText = items
    .map((i) => `• ${i.qty}× ${i.name} (R${((i.price_cents * i.qty) / 100).toFixed(0)})`)
    .join("\n");

  const message =
    `🔔 NEW ORDER #${order.order_number} — eKasi Kota Hub\n\n` +
    `${order.customer_name}\n${order.customer_phone}\n\n` +
    `${itemsText}\n\n` +
    `Total: R${(order.total_cents / 100).toFixed(0)}\n` +
    `Payment: ${order.payment_method === "cash" ? "Cash on Pickup" : "Online"}` +
    (order.notes ? `\n\nNotes: ${order.notes}` : "");

  await fetch("https://api.fonnte.com/send", {
    method: "POST",
    headers: { Authorization: fonnteToken, "Content-Type": "application/json" },
    body: JSON.stringify({ target: owner.phone, message }),
  });
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
