# Maestrly Bot — Fase 2

O Maestrly Bot conecta a conta de IA uma vez e cria bots em ambientes preparados.
Cada bot escolhe modelo e effort e recebe tarefas por conversa. O trabalho
executa dentro de uma VM Linux no Host escolhido (o Mac mini do laboratório ou este Mac),
com identidade, histórico, memória e arquivos persistentes. Fechar o aplicativo não
interrompe o bot; o computador que executa a VM precisa continuar ligado.

## Arquitetura

`App instalado → transporte local (`maestrly-host rpc-stdio`) ou SSH já confiável → Host/BotService → canal privado da VM → runtime Linux → Codex app-server e ferramentas`.

- O Host ([`packages/host-core`](../packages/host-core/src/index.ts)) continua a autoridade sobre
  VMs, políticas, aprovações e registros duráveis. O domínio Bot usa o schema SQLite 4
  ([migrações](../packages/host-core/src/bots/migrations.ts)); as migrações 1→2→3→4 preservam
  hostId, VMs, operações e histórico. Binários antigos recusam schemas futuros.
- Uma VM preparada pode hospedar vários bots com áreas de trabalho independentes
  ([arquitetura e validação](bot-runtime/shared-vm-validation.md)). Cada bot é vinculado a uma VM. Bot, conversa, turno e computador têm ciclos de vida
  distintos: encerrar uma tarefa não remove a VM; arquivar não apaga disco nem histórico.
- O runtime Linux ([`apps/bot-runtime`](../apps/bot-runtime/README.md)) fala com o Host por um
  virtio-serial privado (`org.maestrly.bot.control.0`) com handshake versionado (`bot.runtime.v1`),
  bootId, geração e nonce ecoado. Eventos só são confirmados (ACK) após persistência no Host;
  reentregas são deduplicadas por `runtimeEventId`.
- A VM continua sem NIC. A única saída é o broker de egress ([`egress/`](../packages/host-core/src/egress/broker.ts))
  sobre o port `org.maestrly.bot.egress.0`: hostnames exatos nas portas 80/443, sem IPs literais,
  privados, link-local, multicast, metadata ou endereços do próprio Host (incluindo IPv4 mapeado em IPv6);
  resolução única com endereço pinado e verificação do peer. CONNECT é pass-through TLS: controlar o
  destino não significa inspecionar conteúdo. Revogar a política encerra streams existentes.
- A conta geral pertence a uma autoridade persistente no Host, com `CODEX_HOME` exclusivo e privado.
  Os workers recebem tokens de acesso temporários; o refresh token permanece na autoridade.
  Outros Hosts cadastrados usam vínculos explícitos e revogáveis. O login usa o fluxo oficial
  de dispositivo; a chave de API é alternativa explícita, enviada pelo canal privado sem journal.
  Veja [autenticação compartilhada](bot-runtime/shared-accounts.md).
- Vários bots podem formar uma **equipe** que recebe um pedido só e devolve um resultado
  consolidado, com delegação em lotes, compartilhamento explícito e controle humano preservado.
  Veja [equipes de bots](bot-runtime/teams.md).
- A conversa mostra ferramentas, raciocínio e tempo de resposta a partir de uma projeção única
  dos eventos; comandos prontos, servidores MCP e skills por bot e uma área de uso e custos
  completam a experiência. Veja [experiência de chat](bot-runtime/chat-experience.md).
- Permissões: `ask` (recomendado: usuário Linux não-root, workspace, aprovações para ações elevadas,
  novos destinos e exclusões protegidas) e `full-vm` (controle administrativo completo dentro da VM,
  confirmação explícita, sem acesso ao Host nem alteração de egress). Nenhuma delas é isolamento
  contra um administrador malicioso do guest.

## Métodos Bot do protocolo

Todos usam o envelope v1 com params/result próprios ([`bot-rpc.ts`](../packages/host-protocol/src/bot-rpc.ts)):
`bot.list/create/inspect/update/archive`, `bot.setup.preview/start/inspect/cancel`,
`bot.runtime.inspect/prepare`, `bot.models.list`, `bot.auth.status/start/cancel/logout/setApiKey`,
`bot.messages.list/send/lookup`, `bot.turn.get/cancel`, `bot.interactions.list/resolve`,
`bot.memory.list/upsert/delete`, `bot.events.list` (paginado por cursor e orçamento de 512 KiB),
`bot.network.inspect/update`, `bot.files.list/transferBegin/transferChunk/transferFinish/transferAbort`
(chunks de 48 KiB, até 32 MiB por arquivo) e `bot.operation.get/lookup`.

