# Validação da Fase 3 — tela ao vivo e intervenção humana

Fluxo de aceite: bot trabalhando → **Ver tela** → **Assumir controle** → correção pela interface →
**Devolver e continuar** → o bot observa o estado novo e prossegue. Arquitetura e garantias em
[tela ao vivo](bot-runtime/live-desktop.md); comandos do laboratório em
[laboratório](maestrly-bot-lab.md). Evidências ficam em `.host-lab/` (ignorado pelo Git).

## Situação

| Categoria | Itens |
| --- | --- |
| Implementado e verificado | Protocolo `bot.desktop.*` e lane de mídia; migração 4→5 com cópia prévia do banco; serviços gráficos separados da automação; takeover, lease, epoch e continuação única; servidor RFB somente leitura e entrada XTEST; gateway, `desktop-stdio`, cliente e UX do aplicativo; addon offline e bundle versionado; atualização opcional do ambiente com backup, retenção da instalação anterior e reinício. Validado em contêiner, em VM Linux local sem rede e **no Mac mini**: Host instalado, ambiente atualizado pelo fluxo do produto, laboratório físico por SSH com 9/9 cenários e 4/4 metas, e o aplicativo empacotado instalado contra o Host real |
| Implementado, não homologado | Arquivar ou parar um bot com a tela aberta; saturação de mídia além de um arraste contínuo; takeover no meio de uma tarefa com continuação clicado pela interface do aplicativo empacotado (comprovado pelo laboratório pelas mesmas chamadas do aplicativo; o teste de interface assume um bot ocioso) |
| Bloqueado | Nada da fase 3. O agregado `npm run check` segue falhando em dois testes de contrato de `apps/desktop` (o aplicativo Maestrly principal), anteriores a esta fase e sem alteração nela |

## Mac mini (homologação física, 2026-09-15)

Tudo dentro da janela autorizada, só na VM selecionada `lab-mini-linux-1`; a segunda VM continuou
parada e intocada. Nenhum dado foi apagado.

1. **Preflight somente leitura** (`.host-lab/desktop-rollout/preflight.json`): identidade física
   conferida; Host 0.2.0 sem as capacidades da fase 3; manifesto e configuração instalados iguais
   aos deixados pela atualização de contas; dois bots prontos e ociosos.
2. **Instalação do Host** pelo kit de administrador (a senha foi digitada pela pessoa). O kit
   conferiu identidade, cada arquivo instalado e cada arquivo em staging por SHA-256, fez backup do
   SQLite com `integrity_check`, do aplicativo, da configuração e do manifesto em
   `/Library/MaestrlyHost/backups/desktop-r2`, trocou só o bundle do template
   `linux-arm64-accounts-v1` e reiniciou o serviço. Resultado: `DESKTOP_HOST_READY`, mesma
   identidade do Host, VMs, bots e capacidade inalterados, banco migrado para o schema 5.
3. **Atualização do ambiente** pelo fluxo do produto (`environment.prepare`, evidência
   `.host-lab/desktop-rollout/environment-1789486628940`): backup do disco, instalação do runtime
   `0.1.0-20260915-desktop-r2` pelo QGA com retenção da instalação anterior e reinício, em 3,9 min.
   Histórico e memória dos dois bots preservados (12 e 5 mensagens), segunda VM inalterada, os dois
   bots com `desktop.live.v1` e `desktop.handoff.v1`.
4. **Laboratório físico** (`npm run lab:bot:desktop -- run --authorize-desktop-lab`), pelo mesmo
   caminho do aplicativo: `rpc-stdio` persistente e `desktop-stdio` por SSH, com o ticket só no stdin.

| Cenário | 2ª execução (`supported`) |
| --- | --- |
| Primeiro quadro | 938 ms, 1280×800 |
| Dois visualizadores do mesmo bot | 863 ms |
| Dois bots | telas distintas, 1170 ms |
| Takeover no meio de uma tarefa real | 1051 ms; a tarefa interrompida para a pessoa; o outro bot seguiu intacto |
| Entrada→pixel | p50 96 ms, p95 148 ms (meta ≤ 250 ms), 20 amostras, 0 perdas |
| Atualizações durante um arraste | 17,5/s (meta ≥ 10) |
| Queda de um visualizador | o controlador continuou vendo e controlando |
| Perda do lease | `paused` em 12,2 s; entrada recusada com `CONTROL_EXPIRED` |
| Devolução e continuação | devolução em 1036 ms; a continuação terminou e produziu `lab-desktop.md` |
| Renovação | no máximo 202 ms |

