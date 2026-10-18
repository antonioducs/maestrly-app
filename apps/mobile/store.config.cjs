// The App Store listing, pushed with `eas metadata:push --profile production` (see docs/mobile.md#release).
// The contact App Review calls comes from the environment, so no personal details live in the repository; without it
// the listing keeps the contact already in App Store Connect.
const { readdirSync } = require('node:fs')
const path = require('node:path')
const { version } = require('./package.json')

const SCREENSHOTS = 'store/screenshots/iphone-6.9'
const env = (name) => process.env[name]?.trim() || undefined

/** The version the App Store got first, which has no What's New. */
const FIRST_VERSION = '0.1.0'
/**
 * What's New of each later version, in every language of the listing. Without them, `eas metadata:push` would show
 * "Bug fixes and improved stability" in every language, so the listing refuses to load instead.
 */
const RELEASE_NOTES = {
  '0.1.1': {
    'en-US': `• Create bots from the phone in an environment your server already runs.
• Paste images into a message, choose the branch of a new workspace chat and see chats grouped by branch.
• On iOS 26, dictation uses Apple's newest speech recognition.
• Approval cards show multi-line commands exactly as they will run.`,
    'pt-BR': `• Crie bots pelo celular num ambiente que seu servidor já roda.
• Cole imagens numa mensagem, escolha a branch de um novo chat de workspace e veja os chats agrupados por branch.
• No iOS 26, o ditado usa o reconhecimento de voz mais recente da Apple.
• Os cartões de aprovação mostram comandos de várias linhas exatamente como vão rodar.`,
  },
}
const notes = RELEASE_NOTES[version]
if (version !== FIRST_VERSION && !(notes?.['en-US']?.trim() && notes?.['pt-BR']?.trim())) {
  throw new Error(`Write the What's New of ${version} in English and Portuguese in RELEASE_NOTES of store.config.cjs.`)
}
const releaseNotes = (locale) => (notes ? { releaseNotes: notes[locale].trim() } : {})

/** The 6.9-inch iPhone screenshots `npm run screenshots` renders, in file name order. */
const screenshots = readdirSync(path.join(__dirname, SCREENSHOTS))
  .filter((file) => file.endsWith('.png'))
  .sort()
  .map((file) => `${SCREENSHOTS}/${file}`)

const urls = {
  marketingUrl: 'https://www.maestrly.com/',
  supportUrl: 'https://www.maestrly.com/support',
  privacyPolicyUrl: 'https://www.maestrly.com/privacy',
}

const contact = {
  firstName: env('MAESTRLY_APP_REVIEW_FIRST_NAME'),
  lastName: env('MAESTRLY_APP_REVIEW_LAST_NAME'),
  email: env('MAESTRLY_APP_REVIEW_EMAIL'),
  phone: env('MAESTRLY_APP_REVIEW_PHONE'),
}

/** Answers what App Review asks new developer accounts under Guideline 2.1, so later submissions keep the answers. */
const REVIEW_NOTES = `Maestrly is an open-source developer tool (MIT License, https://github.com/antonioducs/maestrly-app). People run AI coding and automation agents ("bots") on their own computer or server with the Maestrly desktop app and bot server. This iOS app is the phone client of that server.

PURPOSE AND AUDIENCE
The app is for developers and technical users who run their own Maestrly bot server. Long-running agents often stop and wait for their owner; with the app, the owner follows them and answers from anywhere instead of staying at the computer. It shows what each bot is doing, streams its conversations, sends messages, photos and files, approves or denies commands, answers questions, reviews plans, starts chats in the server's workspaces and notifies the owner when a bot needs them.

SETUP AND ACCESS
The app has no accounts and no sign-in, so no credentials are needed. It has no account registration, no content shared between people and no paid content.
- To review the app without a server, tap "Explore a demo server" on the first screen. It opens an in-memory server with sample bots, chats and workspaces, and nothing leaves the device. From there you can read a bot's conversation, send a message, approve a command, start a chat, change its setup and open Settings.
- For real use, run the Maestrly desktop app and bot server on a computer. Then tap "Scan pairing code" and scan the QR code the desktop app shows, or tap "Enter code manually" and enter the server's HTTPS address and a single-use 8-character code.
- Settings > "Unpair from <server>" revokes the phone on the server and deletes that server's data from the phone.
Push notifications, bot pages and file downloads need a paired server; the demo server shows every other screen.

EXTERNAL SERVICES
- The person's own Maestrly bot server, self-hosted and open source, provides every core feature over HTTPS.
- AI model providers (for example OpenAI, Anthropic, Google and xAI) are set up on that server with the person's own accounts or API keys. The app never contacts them and never handles their keys.
- Expo Push Service and Apple Push Notification service deliver the server's notifications, which carry only a bot or chat name and a short fixed phrase, never message content.
- Apple's speech recognition, for optional dictation.
The app uses no authentication service, payment processor, analytics, advertising or tracking.

REGIONAL DIFFERENCES
The app works the same in every region where it is offered, in English and Brazilian Portuguese. It is not offered in mainland China.

REGULATED INDUSTRY OR THIRD-PARTY MATERIAL
Not applicable: the app does not operate in a regulated industry and contains no protected third-party material.`

