# Implementação da Fase 1 — evidências em 12/09/2026

**Fase 2:** bots conversacionais sobre este Host estão descritos em
[Maestrly Bot](maestrly-bot.md), com [laboratório](maestrly-bot-lab.md) e
[validação física](maestrly-bot-physical-validation.md) próprios.

**Atualização:** o Host foi instalado e a operação básica foi validada no Mac mini,
inclusive conexão pelo aplicativo instalado e duas VMs reais. Veja a
[validação do equipamento físico](maestrly-host-physical-validation.md). O relatório
abaixo preserva o estado da entrega anterior à conexão remota.

O Maestrly Bot Lab foi implementado, empacotado e instalado no Mac controlador.
O núcleo do Host administrou **duas VMs Linux reais simultâneas**, inclusive usando
o pacote distribuível fora do repositório e seu próprio Node, com ambiente mínimo.
**A fase não está homologada no Mac mini:** não foi fornecido um alvo SSH explícito
com identidade física esperada e teto de recursos remotos.

**Implementado e testado**

- Quatro workspaces independentes: [Bot Desktop](../apps/bot-desktop/package.json),
  [Host](../apps/host/package.json), [protocolo](../packages/host-protocol/src/index.ts)
  e [núcleo](../packages/host-core/src/index.ts). Identidade Bot
  `io.github.antonioducs.maestrly.bot`, com perfil próprio de laboratório.
- Schemas estritos/versionados, IPC restrito, interface local React/Electron,
  OpenSSH com comando remoto fixo, chaves verificadas estritamente e sem
  encaminhamento de agent. Não há dependência de board/card, Kanban ou PostgreSQL.
- SQLite próprio, IDs persistentes, operações duráveis/idempotentes, revisões,
  recuperação conservadora, inventário de discos retidos e consulta por chave
  após perda de resposta. Reenvio incerto exige ação explícita com a mesma chave.
- QEMU/HVF com executáveis verificados, QMP e QGA privados, NoCloud, confirmação
  de provisionamento, admissão de capacidade, ausência de NIC e console limitado.
  Remover preserva dados por padrão; purge é uma ação confirmada separadamente.
- Builds de runtime/imagem, diagnóstico, transferência verificada, instalador
  launchd, smoke opt-in e CI ampliada. Os testes físicos não rodam automaticamente
  em PRs. As proteções e a identidade do desktop de desenvolvimento foram mantidas.

Os componentes principais estão em [provider QEMU](../packages/host-core/src/providers/qemu/provider.ts),
[Guest Agent](../packages/host-core/src/providers/qemu/guest-agent.ts),
[persistência](../packages/host-core/src/persistence/store.ts),
[serviço](../apps/host/src/main.ts), [ponte SSH](../apps/bot-desktop/src/main/ssh-transport.ts),
[recuperação do cliente](../apps/bot-desktop/src/main/host-connections.ts),
[interface](../apps/bot-desktop/src/renderer/App.tsx) e
[laboratório](../scripts/host-lab.mjs).

**Artefatos efetivamente produzidos**

| Artefato | Versão/arquitetura | Integridade |
|---|---|---|
| Bot Lab | 0.1.0, Electron 42.11.2, Arm64 | SHA-256 do ASAR: `6f67d3bf752112d5e96cacbe197d96025aecdff0363f23c7352797abfe0dd192` |
| Pacote Host | Node 22.23.2, QEMU 11.1.1, Arm64 | SHA-256 do manifesto: `4dee5e88a90cc2a78af6e6dec30aba80880cb4a25e1dc63b042ab3399cbfdd23` |
| Linux preparado | Ubuntu 24.04, base 2026-08-26, Arm64 | SHA-256: `386f969d80b586468e9363c51cef80177d5b8b51fbb0fb94f76d16e1bab337b3` |
| Base Ubuntu oficial | Ubuntu 24.04, 2026-08-26, Arm64 | SHA-256: `afa139bac6f2629c1e1f2f8f34215f3a9ad9779801bcb945521ba1a45016743f` |

A imagem contém QEMU Guest Agent `1:8.2.2+ds-0ubuntu1.18` e cloud-init
`26.1-0ubuntu1~24.04.1`. O inventário completo de pacotes acompanha a imagem.
O pacote Host tem 240 arquivos verificados. As 31 fontes de distribuição do
runtime foram verificadas por checksum; a closure contém executáveis, bibliotecas,
firmware e notices. [Catálogo e proveniência](../deploy/host/macos/runtime-arm64.candidate.json).

Este candidato requer **macOS 26.0 ou superior**, medido nos Mach-O, além de Arm64
nativo. O baseline genérico de doctor (macOS 13) não reduz esse requisito do
artefato. O instalador recusa arquitetura/versão incompatíveis. Não há pacote
Intel homologado. O app é um build local de laboratório sem assinatura de
identidade de distribuição/notarização; QEMU/helper receberam assinatura ad-hoc
com entitlement de hypervisor. Nenhum release foi publicado.

Saídas locais: `apps/bot-desktop/dist/lab/`, `dist/maestrly-host-arm64/` e
`dist/ubuntu-24.04-20260826-arm64.qcow2`. Aplicativo instalado em
`~/Applications/Maestrly Bot Lab.app`. O inventário do app confirmou sandbox,
context isolation, Node desabilitado no renderer, fixture desabilitada e perfil
`io.github.antonioducs.maestrly.bot.lab`.

**Configuração sanitizada e lifecycle observado**

