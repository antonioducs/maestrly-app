# Laboratório da Fase 2 — bot real no Mac mini

Reutiliza o `.maestrly-host-lab.json` privado da fase 1 (alias SSH, identidade física esperada,
namespace e cotas). Nada contata o Host sem esse arquivo; nada prepara um guest sem consentimento
explícito. As duas VMs existentes são preservadas: uma só é preparada quando selecionada pelo seu ID.

```json
{
  "sshAlias": "your-explicit-lab-alias",
  "expectedIdentity": "12345678-1234-1234-1234-123456789ABC",
  "namespace": "lab-example",
  "caps": { "cpus": 4, "memoryMiB": 8192, "diskGiB": 40 },
  "botVmId": "00000000-0000-4000-8000-000000000000",
  "allowGuestPreparation": false,
  "authorizeBotSmoke": false
}
```

## Comandos

- `npm run lab:bot:doctor` — preflight sanitizado: identidade, versões do serviço, suporte a
  `bot.runtime.v1`/`bot.setup`, cotas, recursos reservados pelas VMs, imagens disponíveis, a VM
  selecionada e a pré-visualização de setup. Somente métodos de leitura; não muta nada.
- `npm run lab:bot:prepare` — exige `botVmId`, `allowGuestPreparation: true` **e** a flag
  `--allow-guest-preparation`. Executa `bot.setup.start` com a VM escolhida e as confirmações de
  preparação, backup e reinício. A intenção e a chave de idempotência são gravadas antes do contato.
  Termina em `needs_account`: o login do provedor acontece no aplicativo, nunca pelo script.
- `npm run lab:bot:smoke` — exige `authorizeBotSmoke: true` e `--authorize-bot-smoke`. Envia uma
  tarefa verificável ao bot pronto do namespace e confere o arquivo produzido no workspace.
- `npm run test:lab:bot` — wrapper Vitest do smoke, pulado sem `MAESTRLY_BOT_LAB_TEST=1`.

## Fase 3 — tela ao vivo e intervenção humana

- `npm run lab:bot:desktop` — somente consulta, sem flags: capacidades `desktop.live.v1` e
  `desktop.handoff.v1` do Host, a VM selecionada por `botVmId`, os bots dessa VM, o estado da
  tela de cada um e o próximo passo (atualizar o Host; atualizar o ambiente e reiniciar a VM
  selecionada em janela autorizada; ou pronto). Não muta nada.
- `npm run lab:bot:desktop -- run --authorize-desktop-lab` — exige `"authorizeDesktopLab": true`
  na configuração privada **e** a flag. Pelo mesmo caminho do aplicativo (`rpc-stdio` persistente
  e `desktop-stdio` com o ticket só no stdin) mede o primeiro quadro, abre dois visualizadores e,
  se existir, a tela de um segundo bot; envia uma tarefa real, assume o controle no meio dela,
  mede entrada→pixel, derruba um visualizador, deixa o lease expirar e devolve com continuação.
  Não prepara, não reinicia, não arquiva e não apaga nada.
- `MAESTRLY_BOT_DESKTOP_LAB_TEST=1 npx --workspace @maestrly/bot-runtime vitest run test/lab/live-desktop.test.ts`
  — wrapper Vitest do comando acima.

A porta virtio da tela só existe depois que a VM reinicia com o novo perfil; essa janela é do
operador. Sem Mac mini, `node scripts/verify-bot-desktop.mjs --local-container` e
`--local-vm` validam a pilha em contêiner e em VM Linux local sem rede
([tela ao vivo](bot-runtime/live-desktop.md)).

## Equipes de bots (fase 4)

- `npm run lab:bot:teams` — inventário **somente leitura**: bots, computadores, se o Host anuncia
  `teams.v1` e se a equipe configurada pode rodar. Não cria, não prepara e não apaga nada. Num Host
  anterior à fase 4 ele reporta `teams: false` em vez de falhar.
- `node scripts/bot-team-lab.mjs smoke --authorize-team-smoke` — prova ponta a ponta. Exige, no
  `.maestrly-host-lab.json` privado, `allowTeamSmoke: true` e `teamBotIds` com os **identificadores
  exatos** dos bots que podem formar a equipe de teste. O laboratório nunca escolhe "o primeiro bot
  livre", nunca cria bot ou conta e nunca desliga um computador. Ele compartilha um CSV sintético,
  pede um relatório e **confere a aritmética e os digests**, em vez de acreditar no texto do modelo.
  São dois pedidos: um pequeno, que o coordenador pode responder sozinho, e um que a pessoa manda
  distribuir, para exercitar a delegação de verdade. Com dois bots isso prova delegação, nunca dois
  membros trabalhando ao mesmo tempo — o relatório diz isso em `concurrencyProven`.
  Um membro em `ask` pede permissão; o laboratório responde no papel da pessoa e **registra no
  relatório o comando exato que autorizou**, porque aprovar sem dizer o quê seria pior que não
  aprovar. Sem `allowTeamSmoke` nada disso acontece.

