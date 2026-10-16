// The App Store listing, pushed with `eas metadata:push --profile production` (see docs/mobile.md#release).
// The contact App Review calls comes from the environment, so no personal details live in the repository; without it
// the listing keeps the contact already in App Store Connect.
const { readdirSync } = require('node:fs')
const path = require('node:path')
const { version } = require('./package.json')

const SCREENSHOTS = 'store/screenshots/iphone-6.9'
const env = (name) => process.env[name]?.trim() || undefined

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

const REVIEW_NOTES = `Maestrly is the phone client of the Maestrly bot server, which people run on their own computer or server (open source: https://github.com/antonioducs/maestrly-app). The app has no accounts and no sign-in: it pairs with a server by scanning a QR code that the Maestrly desktop app shows.

To review the app without a server, tap "Explore a demo server" on the first screen. It opens an in-memory server with sample bots, chats and workspaces, and nothing leaves the device. From there you can read a bot's conversation, send a message, approve a command, start a chat, change its setup and open Settings.

Push notifications need a paired server; the demo server shows every other screen.`

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
      },
    },
    ...(Object.values(contact).every(Boolean) ? { review: { ...contact, demoRequired: false, notes: REVIEW_NOTES } } : {}),
  },
}