| Campo | Evidência |
|---|---|
| Alvo SSH do Mac mini | Não configurado; nenhuma descoberta automática |
| Identidade física/cotas do Mac mini | Não fornecidas; homologação bloqueada |
| Controlador do teste | macOS 26.6.2, Arm64; não tratado como o Host remoto |
| Orçamento local | Duas VMs, cada uma com 1 CPU, 1 GiB de RAM e disco virtual de 12 GiB |
| Rede normal | Nenhuma NIC; QGA observou somente loopback |
| Rede de preparação | Somente na VM descartável de build, sem port forwarding |

O teste com pacote carregou `app/host-core.mjs` através de Node empacotado, de uma
cópia em diretório temporário fora do worktree, com `PATH=/usr/bin:/bin`. Confirmou:

1. Duas VMs prontas, IDs/discos distintos e marcadores gravados e sincronizados.
2. Fechamento/reabertura do núcleo sem interrupção dos guests.
3. Reboot de cada guest, com boot ID diferente e marcador preservado.
4. Desligamento e novo início de cada guest, novamente preservando o marcador.
5. Remoção da primeira com disco retido e segunda VM intacta.
6. Purge explícito e limpeza de ambos os guests descartáveis do teste.

A [evidência sanitizada](../deploy/host/macos/controller-evidence.json) registra o
escopo. Relatórios completos, manifests privados, logs e screenshots estão em
`.host-lab/` e nos `test-results` locais, ignorados pelo Git. O teste local não
prova SSH, logout, launchd sob conta dedicada ou boot físico do Mac mini.

**Comandos e resultados**

| Comando/verificação | Resultado |
|---|---|
| `npm run check` | Passou, incluindo workspaces antigos e novos |
| `npm run check:host-phase1` | Passou |
| `npm run test:host-phase1` | Passou; 52 core, 4 protocolo, 29 Host, 25 Bot e testes de artefatos |
| `npm run check:boundaries` | Passou; também detecta imports Node sem prefixo `node:` |
| `npm run lint` | Código 0; 40 warnings e 4 infos existentes fora dos novos componentes |
| `npm run test:policy` | 38 testes passaram |
| `npm run test:docs` | Links passaram |
| `npm run test:e2e:bot` | 6 testes passaram: cinco fluxos Electron com fixtures e startup empacotado |
| `npm run package:bot:lab` | Pacote e inventário produzidos; startup/sandbox verificados |
| Startup da cópia instalada | Passou, usando o executável em `~/Applications` |
| `npm run package:host:lab` com manifest explícito | Pacote produzido; 240 hashes verificados |
| `npm run build:host:image` com manifest explícito | Linux iniciou, preparou pacotes, sincronizou e desligou |
| `host-local-smoke.mjs`, primeiro no worktree e depois empacotado | Passou com duas VMs reais; o segundo também verificou cold start |
| `lab:host:doctor`, `lab:host:deploy`, `lab:host:smoke` sem configuração | Código 1 com orientação; nenhum contato remoto |

No desktop existente, 3.768 testes passaram e 5 permaneceram skipped. Não houve
alteração em seu código, appId ou caminhos de perfil. A execução nativa dos novos
checks em Linux/Windows ainda cabe à CI; casos POSIX têm skips explícitos no
Windows, mantendo contratos e validações puras ativos.

**Falhas encontradas e corrigidas**

A validação real detectou espera por rede na imagem sem NIC, impedindo readiness
no prazo. A preparação agora desabilita essa espera **no guest**; os dois testes
reais seguintes comprovaram provisionamento offline. Os primeiros guests de teste
foram encerrados somente após confirmação de UUID por QMP e purgados; a evidência
de falha foi mantida. Também foram corrigidos framing/sincronização QGA, nomes
VFAT NoCloud, send-only shutdown, saída de processo, retenção/purge, resposta
perdida, preload CommonJS e cleanup de probes HVF sem resposta. Não houve falha
preexistente suprimida; os avisos de lint existentes continuam visíveis.

**Implementado não homologado / bloqueado**

SSH real, instalação administrativa, QEMU sob `_maestrlyhost`, continuidade após
logout, launchd/recovery e lifecycle do aplicativo conectado ao **Mac mini** estão
implementados, mas não homologados nesse equipamento. Reboot físico não foi
executado. A aprovação do plano não foi usada para descobrir aliases ou alterar
outros computadores. Não se promete preservação de RAM ou escritas não
sincronizadas após falha do serviço. O resize de disco posterior, rede liberada,
IA/bots e interfaces remotas continuam fora deste recorte. Atualizações de uma
instalação existente exigem procedimento controlado; o instalador é conservador
e não substitui dados existentes automaticamente.

**Instalação e próxima operação**

Abra o Bot instalado. Para habilitar a homologação remota, forneça/configure o
alias SSH exato, IOPlatformUUID esperado e orçamento autorizado no arquivo privado
`.maestrly-host-lab.json`. Execute doctor, compare a arquitetura/macOS com o
candidato e só então transfira o pacote. A instalação inicial requer revisão e
privilégio administrativo no Mac mini; o grupo de operadores é escolhido
explicitamente. Depois, conectar/criar/iniciar/desligar/reiniciar/remover ocorre
pelo aplicativo, sem terminal por VM.

Siga [operação e instalação](maestrly-host.md),
[procedimento do laboratório](maestrly-host-lab.md) e
[builds de artefatos](host-artifact-build.md). A demonstração final no Mac mini
permanece pendente desse alvo e da instalação autorizada.
