# Validação da Fase 5 — rotinas agendadas e mensagens de áudio

Fluxo de aceite: **gravar um áudio** → conferir a transcrição → **enviar** → receber um cartão de
rotina → **confirmar** → fechar o aplicativo → o Host cumprir o horário sozinho → reencontrar o
resultado ao voltar. Arquitetura e garantias em
[rotinas e voz](bot-runtime/routines-and-voice.md); comandos do laboratório em
[laboratório](maestrly-bot-lab.md). Evidências ficam em `.host-lab/` (ignorado pelo Git).

Escopo desta entrega: `feat/maestrly-bot`, a partir de `47bb6bc` (fase 4).

## Situação

| Categoria | Itens |
| --- | --- |
| **Implementado e testado (sem hardware)** | Contratos `routine.*`/`voice.*` e a lane privada de propostas; migração 6→7 preservadora; calendário com fuso, horário de verão e intervalos sem deriva; serviço de rotinas com prévia, ativação por impressão digital, pausa, edição, arquivamento e "executar agora"; agendador durável com atraso, sobreposição, prazo de fila e watermark; admissão nas engrenagens existentes (turno para bot, run para equipe) com dono único por turno e pool único de slots; autoridade de permissões e orçamento de 24 h; propostas inertes com escopo verificado; upload, transcrição, envio, retenção e remoção de áudio; worker ASR empacotado, verificado e isolado; microfone, rascunho de voz e UI de rotinas no aplicativo. **224 testes** (14 de contrato, 147 no Host, 9 no runtime, 24 no cliente, 30 de artefato/worker/laboratório) |
| **Implementado e provado com artefatos reais** | Transcrição por Whisper base real, pelo worker empacotado, com áudio de fala de verdade; pacote de fala de 211 MiB construído e verificado arquivo a arquivo; pacote do Host 0.3.1 (schema 7) e bundle do guest com `bot.routines.v1` construídos, transferidos e conferidos por digest no mini; app Bot Lab 0.3.1 instalado nesta máquina; **9 testes de interface no app empacotado** |
| **Homologado no Mac mini** | Host **0.3.2** no ar (0.3.1 pelo kit r1+r2, 0.3.2 pelo kit r3), schema 7 migrado, anunciando `routines.v1` e `voice.messages.v1`; pacote de fala verificado arquivo a arquivo pelo próprio Host (`voice.status: ready`); VMs, bots e dados preservados; versões antigas e bundles órfãos removidos a pedido |
| **Transcrição no mini** | ✅ sem `voice.send` (nada foi enviado ao bot): upload de 116 KB em 56 ms, transcrição pelo worker do mini em 15 s (frio), 10 palavras / 54 caracteres, `state: succeeded` |
| **Agendamento com o app fechado** | ✅ **provado no mini com o Host 0.3.2**: rotina ativada para 20:58:00 UTC, nenhum aplicativo aberto; o Host disparou às 20:58:03, o bot (no guest da fase 3) respondeu "A execução programada aconteceu em 17/09/2026 às 17:58 (horário de Brasília)." e a ocorrência terminou `succeeded` às 20:58:29 — **1 ocorrência, 1 execução, 1 `turn.start`**, 14,6 s de trabalho ativo. A primeira tentativa (Host 0.3.1) disparou no horário mas não executou, por um defeito de compatibilidade corrigido no 0.3.2 |

## Portão 1 — transcrição real: **executado e aprovado**

Os insumos existiam nesta máquina: os pesos do `Xenova/whisper-base` (76 MiB, tokenizer, configs e
os dois ONNX quantizados) no cache do app instalado, e o runtime local-ML `mac-arm64` dentro do
`Maestrly App.app`. Com eles, `npm run build:host:asr` produziu um pacote de **211 MiB, 864
arquivos**, com digest de cada um.

O áudio é fala sintética gerada por `say -v Luciana` e convertida para o formato canônico
(16 kHz, mono, PCM16, 3,75 s) — fala de verdade, sem gravar ninguém.

Rodando pelo **caminho de produção** (`inspectAsrBundle` → `forkAsrWorker` → processo separado):

