# Internet pública e sites bloqueados

Novos bots usam `blocklist` com lista vazia: permitem destinos HTTP/HTTPS públicos
nas portas 80/443 pelo broker do Host. A VM continua sem NIC. Resolução, validação
dos IPs, pinning, conferência do peer e bloqueio de endereços internos, reservados,
metadata e do próprio Host continuam obrigatórios. Esta política controla destinos,
não inspeciona o conteúdo TLS: o bot pode enviar dados a qualquer site público não
bloqueado.

Em Detalhes → Internet, o usuário adiciona domínios sem protocolo. Um bloqueio de
`example.com` inclui `example.com` e seus subdomínios, mas não `notexample.com`.
Adicionar um bloqueio fecha túneis existentes para o domínio e seus subdomínios,
além de negar novas conexões. Desativar internet preserva os sites bloqueados
para reativação. As revisões e chaves idempotentes existentes continuam em uso.

O armazenamento continua usando `{ mode, domains, revision }`. Dados antigos
`allowlist` mantêm seu significado exato, sem migração automática para bloqueios.
A interface oferece a ação explícita “Permitir internet pública”; essa mudança
começa com lista de bloqueados vazia. `offline` continua negando toda saída.

A capacidade guest `network.blocklist.v1` identifica suporte. O Host recusa
`bot.network.update` para blocklist em runtime antigo antes de persistir a mudança.
Protocolo, Host e runtime devem ser atualizados juntos. Novos artefatos anunciam a
capacidade; não se deve ativar a política num Host ou runtime antigo manualmente.
Não há migração de schema SQLite ou alteração das cotas das VMs.

Verificação: testes de protocolo, broker, proxy, schemas de streams e UI cobrem
domínios/subdomínios, legado, offline, revogação de streams e endereços proibidos.
A validação Linux de artefatos exige também confirmação da capacidade e ACK de
`policy.update` em canais virtio reais. Testes de resolver usam fixtures; não
sondam metadata ou redes internas reais.
