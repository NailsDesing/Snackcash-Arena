# SnakeCash Arena — ativação financeira

O código financeiro está preparado, mas pagamentos e saques reais permanecem bloqueados por padrão.

## Segredos das Edge Functions

Cadastre no Supabase, em **Edge Functions > Secrets**:

- `MERCADO_PAGO_ACCESS_TOKEN`: Access Token privado do Mercado Pago.
- `MERCADO_PAGO_WEBHOOK_SECRET`: assinatura secreta criada na configuração de Webhooks.
- `PAYMENTS_ENABLED`: use `true` somente depois dos testes em ambiente de teste.
- `WITHDRAWALS_ENABLED`: use `true` somente quando o processo administrativo de saque estiver pronto.
- `ALLOWED_ORIGINS`: `https://snakecash-arena.nailsdesing03.chatgpt.site`

Nunca coloque o Access Token ou a chave do webhook no HTML, no GitHub ou em variáveis públicas.

## Webhook do Mercado Pago

Configure o evento **Order (Mercado Pago)** com esta URL HTTPS:

`https://ayqdhjorcjnaqdmneyrn.supabase.co/functions/v1/mercado-pago-webhook`

Depois de salvar, copie a chave secreta gerada para `MERCADO_PAGO_WEBHOOK_SECRET` e use a ferramenta **Simular** do Mercado Pago para confirmar uma resposta HTTP 200.

## Ordem segura de ativação

1. Use credenciais de teste do Mercado Pago.
2. Configure a URL e a assinatura do webhook.
3. Ative `PAYMENTS_ENABLED=true`.
4. Gere um PIX de teste e confirme que a carteira é creditada apenas uma vez.
5. Reenvie o mesmo webhook e confirme que não há crédito duplicado.
6. Teste um valor divergente e confirme que não há crédito.
7. Só depois configure credenciais de produção.
8. Ative saques separadamente após validar o painel administrativo.

## Regras implementadas

- PIX entre R$ 10,00 e R$ 5.000,00.
- Saque mínimo de R$ 30,00.
- O cliente nunca altera diretamente o saldo real.
- O webhook é validado por HMAC e a ordem é consultada novamente no Mercado Pago.
- Confirmação e crédito são idempotentes.
- Indicação paga R$ 10,00 uma única vez após depósito real acima de R$ 30,00.
- Saque reserva o saldo até aprovação ou rejeição administrativa.

