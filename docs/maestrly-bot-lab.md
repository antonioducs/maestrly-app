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

Relatórios ficam em `.host-lab/bot-*/` (ignorado pelo Git). O laboratório não executa reboot
físico, não altera cotas, não instala pacotes no controlador e não copia credenciais.

## Pré-requisitos do Host

O pacote do Host precisa incluir `templates` em `etc/host.json` (gerados por
`npm run package:host:lab` a partir de `botTemplates` no manifesto privado, apontando para o
bundle Linux Arm64 produzido por `npm run build:bot-runtime:bundle`). A imagem Ubuntu
com interface leve tem build separado em `npm run build:bot:image -- <configuração>`;
veja [imagem e medições](maestrly-bot-image.md). Sem template compatível,
`bot.setup.preview` retorna `NO_BOT_TEMPLATE` e o aplicativo explica o bloqueio. A atualização de
uma instalação existente segue [`upgrade.sh`](../deploy/host/macos/upgrade.sh).