| Medida | Resultado |
| --- | --- |
| Verificação do pacote | `ready`, `Xenova/whisper-base`, 211 MiB, 864 arquivos conferidos |
| Dito | "Toda segunda às nove, prepare esse resumo da semana." |
| Transcrito | `Toda segunda às nove, prepare esse resumo da semana.` |
| Frio | 1611 ms (inclui hash do pacote, fork e carga do modelo) |
| Quente | 608 ms, mesmo worker |
| Silêncio | `ASR_NO_SPEECH` — nenhuma frase inventada |

Isso é o portão que o plano chamava de insubstituível por fixture. No mini, o Host 0.3.1 já
verifica esse mesmo pacote (mesmo `manifest.json`, `345b5cf7…`) e responde `voice.status: ready`;
uma transcrição **lá** ainda depende de `allowVoiceSmoke` e de um `voiceSampleFile` consentido.

### Três defeitos que só o artefato real revelou

| Defeito | Consequência se não corrigido |
| --- | --- |
| O build achatava `Xenova/whisper-base` em `models/Xenova_whisper-base` | Pacote verificaria perfeitamente e o runtime nunca acharia o modelo |
| O manifesto aceitava no máximo 200 arquivos | Todo pacote real (864) seria recusado como inválido |
| Caminhos com `@` eram recusados | Qualquer runtime com pacote npm com escopo (`@huggingface/...`) seria recusado |

Os três estão cobertos por teste em `apps/host/test/asr-worker.test.mjs`, que roda o build, a
verificação e um `fork` real.

## Portão 2 — aplicação no Mac mini: **Host no ar com rotinas e voz** (0.3.1, depois 0.3.2)

Duas aplicações administrativas, ambas com a senha digitada pela pessoa: a primeira (09:52)
instalou tudo e parou na verificação de voz; a correção (10:24) fechou o que faltava. O estado
final foi conferido de fora, por ssh sem privilégios e pelo RPC do Host vivo.

### Primeira aplicação (r1)

| Etapa | Resultado |
| --- | --- |
| Verificações e integridade da instalação | ✅ |
| Host 0.3.1, schema 7, migração 6 → 7 com cópia prévia | ✅ |
| `routines.v1` anunciado | ✅ |
| Bundle do guest com `bot.routines.v1` instalado | ✅ |
| `voice.messages.v1` anunciado | ❌ — o script abortou aqui |

O script parou exatamente onde devia: a asserção `Voice capability missing after the upgrade`
falhou **antes** de remover a versão anterior, então o rollback continuou disponível o tempo todo.
Nada foi perdido, e o Host ficou no ar com rotinas.

### A causa: um defeito meu, e um sintoma que mentia

O pacote de fala foi extraído como `drwx------` — só root. O daemon **não roda como root** (roda
como `_maestrlyhost`), então não conseguia nem entrar no diretório. Origem: meu
`build-host-asr.mjs` criava o diretório com modo `0700`, e `cp` preservou os modos de origem do
runtime e dos pesos; o `chmod -R go-w` do instalador remove escrita, mas nunca **adiciona** leitura.

Pior que o defeito foi o sintoma. O Host reportou `state: missing` — "nenhum pacote instalado" —
para um pacote que estava instalado ali. Isso mandaria qualquer pessoa depurando procurar no lugar
errado. Três correções:

| Correção | Onde |
| --- | --- |
| Diretórios `0755` e arquivos `0644`, normalizados **depois** de copiar | `scripts/build-host-asr.mjs` |
| Verificação passa a exigir legível-pelo-serviço e não-gravável | `verifyBundle` / `checkPermissions` |
| `EACCES` vira "existe mas não tenho permissão de ler", com o caminho | `inspectAsrBundle` |

Cada uma tem teste: um bundle `0700` é recusado com `BUNDLE_DIRECTORY_UNREADABLE`, um arquivo
`0666` com `BUNDLE_FILE_WRITABLE`, e o Host distingue "não instalado" de "ilegível".

