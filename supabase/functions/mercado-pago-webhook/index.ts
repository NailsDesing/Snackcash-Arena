import { createClient } from "jsr:@supabase/supabase-js@2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hmacSha256Hex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validSignature(req: Request, dataId: string, secret: string) {
  const signatureHeader = req.headers.get("x-signature") ?? "";
  const requestId = req.headers.get("x-request-id") ?? "";
  const parts = Object.fromEntries(signatureHeader.split(",").map((part) => part.trim().split("=", 2)));
  const timestamp = parts.ts;
  const received = parts.v1;
  if (!timestamp || !received || !requestId || !dataId) return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() - timestampNumber) > 10 * 60 * 1000) return false;

  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  const expected = await hmacSha256Hex(secret, manifest);
  return timingSafeEqual(expected, received);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Método não permitido." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const accessToken = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
  const webhookSecret = Deno.env.get("MERCADO_PAGO_WEBHOOK_SECRET");
  if (!supabaseUrl || !serviceRoleKey || !accessToken || !webhookSecret) {
    return json({ error: "Webhook não configurado." }, 503);
  }

  const url = new URL(req.url);
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // The query parameter remains the source of the resource identifier.
  }
  const bodyData = body.data as Record<string, unknown> | undefined;
  const dataId = url.searchParams.get("data.id") ?? (bodyData?.id ? String(bodyData.id) : "");
  if (!dataId || !(await validSignature(req, dataId, webhookSecret))) {
    return json({ error: "Assinatura inválida." }, 401);
  }

  // Never trust financial values from the webhook body. Re-read the order from Mercado Pago.
  const orderResponse = await fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(dataId)}`, {
    headers: { "Authorization": `Bearer ${accessToken}`, "Accept": "application/json" },
  });
  if (!orderResponse.ok) return json({ error: "Não foi possível consultar a ordem." }, 502);

  const order = await orderResponse.json();
  if (!order?.id || String(order.id) !== dataId || !order.external_reference) {
    return json({ error: "Ordem inconsistente." }, 422);
  }

  const payment = order?.transactions?.payments?.[0] ?? {};
  const paidAmount = Number(order.total_paid_amount ?? payment.paid_amount ?? 0);
  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await admin.rpc("reconcile_mercado_pago_order", {
    p_provider_order_id: String(order.id),
    p_external_reference: String(order.external_reference),
    p_provider_payment_id: payment.id ? String(payment.id) : null,
    p_order_status: String(order.status ?? "unknown"),
    p_status_detail: String(order.status_detail ?? payment.status_detail ?? "unknown"),
    p_paid_amount: paidAmount,
    p_paid_at: order.date_last_updated ?? new Date().toISOString(),
  });

  if (error) {
    console.error("PIX reconciliation failed", error.code);
    return json({ error: "Falha ao conciliar a ordem." }, 500);
  }
  return json({ received: true, result: data }, 200);
});

