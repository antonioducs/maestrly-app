# Validação da Fase 4 — equipes de bots e colaboração governada

Fluxo de aceite: **criar equipe** com bots existentes → **conversar** → o coordenador distribui um
lote → membros trabalham → **uma resposta consolidada**, distinguindo o que foi feito, o que falhou
e o que depende de decisão humana. Arquitetura e garantias em
[equipes](bot-runtime/teams.md); comandos do laboratório em [laboratório](maestrly-bot-lab.md).
Evidências ficam em `.host-lab/` (ignorado pelo Git).

Escopo desta entrega: `feat/maestrly-bot`, de `cdd2bf2` (fase 3) até `a948a98`.

## Situação

| Categoria | Itens |
| --- | --- |
| **Implementado e homologado em hardware** | Rollout preservador do Host para 0.3.0 com `teams.v1` e migração 5→6; atualização do ambiente dos bots para o runtime com `bot.teams.v1`; criação de equipe sem alterar inventário de VM; compartilhamento de um CSV real com digest conferido; entrega verificada da cópia no espaço de trabalho do membro; delegação real coordenador → membro → consolidação (3 turnos físicos); aprovação de um membro respondida pela pessoa, com o coordenador sem poder responder por ela; parada de trabalho concluída; recuperação de um cancelamento interrompido por reinício do Host |
| **Implementado e testado (sem hardware)** | Contratos `team.*` e da lane de colaboração; agendador durável com lotes, DAG validado, paralelismo e consolidação única; orçamento por trabalho com parcela reservada e consumo desconhecido preservado; memória de equipe com proposta inerte; revogação de compartilhamento; takeover e continuação; RPC pública, cliente e journal; UX conversacional em pt-BR/en. **80 testes de equipe** (7 de contrato, 52 no Host, 13 no runtime, 8 no cliente) + 14 e2e em Electron + 19 guardrails |
| **Não homologado** | **Dois membros trabalhando ao mesmo tempo**: o laboratório tem dois bots autorizados, o que prova delegação mas nunca dois workers simultâneos. Também não foram exercitados em hardware: takeover físico durante um trabalho de equipe, queda de SSH no meio da execução e membros em VMs distintas (a segunda VM está parada) |

## Rollout real executado (2026-09-16, Mac mini do laboratório)

Seis aplicações administrativas, cada uma com senha digitada pela pessoa, backup verificado do
banco e conferência de hash de cada arquivo instalado e enviado:

| Kit | O que mudou | Resultado |
| --- | --- | --- |
| `teams-rollout` | Código do Host, bundle do guest e catálogo; migração 5→6 | `TEAMS_HOST_READY` |
| `teams-rollout-r2` | Só código do Host (correção 1) | `TEAMS_FIX_READY` |
| `teams-rollout-r3` | Só código do Host (correção 2) | `TEAMS_FIX_READY` |
| `teams-rollout-r4` | Só código do Host (correção 3) | `TEAMS_FIX_READY` |
| `teams-rollout-r5` | Só bundle do guest e catálogo (correção 4) | `TEAMS_RUNTIME_READY` |
| `teams-rollout-r6` | Código do Host e bundle (correções 5 e 6) | `TEAMS_FIX_READY` |

Cada aplicação verificou, depois de subir, que **nenhuma capacidade desapareceu**, que identidade
do Host, VMs, bots e contas continuam iguais, e que o banco não é migrado de novo. As duas VMs, os
dois bots, suas conversas individuais, memória e contas permanecem intactos.

Os bundles antigos continuam instalados em `/Library/MaestrlyHost/bot-runtimes` de propósito: um
vínculo que ainda nomeie uma versão anterior continua resolvendo.

## Seis defeitos que só o hardware revelou

Todos tinham a mesma raiz: os dublês de teste eram **mais permissivos que a realidade**. Cada
correção tem um teste que falha sem ela — verificado revertendo a correção isoladamente.

1. **Identificador de transferência recusado pelo guest.** A entrega de arquivo usava
   `<grant>:deliver`; o runtime só aceita `[A-Za-z0-9_-]`. Nenhuma cópia era entregue. O guest falso
   aceitava qualquer identificador; agora aplica a mesma regra do real.
2. **Parar a equipe nunca concluía.** Uma tarefa que jamais virou turno era ignorada no
   cancelamento e ficava ativa para sempre. Corrigido em `cancel()` e em `advance()` — o segundo
   também recupera um Host que reinicia no meio da parada.