### Correção (r2) — **aplicada e verificada**

O kit de correção (`Corrigir voz e limpar o Host.command`) rodou às 10:24 no mini. Ele só chega à
limpeza depois de `voice.status.state === 'ready'`, então a limpeza ter acontecido é, por si, a
prova de que a asserção de voz passou. Estado observado de fora, sem privilégios:

| Evidência | Observado |
| --- | --- |
| `app/cli.mjs`, `app/host-core.mjs`, `manifest.json` | digests **iguais aos do kit r2** (`d578ebae…`, `846b7256…`, `59251bd3…`) |
| `/Library/MaestrlyHost/asr` | `drwxr-xr-x root:wheel`; **865 arquivos** (864 + manifesto), nenhum ilegível, nenhum gravável por grupo/outros, nenhum symlink |
| `asr/manifest.json` | `345b5cf7…`, o digest pinado na primeira aplicação |
| `host.inspect` (RPC vivo) | `0.3.1`, `health: ready`, anuncia **`routines.v1` e `voice.messages.v1`**, nenhuma capacidade anterior removida |
| `voice.status` (RPC vivo) | `state: ready`, `Xenova/whisper-base`, fila 0, cota 1 GiB |
| VMs e bots | `lab-mini-linux-1` running / `-2` stopped; dois bots `ready`, nenhum turno ativo — iguais ao preflight |
| `npm run lab:bot:phase5` | `routines: true`, `voice: true`, `transcription.state: ready`, bloqueio `ROUTINE_TARGET_REQUIRED` |

O screenshot do erro `Voice capability missing after the upgrade` que circulou depois disso é da
**primeira** aplicação (09:52): o caminho `/private/var/tmp/maestrly-bot-phase5/admin.mjs` que ele
mostra já nem existe no mini, e `last` registra exatamente duas sessões administrativas, 09:52 e
10:24. Rodar o r1 de novo é inofensivo: ele recusa na primeira asserção (`Installed manifest
changed`) sem tocar em nada.

### Limpeza executada

| Item | Estado no mini |
| --- | --- |
| Bundles de guest | restam só os **3 que templates referenciam**: `…-0.2.0-20260917-phase5`, `…-0.1.0-20260914-sessions-r1` e `runtime/bot/deploy-r1/runtime.tar` |
| Cópias antigas da aplicação (`app.*`, `.phase5-previous`) | nenhuma |
| `backups/` de rollouts e staging `maestrly-bot-*` em `/private/var/tmp` | vazios / removidos |
| **Cópias do banco de dados** | **preservadas** (`state/` é do serviço e não é legível de fora — a preservação é regra do script, não algo que eu tenha recontado) |
| Espaço livre | **705 GiB** (`df -g`) |

A quantidade exata liberada foi impressa pela última linha do próprio script
(`PHASE5_VOICE_READY — … GiB liberados`) na janela do Terminal em que ele rodou; não a reproduzo
aqui porque não a vi. As entradas dos bundles removidos saíram do manifesto do Host no mesmo passo:
um manifesto que ainda pinasse um arquivo apagado faria a próxima verificação de integridade falhar.

## O que os testes automatizados provam

### Rotinas

- **Nada executa sem confirmação.** Uma prévia não cria rotina; ativar exige a impressão digital
  exata que foi exibida; uma prévia expirada ou uma mudança de conta/modelo/permissões entre a
  revisão e a confirmação são recusadas. Texto de mensagem que imita uma instrução do sistema não
  ativa nada.
- **Um horário, uma execução.** Três ticks no mesmo instante produzem uma ocorrência; relógio
  voltando não reabre o slot; reinício entre materializar e despachar adota a ocorrência existente
  em vez de criar outra. A garantia está no índice único, não no código de aplicação.
- **Esperar não é falhar.** Bot ocupado, tela sob controle da pessoa, computador desligado e
  slots de segundo plano cheios mantêm a ocorrência na fila com uma causa legível; o prazo de fila
  encerra com `QUEUE_DEADLINE` sem ter consumido nada.