As famílias `account.*` e `environment.*` gerenciam contas e ambientes independentemente dos bots;
`account.models` carrega modelos antes da criação. Os métodos `bot.auth.*` permanecem para
compatibilidade e migração administrativa de instalações anteriores.

Uma conversa e um turno ativo por bot. A mensagem é persistida antes do recibo; repetir o mesmo
`clientMessageId` devolve o mesmo turno; enviar durante uma tarefa retorna `BOT_BUSY`. Estados do
turno: `queued, starting, running, waiting_approval, waiting_input, cancelling, succeeded, failed,
cancelled, interrupted, needs_attention`. Um timeout de transporte nunca autoriza repetir
`turn.start`: o Host consulta o journal do guest (`turn.reconcile`). Reiniciar o Host marca turnos
incertos como `needs_attention` e reconcilia; reiniciar a VM interrompe honestamente (`VM_STOPPED`).
Limites por turno: 30 min de execução ativa, 100 ferramentas, 10 MiB de log normalizado, lease de
30 s renovado a cada 10 s; espera humana até 24 h.

## Criação e preparação

O fluxo é nome/instruções → ambiente → modelo/effort → criar. Um único ambiente preparado é
selecionado automaticamente; vários permitem escolha. O formulário preserva o rascunho ao abrir
Contas ou Ambientes. A lista não verifica imagens; `bot.setup.preview/start` no caminho `shared-vm`
consulta a disponibilidade das sessões, sem inspecionar binários ou artefatos da instalação.
A criação reserva capacidade em uma transação e rejeita inventário alterado ou ambiente indisponível.
Repetir a mesma chave de criação recupera a operação existente.

Criar ou preparar ambientes é uma ação separada em Ambientes, sem criar um bot incidentalmente.
A preparação efetiva verifica artefatos e exige confirmação do backup e reinício quando necessários.
Ela usa QGA com paths fixos: backup do disco com guest parado, transferência do bundle em chunks,
conferência do SHA-256 dentro do guest e execução do instalador fixo. Falhas incertas não são repetidas
silenciosamente. Ambientes preparados não exibem controles de reinstalação no formulário do bot.

## Aplicativo

A home é a conversa e a lista de bots. A administração de computadores da fase 1 continua em
Configurações → Avançado → Computadores. O transporte local usa o comando fixo
`/Library/MaestrlyHost/bin/maestrly-host rpc-stdio` após verificar propriedade e permissões da
instalação; SSH mantém `StrictHostKeyChecking=yes` e sem agent forwarding. Só o destino já escolhido
e confiável é reconectado; não há varredura de rede. O journal Bot registra a chave antes de enviar
e consulta por `bot.messages.lookup`/`bot.operation.lookup` após perda de resposta; `bot.auth.setApiKey` e `account.setApiKey`
nunca são journalados. Conteúdo de chat e caminhos do guest passam por projeções tipadas, não pelo
sanitizador de diagnóstico.

"Neste Mac" instala o Host apenas a partir de um pacote verificado e preparado pelo administrador
(`/private/var/tmp/maestrly-host-package`) e de uma autorização de instalação revisada
(`install-request.json` no perfil do app), usando o instalador fixo com o prompt administrativo do
macOS. O app nunca coleta a senha nem monta comandos a partir do renderer.

## Atualização preservadora

`deploy/host/macos/upgrade.sh --authorize-upgrade <sha256 do manifesto> --window-confirmed` verifica o
pacote preparado, executa o preflight ([`check-upgrade.mjs`](../deploy/host/macos/check-upgrade.mjs):
recusa bots ativos, downgrade, cotas abaixo das reservas e imagens referenciadas removidas), faz
backup consistente do SQLite (incluindo WAL) com o serviço parado, mantém o código e o runtime anteriores
em diretórios `*.previous-*`, mescla o catálogo (runtimes, imagens e templates) e reinicia o serviço.
Nunca apaga `/Library/MaestrlyHost`. A migração de schema roda no primeiro start e só é revertida
restaurando o backup, com perda dos dados posteriores.

## Verificação

- `npm run check:bot-phase2` e `npm run test:bot-phase2`: contratos, migração, setup, turnos,
  egress, memória, arquivos, runtime Linux (canal, journal, adapter Codex com fixture de app-server,
  proxy, ferramentas), cliente Codex, app (journal, alvos, instalação) e artefatos.
- `npm run test:e2e:bot`: onboarding, chat, modo simples/avançado e administração com fixtures.
- Laboratório opt-in no Mac mini: veja [procedimento](maestrly-bot-lab.md) e a
  [validação física](maestrly-bot-physical-validation.md).
