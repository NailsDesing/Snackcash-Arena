# SnakeCash Arena

Jogo multiplayer de arena com servidor Node.js, Socket.IO e Supabase.

## Como executar

1. Instale as dependências com `npm ci`.
2. Copie `.env.example` para `.env` e preencha as configurações locais.
3. Inicie o servidor com `npm start`.

- Jogo: `dist/index.html`
- Painel administrativo: `dist/admin.html`
- Testes: `npm test`

## Estado de segurança

- A identidade financeira das partidas vem do usuário autenticado.
- Entradas, cashouts e solicitações de saque usam operações protegidas no backend.
- As RPCs financeiras do Supabase são restritas ao `service_role`.
- O painel administrativo exige `app_metadata.role = admin`.
- Pagamentos e saques reais permanecem desativados até a escolha e homologação de um provedor.

Nunca inclua o arquivo `.env` ou credenciais no repositório.