- **O Host não liga a VM.** Com a VM parada, a ocorrência espera com `COMPUTER_OFF` e o provedor
  registra zero chamadas extras de `start`.
- **Horário de verão de verdade.** 02:30 em 09/03/2025 (Nova York) é pulado; 01:30 em 02/11/2025
  executa uma vez, não duas; dia 31 pula fevereiro; 29/02 existe em 2028 e não em 2100.
- **Atraso é resumido, não acumulado.** Mil dias perdidos produzem zero execuções por padrão, ou
  exatamente uma com a política `latest`.
- **Pausar ≠ parar.** Pausar cancela o que não foi despachado e não mata a execução em andamento;
  retomar olha só para frente; arquivar é recusado enquanto houver execução ativa.
- **Um dono por turno.** Dois domínios reivindicando o mesmo turno resultam em
  `TURN_OWNERSHIP_CONFLICT`, não em escolha por ordem de registro.
- **Slots compartilhados.** Tarefas de equipe e ocorrências de rotina dividem o mesmo pool; uma
  rotina não ganha um par extra de slots.
- **Takeover.** Assumir a tela põe a ocorrência em espera humana sem declará-la concluída;
  devolver sem continuar encerra com causa explícita; continuar mantém a mesma ocorrência,
  conversa e parcela de orçamento.
- **Resultado incerto continua incerto.** Uma execução em andamento conta a reserva inteira; um
  turno cuja resposta se perdeu não é reexecutado nem marcado como concluído.

### Permissões e orçamento

- O teto aprovado chega ao **payload real** entregue ao guest: um bot em `ask` recebe `ask` mesmo
  quando a rotina pediu `full-vm`, e os limites numéricos descem, nunca sobem.
- O defeito que a fase 4 deixou está corrigido: `turn.start` **intersecta** a política da sessão
  com o teto do turno em vez de substituí-lo. A configuração real do Codex reflete isso
  (`approvalPolicy: on-request`, `sandbox: workspace-write`).
- Identidade aprovada muda com conta, modelo, modo de permissão, modo de rede, coordenador e
  roster; **não** muda com renomear o bot nem com ele estar ocupado. Estreitar destinos vale na
  hora, sem nova revisão.
- A janela de 24 h é calculada a partir das próprias ocorrências; consumo mais antigo é esquecido
  e um horário pulado não conta nada.

### Propostas

Um cartão é inerte, consultável depois do turno e expira sozinho. Só a conversa privada do bot e o
coordenador de um pedido que a pessoa iniciou podem propor. Execução programada, worker delegado,
continuação, geração antiga, turno de outro bot e turno encerrado são todos recusados — e a
ferramenta nem aparece no catálogo desses turnos. Sem fuso conhecido, o cartão pede confirmação em
vez de assumir um.

### Voz

- Upload só é aceito depois que tamanho, digest e layout canônico concordam com os bytes
  recebidos; cabeçalho mentiroso, arquivo truncado, estéreo, 44,1 kHz, PCM comprimido e bytes
  sobrando são recusados.
- Gravar e transcrever **não** iniciam o bot. Só `voice.send` cria mensagem e turno, na mesma
  transação do vínculo de áudio.
- Silêncio volta como silêncio, antes de carregar o modelo.
- Bot ocupado preserva o rascunho e o texto; enviar duas vezes com a mesma chave produz uma
  mensagem; o destino vem do clip, nunca do pedido.
- Remover o áudio preserva a mensagem e a transcrição, marcando o áudio como indisponível; TTL de
  rascunho não toca em gravação enviada.
- O journal do aplicativo guarda referência e recibo — o teste verifica que a transcrição **não**
  aparece no arquivo.

### Worker ASR

Crash, timeout, cancelamento, resposta atrasada de worker substituído, resposta endereçada a outro
job, fila cheia, modelo ausente, bundle adulterado, arquivo a mais, link simbólico e encerramento
do Host: todos terminam em um estado explícito, com o worker substituído quando necessário e
liberação por ociosidade.

## Verificações executadas (2026-09-17)

