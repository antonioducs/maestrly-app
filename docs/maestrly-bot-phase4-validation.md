# Validação da Fase 4 — equipes de bots e colaboração governada

Fluxo de aceite: **criar equipe** com bots existentes → **conversar** → o coordenador distribui um
lote → membros trabalham em paralelo → **uma resposta consolidada**, distinguindo o que foi feito,
o que falhou e o que depende de decisão humana. Arquitetura e garantias em
[equipes](bot-runtime/teams.md); comandos do laboratório em [laboratório](maestrly-bot-lab.md).
Evidências ficam em `.host-lab/` (ignorado pelo Git).

Escopo desta entrega: `feat/maestrly-bot`, a partir de `cdd2bf2` (fase 3).

## Situação

| Categoria | Itens |
| --- | --- |
| **Implementado e testado** | Contratos `team.*` e da lane de colaboração; migração 5→6 transacional com cópia prévia do banco; admissão de turno escopado com thread própria por trabalho/tarefa; agendador durável com lotes, DAG validado, paralelismo e consolidação única; orçamento por trabalho com parcela reservada e consumo desconhecido preservado; compartilhamento de arquivos por cópia verificada com revogação honesta; memória de equipe com proposta inerte; ferramentas de colaboração no runtime empacotado com origem decidida pelo Host; aprovações, takeover, devolução e parada; RPC pública, cliente e journal do aplicativo; UX conversacional em pt-BR/en, tema claro/escuro e janela mínima. **76 testes novos** (7 de contrato, 48 no Host, 13 no runtime, 8 no cliente) + 16 guardrails, todos verdes |
| **Implementado, não homologado** | Tudo que depende de **hardware**: dois membros reais trabalhando em paralelo em sessões distintas, takeover físico num membro com continuação, arquivo real circulando entre dois guests, queda de SSH durante execução real e reinício real do Host durante um trabalho. O Host instalado no Mac mini ainda é 0.2.0 e **não** expõe `teams.v1`; a atualização exige senha de administrador digitada pela pessoa e não foi autorizada nesta sessão |
| **Bloqueado** | Smoke físico de equipe: falta `teamBotIds` + `allowTeamSmoke` no `.maestrly-host-lab.json` e a atualização do Host. O `doctor` somente leitura já roda contra o Mac mini e reporta o bloqueio. Persiste também a limitação de disco do controlador descrita abaixo, anterior a esta fase |

## Verificações executadas (2026-09-16, commit `b1af04b`)

| Comando | Resultado |
| --- | --- |
| `npm run check:bot-phase4` | 16/16 guardrails; builds e typecheck de host-protocol, host-core, host, runtime e aplicativo |
| `npm run test:bot-phase4` | 7 + 48 + 13 + 8 testes de equipe e 16 guardrails, **0 falhas** |
| `npm run test:e2e:bot-teams` | 14/14 em Electron; repetido 3× sem instabilidade |
| `npm run test:e2e:bot` | 41 passaram, 6 skipped (sem regressão) |
| `npm run check:bot-sessions` | verde |
| `npm run check:bot-phase3` | 20/20 |
| `npm run check:boundaries` | isolado |
| `npm run test:policy` | 38/38 |
| `npm run test:docs` | 51 arquivos ok |
| `npm run lint` | 3 erros / 44 avisos — **melhor que o baseline** (4 / 55); nenhum no código novo |
| `npm run package:bot:lab` | pacote gerado; inicialização e sandbox verificados, fixtures desabilitadas no empacotado |
| `npm run lab:bot:teams` | executado **contra o Mac mini real**; ver abaixo |

### Falhas preexistentes (não são regressões)

`test:bot-sessions` e `test:bot-phase3` falham em 2 e 10 testes respectivamente, sempre com
`CAPACITY_EXCEEDED: Insufficient uncommitted disk capacity`. O helper `setup()` pede uma VM de
24 GiB e o controlador tem ~13 GiB livres. Isso foi **confirmado no baseline**: com as alterações
desta fase revertidas (`git stash`), os mesmos 8 arquivos de `host-core` falham pelo mesmo motivo.
As suítes novas de equipe usam um template pequeno e rodam em qualquer máquina.

Um único guardrail de schema precisou mudar, porque a fase avança o banco para a versão 6:
`desktop-state.test.ts` passou a exigir `HOST_DB_VERSION >= 5` e a recusar `HOST_DB_VERSION + 1`
em vez do literal `6`. A intenção original — a migração de tela para na versão 5 e um binário
antigo recusa schema novo — foi preservada.

## Mac mini (inventário somente leitura, 2026-09-16)

