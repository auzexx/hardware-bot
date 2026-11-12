# Hardware Bot

Filtro simples em Node.js: consulta a prévia pública de `TJGOFERTASs`, compara o preço anunciado com os limites em [rules.json](rules.json) e manda uma mensagem para uma única conversa privada do Telegram. Não usa IA, não compra produtos e não precisa de computador pessoal ligado depois de publicado no GitHub Actions.

## Limites iniciais

| Componente | Preço máximo anunciado |
|---|---:|
| RTX 5070 (exceto Ti) | R$ 4.500 |
| RX 9070 (exceto XT/GRE) | R$ 4.500 |
| Ryzen 5 9600X | R$ 950 |
| Ryzen 7 9700X | R$ 1.500 |
| Gigabyte B650M D3HP AX | R$ 650 |
| DeepCool AK400 básico | R$ 140 |
| XPG Core Reactor II VE 850 W | R$ 450 |

Edite `max` em `rules.json` para mudar os valores. Eles estão em reais; `4500` significa R$ 4.500. O limite inclui igualdade. Os padrões e exclusões permitem distinguir modelos próximos. Anúncios com vários componentes monitorados ou de PCs completos são ignorados por não terem associação confiável entre cada peça e cada preço.

## Execução na nuvem

O workflow roda no runner Ubuntu padrão do GitHub, com consultas programadas a cada cinco minutos entre 07:00 e 23:00 no fuso `America/Sao_Paulo`, todos os dias. Os minutos programados são 02, 07, 12, 17, 22, 27, 32, 37, 42, 47, 52 e 57 de cada hora entre 7h e 22h. O código também verifica o horário antes de consultar e antes de enviar ofertas, para respeitar a faixa se uma execução atrasar; chamadas ao Telegram já em trânsito podem terminar depois do limite. Execuções manuais com `test_message` são testes explícitos e podem ocorrer fora dessa faixa.

O GitHub permite intervalo mínimo de cinco minutos para agendamentos. Os horários podem atrasar ou ser descartados por carga do GitHub: não é monitoramento em tempo real. Runners padrão em repositórios públicos são gratuitos conforme as regras atuais do GitHub. O GitHub pode desativar agendamentos de repositórios públicos após 60 dias sem atividade: consulte a aba Actions se os envios pararem.

Cadastre em **Settings → Secrets and variables → Actions**:

- `TELEGRAM_BOT_TOKEN`: token do bot criado no BotFather.
- `TELEGRAM_CHAT_ID`: identificador positivo da conversa privada já pareada.

Não colocar credenciais no código, no arquivo de regras, nos logs ou em comentários. O código é público se publicado nessa modalidade; token e destinatário ficam nos Secrets. Nenhum arquivo da configuração local do Windows deve ser publicado.

Para testar na nuvem: **Actions → Ofertas TJGaming → Run workflow**, marque `test_message`. Essa execução envia apenas o aviso de teste. Depois rode novamente sem marcar para inicializar o cursor.

Na primeira consulta, o filtro guarda a última publicação sem enviar o histórico. O estado do cursor é salvo em cache do Actions. Se o cache for apagado ou expirar, a próxima consulta reinicializa sem enviar posts antigos; pode haver perda de alertas nesse intervalo. Envios aceitos são registrados antes de avançar o cursor; uma falha não descarta os posts pendentes. Em caso de timeout após um POST, não há como garantir que o Telegram não tenha recebido a mensagem, portanto uma execução posterior pode repetir esse aviso.

A consulta busca até dez páginas para alcançar o cursor, ignora publicações com mais de dois dias e preserva o cursor se a prévia ficar indisponível ou mudar de formato. Não inclui o bot no canal da TJ nem acessa a conta pessoal do Telegram. Usa somente a prévia pública da web, que pode mudar ou ficar indisponível.

**Preço do canal:** o filtro não verifica estoque, vendedor, frete ou validade de cupons na loja. Cada aviso contém o link da publicação para conferir essas condições. Ele ignora parcelas e valores identificados como preço antigo, desconto ou frete. Publicações ambíguas podem ser ignoradas em vez de gerar alerta falso.

## Verificação local

Requer Node.js 24 ou superior, sem instalação de pacotes:

```sh
node --test test/monitor.test.mjs
node src/run.mjs --dry-run
```

O modo `--dry-run` apenas lê a prévia pública e mostra contagens; não envia mensagens nem grava o cursor. Para o modo de envio, use variáveis de ambiente para os dois segredos; não os passe como argumentos.

Fontes: [Agendamentos](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [custos](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [inativação de workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/disable-and-enable-workflows), [prévia do canal](https://t.me/s/TJGOFERTASs).