| Comando | Resultado |
| --- | --- |
| `npm run check:boundaries` | ✅ |
| `npm run check:bot-phase5` | ✅ 30 guardrails |
| `npm run test:bot-phase5` | ✅ 14 + 147 + 9 + 24 + 34 |
| `npm run test:e2e:bot-phase5` | ✅ **9 testes no app empacotado** |
| `npm run test:policy` / `test:docs` | ✅ 38 · 54 arquivos |
| `test:host-phase1`, `test:bot-phase2`, `test:bot-sessions`, `test:bot-phase3`, `test:bot-phase4` | ✅ |
| `check:bot-phase2`, `check:bot-sessions`, `check:bot-phase3`, `check:bot-phase4` | ✅ |
| `test:e2e:bot`, `test:e2e:bot-teams` | ✅ 10 testes, sem regressão |
| `npm run build:host:asr` | ✅ pacote real de 211 MiB verificado |
| `npm run package:host:lab` | ✅ Host 0.3.1, schema 7 |
| `npm run build:bot-runtime:bundle` | ✅ guest com `bot.routines.v1` |
| `npm run package:bot:lab` | ✅ app **0.3.2** instalado em `~/Applications` (o 0.3.1 de 09:33 antecedia as correções de `validateResult` e da recarga do histórico) |
| `npm run lab:bot:phase5` | ✅ inventário real do mini, somente leitura: `routines: true`, `voice: true`, `transcription.state: ready` |
| `npm run lint` | ⚠️ 2 erros e 43 avisos, idêntico ao baseline e todos em `apps/desktop` |

### Portão 3 — os dois smokes no mini (2026-09-17, 13:38–13:55 UTC)

Consentimento gravado no `.maestrly-host-lab.json` privado (`routineBotId` = `lab-mini-bot`, o bot
de laboratório; `voiceSampleFile` = a mesma fala sintética do Portão 1, reempacotada). Três coisas
que só o hardware revelou, em ordem:

| Achado | Onde estava o erro | Correção |
| --- | --- | --- |
| `validateConfig` recusava as próprias chaves da fase 5 (`Unknown lab configuration key`) — os portões eram **inautorizáveis** | `scripts/host-lab.mjs` | chaves aceitas com validação (booleano, id exato, caminho absoluto, fuso IANA); teste em `bot-routines-lab.test.mjs` |
| `voice.upload.finish` recusou o WAV do `afconvert` (chunk `FLLR` entre `fmt ` e `data`) — correto — mas o clipe recusado **continuou contando na cota** (`usedBytes: 120076` após o upload seguinte) e, na recusa de layout, o staging ficava em disco | `voice/service.ts`, `voice/uploads.ts` | recusa encerra o clipe (`expired`, 0 bytes), apaga a transferência e o staging; testes em `voice-store.test.ts` |
| A rotina disparou sozinha, mas o turno ficou em `starting` num loop de ~35 s por 12 min: o Host anexava `routines` a **todo** snapshot sem checar se o guest anunciou `bot.routines.v1`; o guest da VM (`0.1.0-20260914-sessions-r1`, schema `strictObject`) respondia `INVALID_REQUEST` e o Host reenviava | `bots/runtime-coordinator.ts` | `compatibleSnapshot`: a seção só vai para guest que a anunciou (decidido **no envio**, contra a sessão viva); `INVALID_REQUEST` encerra o turno com `RUNTIME_UPDATE_REQUIRED` em vez de repetir; teste em `routine-execution.test.ts` |

Resultado da voz: `succeeded`, 3,6 s de áudio, upload 56 ms, transcrição 15 062 ms (worker frio no
mini), 10 palavras. Resultado da rotina: ocorrência criada e admitida a 1,5 s do horário com
nenhum aplicativo aberto — a parte "o Host cumpre o horário sozinho" está provada; a parte "o bot
executa" não, pelo defeito acima. O laboratório expirou aos 15 min, pausou a rotina e a
ocorrência foi cancelada; o bot ficou livre (`activeTurnId: null`).

### Portão 3, segunda passagem — Host 0.3.2 aplicado (kit r3) e rotina executada

