# Validação da experiência de chat — transcript, comandos, extensões e uso

Fluxo de aceite: abrir a conversa e **ver** o bot trabalhar (ferramentas, raciocínio, tempo de
resposta) → digitar `/` e usar um **comando pronto** → dar ao bot um **servidor MCP e uma skill**
que a pessoa escolheu → o Codex de verdade, no guest, **usar** os dois → saber **quanto custou**.
Arquitetura e garantias em [experiência de chat](bot-runtime/chat-experience.md); comandos do
laboratório em [laboratório](maestrly-bot-lab.md). Evidências ficam em `.host-lab/chat-rollout/`
(ignorado pelo Git).

Escopo desta entrega: `feat/maestrly-bot`, commits `f5a29c4` (T0) em diante, sobre a fase 5.

## Situação

| Categoria | Itens |
| --- | --- |
| **Implementado e testado (sem hardware)** | Pacote compartilhado `@maestrly/chat-ui` (Markdown/Mermaid, cartões de ferramenta, composer, seletores, medidor de contexto, lista de transcript, painel de uso) usado pelos dois aplicativos; projeção única `foldTranscript`/`applyTranscriptEvent`; eventos enriquecidos no guest; migração 7→8 preservadora (prompts, extensões, skills, ledger, `turn_id` nos eventos); comandos prontos com `$ARGUMENTS`; extensões por bot com segredos em arquivos privados e entrega `extensions.apply` antes do turno; elicitação de servidor configurado sob o teto do turno; `usage.summary` sem preços; UI: transcript rico, composer, comandos, MCP/skills, `$` e página de uso. **Suítes `check:bot-chat`/`test:bot-chat`** (contratos 10, Host 16, guest 22, chat-ui 30, aplicativo 27, artefatos 9, laboratório 10) e **10 testes de interface** no app empacotado |
| **Homologado no Mac mini** | Host **0.4.0**, schema 8 migrado com cópia `host-v7-…`, anunciando `chat.experience.v1` sem perder `routines.v1`/`voice.messages.v1`; ledger com **28 turnos** dos 7 dias anteriores preenchidos pela migração; guest `0.2.0-20260918-chat-r2` (`bot.transcript.v1` + `bot.extensions.v1`) instalado pelo fluxo de Ambientes |
| **Portão das extensões** | ✅ **aprovado no mini**: MCP `echo` + skill `verificacao` instalados no `lab-mini-bot`, uma mensagem, o Codex leu a skill, chamou a ferramenta `echo` do servidor configurado, o eco voltou, e o bot ficou limpo ao final (`usedConfiguredServer: true`, `echoedBack: true`, 31,8 s, 2 ferramentas, 0 diagnósticos, `revision 8` com 0 servidores e 0 skills) |
| **Transcript e uso em hardware** | ✅ o cartão do turno saiu do Host dobrado: 2 partes de texto, `commandExecution` com a saída do `sed` no SKILL.md, parte `echo` concluída, `responseDurationMs 24117`, `model gpt-5.6-luna`; `usage.summary` da última hora: 2 turnos, `gpt-5.6-luna`, 758 255 tokens de entrada / 1 877 de saída |

## Portão 1 — Host 0.4.0 no mini (kit r1): **aplicado**

Kit no molde da fase 5: preflight somente leitura, `build-kit` local com todos os digests pinados,
`stage` por ssh com verificação de hash, `.command` administrativo com senha digitada pela pessoa.

| Etapa | Resultado |
| --- | --- |
| Verificações: identidade física, manifesto e config iguais ao preflight, cada artefato instalado íntegro, nenhum turno iniciado | ✅ |
| Host 0.4.0 (`app/cli.mjs` `085c8194…`, `app/host-core.mjs` `869e84fc…`), `node --check` como `_maestrlyhost` antes de trocar | ✅ |
| Bundle `0.2.0-20260918-chat` instalado; template `linux-arm64-accounts-v1` apontado para ele sem perder capacidade alguma | ✅ |
| Migração 7→8 com **exatamente uma** cópia prévia (`host-v7-2026-09-18T11-22-04-623Z-29c9d801.sqlite`) | ✅ |
| `chat.experience.v1` anunciado; `routines.v1`, `voice.messages.v1` e `voice.status: ready` preservados; VMs e bots iguais ao antes | ✅ |
| `prompt.list` e `usage.summary` respondendo no Host vivo (28 turnos nos 7 dias anteriores) | ✅ |
| Versão anterior e staging removidos após a prova de saúde | ✅ |

Doctor de fora (`npm run lab:bot:chat`): `serviceVersion 0.4.0`, `chat: true`, `ready: true`.

## Portão 2 — extensões no Codex real: **aprovado, na segunda tentativa**

### Primeira tentativa (guest `…-chat`): a skill chegou, o servidor não

O turno terminou `succeeded` em 51 s, mas `usedConfiguredServer: false`. O transcript mostrou o
que aconteceu: o bot **leu** `/var/lib/maestrly-bot/codex/skills/verificacao/SKILL.md` — prova de
que `extensions.apply` chegou ao guest e a skill foi escrita onde o Codex a lê — e respondeu que a
ferramenta MCP `echo` "não está disponível nesta sessão".

Causa: o Codex roda com ambiente mínimo, **sem `PATH`**, e o Node do guest fica em
`runtime/bin/node` dentro do bundle, não em `/usr/bin`. Um servidor declarado como `node …` (ou
`npx …`) nunca resolvia o comando e o Codex o omitia do catálogo. O servidor próprio do bot nunca
sofreu disso porque é declarado por `process.execPath` absoluto.