A **1ª execução** passou nos mesmos cenários de tela, lease e devolução, com entrada→pixel p95 de
388 ms, mas foi registrada como bloqueada por dois motivos, ambos corrigidos no laboratório: a
tarefa pedia um terminal gráfico e o bot gastou o orçamento restante antes de criar o arquivo; e o
laboratório lia o código do erro do turno, que o socket do Host substitui (ver limites). A
diferença de p95 entre as execuções vem da rede (SSH sobre Tailscale).

5. **Aplicativo empacotado.** `npm run package:bot:lab` gerou o aplicativo e o teste de
   inicialização empacotada passou (ele falha enquanto outra cópia do aplicativo estiver aberta, por
   causa da instância única). A versão foi instalada em `~/Applications`, com a anterior guardada
   como `Maestrly Bot Lab.before-desktop.app` e o perfil do usuário intocado. O teste real
   `bot-desktop-real.spec.ts` passou em 9,7 s: conectou ao Mac mini, abriu a tela do bot,
   assumiu o controle, clicou, devolveu o teclado com Shift+Esc e voltou a somente observar, sem
   nenhum ticket ou capacidade no DOM.

## Responsividade da tela (correção de atraso, 2026-09-15)

A tela ficou lenta no uso real. Medida no aplicativo empacotado contra o Mac mini (rede de
2,3 ms), a causa não era a rede:

- o servidor de tela enviava no máximo 15 quadros/s, e o temporizador de quadros é o piso da
  latência (no contêiner: 15 fps dá p50 66 ms de entrada→pixel; 30 fps, 34 ms; 60 fps, 16 ms, com a
  CPU do servidor passando de 5% para 7%; `scripts/test/desktop-frame-bench.ts`);
- o guest lia e escrevia as portas virtio por polling, com espera de 10 ms quando não havia dado ou
  a porta estava cheia, nas lanes de controle, egress e mídia; cada entrada levava p50 37 ms e p95
  174 ms só para atravessar o guest;
- o Host refazia o hash do QEMU e do firmware e subia uma VM de sonda a cada `host.inspect`
  (~0,8 s), e o aplicativo faz essa chamada ao abrir a tela.

Correções: 60 quadros/s; portas virtio lidas e escritas por eventos de prontidão (`poll`), com o
polling mantido só como fallback; um único `systemctl` por sessão no timer de 2 s e a sonda do VNC
em cache; a checagem de runtime em `host.inspect` reaproveitada por 60 s (falhas são rechecadas e
iniciar uma VM continua verificando tudo). Para que a correção chegue a ambientes já atualizados,
o Host passou a oferecer **Atualizar ambiente** também quando o runtime anunciado pelo guest difere
do pacote do template; a versão fica só no Host e não entra no inventário enviado ao aplicativo.

Entregue no Mac mini pelo mesmo caminho da homologação: kit de administrador do Host `r3` (senha
digitada pela pessoa; `DESKTOP_HOST_READY`, mesma identidade) e atualização do ambiente
`lab-mini-linux-1` pelo aplicativo em 3,9 min, com runtime `0.1.0-20260915-desktop-r3`
(`9aba7a020f01f799d9bfb98e75249e6d829b8a806db4b69db1763bbd42f63b23`), histórico e memória
preservados e a segunda VM intocada. Antes, a VM local sem rede passou 29/29 na atualização no
lugar a partir do runtime implantado (`.host-lab/desktop-vm-xvgUvz`): entrada→pixel p50 14 ms e p95
17 ms (antes 64/66), 53 atualizações/s (antes 15), renovação no máximo 3 ms (antes 13).

