# Hardware Bot na Cloudflare

O Worker encaminha o cron a um Durable Object SQLite. O objeto reutiliza o filtro existente e guarda cursores independentes de Telegram e WhatsApp. Não depende do PC nem do cache do GitHub. O endereço workers.dev e as prévias públicas começam desativados; não existe rota HTTP de envio ou leitura de estado.

O cron `* 0-1,10-23 * * *` usa UTC: a cada minuto entre 07:00 e 22:59 em São Paulo. O monitor verifica também a hora real antes de consultar/enviar. Cron, prévia da TJ e CallMeBot não oferecem entrega instantânea garantida.

## Verificação local

Requer Node 24+. As dependências são somente ferramentas de desenvolvimento, fixadas no lockfile.

```sh
npm ci --ignore-scripts
npm test
npm run test:runtime
```

O teste de runtime usa respostas locais e chaves fictícias, sem mensagens reais. O pacote publicável fica em `dist/worker.js`. `npm run deploy` requer acesso à conta Cloudflare pessoal do proprietário. Não exige login do GitHub CLI ou acesso a organizações.

## Recursos e credenciais

Usar apenas Workers Free com a classe SQLite `HardwareMonitor`, binding `MONITOR` e migração `v1`, conforme `wrangler.jsonc`. Não habilitar plano pago automaticamente.

Em **Settings → Variables and Secrets**, o proprietário insere diretamente quatro **Secrets**:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `WHATSAPP_PHONE`
- `CALLMEBOT_API_KEY`

Nunca recuperar Secrets do GitHub, decriptar configurações locais ou colar valores em chat, arquivos e logs. O CallMeBot recebe o número, chave e texto para entregar a mensagem, assim como no monitor atual.

## Modos

Variável de texto `MONITOR_MODE`:

- `disabled` (padrão): não consulta nem envia.
- `dry-run`: consulta e registra contagens; não envia nem avança cursores. Respeita o horário.
- `test`: envia um teste por canal para cada `TEST_RUN_ID` novo (até 64 letras, números, hífens ou sublinhados). Persiste o aceite para não repetir. Este teste explícito pode ocorrer fora do horário.
- `live`: monitoramento normal; exige os cursores de migração para cada canal ainda não inicializado.

Os testes usam o mesmo cron, não um endereço público. Após confirmar um teste, trocar para `disabled` ou prosseguir com o corte. Se faltar credencial de um canal, o outro ainda pode ser testado; o job registra falha sanitizada para o canal pendente.

Somente no modo `test`, `TEST_READ_FEED=true` inclui uma leitura diagnóstica da prévia pública, mesmo fora do horário. Ela ocorre uma vez por `TEST_RUN_ID`, registra apenas quantidade/último ID e não filtra ofertas nem altera cursores de produção. Para um teste explícito fora do horário, o cron pode ser temporariamente `* * * * *`; restaurar imediatamente o cron autorizado após o teste.

## Corte e reversão

1. Publicar inicialmente desativado, mantendo o GitHub intacto.
2. Inserir Secrets; executar `dry-run` na nuvem e conferir resultado/CPU. Executar `test` com ID único e confirmar ambos os recebimentos no celular.
3. Desativar o workflow **Ofertas TJGaming** no GitHub e aguardar qualquer job em andamento. Continuar somente após uma execução bem-sucedida dos dois canais.
4. Ler os últimos cursores nos resumos sanitizados desse job e definir as variáveis de texto `INITIAL_TELEGRAM_CURSOR` e `INITIAL_WHATSAPP_CURSOR`. Não substituir esses valores pelo post mais recente: isso descartaria avisos pendentes.
5. Ativar `MONITOR_MODE=live`. O primeiro tick grava os cursores antes da consulta; os seguintes usam o estado durável. Conferir várias execuções reais separadas por aproximadamente um minuto.
6. Manter o GitHub desativado. Nunca deixar os dois monitores ativos simultaneamente.

Antes do corte, qualquer falha mantém a Cloudflare em `disabled` e o GitHub ativo. Para reverter após o corte, primeiro desativar a Cloudflare, transportar os cursores atuais ao monitor antigo e só então reativar o GitHub. Reativar um cache antigo cegamente pode repetir avisos.

Há cerca de 960 consultas por dia na janela autorizada, usando um único objeto sem conexões permanentes. Validar uso e cotas no painel. Cursores e aceites são persistidos por canal; timeout após aceite externo ainda pode repetir um aviso, pois os serviços de entrega não participam da transação do banco.

Fontes: [Cron](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [Durable Objects Free](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
