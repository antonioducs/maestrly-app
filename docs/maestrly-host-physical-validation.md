# Validação do Host físico — 12/09/2026

O Host foi instalado no Mac mini explicitamente selecionado pelo operador,
com autenticação administrativa feita diretamente no terminal. O pacote foi
verificado no destino antes da instalação. A configuração de conexão, identidade
física, usuário e relatórios completos ficam nos arquivos privados ignorados
pelo Git.

O equipamento medido tem arquitetura Arm64, macOS 26.6.2, 32 GiB de RAM e
10 núcleos físicos. O teto autorizado/aplicado é 4 CPUs, 8192 MiB de RAM e
40 GiB de disco virtual. O daemon e QEMU executam na conta dedicada não-root,
como LaunchDaemon de sistema; essa conta não tem sessão gráfica.

Foram criadas duas VMs Linux reais, cada uma com 2 CPUs, 2048 MiB de RAM e
12 GiB de disco virtual. Ambas ficaram em execução e prontas para uso pelo
operador, totalizando 4 CPUs, 4096 MiB de RAM configurada e 24 GiB de disco virtual.
A memória configurada do guest não é um limite rígido do processo QEMU nem de
outros processos do Mac.

Foram verificados provisionamento, Guest Agent, ausência de NIC, marcadores
sincronizados, reconexão SSH sem reboot, reboot do guest e desligamento/início
com preservação dos marcadores. O aplicativo **instalado** conectou ao Host,
mostrou ambas as VMs reais prontas e leu o log de boot. Após fechar o aplicativo,
ambas continuaram prontas, com boot IDs inalterados.

A primeira sondagem do runtime após a instalação retornou indisponível. As
consultas seguintes, o teste de HVF e os boots reais passaram. Não foi atribuída
uma causa exata à primeira resposta, nem aplicado fallback para emulação.

Não foram executados reboot físico, interrupção forçada do daemon ou exclusão
definitiva de dados no Host remoto. Recuperação e retenção/purge já tinham sido
testados localmente; esses testes não substituem a verificação remota de falhas.
A validação operacional básica no equipamento está concluída, mas não significa
que todos os cenários de falha da Fase 1 foram homologados.

Veja a [evidência sanitizada](../deploy/host/macos/physical-host-evidence.json),
[operação](maestrly-host.md) e [procedimento de laboratório](maestrly-host-lab.md).