| No Mac mini, pelo aplicativo empacotado | Antes | Depois |
| --- | --- | --- |
| Clique/tecla até o pixel (p50 / p95) | 104–149 / 324–350 ms | 49 / 98 ms |
| Mudanças vistas percorrendo um menu | 17/s, pausas p95 170 ms | 26/s, pausas p95 81 ms |
| Abrir a tela até o primeiro quadro | 1,9–2,3 s | 0,84 s |
| Cada entrada pelo guest (p50 / p95) | 37 / 174 ms | 8,6 / 13 ms |
| Renovação com controle (p50 / p95) | 20 / 206 ms | 7,7 / 12 ms |
| `host.inspect` (p50) | 801 ms | 3,4 ms |

A medição do aplicativo é `apps/bot-desktop/test/e2e/bot-desktop-real-perf.spec.ts` (opt-in, como os
testes reais); ela assume o controle de um bot ocioso por alguns segundos e devolve.

## Controles de janela e ponteiro (correção de clique, 2026-09-15)

No uso real não dava para fechar, maximizar nem arrastar janelas, e o clique parecia ruim. Causas:

- O Openbox roda com `--config-file`, que substitui todos os padrões. O `openbox-rc.xml` só
  declarava o clique direito na área de trabalho: os botões da barra de título apareciam, mas não
  tinham ação, a barra não arrastava e clicar numa janela não a focava. Isso valia também para os
  cliques do próprio bot.
- O servidor de tela envia um cursor vazio (0×0) sobre o Xvfb. O noVNC então esconde o ponteiro
  sobre a tela, e o CSS do app escondia o do Mac durante o controle: a pessoa clicava sem ver o
  ponteiro.

Correções: o `openbox-rc.xml` passa a declarar clique para focar e trazer à frente, arrastar e
duplo clique na barra de título, fechar, maximizar e redimensionar pelas bordas, sem o botão de
minimizar (não há painel para restaurar a janela), sem enrolar a janela e sem trocar de área de
trabalho. O app mostra a seta local sobre a tela sempre que o formato remoto vem vazio.

Prova em contêiner sem rede com o Openbox fixado e o arquivo entregue, pela mesma entrada XTEST do
app (`scripts/test/desktop-wm-probe.ts`, agora parte do `--local-container`). Com o arquivo
anterior: foco por clique não, arraste 0×0, maximizar e fechar sem efeito. Com o novo: foco por
clique, arraste de exatamente 150×80 px, maximizar para 1280 px, duplo clique restaurando e
fechar. A prova completa passou (`.host-lab/desktop-proof-vkagTQ`). No app, o teste de takeover
confere que o cursor sobre a tela é a seta (`cursor: default`) durante o controle.

Entregue no Mac mini com o runtime `0.1.0-20260915-desktop-r4`
(`7cd8309ddd5478c513c95bf03b455fcbe69500d44112d82a8d8b9a4ec0df62ee`), pelo mesmo processo: Host `r4`
com a senha digitada pela pessoa (`DESKTOP_HOST_READY`, mesma identidade) e ambiente
`lab-mini-linux-1` atualizado pelo app em 3,8 min, com histórico e memória preservados e a segunda
VM intocada. Antes, a VM local sem rede passou 29/29 na atualização a partir do runtime
`accounts-r2` (`.host-lab/desktop-vm-AnavDK`). O guest roda o Openbox `3.6.1-12build5`, a mesma
versão da prova em contêiner.

Homologação física pelo app empacotado (`apps/bot-desktop/test/e2e/bot-desktop-real-windows.spec.ts`,
opt-in), num terminal aberto pelo próprio teste com Super+Enter no bot ocioso e fechado ao final:
o ponteiro aparece sobre a tela; duplo clique na barra de título maximiza (54% da tela muda) e
restaura; arrastar a barra move a janela 144×88 px (pedido 140×90, em células de 8 px); o botão
maximizar maximiza e restaura; o botão fechar fecha a janela. O teste real anterior
(`bot-desktop-real.spec.ts`) também passou depois da atualização.

## Navegador do bot (correção de "não há Chrome", 2026-09-15)

Pedido real no Mac mini: "abre o chrome ae pra mim e pesquisa haval no google". O bot rodou dois
comandos de shell, não achou navegador e respondeu que nenhum estava instalado. Pelos eventos, ele
nunca chamou `browser_*`. A rede do bot estava liberada (lista de bloqueio vazia, saída mediada).