Relatórios ficam em `.host-lab/bot-*/` e `.host-lab/desktop-lab-*/` (ignorados pelo Git). O laboratório não executa reboot
físico, não altera cotas, não instala pacotes no controlador e não copia credenciais.

## Rotinas e mensagens de voz (fase 5)

- `npm run lab:bot:phase5` — inventário **somente leitura**: bots, computadores, se o Host anuncia
  `routines.v1` e `voice.messages.v1`, o que já está agendado e se o alvo configurado pode executar.
  Não cria rotina, não grava áudio e não transcreve nada. Num Host anterior à fase 5 ele reporta
  `routines: false` e `voice: false` em vez de falhar. O relatório traz **nome e horário** das
  rotinas, nunca o pedido em si — o texto de uma rotina pode ser confidencial.
- `npm run lab:bot:phase5 -- --authorize-routine-smoke` — o portão de agendamento. Exige, no
  `.maestrly-host-lab.json` privado, `allowRoutineSmoke: true` e um `routineBotId` com o
  **identificador exato** do bot. Ele ativa uma rotina de **uma única execução**, poucos minutos à
  frente, e espera o Host cumprir o horário sozinho. Ao terminar, pausa o que criou: nada fica
  agendado sem querer. O relatório traz horário previsto e real, quantas ocorrências e quantas
  execuções existiram (o valor que importa é **um e um**) e o **tamanho** da resposta, nunca o
  conteúdo.
- `npm run lab:bot:phase5 -- --authorize-voice-smoke` — o portão de transcrição. Exige
  `allowVoiceSmoke: true` e um `voiceSampleFile` apontando para um WAV canônico (16 kHz, mono,
  PCM16) que a pessoa **consentiu** em usar. O laboratório nunca grava ninguém: ele envia o arquivo
  ao Host, pede a transcrição e confere que o worker empacotado produziu texto. O relatório traz
  duração, tempos de upload e de inferência e o **número de palavras**, nunca a transcrição.

Os dois consentimentos são independentes: autorizar agendamento não autoriza áudio, e vice-versa.
Sem a chave na configuração **e** a flag na linha de comando, apenas os métodos de leitura rodam.

Para transcrever, o Host precisa de um pacote de fala verificado:

```bash
npm run build:host:asr -- --runtime <dir do runtime local-ML> --model <dir do modelo> --model-id <id>
```

O build não baixa nada: runtime e pesos são entradas explícitas do operador. A saída traz um
`manifest.json` com o digest de cada arquivo, e o Host recalcula tudo antes de iniciar um worker.
Instale o pacote sob `/Library/MaestrlyHost/` e aponte `asrBundleDirectory` no manifesto privado do
Host; sem isso o Host não anuncia voz e o aplicativo continua só com texto. **O pacote de fala vai
no Host, nunca dentro das VMs dos bots.**

## Experiência de chat: extensões por bot

- `npm run lab:bot:chat` — inventário **somente leitura**: se o Host anuncia
  `chat.experience.v1`, o que o inventário do ambiente registrou sobre o guest do bot escolhido
  (`bot.extensions.v1`, `bot.transcript.v1` — pode ficar defasado; a prova é o `guestOutdated`
  do portão), quais servidores MCP e skills estão configurados (nomes
  e contagens, nunca comandos, cabeçalhos ou textos), quantos comandos existem e o uso dos últimos
  7 dias. Num Host anterior ele reporta `chat: false` em vez de falhar.
- `npm run lab:bot:chat -- --authorize-extensions-smoke` — o portão das extensões. Exige, no
  `.maestrly-host-lab.json` privado, `allowExtensionsSmoke: true` e o mesmo `routineBotId` com o
  **identificador exato** do bot. Ele instala um servidor MCP `echo` (um script de uma linha que
  roda com o Node do próprio guest, sem rede e sem arquivos) e uma skill `verificacao`, manda
  **uma** mensagem que só pode ser respondida usando os dois, lê o transcript que o Host dobrou e
  **remove exatamente o que instalou**. O relatório traz o estado do turno, quantas ferramentas
  foram chamadas, se o servidor configurado foi usado, se o eco voltou, o **tamanho** da resposta
  e se o guest se declarou antigo — nunca a resposta em si.

Autorizar extensões não autoriza rotinas nem áudio, e vice-versa. Sem a chave na configuração
**e** a flag na linha de comando, apenas os métodos de leitura rodam.

## Pré-requisitos do Host

O pacote do Host precisa incluir `templates` em `etc/host.json` (gerados por
`npm run package:host:lab` a partir de `botTemplates` no manifesto privado, apontando para o
bundle Linux Arm64 produzido por `npm run build:bot-runtime:bundle`). A imagem Ubuntu
com interface leve tem build separado em `npm run build:bot:image -- <configuração>`;
veja [imagem e medições](maestrly-bot-image.md). Sem template compatível,
`bot.setup.preview` retorna `NO_BOT_TEMPLATE` e o aplicativo explica o bloqueio. A atualização de
uma instalação existente segue [`upgrade.sh`](../deploy/host/macos/upgrade.sh).
