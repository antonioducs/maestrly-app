import type { MemoryType } from '../../src/shared/memory'

export interface EvalMemory {
  key: string
  title: string
  content: string
  type: MemoryType
  pinned?: boolean
}
export interface EvalQuery {
  query: string
  relevant: string[]
}

export const EVAL_MEMORIES: EvalMemory[] = [
  {
    key: 'release-tags',
    title: 'Release tags are signed',
    content: 'Create release tags with `git tag -s vX.Y.Z` and push them; CI refuses unsigned tags.',
    type: 'decision',
  },
  {
    key: 'commit-style',
    title: 'Commit messages follow Conventional Commits',
    content: 'Use `type(scope): imperative description`, in English, at most 100 characters.',
    type: 'constraint',
    pinned: true,
  },
  {
    key: 'select-rule',
    title: 'Never use the native select element in the UI',
    content:
      'Always use the custom Select component (button + listbox) with theme tokens; native dropdowns break the dark theme.',
    type: 'constraint',
    pinned: true,
  },
  {
    key: 'tailwind-border',
    title: 'Default border color lives in @layer base',
    content:
      'In the desktop styles.css, global defaults that utilities may override must be inside @layer base, otherwise they silently beat every border color class.',
    type: 'lesson',
  },
  {
    key: 'strictmode-cache',
    title: 'Never tie child resources to a parent effect cleanup',
    content:
      'The bot image cache failed under React StrictMode because children re-ran effects before the parent reactivated the cache. Use an app-lifetime cache with acquire/release holds.',
    type: 'lesson',
  },
  {
    key: 'fleet-update',
    title: 'Updating bots to a new image',
    content:
      'Rebuild the images with node scripts/bot-fleet-images.mjs --from-head, recreate the gateway, then restart each bot; the home volume is kept.',
    type: 'procedure',
  },
  {
    key: 'fleet-pairing',
    title: 'Pair a temporary maintenance device',
    content:
      'Run maestrly-bot-gateway pair inside the gateway container, call POST /v1/pair, and revoke the device at the end. Never revoke the owner device named Mac.',
    type: 'procedure',
  },
  {
    key: 'e2e-drawer',
    title: 'Drawer panels are invisible to Playwright',
    content:
      'Plan, notes and review panels are WebContentsViews; drive them from the main process with webContents.getAllWebContents().',
    type: 'procedure',
  },
  {
    key: 'readme-badges',
    title: 'README keeps badges and the website link',
    content: 'Keep the badges visible and reference the official website prominently when editing the README.',
    type: 'preference',
  },
  {
    key: 'db-migrations',
    title: 'Desktop migrations run inside initStore',
    content:
      'Schema changes are idempotent statements in initializeSchema; table rebuilds run in their own transaction with foreign keys off, then check foreign keys and integrity.',
    type: 'reference',
  },
  {
    key: 'verify-pr',
    title: 'Run verify:pr before publishing',
    content:
      'Run npm run verify:pr with the real PR title; add --full for application changes and --package for native or packaging changes.',
    type: 'procedure',
  },
  {
    key: 'local-ml',
    title: 'Local ML runtime is a bundled archive',
    content:
      'The embedding runtime is extracted on demand from a hash-pinned archive; the MiniLM model downloads on first use.',
    type: 'reference',
  },
  {
    key: 'owner-tz',
    title: 'O dono mora em São Paulo',
    content: 'Use o fuso America/Sao_Paulo para horários, lembretes e rotinas do dono.',
    type: 'preference',
  },
  {
    key: 'owner-concise',
    title: 'O dono prefere respostas curtas',
    content: 'Responda de forma curta e direta, começando pela decisão; sem preâmbulo.',
    type: 'preference',
  },
  {
    key: 'owner-pt',
    title: 'Falar com o dono em português',
    content: 'Mensagens para o dono em português do Brasil; código, commits e documentação em inglês.',
    type: 'preference',
  },
  {
    key: 'deploy-bluegreen',
    title: 'Deploy de produção usa azul e verde',
    content:
      'O deploy de produção troca o tráfego do ambiente azul para o verde depois do health check; o rollback volta o balanceador.',
    type: 'decision',
  },
  {
    key: 'staging-ssh',
    title: 'Staging SSH uses port 2222',
    content: 'The staging server 10.0.1.50 accepts SSH only on port 2222 with the key ~/.ssh/staging_ed25519.',
    type: 'reference',
  },
  {
    key: 'postgres-version',
    title: 'Database is PostgreSQL 16',
    content: 'The platform database runs PostgreSQL 16; integration tests start it with Docker.',
    type: 'reference',
  },
  {
    key: 'go-tests',
    title: 'Go services test with make test',
    content: 'Run make test inside services/api; it needs Docker for the database container.',
    type: 'procedure',
  },
  {
    key: 'invoice-routine',
    title: 'Notas fiscais saem no dia 5',
    content: 'A rotina de faturamento envia as notas fiscais no dia 5 de cada mês pelo portal da prefeitura.',
    type: 'procedure',
  },
  {
    key: 'portal-login',
    title: 'Login do portal da prefeitura pede código por SMS',
    content: 'O portal pede um código 2FA por SMS; peça ajuda ao dono com request_owner_help quando aparecer.',
    type: 'procedure',
  },
  {
    key: 'supplier-email',
    title: 'Cotações de fornecedores vão para compras',
    content: 'Envie cotações de fornecedores para compras@empresa.com.br com o número do pedido no assunto.',
    type: 'reference',
  },
  {
    key: 'price-check',
    title: 'Pesquisa de preço em três marketplaces',
    content: 'Na rotina de preços, comparar Mercado Livre, Amazon e Magalu e registrar o menor preço com frete.',
    type: 'procedure',
  },
  {
    key: 'screenshot-rule',
    title: 'Screenshot ao terminar tarefas em sites',
    content: 'Ao terminar uma tarefa num site, tire um screenshot da tela final para o dono conferir.',
    type: 'preference',
  },
  {
    key: 'backup-schedule',
    title: 'Gateway backups run nightly',
    content: 'The gateway SQLite database is copied to /data/backup every night at 03:00 UTC; keep 7 copies.',
    type: 'reference',
  },
  {
    key: 'docker-compose',
    title: 'Dev fleet compose project',
    content: 'The dev fleet runs as the docker compose project maestrly-fleet-dev with deploy/bot-fleet/compose.yml.',
    type: 'reference',
  },
  {
    key: 'codex-accounts',
    title: 'Codex failover between accounts',
    content: 'Subscription failover rotates between configured Codex accounts when one reaches its usage limit.',
    type: 'reference',
  },
  {
    key: 'image-limits',
    title: 'Owner attachment limits',
    content: 'Owners can attach up to 8 images, 5 MB each and 20 MB in total.',
    type: 'reference',
  },
  {
    key: 'i18n-parity',
    title: 'Translations need en and pt-BR parity',
    content: 'Every user-facing string goes in shared/i18n for both en and pt-BR; the parity test fails otherwise.',
    type: 'constraint',
  },
  {
    key: 'no-verify',
    title: 'Never bypass git hooks',
    content: 'Do not use --no-verify or skip checks unless the owner explicitly authorizes it.',
    type: 'constraint',
  },
  {
    key: 'cafe-order',
    title: 'Pedido de café do dono',
    content: 'Quando pedir café para o dono: cappuccino sem açúcar, tamanho médio.',
    type: 'preference',
  },
  {
    key: 'meeting-notes',
    title: 'Notas da reunião semanal no Notion',
    content: 'As notas da reunião semanal de segunda vão para a página Sync semanal no Notion do time.',
    type: 'procedure',
  },
  {
    key: 'vacation',
    title: 'Férias do dono em dezembro',
    content: 'O dono estará de férias de 20/12 a 06/01; nesse período, agrupe pendências num resumo semanal.',
    type: 'reference',
  },
  {
    key: 'renderer-credentials',
    title: 'Renderer never touches credentials',
    content: 'Credential handling and privileged operations stay in the main process; validate renderer input there.',
    type: 'constraint',
  },
  {
    key: 'flaky-e2e',
    title: 'Background compaction e2e is timing sensitive',
    content:
      'Wait for data-background-compaction-status before asserting in the background compaction Playwright spec.',
    type: 'lesson',
  },
  {
    key: 'key-rotation',
    title: 'Rotate integration API keys monthly',
    content: 'API keys for the integrations are rotated on the first business day of each month.',
    type: 'procedure',
  },
  {
    key: 'acme-renewal',
    title: 'ACME Corp contract renewal',
    content: 'The ACME Corp contract renews on March 1st; send the renewal proposal two weeks before.',
    type: 'reference',
  },
  {
    key: 'newsletter',
    title: 'Newsletter sai às sextas',
    content: 'A newsletter semanal é enviada às sextas às 10h; revisar os links antes de agendar.',
    type: 'procedure',
  },
  {
    key: 'theme-tokens',
    title: 'Use theme tokens for colors',
    content: 'Never hardcode hex colors in desktop components; use the Tailwind theme tokens.',
    type: 'constraint',
  },
  {
    key: 'gateway-ports',
    title: 'Gateway listens on 7443 and 7444',
    content: 'Public API on 7443 for paired devices; internal API on 7444 for bots on the fleet network.',
    type: 'reference',
  },
  {
    key: 'pdf-reports',
    title: 'Relatório mensal de vendas em PDF',
    content: 'O relatório mensal de vendas é exportado em PDF do painel e enviado ao dono no primeiro dia útil.',
    type: 'procedure',
  },
  {
    key: 'timezone-routines',
    title: 'Routines use the owner time zone',
    content: 'Weekly routines are scheduled in America/Sao_Paulo unless the owner says otherwise.',
    type: 'decision',
  },
  {
    key: 'ml-login',
    title: 'Login do Mercado Livre falha no modo headless',
    content: 'O login do Mercado Livre falha com user agent headless; use o navegador normal do bot em tela cheia.',
    type: 'lesson',
  },
  {
    key: 'vpn',
    title: 'Internal dashboards need the VPN',
    content: 'The analytics dashboard only loads when the WireGuard VPN is connected.',
    type: 'reference',
  },
  {
    key: 'sqlite-wal',
    title: 'SQLite backups need the WAL files',
    content: 'Gateway and desktop databases use WAL; copy the -wal and -shm files together when backing up.',
    type: 'lesson',
  },
  {
    key: 'pr-titles',
    title: 'PR titles use the commit format',
    content: 'Pull request titles follow the Conventional Commit format and must pass verify:pr --title.',
    type: 'constraint',
  },
]

