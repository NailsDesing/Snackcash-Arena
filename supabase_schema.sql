-- ==============================================================================
-- SnakeCash Arena - Schema do Supabase (PostgreSQL)
-- Cole este script no SQL Editor do seu projeto Supabase e execute.
-- ==============================================================================

-- 1. Habilitar extensões necessárias
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Tabela de Perfis de Jogadores (vinculada ao Supabase Auth)
CREATE TABLE IF NOT EXISTS public.profiles (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    name VARCHAR(50) NOT NULL,
    email VARCHAR(120) NOT NULL UNIQUE,
    referral_code VARCHAR(12) NOT NULL UNIQUE,
    referred_by VARCHAR(12),
    referral_count INT DEFAULT 0,
    referral_earnings NUMERIC(10,2) DEFAULT 0.00,
    avatar_url TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. Tabela de Carteiras Financeiras
CREATE TABLE IF NOT EXISTS public.wallets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL UNIQUE REFERENCES public.profiles(id) ON DELETE CASCADE,
    balance NUMERIC(10,2) DEFAULT 0.00 NOT NULL CHECK (balance >= 0),
    locked_balance NUMERIC(10,2) DEFAULT 0.00 NOT NULL CHECK (locked_balance >= 0), -- valor em partida
    total_deposited NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
    total_withdrawn NUMERIC(10,2) DEFAULT 0.00 NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Tabela de Cobranças PIX (Mercado Pago)
CREATE TABLE IF NOT EXISTS public.pix_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    mp_payment_id BIGINT UNIQUE, -- ID do pagamento retornado pelo Mercado Pago
    amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
    status VARCHAR(20) DEFAULT 'pending' NOT NULL, -- pending, approved, cancelled, refunded
    qr_code TEXT, -- Código PIX Copia e Cola
    qr_code_base64 TEXT, -- Imagem do QR Code em Base64
    ticket_url TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    paid_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Tabela de Solicitações de Saque (PIX)
CREATE TABLE IF NOT EXISTS public.withdraw_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL CHECK (amount >= 30.00), -- mínimo de R$ 30,00
    pix_key VARCHAR(100) NOT NULL,
    pix_key_type VARCHAR(20) NOT NULL, -- CPF, CNPJ, EMAIL, TELEFONE, ALEATORIA
    status VARCHAR(20) DEFAULT 'pending' NOT NULL, -- pending, approved, rejected
    processed_at TIMESTAMP WITH TIME ZONE,
    rejection_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 6. Tabela de Histórico de Partidas
CREATE TABLE IF NOT EXISTS public.matches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    snake_tier NUMERIC(10,2) NOT NULL, -- 10.00 ou 20.00
    final_mass INT NOT NULL DEFAULT 0,
    amount_cashed_out NUMERIC(10,2) DEFAULT 0.00,
    result VARCHAR(30) NOT NULL, -- safe_house, killed, hazard
    duration_seconds INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 7. Tabela de Log de Auditoria de Saldo
CREATE TABLE IF NOT EXISTS public.balance_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    amount NUMERIC(10,2) NOT NULL,
    balance_before NUMERIC(10,2) NOT NULL,
    balance_after NUMERIC(10,2) NOT NULL,
    operation_type VARCHAR(50) NOT NULL, -- pix_deposit, match_entry, match_cashout, withdraw, referral_bonus
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- ==============================================================================
-- ÍNDICES PARA ALTA PERFORMANCE
-- ==============================================================================
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_referral_code ON public.profiles(referral_code);
CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_pix_mp_id ON public.pix_transactions(mp_payment_id);
CREATE INDEX IF NOT EXISTS idx_pix_status ON public.pix_transactions(status);
CREATE INDEX IF NOT EXISTS idx_withdraw_status ON public.withdraw_requests(status);

-- ==============================================================================
-- FUNÇÃO SEGURA DE TRANSAÇÃO: CREDITAR CARTEIRA (com lock atômico FOR UPDATE)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.credit_wallet(
    p_user_id UUID,
    p_amount NUMERIC(10,2),
    p_operation VARCHAR(50),
    p_description TEXT DEFAULT NULL
)
RETURNS NUMERIC(10,2)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_balance NUMERIC(10,2);
    v_new_balance NUMERIC(10,2);
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'O valor do crédito deve ser maior que zero.';
    END IF;

    -- Bloqueia a linha da carteira para prevenir condições de corrida (Race Conditions)
    SELECT balance INTO v_old_balance
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Carteira do usuário % não encontrada.', p_user_id;
    END IF;

    v_new_balance := v_old_balance + p_amount;

    UPDATE public.wallets
    SET balance = v_new_balance,
        total_deposited = CASE WHEN p_operation = 'pix_deposit' THEN total_deposited + p_amount ELSE total_deposited END,
        updated_at = timezone('utc'::text, now())
    WHERE user_id = p_user_id;

    -- Registrar log de auditoria
    INSERT INTO public.balance_logs (user_id, amount, balance_before, balance_after, operation_type, description)
    VALUES (p_user_id, p_amount, v_old_balance, v_new_balance, p_operation, p_description);

    RETURN v_new_balance;
END;
$$;

-- ==============================================================================
-- FUNÇÃO SEGURA DE TRANSAÇÃO: DEBITAR CARTEIRA (com verificação e lock atômico)
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.debit_wallet(
    p_user_id UUID,
    p_amount NUMERIC(10,2),
    p_operation VARCHAR(50),
    p_description TEXT DEFAULT NULL
)
RETURNS NUMERIC(10,2)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_old_balance NUMERIC(10,2);
    v_new_balance NUMERIC(10,2);
BEGIN
    IF p_amount <= 0 THEN
        RAISE EXCEPTION 'O valor do débito deve ser maior que zero.';
    END IF;

    SELECT balance INTO v_old_balance
    FROM public.wallets
    WHERE user_id = p_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Carteira do usuário % não encontrada.', p_user_id;
    END IF;

    IF v_old_balance < p_amount THEN
        RAISE EXCEPTION 'Saldo insuficiente. Disponível: %, Solicitado: %', v_old_balance, p_amount;
    END IF;

    v_new_balance := v_old_balance - p_amount;

    UPDATE public.wallets
    SET balance = v_new_balance,
        updated_at = timezone('utc'::text, now())
    WHERE user_id = p_user_id;

    -- Registrar log de auditoria
    INSERT INTO public.balance_logs (user_id, amount, balance_before, balance_after, operation_type, description)
    VALUES (p_user_id, -p_amount, v_old_balance, v_new_balance, p_operation, p_description);

    RETURN v_new_balance;
END;
$$;

-- ==============================================================================
-- TRIGGER AUTOMÁTICO: CRIAÇÃO DE PERFIL E CARTEIRA NO SIGNUP
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
DECLARE
    v_name TEXT;
    v_ref_code TEXT;
    v_referred_by TEXT;
BEGIN
    v_name := COALESCE(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1));
    v_referred_by := new.raw_user_meta_data->>'referred_by';
    -- Gera código de indicação único baseado nos primeiros 6 caracteres do UUID
    v_ref_code := 'SC' || UPPER(SUBSTRING(new.id::text FROM 1 FOR 6));

    INSERT INTO public.profiles (id, name, email, referral_code, referred_by)
    VALUES (new.id, v_name, new.email, v_ref_code, v_referred_by);

    INSERT INTO public.wallets (user_id, balance)
    VALUES (new.id, 0.00);

    RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Disparador no evento de novo cadastro no Auth
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ==============================================================================
-- ROW LEVEL SECURITY (RLS) - SEGURANÇA POR LINHA
-- ==============================================================================
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pix_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.withdraw_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.balance_logs ENABLE ROW LEVEL SECURITY;

-- Usuários só leem seus próprios dados
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can view own wallet" ON public.wallets FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can view own pix transactions" ON public.pix_transactions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can view own withdraw requests" ON public.withdraw_requests FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert withdraw requests" ON public.withdraw_requests FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can view own matches" ON public.matches FOR SELECT USING (auth.uid() = user_id);
