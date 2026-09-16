# Validação física da Fase 2 — estado em 13/09/2026

**Atualização posterior:** a consulta remota confirmou identidade e inventário do
mini, sem mutações. Foram construídos artefatos Ubuntu ARM64 e realizados testes
locais numa VM descartável. Veja [imagem e medições](maestrly-bot-image.md) e
a [verificação do pacote final](bot-runtime/offline-environment-verification.md).
Os bloqueios e contagens abaixo registram a primeira implementação; não devem
ser interpretados como inventário atualizado dos artefatos locais.

Este relatório separa o que foi implementado e testado no controlador, o que está implementado
mas **não homologado** no Mac mini, e o que está bloqueado. Nenhum item abaixo alega homologação
Intel, reboot físico, capacidade ilimitada ou proteção contra um guest root malicioso.

## Implementado e testado (controlador, sem hardware remoto)

| Área | Evidência |
|---|---|
| Contratos Bot (`host-protocol`) | 12 testes: envelope v1 compartilhado, métodos exaustivos com result schema, rejeição de métodos arbitrários/segredos, política de rede, frames do canal guest |
| Núcleo (`host-core`) | 85 testes: migração 1→2 transacional e abortável, índices únicos, setup guiado retomável e idempotente, preview obsoleto/cota/VM já vinculada, arquivamento, turnos/aprovações/perguntas, cancelamento confirmado pelo guest, perda de resposta e reinício sem replay, queda de canal → `needs_attention` → reconciliação, desligamento emergencial, memória/orçamento, arquivos/transferências, egress (política, normalização IPv6, rebinding, peer mismatch, revogação) |
| Runtime Linux (`bot-runtime`) | 55 testes: framing/handshake/ack, journal e recuperação, leases e limites, adapter Codex contra app-server fixture (thread persistente, aprovação, cancelamento, env mínimo, -32601), auth (device/apiKey, URL não confiável), arquivos, proxy/egress (CONNECT, negação, offline, loopback, backpressure, 17º stream), ferramentas (registro, aprovação elevada, observação obsoleta, dedupe), MCP, instalador (sintaxe e SHA-256). Browser/Xvfb pulados sem binários |
| Cliente Codex (`codex-client`) | 20 testes, incluindo regressões do desktop antigo (24 testes) |
| Aplicativo (`bot-desktop`) | 43 unitários (journal sem segredos, alvos, transporte local fixo, instalação fail-closed, projeções tipadas) e 14 e2e Electron com fixtures (onboarding sem escolhas técnicas, Host ausente, retomada, chat/aprovação/pergunta/parar/falha, markdown malicioso, reconexão, modo simples sem infraestrutura, administração no avançado, temas, teclado, janela mínima) |
| Artefatos e scripts | `tests/bot-artifacts.test.mjs`, `apps/host/test/{bot-lab,upgrade}.test.mjs`: instaladores sem `--no-sandbox`/CDP e sem VNC em rede (a tela ao vivo da fase 3 usa TigerVNC somente leitura em socket Unix privado, coberto por `tests/bot-desktop-artifacts.test.mjs`), sudoers restrito, builder exige manifesto pinado, laboratório opt-in não muta sem consentimento, preflight de upgrade |

## Implementado, não homologado no Mac mini

- Canal virtio-serial real, handshake e egress sobre QEMU/HVF com o runtime dentro de uma VM.
- Preparação de um guest existente por QGA (backup, transferência do bundle, instalador fixo, reinício).
- Login oficial por código de dispositivo com conta autorizada e catálogo real de modelos do Codex app-server.
- Tarefa real (CSV → relatório Markdown/HTML), navegação pública autorizada pelo broker, HTML local no
  Chromium do guest com interação e screenshot, ação elevada aprovada/negada, cancelamento de
  comando longo com término do cgroup, persistência após reinício de runtime/guest, transferências
  e revogação de saída durante stream.
- Atualização preservadora do Host instalado e empacotamento do bundle Linux Arm64.

## Bloqueado nesta sessão

- Não houve acesso SSH ao Mac mini nem conta de provedor autorizada; o roteiro da Tarefa 11 não foi
  executado. Os scripts `lab:bot:doctor/prepare/smoke`, o teste Vitest opt-in
  (`apps/bot-runtime/test/lab/bot-lifecycle.test.ts`) e o e2e `bot-real-host.spec.ts` existem e se
  recusam a rodar sem a configuração privada e as flags de autorização.
- O bundle Linux Arm64 (Node, Codex, Chromium) não foi construído: exige entradas pinadas com SHA-256
  fornecidas pelo administrador (`MAESTRLY_BOT_BUILD_CONFIG`). Sem ele não há template bot-ready e
  `bot.setup.preview` retorna `NO_BOT_TEMPLATE` de forma explícita.
- Os nomes exatos de notificações/requests do Codex app-server v2 foram implementados de forma
  defensiva e testados contra um fixture local; a conformance com o binário empacotado permanece
  pendente (ver `apps/bot-runtime/README.md`).

## Roteiro a executar no Mac mini

1. Registrar baseline (`npm run lab:host:doctor`, `npm run lab:bot:doctor`) com IDs, markers e cotas.
2. Construir o bundle (`npm run build:bot-runtime:bundle`) e o pacote do Host com `botTemplates`; atualizar o
   Host com `upgrade.sh` em janela autorizada; atualizar o app instalado.
3. Selecionar a VM em `botVmId`, autorizar `allowGuestPreparation` e rodar `npm run lab:bot:prepare`
   (ou fazer o mesmo pelo onboarding, escolhendo "Usar um computador virtual existente").
4. Conectar a conta no aplicativo, delegar a tarefa CSV → relatório e conferir valores/hashes.
5. Seguir os itens 5–12 da Tarefa 11 (navegação pública/negada, screenshot fresca, fechar app/SSH
   durante tarefa, aprovação/negação, cancelar, reiniciar runtime/guest, memória/arquivos, revogação,
   avançado, capturas e acessibilidade), registrando referências sanitizadas em `.host-lab/`.