export const EVAL_QUERIES: EvalQuery[] = [
  { query: 'como faço o deploy de produção? troca azul e verde?', relevant: ['deploy-bluegreen'] },
  { query: 'which port should I use to ssh into staging?', relevant: ['staging-ssh'] },
  { query: 'vou criar a tag da release 2.3.0, algum cuidado?', relevant: ['release-tags'] },
  { query: 'o dono prefere respostas longas ou curtas?', relevant: ['owner-concise'] },
  { query: 'can I use a normal select dropdown in this settings screen?', relevant: ['select-rule'] },
  { query: 'how do I update the bots after building new images?', relevant: ['fleet-update'] },
  { query: 'preciso parear um dispositivo temporário no gateway', relevant: ['fleet-pairing'] },
  { query: 'the border colors are not showing in the desktop app', relevant: ['tailwind-border'] },
  { query: 'playwright cannot find the plan panel window', relevant: ['e2e-drawer'] },
  { query: 'qual versão do PostgreSQL o banco usa?', relevant: ['postgres-version'] },
  { query: 'como rodo os testes dos serviços em Go?', relevant: ['go-tests'] },
  { query: 'quando devo mandar as notas fiscais?', relevant: ['invoice-routine'] },
  { query: 'o portal pediu um código por SMS, e agora?', relevant: ['portal-login'] },
  { query: 'para quem envio a cotação do fornecedor?', relevant: ['supplier-email'] },
  { query: 'faz a pesquisa de preço nos marketplaces', relevant: ['price-check'] },
  { query: 'terminei a tarefa no site, preciso mandar screenshot?', relevant: ['screenshot-rule'] },
  { query: 'when do the gateway backups run?', relevant: ['backup-schedule'] },
  { query: 'what is the docker compose project for the dev fleet?', relevant: ['docker-compose'] },
  { query: 'how many images can owners attach?', relevant: ['image-limits'] },
  { query: 'esqueci de traduzir uma string para pt-BR, tem problema?', relevant: ['i18n-parity'] },
  { query: 'can I push with --no-verify to skip the hook?', relevant: ['no-verify'] },
  { query: 'pede um café pro dono', relevant: ['cafe-order'] },
  { query: 'onde salvo as notas da reunião semanal?', relevant: ['meeting-notes'] },
  { query: 'o dono vai estar de férias em dezembro?', relevant: ['vacation'] },
  { query: 'when do we rotate the integration API keys?', relevant: ['key-rotation'] },
  { query: 'when does the ACME contract renew?', relevant: ['acme-renewal'] },
  { query: 'a newsletter sai em que dia?', relevant: ['newsletter'] },
  { query: 'which ports does the gateway listen on?', relevant: ['gateway-ports'] },
  { query: 'gera o relatório mensal de vendas', relevant: ['pdf-reports'] },
  { query: 'o login do mercado livre não funciona no bot', relevant: ['ml-login'] },
  { query: 'the analytics dashboard will not load', relevant: ['vpn'] },
  { query: 'how do I back up the sqlite database safely?', relevant: ['sqlite-wal', 'backup-schedule'] },
  { query: 'what format should the pull request title have?', relevant: ['pr-titles', 'commit-style'] },
  { query: 'em que fuso devo agendar a rotina semanal?', relevant: ['timezone-routines', 'owner-tz'] },
  { query: 'React effect cleanup broke the image cache in dev mode', relevant: ['strictmode-cache'] },
  { query: 'me conta uma piada sobre gatos', relevant: [] },
  { query: 'what is the capital of Australia?', relevant: [] },
  { query: "traduz 'good morning' para o espanhol", relevant: [] },
  { query: 'escreva um haicai sobre o outono', relevant: [] },
  { query: 'how does quicksort work?', relevant: [] },
  { query: 'qual a previsão do tempo amanhã?', relevant: [] },
  { query: 'summarize this paragraph for me please', relevant: [] },
  { query: 'obrigado, pode encerrar', relevant: [] },
  { query: 'calculate 15% of 240', relevant: [] },
  { query: 'sugira nomes para um cachorro', relevant: [] },
  { query: 'explique o que é uma monad em Haskell', relevant: [] },
  { query: 'write a limerick about coffee', relevant: [] },
  { query: 'o que você acha de inteligência artificial?', relevant: [] },
]