3. **"Ainda acordando" tratado como "falhou".** A sessão gráfica sobe sob demanda e leva dezenas de
   segundos; uma falha de transporte nesse intervalo virava `needs_attention` definitivo. Agora
   falhas transitórias voltam para a fila, com limite, e falhas reais avisam na hora com o código.
4. **O contexto da equipe não chegava ao modelo.** O Host montava participantes, caminho das cópias
   entregues e resultados de dependências, mas o runtime usava isso apenas para liberar ferramentas.
   O membro sabia que havia um arquivo e não onde: gastou 1,88 M de tokens procurando até estourar
   o limite de ferramentas. Agora esse bloco entra no prompt, sem identificadores internos.
5. **O tempo que a pessoa leva decidindo era cobrado do agente.** O limite de execução era relógio
   de parede e corria enquanto o turno esperava aprovação; um turno morreu 15 min após iniciar por
   causa de 9 min de espera humana. Como `ask` é o modo padrão, isso atingiria qualquer bot que
   peça permissão. O orçamento agora pausa na espera e retoma na resposta, no guest e na rede de
   segurança do Host.
6. **A equipe dizia "membros trabalhando" enquanto esperava a pessoa.** O estado `waiting_user`
   existia no contrato e na interface mas nunca era usado.

Um sétimo problema era do próprio laboratório: a conferência aritmética comparava texto cru, e
reportava `1.234` (correto) como erro. Um relatório que transforma acerto em erro mente na direção
que parece segura; a checagem agora aceita separadores e continua recusando outro número.

## Prova end-to-end (`bot-team-lab.mjs smoke --authorize-team-smoke`)

Executada com os dois bots reais explicitamente autorizados em `.maestrly-host-lab.json`
(`teamBotIds` + `allowTeamSmoke`), contra o Host 0.3.0 e o ambiente `0.2.0-…-teams-r3`:

```json
{ "step": "team.created", "members": 2 },
{ "step": "inventory.unchanged", "ok": true },
{ "step": "artifact.shared", "digest": "77ea7b3d603f" },
{ "step": "run.direct",    "status": "succeeded", "delegatedTasks": 0, "physicalTurns": 1,
  "arithmetic": true, "singleAnswer": true, "approvals": [] },
{ "step": "run.delegated", "status": "succeeded", "delegatedTasks": 1, "membersWorked": 1,
  "physicalTurns": 3, "arithmetic": true, "singleAnswer": true },
{ "step": "delegation.exercised", "ok": true, "concurrencyProven": false },
{ "step": "computers.intact", "ok": true }
```

O que isso prova, e o que não prova:

1. **Criar equipe não mexe em infraestrutura**: o inventário de VMs é idêntico antes e depois.
2. **O arquivo circulou de verdade**: o membro pediu permissão para ler
   `equipe/<run>/<artefato>-dados.csv` — foi ao caminho exato, sem procurar — e a resposta
   consolidada discrimina 120 + 340 + 774, batendo com o CSV sintético conhecido. A aritmética é
   conferida contra o arquivo, não contra a afirmação do modelo.
3. **A delegação é real**: `delegation.submitted` no lote, turno do membro, rodada de consolidação.
   O coordenador respondeu sozinho o pedido pequeno, que é o comportamento correto, e distribuiu
   quando a pessoa pediu para distribuir.
4. **Uma resposta por pedido**, nunca uma por membro.
5. **Concorrência física não foi provada** (`concurrencyProven: false`): com dois bots há um
   coordenador e um membro. O paralelismo entre dois workers só existe como teste automatizado.
6. **As aprovações são da pessoa**: o laboratório responde no papel dela e **registra no relatório
   o comando exato que autorizou**. Aprovar sem dizer o quê seria pior que não aprovar.

## Verificações executadas (2026-09-16, commit `a948a98`)

| Comando | Resultado |
| --- | --- |
| `npm run check:bot-phase4` | 19/19 guardrails; builds e typecheck de host-protocol, host-core, host, runtime e aplicativo |
| `npm run test:bot-phase4` | 7 + 52 + 13 + 8 testes de equipe e 19 guardrails, **0 falhas** |
| `npm run test:e2e:bot-teams` | 14/14 em Electron |
| `npm run test:e2e:bot` | 41/41 (sem regressão) |
| `npm run check:bot-sessions` / `test:bot-sessions` | verde / 26 testes, 0 falhas |
| `npm run check:bot-phase3` / `test:bot-phase3` | 20/20 / 91 testes, **0 falhas** |
| `npm run check:boundaries` | isolado |
| `npm run check` | verde, exceto 3 testes do desktop antigo (`apps/desktop`) — falhas idênticas na baseline `cdd2bf2`, e este produto não foi tocado (0 arquivos alterados) |
| `npm run lint` | 10 achados, **todos em arquivos que esta entrega não alterou** |
| `npm run test:policy` | 38/38 |
| `npm run test:docs` | 52 arquivos ok |
| `npm run package:bot:lab` | pacote gerado; inicialização e sandbox verificados, fixtures desabilitadas no empacotado |
| `npm run lab:bot:teams` | `ready: true` contra o Mac mini real |

