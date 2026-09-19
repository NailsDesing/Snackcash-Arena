import { createClient } from "jsr:@supabase/supabase-js@2";

const SITE_ORIGIN = "https://snakecash-arena.nailsdesing03.chatgpt.site";

function corsHeaders(req: Request) {
  const requestedOrigin = req.headers.get("origin") ?? "";
  const allowed = (Deno.env.get("ALLOWED_ORIGINS") ?? SITE_ORIGIN).split(",").map((v) => v.trim());
  return {
    "Access-Control-Allow-Origin": allowed.includes(requestedOrigin) ? requestedOrigin : allowed[0],
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
  if (Deno.env.get("WITHDRAWALS_ENABLED") !== "true") {
    return json(req, { error: "Saques reais ainda estão em fase de ativação." }, 503);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return json(req, { error: "Serviço não configurado." }, 503);

  const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) return json(req, { error: "Sessão obrigatória." }, 401);

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await admin.auth.getUser(jwt);
  if (userError || !userData.user?.id) return json(req, { error: "Sessão inválida ou expirada." }, 401);

  let body: { amount?: number; pix_key?: string; pix_key_type?: string };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Dados de saque inválidos." }, 400);
  }

  const amount = Number(body.amount);
  const pixKey = String(body.pix_key ?? "").trim();
  const pixKeyType = String(body.pix_key_type ?? "").toUpperCase();
  if (!Number.isFinite(amount) || amount < 30 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-8) {
    return json(req, { error: "O saque mínimo é R$ 30,00." }, 400);
  }

  const { data, error } = await admin.rpc("create_withdrawal_request", {
    p_user_id: userData.user.id,
    p_amount: amount,
    p_pix_key: pixKey,
    p_pix_key_type: pixKeyType,
  });
  if (error) return json(req, { error: error.message }, 400);

  return json(req, { request_id: data, status: "pending" }, 201);
});
