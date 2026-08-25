import * as functions from "firebase-functions";
import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

const RATE_LIMIT_WINDOW_MINUTES = 10;
const RATE_LIMIT_MAX_ORDERS = 3;

interface OrderItemReq {
  menu_item_id: string;
  qty: number | string;
}

export const placeOrder = functions.https.onCall(async (data, context) => {
  try {
    const { owner_id, customer_name, customer_phone, notes, payment_method, items } = data || {};

    if (!owner_id || !customer_name || !customer_phone || !payment_method || !Array.isArray(items) || items.length === 0) {
      throw new functions.https.HttpsError("invalid-argument", "Missing required fields");
    }

    const cleanPhone = String(customer_phone).replace(/\D/g, "");
    if (!/^\d{9,15}$/.test(cleanPhone)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid phone number");
    }

    if (!["cash", "online"].includes(payment_method)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid payment method");
    }

    // Rate limiting check
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MINUTES * 60_000);
    const rateLimitsSnap = await db
      .collection("order_rate_limits")
      .where("customer_phone", "==", cleanPhone)
      .where("created_at", ">=", windowStart)
      .get();

    if (rateLimitsSnap.size >= RATE_LIMIT_MAX_ORDERS) {
      throw new functions.https.HttpsError(
        "resource-exhausted",
        "Too many orders placed recently. Please wait a few minutes."
      );
    }

    // Shop must be open
    const ownerDoc = await db.collection("owners").doc(owner_id).get();
    if (!ownerDoc.exists) {
      throw new functions.https.HttpsError("not-found", "Shop not found");
    }
    const ownerData = ownerDoc.data() || {};
    if (!ownerData.shop_open) {
      throw new functions.https.HttpsError("failed-precondition", "Shop is currently closed");
    }

    // Re-price items server-side from Firestore menu_items
    const orderItemRows: Array<{ menu_item_id: string; name: string; price_cents: number; qty: number }> = [];
    let total_cents = 0;

    for (const reqItem of items as OrderItemReq[]) {
      const menuDoc = await db.collection("menu_items").doc(reqItem.menu_item_id).get();
      if (!menuDoc.exists) {
        throw new functions.https.HttpsError("not-found", `Item not found: ${reqItem.menu_item_id}`);
      }
      const menuItem = menuDoc.data() || {};
      if (menuItem.owner_id !== owner_id) {
        throw new functions.https.HttpsError("permission-denied", "Menu item does not belong to shop");
      }
      if (!menuItem.available) {
        throw new functions.https.HttpsError("failed-precondition", `${menuItem.name || "Item"} is sold out`);
      }

      const qty = parseInt(String(reqItem.qty), 10);
      if (!Number.isInteger(qty) || qty <= 0 || qty > 50) {
        throw new functions.https.HttpsError("invalid-argument", "Invalid quantity");
      }

      const itemTotal = (menuItem.price_cents || 0) * qty;
      total_cents += itemTotal;
      orderItemRows.push({
        menu_item_id: menuDoc.id,
        name: menuItem.name || "Item",
        price_cents: menuItem.price_cents || 0,
        qty,
      });
    }

    // Transaction for atomic order_number counter
    const counterRef = db.collection("order_counters").doc(owner_id);
    const orderRef = db.collection("orders").doc();

    const orderNumber = await db.runTransaction(async (transaction) => {
      const counterDoc = await transaction.get(counterRef);
      let lastNumber = 0;
      if (counterDoc.exists) {
        lastNumber = counterDoc.data()?.last_number || 0;
      }
      const nextNumber = lastNumber + 1;
      transaction.set(counterRef, { last_number: nextNumber }, { merge: true });

      const now = admin.firestore.FieldValue.serverTimestamp();
      transaction.set(orderRef, {
        owner_id,
        order_number: nextNumber,
        customer_name: String(customer_name).trim().slice(0, 100),
        customer_phone: cleanPhone,
        notes: String(notes || "").trim().slice(0, 500),
        payment_method,
        total_cents,
        wait_time_minutes: ownerData.wait_time_minutes || 15,
        status: "new",
        created_at: now,
        order_items: orderItemRows,
      });

      return nextNumber;
    });

    // Record rate limit attempt
    await db.collection("order_rate_limits").add({
      customer_phone: cleanPhone,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Send WhatsApp notification if token is set
    await notifyOwnerWhatsApp(ownerData, orderNumber, customer_name, cleanPhone, notes, payment_method, total_cents, orderItemRows);

    return {
      order_id: orderRef.id,
      order_number: orderNumber,
      total_cents,
      wait_time_minutes: ownerData.wait_time_minutes || 15,
      pay_instructions: payment_method === "online" ? ownerData.pay_instructions : null,
    };
  } catch (err: any) {
    console.error("placeOrder error:", err);
    if (err instanceof functions.https.HttpsError) {
      throw err;
    }
    throw new functions.https.HttpsError("internal", err.message || "Could not place order");
  }
});

async function notifyOwnerWhatsApp(
  owner: any,
  orderNumber: number,
  customerName: string,
  customerPhone: string,
  notes: string,
  paymentMethod: string,
  totalCents: number,
  items: any[]
) {
  const fonnteToken = process.env.FONNTE_TOKEN;
  if (!fonnteToken || !owner.phone) return;

  const itemsText = items
    .map((i) => `• ${i.qty}× ${i.name} (R${((i.price_cents * i.qty) / 100).toFixed(0)})`)
    .join("\n");

  const message =
    `🔔 NEW ORDER #${orderNumber} — eKasi Kota Hub\n\n` +
    `${customerName}\n${customerPhone}\n\n` +
    `${itemsText}\n\n` +
    `Total: R${(totalCents / 100).toFixed(0)}\n` +
    `Payment: ${paymentMethod === "cash" ? "Cash on Pickup" : "Online"}` +
    (notes ? `\n\nNotes: ${notes}` : "");

  try {
    await fetch("https://api.fonnte.com/send", {
      method: "POST",
      headers: { Authorization: fonnteToken, "Content-Type": "application/json" },
      body: JSON.stringify({ target: owner.phone, message }),
    });
  } catch (e) {
    console.error("WhatsApp notification error:", e);
  }
}