### Sobre as falhas de disco relatadas antes

Versões anteriores deste relatório registravam falhas `CAPACITY_EXCEEDED: Insufficient uncommitted
disk capacity` em `test:bot-sessions` e `test:bot-phase3`. **Não eram do código**: o controlador
tinha 1,9 GiB livres porque cada bundle do runtime ocupa ~1,1 GB e cada pacote do Host ~4 GB. Com a
limpeza de artefatos superados (142 GB → 65 GB no worktree, 60 GiB livres) essas suítes passam
integralmente. O procedimento de limpeza — e o que nunca pode ser apagado — está registrado na
memória do projeto.

## O que os testes automatizados provam

- **Paralelismo e serialização**: dois membros com turnos simultâneos observados no mesmo instante;
  com `concurrency: 1` a segunda tarefa espera sem interromper a primeira.
- **Um turno por bot**: duas equipes disputando o mesmo bot e um envio individual simultâneo são
  recusados com `BOT_BUSY`.
- **Sem vazamento de contexto**: o snapshot de um turno de equipe não contém memória privada nem
  histórico particular do bot, e a thread escopada nunca substitui `bot.conversationId`.
- **Permissões só se estreitam**: equipe em `full-vm` com bot em `ask` resulta em `ask`.
- **Origem não é forjável**: a sessão de um bot não age no turno de outro; geração velha, worker
  tentando delegar e método administrativo pela lane de colaboração são recusados.
- **Lote atômico**: ciclo, dependência externa, auto-delegação, destinatário desconhecido e
  arquivo não autorizado são rejeitados **sem criar nenhuma tarefa**.
- **Honestidade do resultado**: dependência que falhou gera `skipped` explícito e o trabalho termina
  como `partial` mesmo quando o coordenador escreve que concluiu.
- **Orçamento único**: a soma das parcelas não ultrapassa o teto do trabalho menos a reserva de
  consolidação; tokens não informados aparecem como desconhecidos, nunca como zero.
- **Espera humana não consome orçamento**: aprovações sobrepostas contam uma vez, uma pendente
  conta até agora, e um turno não expira por demora da pessoa.
- **Arquivos**: digest idêntico no destinatário, terceiro membro sem grant não recebe nada, arquivo
  alterado no meio da cópia falha com `FILE_CHANGED` sem deixar resíduo, e um arquivo particular de
  mesmo nome em outro bot permanece intocado.
- **Revogação**: bloqueia novas entregas e informa quantas cópias já entregues **não** podem ser
  apagadas remotamente.
- **Intervenção humana**: takeover pausa só aquele membro; a continuação usa a thread escopada, uma
  captura nova e no máximo o que restou da parcela original; parar a equipe não tira a tela de quem
  está no controle.
- **Recuperação**: reiniciar o Host não duplica trabalho, tarefa, mensagem nem resposta; um turno
  que terminou com o Host fora do ar é liquidado exatamente uma vez; um cancelamento interrompido
  por reinício é concluído.

## Limites que não devem ser exagerados

- Os números de limite são **defaults de segurança operacional**, não capacidade medida do Mac mini
  e não teto financeiro. Não há enforcement de custo pelo provedor.
- Threads separadas **não** são isolamento de dados dentro de um mesmo bot. Publicar um arquivo é
  autorização de fluxo, não prova de ausência de dado sensível. A interface diz isso.
- Remover memória impede injeções futuras; não apaga o que já foi enviado.
- Cópias já entregues a um espaço de trabalho não podem ser apagadas remotamente.
- **Dois membros executando ao mesmo tempo continua sem prova física.** Isso exige um terceiro bot
  autorizado no laboratório; os testes automatizados cobrem o comportamento, mocks não homologam
  concorrência real.
- O relatório da fase 3 (`maestrly-bot-phase3-validation.md`) é histórico; o estado atual do
  laboratório é o descrito aqui.