`npm run lab:bot:teams` conectou pelo alias privado e executou apenas consultas. Nada foi
instalado, preparado, reiniciado ou apagado.

```json
{
  "host": { "id": "65fbc6b6-…", "serviceVersion": "0.2.0", "teams": false },
  "bots": 2,
  "teams": 0,
  "computers": [
    { "id": "aa1a55bc-…", "state": "running", "health": "ready" },
    { "id": "c9d5839c-…", "state": "stopped", "health": "unknown" }
  ],
  "blocker": "TEAM_TARGET_REQUIRED",
  "ready": false
}
```

Leitura honesta deste resultado:

1. **As duas VMs continuam intactas**, uma ligada e uma parada, como antes desta fase.
2. O Host implantado é **0.2.0** e não anuncia `teams.v1`: nenhuma chamada `team.*` existe lá. O
   laboratório detecta isso e **não** pergunta nada de equipe a um Host antigo.
3. O bloqueio `TEAM_TARGET_REQUIRED` é o comportamento projetado: sem `teamBotIds` explícitos o
   laboratório **recusa escolher bots**; ele nunca pega "o primeiro bot livre".
4. Para homologar de verdade faltam, nesta ordem: atualizar o Host (senha de administrador digitada
   pela pessoa, com backup do banco antes da migração 5→6), atualizar o ambiente dos bots para o
   runtime 0.2.0 com `bot.teams.v1`, e então declarar `teamBotIds` + `allowTeamSmoke` e rodar
   `node scripts/bot-team-lab.mjs smoke --authorize-team-smoke`.

O relatório da fase 3 (`maestrly-bot-phase3-validation.md`) descreve um rollout real anterior; ele
é **histórico** e não substitui esta consulta fresca, que é o estado atual do laboratório.

## O que os testes realmente provam

- **Paralelismo e serialização**: dois membros com turnos simultâneos observados no mesmo instante;
  com `concurrency: 1` a segunda tarefa espera sem interromper a primeira.
- **Um turno por bot**: duas equipes disputando o mesmo bot e um envio individual simultâneo são
  recusados com `BOT_BUSY`; a equipe em espera nunca interrompe o trabalho em curso.
- **Sem vazamento de contexto**: o snapshot de um turno de equipe não contém memória privada nem
  histórico particular do bot, e a thread escopada nunca substitui `bot.conversationId`.
- **Permissões só se estreitam**: equipe em `full-vm` com bot em `ask` resulta em `ask`.
- **Origem não é forjável**: a sessão de um bot não age no turno de outro; geração velha, worker
  tentando delegar e método administrativo pela lane de colaboração são recusados.
- **Lote atômico**: ciclo, dependência externa, auto-delegação, destinatário desconhecido e
  arquivo não autorizado são rejeitados **sem criar nenhuma tarefa**.
- **Honestidade do resultado**: dependência que falhou gera `skipped` explícito e o trabalho termina
  como `partial` mesmo quando o coordenador escreve que concluiu.
- **Orçamento único**: a soma das parcelas de três execuções não ultrapassa o teto do trabalho menos
  a reserva de consolidação; tokens não informados aparecem como desconhecidos, nunca como zero.
- **Arquivos**: digest idêntico no destinatário, terceiro membro sem grant não recebe nada, arquivo
  alterado no meio da cópia falha com `FILE_CHANGED` sem deixar resíduo, e um arquivo particular de
  mesmo nome em outro bot permanece intocado.
- **Revogação**: bloqueia novas entregas e informa quantas cópias já entregues **não** podem ser
  apagadas remotamente.
- **Intervenção humana**: takeover pausa só aquele membro; a continuação usa a thread escopada, uma
  captura nova e no máximo o que restou da parcela original; devolver sem continuar encerra a tarefa
  e a equipe reporta parcial; parar a equipe não tira a tela de quem está no controle.
- **Recuperação**: reiniciar o Host não duplica trabalho, tarefa, mensagem nem resposta; um turno
  que terminou com o Host fora do ar é liquidado exatamente uma vez.

## Limites que não devem ser exagerados

- Os números de limite são **defaults de segurança operacional**, não capacidade medida do Mac mini
  e não teto financeiro. Não há enforcement de custo pelo provedor.
- Threads separadas **não** são isolamento de dados dentro de um mesmo bot. Publicar um arquivo é
  autorização de fluxo, não prova de ausência de dado sensível. A interface diz isso.
- Remover memória impede injeções futuras; não apaga o que já foi enviado.
- Cópias já entregues a um espaço de trabalho não podem ser apagadas remotamente.
- Nada aqui foi provado com dois membros reais executando ao mesmo tempo em hardware: isso depende
  da atualização autorizada descrita acima.