Correção (`6cc79ca`): todo servidor `stdio` configurado pela pessoa recebe um `PATH` que começa no
diretório do Node do guest e segue pelos diretórios padrão; um `PATH` que a pessoa definir vence.
Coberto por teste em `apps/bot-runtime/test/extensions.test.ts`.

Só o guest mudou; o Host 0.4.0 ficou como estava. Kit **r2**: bundle `…-chat-r2`
(`8a3911f5…`), template e manifesto apontados para ele, Host reiniciado uma vez, bundle r1
removido depois da prova de saúde, ambiente atualizado de novo pelo fluxo de produto (3 min 41 s).

### Segunda tentativa (guest `…-chat-r2`)

| Medida | Resultado |
| --- | --- |
| Turno | `succeeded`, 31 815 ms de ponta a ponta, `responseDurationMs 24117` |
| Ferramentas no cartão | `commandExecution` (leu o SKILL.md) e **`echo`** (servidor configurado), ambas `done` |
| Eco | voltou na resposta (`echoedBack: true`), 157 caracteres |
| Diagnósticos | nenhum; `guestOutdated: false` |
| Limpeza | `extension.inspect` ao final: 0 servidores, 0 skills |
| Uso | 353 199 entrada / 474 saída, modelo `gpt-5.6-luna` no ledger |

### Um defeito a mais que só o transcript real mostrou

A parte `echo` do cartão fechou com **saída vazia**: `toolDetail` lia `aggregatedOutput`/`output`,
e uma chamada MCP entrega o resultado em `result.content[]`. Corrigido no runtime (blocos de texto
juntados, JSON caso contrário), com asserção no fixture do app-server. Esse guest **não foi
reimplantado** no mini: o portão foi aprovado com a saída da ferramenta ausente do cartão, e o
próximo bundle levará a correção.

## Defeitos encontrados nesta homologação

| Defeito | Onde | Consequência se não corrigido |
| --- | --- | --- |
| Servidor `stdio` sem `PATH` | `apps/bot-runtime/src/extensions/store.ts` | Nenhum servidor declarado por nome de comando funcionaria em hardware real |
| Resultado MCP não vira saída da parte de ferramenta | `apps/bot-runtime/src/providers/codex/events.ts` | Cartões de ferramentas MCP sempre vazios |
| `@maestrly/chat-ui` externo no main do Bot | `apps/bot-desktop/electron.vite.config.ts` | O app **empacotado** 0.4.0 não abria janela: o main não carregava `model-meta.ts` do asar; os e2e (que lançam `out/main/index.js` do workspace) não pegavam. Corrigido bundlando o pacote no main, com guardrail; app Bot Lab 0.4.0 instalado e verificado nesta máquina |
| Doctor lia o inventário do ambiente como se fosse a sessão viva | `scripts/bot-chat-lab.mjs` | `guest.extensions: false` com o guest já aplicando extensões; renomeado para `guestInventory`, a prova é `guestOutdated` |

## Limitações e o que não foi provado

- **O inventário do ambiente não é atualizado pelo `environment.prepare`**: `bot.sessions.list`
  continuou reportando as capacidades do guest da fase 3 depois de dois updates bem-sucedidos.
  É a mesma pendência do fluxo de Ambientes registrada na fase 5; não foi tocada aqui.
- As 28 linhas de uso preenchidas pela migração têm modelo `unknown`: os turnos anteriores não
  guardavam `model`. Turnos novos gravam o modelo (provado acima).
- O guest com a saída MCP no cartão (`events.ts`) foi testado com o fixture, não no mini.
- Elicitação em modo `perguntar` para um servidor configurado foi provada com o fixture do
  app-server; no mini o bot alvo roda em `acesso completo`.
- Prompts, o `$` da conversa e a página de uso foram provados no app empacotado contra o fixture;
  no mini, `prompt.list` e `usage.summary` foram exercitados pelo laboratório, não pela interface.
- Nada de imagens, compactação, Claude/Grok/BYOK ou rotação de contas: fora do escopo.

## Verificações executadas (2026-09-18)

| Comando | Resultado |
| --- | --- |
| `npm run check:bot-chat` | ✅ tipos de host-protocol, host-core, host, bot-runtime, chat-ui, bot-desktop e desktop; 19 guardrails |
| `npm run test:bot-chat` | ✅ 10 + 16 + 22 + 30 + 27 + 19 |
| `npm run test:e2e:bot-chat` | ✅ **10 testes no app empacotado** |
| `test:host-phase1`, `test:bot-phase2`, `test:bot-sessions`, `test:bot-phase3`, `test:bot-phase4`, `test:bot-phase5` | ✅ sem regressão (host-core 387; bot-runtime 147) |
| `typecheck` + `test:unit` do Maestrly App | ✅ tipos limpos; unit = baseline (3 falhas pré-existentes em `chat-design-mode-renderer-contract` e `checkbox-style-contract`, alheias ao pacote compartilhado) |
| `npm run test:docs` / `check:boundaries` | ✅ 57 arquivos · isolamento preservado |

Uma correção de teste saiu desta rodada: o teste do supervisor em `extensions.test.ts` subia o
proxy local na mesma porta que `auth.test.ts`, em workers paralelos, e falhava por `EADDRINUSE`
uma vez a cada poucas rodadas; agora pede uma porta livre ao sistema.