Causas: o Chromium gerenciado fica em `/opt/maestrly-bot/chromium/chrome`, fora do PATH e sem
item no menu, e só é acessível pelas ferramentas `browser_*`. Essas ferramentas se descreviam ao
modelo só como "Abrindo a página", e as instruções do Codex não citavam o navegador. Além disso, a
validação da fase 3 nunca tinha aberto o Chromium depois que ele passou para os serviços gráficos
da sessão.

Correções: descrições das ferramentas para o modelo (o resumo curto continua para quem acompanha a
tarefa); bloco fixo "Ambiente desta área de trabalho" nas instruções do Codex; e uma checagem na VM
local que abre uma página do workspace pelo socket do agente, como o usuário da sessão, e confere
o título, a janela visível na tela e o seccomp do renderer. Runtime `0.1.0-20260915-desktop-r5`
(`c183d246612456234ef60ba4a809d80cd9044cb59d72a0d3dd38e56503e6c6b6`).

## Atualização r5 no Mac mini: falha e correção (2026-09-15)

A atualização do ambiente `lab-mini-linux-1` para o r5 fez o backup do disco e falhou no passo de
instalação. O Host passou a mostrar o ambiente como indisponível e recusava nova preparação
(`ENVIRONMENT_BUSY`), sem caminho no app. O instalador publica de forma atômica, então o runtime
r4 continuou instalado; conversas, memória e a segunda VM não foram tocadas. O motivo real chega
ao cliente como `HOST_ERROR` e o log do Host só é legível como administrador.

Causa provável, a confirmar pelo diagnóstico do kit r6: o disco do guest tem 12 GiB e cada
atualização precisa de ~2,2 GiB livres (cópia do tar e extração), enquanto a retenção criada
nesta fase guardava **todas** as instalações anteriores (~1,1 GiB cada; umas cinco neste guest).

Correções no Host (r6):

- antes de copiar qualquer coisa, remove o staging de tentativas falhas e mantém, além do runtime
  atual, só uma instalação anterior; mede o espaço e recusa com `GUEST_DISK_SPACE` se faltar;
- se o instalador falhar, remove a cópia parcial e o tar e responde `GUEST_INSTALL_FAILED`;
- depois de instalar, remove o tar e as cópias mais antigas que `.previous`;
- um ambiente cuja atualização falhou, mas cujo supervisor responde, continua utilizável, com o
  motivo e a oferta de atualizar; a nova tentativa é aceita e faz um novo backup.

O kit de administrador r6 lê, com o Host parado, a última operação no banco e, pelo QGA, o disco do
guest e o tamanho de cada cópia do runtime, e grava tudo nos backups antes de instalar.

## Reparo do Mac mini e defeitos que o disco cheio revelou (2026-09-15)

O diagnóstico do kit r6, somente leitura e com o Host parado, confirmou a causa da falha r5: disco
do guest 100% cheio (0 KiB livres), com cinco cópias antigas do runtime (5,8 GB), o staging parcial
do r5 (0,36 GB) e o tar da tentativa (1,16 GB). Com o Host r6 instalado, o reparo pelo fluxo do
produto (`repair-environment.mjs`, que só roda quando a última preparação da VM falhou) fez um novo
backup, podou as cópias, instalou o runtime r6 e reiniciou em 4 minutos: ambiente de volta a
`full`, supervisor respondendo, conversas e memória preservadas e a segunda VM intocada. Depois disso
o disco do guest ficou em 45% (6,1 GB livres).

A sessão do "Assistente" continuou sem subir. O diagnóstico somente leitura da sessão mostrou o
runtime reiniciando em loop (185 vezes) com `Expected ':' after property name in JSON`: 1 dos 390
registros do `journal.jsonl` estava corrompido. Uma gravação interrompida pelo disco cheio deixou o
começo de um registro, e a gravação seguinte continuou na mesma linha. Os SQLite do Codex passaram
no `quick_check`. Um pedido de teste enviado a esse bot ficou em `queued` indefinidamente, sem erro.

Três defeitos corrigidos por isso:

