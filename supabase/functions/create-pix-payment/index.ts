import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE_ORIGIN = "https://snakecash-arena.nailsdesing03.chatgpt.site";

function corsHeaders(req: Request) {
  const requestedOrigin = req.headers.get("origin") ?? "";
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? SITE_ORIGIN)
    .split(",")
    .map((value) => value.trim());
  const origin = allowed.includes(requestedOrigin) ? requestedOrigin : allowed[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Método não permitido." }, 405);

  if (Deno.env.get("PAYMENTS_ENABLED") !== "true") {
    return json(req, { error: "PIX real ainda está em fase de ativação." }, 503);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const accessToken = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
  if (!supabaseUrl || !serviceRoleKey || !accessToken) {
    return json(req, { error: "Integração de pagamentos não configurada." }, 503);
  }

  const authHeader = req.headers.get("authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  if (!jwt) return json(req, { error: "Sessão obrigatória." }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  const user = userData.user;
  if (userError || !user?.id || !user.email) {
    return json(req, { error: "Sessão inválida ou expirada." }, 401);
  }

  let requestBody: { amount?: number };
  try {
    requestBody = await req.json();
  } catch {
    return json(req, { error: "Corpo da solicitação inválido." }, 400);
  }

  const amount = Number(requestBody.amount);
  if (!Number.isFinite(amount) || amount < 10 || amount > 5000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) {
    return json(req, { error: "Informe um valor entre R$ 10,00 e R$ 5.000,00." }, 400);
  }

  const transactionId = crypto.randomUUID();
  const idempotencyKey = crypto.randomUUID();
  const externalReference = `snakecash_${transactionId}`;
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const formattedAmount = amount.toFixed(2);

  const { error: insertError } = await admin.from("pix_transactions").insert({
    id: transactionId,
    user_id: user.id,
    amount: formattedAmount,
    status: "pending",
    provider: "mercado_pago",
    external_reference: externalReference,
    idempotency_key: idempotencyKey,
    expires_at: expiresAt,
  });
  if (insertError) return json(req, { error: "Não foi possível iniciar o PIX." }, 500);

  const mpResponse = await fetch("https://api.mercadopago.com/v1/orders", {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "X-Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      type: "online",
      total_amount: formattedAmount,
      external_reference: externalReference,
      processing_mode: "automatic",
      transactions: {
        payments: [{
          amount: formattedAmount,
          payment_method: { id: "pix", type: "bank_transfer" },
          expiration_time: "PT30M",
        }],
      },
      payer: { email: user.email },
    }),
  });

  const mpBody = await mpResponse.json().catch(() => ({}));
  if (!mpResponse.ok) {
    await admin.from("pix_transactions").update({
      status: "failed",
      failure_reason: `Mercado Pago HTTP ${mpResponse.status}`,
      updated_at: new Date().toISOString(),
    }).eq("id", transactionId);
    return json(req, { error: "O Mercado Pago não conseguiu gerar este PIX. Tente novamente." }, 502);
  }

  const payment = mpBody?.transactions?.payments?.[0] ?? {};
  const paymentMethod = payment?.payment_method ?? {};
  const { error: updateError } = await admin.from("pix_transactions").update({
    provider_order_id: String(mpBody.id ?? ""),
    provider_payment_id: payment.id ? String(payment.id) : null,
    status: mpBody.status === "action_required" ? "pending" : "processing",
    status_detail: mpBody.status_detail ?? payment.status_detail ?? null,
    qr_code: paymentMethod.qr_code ?? null,
    qr_code_base64: paymentMethod.qr_code_base64 ?? null,
    ticket_url: paymentMethod.ticket_url ?? null,
    updated_at: new Date().toISOString(),
  }).eq("id", transactionId);

  if (updateError || !mpBody.id || (!paymentMethod.qr_code && !paymentMethod.ticket_url)) {
    return json(req, { error: "PIX criado, mas os dados de pagamento não foram recebidos corretamente." }, 502);
  }

  return json(req, {
    transaction_id: transactionId,
    order_id: String(mpBody.id),
    status: "pending",
    amount: formattedAmount,
    expires_at: expiresAt,
    qr_code: paymentMethod.qr_code ?? null,
    qr_code_base64: paymentMethod.qr_code_base64 ?? null,
    ticket_url: paymentMethod.ticket_url ?? null,
  }, 201);
});