O kit r3 (`preflight-r3`, `build-kit-r3`, `admin-r3`, `stage-r3`) foi aplicado pela pessoa. Ele só
trocou `app/cli.mjs`, `app/host-core.mjs` e o manifesto — sem migração, sem tocar em pacote de
fala, bundles, configuração ou banco. Conferido de fora: `host.inspect` → `0.3.2`, `ready`, rotinas
e voz anunciadas; digests do `app/` iguais aos do kit (`3b22c540…`, `51ca0b94…`); nenhuma cópia
`app.*` ou manifesto `.r3-*` sobrando.

`npm run lab:bot:phase5 -- --authorize-routine-smoke`, com nenhum aplicativo de bot aberto:

| Medida | Observado |
| --- | --- |
| Agendado para | 20:58:00 UTC (17:58 em São Paulo) |
| Host disparou | 20:58:03,664 (3,7 s após o minuto; o tick do agendador é o único relógio) |
| Guest recebeu `turn.start` | uma única vez; `running` às 20:58:15 |
| Resposta do bot | "A execução programada aconteceu em 17/09/2026 às 17:58 (horário de Brasília)." |
| Ocorrência | `succeeded` às 20:58:29; **1 ocorrência, 1 execução**; 14 586 ms ativos |
| Guest | o da fase 3 (`0.1.0-20260914-sessions-r1`): executar uma rotina não exige ferramenta de rotina, só propor exige |

O laboratório pausou a rotina ao terminar; as duas rotinas de verificação (13:39 e 20:55) ficam
`paused` no mini como registro e podem ser arquivadas pelo aplicativo. Um detalhe de cota: o clipe
recusado na primeira passagem (120 076 bytes) ainda conta em `voice.status.usedBytes` porque foi
criado pelo Host 0.3.1, antes da correção; ele some no TTL do rascunho.

Nota: o ambiente do mini reporta `updateAvailable: null` embora o template aponte para o bundle
da fase 5 — o guest da VM continua o da fase 3; isso é da fase de ambientes, não desta.

### Um defeito do laboratório que só o Host real revelou

Com o Host do mini anunciando `routines.v1`, o inventário somente-leitura passou a falhar com
`TEAM_LAB_NOT_AUTHORIZED` — o guard **da fase 4**. A sessão da fase 5 aplicava o seu guard e
depois chamava o da equipe, cuja lista de leitura não conhece `routine.list` nem `voice.status`.
Ficou invisível enquanto o Host era anterior à fase 5, porque esses métodos nunca eram chamados, e
as sessões de teste pulavam o transporte onde o segundo guard vivia. Correção: a sessão base expõe
a política como um método (`guard`) e cada laboratório instala a **sua** política completa em vez
de empilhar duas; `guardPhase5` já recusa qualquer método que não lista, então nada ficou mais
permissivo. O teste novo constrói a sessão real com transporte falso e exige que `routine.list`,
`voice.status` e `team.list` cheguem ao Host sem consentimento, e que `routine.activate`,
`voice.send` e `team.create` continuem recusados.

### Correção de uma afirmação anterior

O relatório anterior dizia que Playwright/Electron não abria neste ambiente e classificava os
testes de interface como não executáveis. **Isso estava errado.** A causa real era `out/` desatualizado;
com o build em dia, as 10 suítes anteriores e as 3 novas passam. Executá-las revelou dois defeitos
de produto que eu não teria encontrado de outro jeito:

| Defeito | Efeito para a pessoa |
| --- | --- |
| `validateResult` não conhecia `routine.*` e `voice.*` | Toda chamada de rotina ou voz falhava com "Unsupported host result" |
| O histórico não recarregava após "Executar agora" | A pessoa clicava e nada aparecia na tela |

Também corrigi três testes meus que estavam errados — entre eles um em que `'Ana'` casava com
"sem**an**a" e outro que clicava em confirmar antes de a prévia existir.

### Dois testes que envelheciam a cada versão