- **Journal do runtime:** `append` volta o arquivo ao tamanho anterior quando a gravação falha e trata
  gravações curtas. Na carga, uma linha formada por um prefixo rasgado seguido de um registro completo
  mantém só o registro completo (o prefixo nunca foi confirmado), guarda o original como
  `journal.jsonl.torn-<data>` e reescreve o journal de forma atômica. Outras linhas inválidas
  continuam fatais (`JOURNAL_CORRUPT`). Runtime `0.1.0-20260915-desktop-r7`.
- **Turno preso na fila:** se a sessão do bot não abre, o turno passa a `needs_attention` (depois de
  60 s) com um motivo e um evento com código estável; ele continua guardado e começa uma única vez
  quando o computador responde.
- **Cancelar um turno em fila nunca funcionou:** `requestCancel` chamava `finish()` dentro de uma
  transação e o SQLite recusava a transação aninhada (`PROVIDER_ERROR`). Transações aninhadas agora
  são savepoints, e um turno que nunca foi despachado (em fila, ou em `needs_attention` sem
  `startedAt`) é cancelado localmente, sem falar com o guest.

O kit r7 aceita instalar com um turno que nunca começou, porque o Host só o guarda; qualquer turno
iniciado continua bloqueando.

Resultado no Mac mini (Host r7 com a senha digitada pela pessoa, `DESKTOP_HOST_READY`): o
diagnóstico mostrou a retenção limitada funcionando (só o runtime atual e `.previous` em `/opt`, o
tar removido, disco do guest em 45%). O pedido de teste preso foi cancelado sem erro (`queued` →
`cancelled`), o que no Host r6 dava `PROVIDER_ERROR`. O ambiente foi atualizado para
`0.1.0-20260915-desktop-r7` em 4,1 min, com conversas e memória preservadas e a segunda VM intocada.
O runtime da sessão do "Assistente" voltou a subir (`ready`, r7) depois de recuperar o journal.
Antes, a VM local sem rede passou 30/30 com o runtime r7 (`.host-lab/desktop-vm-GPl5c0`).

**Causa real do navegador: ferramentas MCP recusadas em modo `ask`.** Num pedido explícito para usar
`browser_navigate` e `browser_snapshot`, o bot chamou as duas ferramentas e ambas foram "recusadas
pelo sistema", sem pedido de aprovação. Os eventos mostram, em cada chamada,
`mcpServer/elicitation/request` com "Solicitação desconhecida do provedor": com aprovações sob
demanda (`ask`), o Codex pede ao cliente que confirme cada chamada de ferramenta MCP, e o runtime
não respondia a esse método, então o Codex tratava a chamada como recusada. Isso desligava, em
silêncio, todas as ferramentas `browser_*` e `computer_*` de qualquer bot em modo `ask`; o
`lab-mini-bot` funcionava porque está em `full-vm`, sem aprovações. O runtime passa a responder
`accept` para o seu próprio servidor de ferramentas (`maestrly-bot`, cujos limites o Host já impõe)
e `decline` para qualquer outro, com diagnóstico. Coberto por teste com o app-server de fixture.

**Confirmado no Mac mini (runtime `0.1.0-20260916-desktop-r8`).** Host r8 instalado com a senha
digitada pela pessoa (`DESKTOP_HOST_READY`, mesma identidade) e ambiente atualizado pelo app em
3,7 min, com conversas e memória preservadas e a segunda VM intocada. O mesmo pedido original
("abre o chrome ae pra mim e pesquisa haval no google") no bot em modo `ask` passou a usar
`browser_navigate` para `https://www.google.com/search?q=haval`, sem tentativa de shell, sem
aprovação e sem erro de ferramenta; o bot respondeu "Pronto — abri o Chrome na pesquisa por 'haval'
no Google". Antes do rollout, a VM local sem rede passou 30/30 com o bundle r8
(`.host-lab/desktop-vm-W07vbw`).