module.exports = {
  configVersion: 0,
  apple: {
    version,
    copyright: '2026 Maestrly App contributors',
    categories: ['DEVELOPER_TOOLS', 'PRODUCTIVITY'],
    // Approval does not publish the version: someone releases it from App Store Connect.
    release: { automaticRelease: false, phasedRelease: false },
    advisory: {
      alcoholTobaccoOrDrugUseOrReferences: 'NONE',
      contests: 'NONE',
      gamblingSimulated: 'NONE',
      gunsOrOtherWeapons: 'NONE',
      horrorOrFearThemes: 'NONE',
      matureOrSuggestiveThemes: 'NONE',
      medicalOrTreatmentInformation: 'NONE',
      profanityOrCrudeHumor: 'NONE',
      sexualContentGraphicAndNudity: 'NONE',
      sexualContentOrNudity: 'NONE',
      violenceCartoonOrFantasy: 'NONE',
      violenceRealistic: 'NONE',
      violenceRealisticProlongedGraphicOrSadistic: 'NONE',
      gambling: false,
      lootBox: false,
      advertising: false,
      ageAssurance: false,
      healthOrWellnessTopics: false,
      // People talk to the bots on their own server, never to each other, and see no one else's content.
      messagingAndChat: false,
      userGeneratedContent: false,
      parentalControls: false,
      unrestrictedWebAccess: false,
      kidsAgeBand: null,
      ageRatingOverride: 'NONE',
      ageRatingOverrideV2: 'NONE',
      koreaAgeRatingOverride: 'NONE',
    },
    info: {
      'en-US': {
        title: 'Maestrly',
        subtitle: 'Follow and direct your AI bots',
        promoText: 'Follow your AI agents, approve what they do next and answer their questions, from anywhere.',
        description: `Maestrly on your phone follows and directs the AI agents that run on your own Maestrly bot server.

• See every bot at a glance: what it is doing now and what waits on you.
• Read conversations as they stream, and send text, photos and files.
• Approve or deny commands, answer questions and review plans from a card.
• Start chats in your workspaces and choose the model, effort, mode and permissions.
• Get a notification when a bot needs you, finishes a turn or fails.
• Dictate messages with the phone's own speech recognition.
• Messages you send offline go out in order once you are back online.

Maestrly needs a bot server you run, on your computer or on a server you manage. Pair the phone by scanning the code Maestrly shows on your computer. There is no Maestrly account and no telemetry: the app talks only to the servers you pair and, when you turn notifications on, to Apple's push service.

Want to look around first? Choose "Explore a demo server" on the first screen.

Maestrly is open source under the MIT License.`,
        keywords: ['ai', 'agents', 'bots', 'assistant', 'developer', 'coding', 'automation', 'approvals', 'self-hosted', 'remote', 'chat', 'devtools'],
        ...urls,
        ...releaseNotes('en-US'),
        screenshots: { APP_IPHONE_67: screenshots },
      },
      'pt-BR': {
        title: 'Maestrly',
        subtitle: 'Acompanhe seus agentes de IA',
        promoText: 'Acompanhe seus agentes de IA, aprove o que eles fazem e responda às perguntas deles de qualquer lugar.',
        description: `O Maestrly no celular acompanha e guia os agentes de IA que rodam no seu próprio servidor de bots do Maestrly.

• Veja todos os bots de uma vez: o que cada um está fazendo e o que espera por você.
• Leia as conversas enquanto chegam e envie texto, fotos e arquivos.
• Aprove ou negue comandos, responda perguntas e revise planos direto de um cartão.
• Comece chats nos seus workspaces e escolha modelo, esforço, modo e permissões.
• Receba uma notificação quando um bot precisar de você, terminar um turno ou falhar.
• Dite mensagens com o reconhecimento de voz do próprio celular.
• Mensagens enviadas sem conexão saem em ordem quando a conexão volta.

O Maestrly precisa de um servidor de bots que você mesmo roda, no seu computador ou num servidor seu. Pareie o celular escaneando o código que o Maestrly mostra no computador. Não há conta no Maestrly nem telemetria: o app fala só com os servidores que você pareou e, quando você ativa as notificações, com o serviço de push da Apple.

Quer conhecer antes? Escolha "Explorar um servidor de demonstração" na primeira tela.

O Maestrly é código aberto, sob a licença MIT.`,
        keywords: ['ia', 'agentes', 'bots', 'assistente', 'desenvolvedor', 'programação', 'automação', 'aprovações', 'self-hosted', 'remoto', 'chat'],
        // Without screenshots of its own, the store shows the English ones.
        ...urls,
        ...releaseNotes('pt-BR'),
      },
    },
    ...(Object.values(contact).every(Boolean) ? { review: { ...contact, demoRequired: false, notes: REVIEW_NOTES } } : {}),
  },
}