`core.test.ts` exigia `serviceVersion: '0.2.0'` e o guardrail de equipes exigia versões literais.
Ambos falhavam por estarem velhos, não por regressão. Agora o primeiro compara a versão consigo
mesma após reabrir, e o segundo exige que as versões **não retrocedam** — que é o que o nome dele
sempre disse. Um novo guardrail garante que `host.inspect` e `apps/host/package.json` concordem: os
dois já tinham divergido, e é exatamente essa comparação que o kit usa para recusar downgrade.

### Sobre o manifesto do runtime local-ML

`apps/desktop/runtime-assets/local-ml/manifest.json` é o **pino de integridade** do runtime de
inferência do *outro* produto, o Maestrly App: ele diz qual archive é legítimo (sha256, bytes
exatos e caminhos críticos), e o app confere isso antes de desempacotar e usar. É a mesma ideia do
manifesto que o pacote de fala do Host usa — impedir que um binário trocado entre em uso.

Investigando a fundo:

| Onde | sha256 do `mac-arm64` | bytes |
| --- | --- | --- |
| Manifesto no worktree | `27f8780e…` | 40 915 502 |
| Manifesto **embutido** no app 0.7.0 instalado | `fb9e5cd1…` | 40 933 472 |
| Archive distribuído dentro do app 0.7.0 | `fb9e5cd1…` | 40 933 472 |

Ou seja: **o app instalado está consistente consigo mesmo e funciona.** A divergência é entre o
manifesto do worktree e os artefatos que existem nesta máquina — o archive `27f8780e…` não está em
lugar nenhum aqui. O manifesto do repositório é a intenção; falta o build publicar o archive
correspondente. Isso é do domínio do desktop e **não afeta o Host**: o pacote de fala tem manifesto
próprio, gerado a partir do artefato real e verificado pelo Host antes de cada uso.

Uma consequência que vale registrar: o pacote de fala foi montado sobre o runtime `fb9e5cd1…`, o
mesmo que o app roda hoje. Quando o build publicar o archive do manifesto do repositório, o pacote
de fala deve ser regenerado a partir dele.

## Desvio do plano: `@js-temporal/polyfill`

O plano pedia o polyfill do Temporal. Ele **não** foi adicionado: `npm install` e `npm ci` já
falham em `47bb6bc` porque vários pacotes do workspace estão fixados em versões que o registro não
tem. Acrescentar uma dependência deixaria uma árvore que nenhum clone novo consegue montar.

A aritmética de fuso foi implementada sobre `Intl.DateTimeFormat` — a mesma base IANA que o
polyfill lê — com verificação por ida e volta: um horário que não volta ao mesmo minuto é um buraco
de horário de verão, e um horário produzido por dois instantes é uma sobreposição. Os casos que o
plano exigia estão cobertos em `routine-calendar.test.ts`, incluindo 02:30 em 09/03/2025 e 01:30 em
02/11/2025 em Nova York.

## Limites que não devem ser exagerados

- A transcrição foi provada **nesta máquina**, com o worker empacotado e o Whisper real. No mini o
  Host 0.3.1 verifica o pacote e se declara pronto, mas ainda não transcreveu nada: isso depende
  de um áudio consentido (`allowVoiceSmoke` + `voiceSampleFile`).
- O Host cumpriu **um** horário com o aplicativo fechado, no mini, com uma rotina `once`. Isso não
  diz nada sobre semanas de recorrência, reinícios do mini no meio de uma janela, nem sobre horário
  de verão em hardware — para esses só existem os testes com relógio injetado.
- O áudio usado é fala sintética do macOS. Ele exercita o reconhecimento de verdade, mas não diz
  nada sobre taxa de acerto com vozes humanas, sotaques ou ruído real.
- Os tempos (frio 1611 ms, quente 608 ms) valem para este Mac, este modelo e 3,75 s de áudio. Não
  são uma promessa de desempenho.
- Os limites de rotina, retenção e cota são decisões de produto desta versão, não medições.
- Dois workers de inferência em paralelo não foram provados: o Host executa um job por vez por
  desenho.
- Backups existentes podem conter gravações; isso é documentado, não apagado retroativamente.