**Tentativa anterior, insuficiente.** Reenviado o mesmo pedido ("abre o chrome ae pra mim e pesquisa
haval no google"), o bot retomou a thread do Codex de 14/09, disse "Vou tentar novamente localizar
o Chrome" e pediu para rodar `find /usr/bin /usr/local/bin /opt -maxdepth 3 -iname 'chrome' …`,
que o teste negou; não chamou `browser_navigate`. As descrições e o bloco "Ambiente" são enviados
também na retomada, mas não mudaram o comportamento numa conversa que já concluiu que não há
navegador. Se aprovado, o `find` acharia o binário cru `/opt/maestrly-bot/chromium/chrome`, que
abre um Chromium fora do navegador gerenciado e sem o proxy de saída (sem internet).

## Validação local

### Contêiner descartável sem rede (`--local-container`)

`tigervnc-scraping-server 1.13.1+dfsg-2build2` sem interface de rede: socket `0600`, nenhum
listener TCP, clipboard ausente, cliente RFB hostil ignorado, XTEST com `ação €`, transmissor
encerrado após o último visualizador. Entrada→pixel p95 74 ms; 15,1 atualizações/s (teto
`FrameRate=15`). Evidência: `.host-lab/desktop-proof-M17VMO`, `.host-lab/desktop-proof-odYXw4`.

### Addon offline e bundle

O addon (`aec9232f95ac21cee410840b2fbae8d194114b432628914533a1ad1c5b777ecb`) acrescenta só
`tigervnc-scraping-server`, `tigervnc-common` e `libfile-readbackwards-perl`, baixados numa VM
descartável clonada do guest da fase 2 (`.host-lab/dependencies-EObKyz`). O bundle implantado
`0.1.0-20260915-desktop-r2` (`023b70c770a576d927c161256ce32f581161566a5d304d456a73f53401d9cf14`)
deriva da configuração do runtime `accounts-r2` que estava no Mac mini; muda só o addon. O
`desktop-r1` anterior usou uma medição de sessão mais antiga e foi descartado sem implantação.

### VM Linux local sem rede (`--local-vm`)

- **Atualização no lugar** (`.host-lab/desktop-vm-e5I8in`, 29/29): sessões criadas pelo runtime
  `accounts-r2`, atualizadas pelo `installGuestRuntime` do Host com retenção da instalação anterior
  e reinício; catálogo do guest migrado do schema 1 para o 2 e arquivos intactos; em seguida todos
  os cenários de tela (takeover 98 ms, entrada→pixel p95 66 ms, 15,3 atualizações/s, pausa por
  lease, revogação no reinício do supervisor, captura nova, retomada, sem OOM).
- **Sessões novas** (`.host-lab/desktop-vm-XFUlg7`, 25/25).

### Correções de produto encontradas pela validação

- **Ambiente já preparado.** O Host não oferecia atualização a um ambiente da fase 2; agora ele fica
  `ready` com `updateAvailable: "desktop"` e o botão **Atualizar ambiente**.
- **Instalação anterior existente.** O instalador recusa `PREVIOUS_EXISTS`; o Host passou a
  retê-la como `previous-before-<versão>`. Exercitado num contêiner Linux (sem diretório: nada;
  diretório: movido com o conteúdo; nome existente, link ou arquivo comum: `PREVIOUS_UNSAFE`) e
  no Mac mini.
- **Doctor do laboratório.** Um Host antigo encerra a sessão ao receber `bot.desktop.*`; o doctor
  não pergunta mais.

## Limites conhecidos

- O socket do Host substitui todo objeto `error` aninhado por `HOST_ERROR` e todo `reason` por
  "Runtime unavailable" (comportamento anterior). A interface da tela usa o estado da tela
  (`interruptedTurnId`, `reasonCode`), que não é afetado; o motivo detalhado de um turno interrompido
  não chega a clientes remotos.
- A latência pela rede varia: p95 de 148 ms e de 388 ms em duas execuções pelo mesmo caminho,
  antes da correção de responsividade.
- O cliente RFB de teste usa Raw (e Tight só para medir banda e CPU); o aplicativo usa noVNC. A taxa
  é limitada a 60 quadros/s pelo servidor.
- A entrada continua em série (um lote por vez, com movimentos coalescidos); o restante do
  clique→pixel no aplicativo vem do quadro, do caminho SSH/Host e da decodificação no noVNC.
- O takeover não desfaz efeitos que o bot já produziu; o controle humano não dá root nem acesso ao
  Host ou a outros bots.
- Parte dos testes do `host-core` compara o tamanho pedido de VM com o disco livre real do
  controlador; com menos de cerca de 27 GiB livres eles falham com `CAPACITY_EXCEEDED`.
