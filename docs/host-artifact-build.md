# Construção dos artefatos do Host

Os builds abaixo produzem artefatos locais; não publicam releases. A arquitetura
é escolhida a partir do diagnóstico do Mac mini, nunca inferida do controlador.
Um pacote construído permanece **não homologado** até os testes no Host escolhido.

## Runtime macOS

Execute `npm run package:host:lab` em macOS nativo da arquitetura selecionada,
com `MAESTRLY_HOST_BUILD_CONFIG` apontando para um JSON privado. O comando exige
Node/QEMU/firmware já construídos de fontes confiáveis, com suas dependências
relocáveis. Ele não instala QEMU do PATH nem depende do Node do shell no destino.

O JSON tem os campos:

- `architecture`: `arm64` ou `x64`.
- `inputDirectory`: diretório absoluto dos arquivos de entrada.
- `nodeVersion`: versão exata 22.x compatível com o manifest raiz.
- `qemuVersion`: versão exata correspondente ao executável fornecido.
- `firmware` e `firmwareVars`: caminhos relativos presentes em `files`, quando necessários.
- `files`: inventário completo de `{path, sha256, license, source}`. Inclua
  `bin/node`, `bin/qemu-img`, `bin/qemu-system-aarch64` ou `bin/qemu-system-x86_64`,
  bibliotecas transitivas, firmware e arquivos de licença das versões reais.
  `source` é a URL HTTPS da fonte/artefato específico. `sha256` deve ser medido e
  comparado com a fonte confiável, nunca preenchido com um valor de exemplo.

O build verifica hashes antes de copiar, versões executadas, dependências Mach-O
(só bibliotecas do sistema e `@loader_path` declarados), assinatura ad-hoc e
entitlement de hypervisor do QEMU. Não modifica Gatekeeper/SIP. Calcula novos
hashes após assinatura. O resultado é `dist/maestrly-host-<arquitetura>/` com
`manifest.json`, runtime próprio, CLI bundled, instalador e notices. Um diretório
existente nunca é substituído automaticamente. A assinatura ad-hoc identifica um
build de laboratório, sem alegação de distribuição pública/notarização.

O build é uma embalagem de entradas verificadas, não um compilador universal de
QEMU. Preparar a closure relocável e cumprir licenças/source offers é requisito
de quem fornece o runtime. Não há versão de QEMU homologada nesta entrega sem
um manifesto e evidência física correspondentes.

## Imagem Linux

Execute `npm run build:host:image` em um ambiente Linux de build confiável, nativo
da arquitetura da imagem. Use `MAESTRLY_HOST_IMAGE_CONFIG` para um JSON privado:

- `architecture`, `inputDirectory`, `releaseDate` (`AAAAMMDD`).
- `sourceUrl`: URL datada em `cloud-images.ubuntu.com/releases/noble/release-<data>/`
  ou no arquivo oficial `cloud-images-archive.ubuntu.com`.
- `base`: `{path, sha256}` do cloud image Ubuntu 24.04, verificado contra a fonte.
- `virtCustomize`, `virtCat`, `virtInspector`: `{path, sha256}` dos build tools.
- `packages`: versões exatas para `cloud-init` e `qemu-guest-agent`, disponíveis
  nos repositórios configurados na imagem base.

A ferramenta confirma distribuição e arquitetura por inspeção, trabalha numa
cópia staging, instala os pacotes e limpa identidade, seeds, chaves SSH, históricos
e logs. A rede é permitida **apenas no ambiente confiável de preparação** para
instalação de pacotes. VMs normais recebem seed NoCloud local e nenhuma NIC.
O manifesto registra a base, inventário completo de pacotes, ferramenta e hash
final. O processo é repetível com entradas fixadas; não promete saída idêntica
byte a byte nem resolve versões transitivas através de um snapshot APT próprio.

O resultado é `dist/ubuntu-24.04-<data>-<arquitetura>.qcow2` e seu manifesto.
Cloud-init e Guest Agent instalados não provam boot, expansão de filesystem ou
provisionamento: estes devem ser verificados no hardware antes de homologar.

## Fontes técnicas

- [Opções de execução QEMU](https://www.qemu.org/docs/master/system/invocation.html)
- [NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html)
- [virt-customize](https://libguestfs.org/virt-customize.1.html)
- [Imagens oficiais Ubuntu](https://cloud-images.ubuntu.com/releases/noble/)

O runtime builder também compila `hvf-smoke.c`, assina o helper e gera
`etc/host.json` com caminhos finais e hashes após assinatura. `images` no manifest
de build pode listar `{id, name, architecture, file, format, virtualSizeGiB}` para
imagens preparadas, sendo `file` uma entrada já verificada em `files`. Sem imagens,
o catálogo instalado fica vazio e criação de VMs permanece indisponível até o
administrador fornecer uma imagem preparada e verificada.

## Preparação em macOS Arm64 com QEMU/HVF

O mesmo `build:host:image` aceita `builder: "qemu-hvf"` no JSON de entrada.
Esse modo usa `runtimeBuildConfig` (caminho do manifest de runtime verificado),
`guestAgentVersion` exata e os mesmos campos `architecture`, `releaseDate`,
`sourceUrl`, `inputDirectory` e `base`. Ele exige macOS Arm64 nativo, firmware
UEFI code/vars e base qcow2 autocontida. O ambiente de build recebe 2 CPUs,
2 GiB de RAM e disco virtual de 12 GiB. A rede user-mode, sem encaminhamento de
portas, existe somente nessa VM descartável de preparação. Os guests do Host
não reutilizam esses argumentos de rede.

A preparação instala a versão fixada do QGA, exporta o inventário de pacotes,
limpa identidades e credenciais, sincroniza e desliga. O build só promove a imagem
após shutdown, marcador de conclusão, inventário confirmado e `qemu-img check`.
Cancelamento encerra apenas o processo filho do build antes de remover staging.
A imagem resultante ainda exige boot offline e lifecycle no Host selecionado.

`node scripts/host-local-smoke.mjs` é um teste adicional do núcleo no controlador,
opt-in por `MAESTRLY_HOST_LOCAL_SMOKE_CONFIG`. O JSON requer `authorize: true`,
`authorizeDeleteTestData: true` e `runtimeBuildConfig` com exatamente uma imagem
preparada. Cria duas VMs sem rede (1 CPU, 1 GiB RAM e disco virtual de 12 GiB cada),
verifica marcadores/reboot e preservação de disco, e limpa só os IDs criados nessa
execução. Evidências ficam em `.host-lab/controller-smoke/`. Este teste não instala
launchd e **não homologa o Mac mini**, não testa SSH nem substitui a suíte remota.
