# Mobile app

Maestrly for iOS and Android (`apps/mobile`) follows and directs the bots, chats
and workspaces on your [bot server](bot-fleet.md) from your phone.

## What it does

- **Pairing:** scan the QR code your computer shows, or enter the server address
  and a pairing code.
- **Bots:** see every bot by environment, with what it is doing right now and
  what waits on you. Read a bot's conversation as it streams, scroll back
  through older messages, and send text, photos and files.
- **Chats and workspaces:** the chats and workspaces of the server's
  [workspaces environment](remote-workspaces.md#on-a-phone), in the menu's
  **Chats** and **Workspaces** tabs. Open a chat, start a new one on its own or
  in a workspace, and change its mode, model, effort, skills, MCP servers and
  context limit. A card shows the conversations an agent started from a chat,
  each with a way to open it.
- **Requests:** approve or deny a command, answer a question, or mark a request
  for help as resolved; in a chat, also review a plan.
- **Setup:** change a bot's model, reasoning effort, Fast and permissions; start,
  pause, resume, restart or stop a bot; run a routine now; compact a bot's
  conversation. New chats start with the defaults you choose in **Settings →
  New chats**.
- **Notifications:** hear when a bot or chat needs you, finishes a turn you
  started, finishes a routine, or fails. See [Notifications](#notifications).
- **Dictation:** the microphone in the message field turns what you say into
  text with the phone's own speech recognition. See
  [Data on the phone](#data-on-the-phone).
- **Artifacts:** a page an agent publishes shows as a card in the conversation;
  **Open** shows the version it published. See [Artifacts](#artifacts).
- **Offline:** messages you send without a connection wait on the phone and go
  out in order when the server is reachable again.

## Requirements

Your phone reaches the bot server over **HTTPS**. iOS and Android refuse plain
HTTP, so an address that works on your computer, such as an SSH tunnel on
`http://127.0.0.1`, does not work on the phone. The simplest way is Tailscale
Serve on the server and Tailscale on the phone: see
[With a server you manage](bot-fleet.md#with-a-server-you-manage).

Chats and workspaces need the server's workspaces environment to run a version
of Maestrly that offers the mobile API. The phone does not need the same version
as the server, only the same mobile API.

## Pair

1. On a computer already paired with the server, open **Settings → Bot server**
   and choose **Pair a phone**.
2. Check the **Address your phone uses** field: it must be the server's
   `https://` address.
3. In the app, choose **Scan pairing code** and scan the QR code. The app shows
   the server's address and asks you to confirm before pairing.

Without a computer at hand, run `maestrly-bot-gateway pair` on the server and
choose **Enter code manually** in the app. Codes work once and expire after ten
minutes. Any paired device can create codes for other devices, at most five
unused at once.

**Explore a demo server**, on the first screen, opens an in-memory server with
sample bots, chats and workspaces. Nothing in it leaves the phone; forget it
from **Settings** like any server.

## Notifications

After pairing, the app offers to turn notifications on. **Settings →
Notifications** chooses what you hear about, for every paired server:

| Category | When |
| --- | --- |
| **Waiting on you** | A bot or chat asks for approval, asks a question, has a plan for you, or needs help. |
| **Replies** | A bot or chat finishes a turn you started. |
| **Routine reports** | A bot's routine finishes. |
| **Problems** | A turn fails, or a bot stops unexpectedly. |

**Send a test notification** asks the server for one. A notification for the
conversation already on screen does not show a banner. Tapping a notification
opens its bot or chat, on the server that sent it.

The server sends notifications through
[Expo's push service](https://docs.expo.dev/push-notifications/overview/), which
hands them to Apple or Google. A notification carries the bot's name or the
chat's title, a fixed phrase such as "Needs your approval" in the phone's
language, and the ids the app needs to open it. It never carries what a bot,
chat or person wrote. Each server keeps the phone's push token and preferences
until the phone unpairs or is revoked; a token Expo reports as no longer
registered is removed.

On a server you manage, set in its `.env`:

| `.env` setting | Purpose | Default |
| --- | --- | --- |
| `MAESTRLY_GATEWAY_PUSH` | `expo` sends notifications through Expo; `off` sends none, and phones say so in their settings | `expo` |
| `MAESTRLY_GATEWAY_EXPO_ACCESS_TOKEN` | An Expo access token, needed only when the app's Expo project requires one for push | Empty |

Notifications need a build of the app from EAS (see [Release](#release)) on a
real phone. Simulators and the web preview cannot receive them; their settings
say so.

## Artifacts

Pages open in the system's browser view, through the server's
[public address](artifacts.md#reach-the-server-from-another-device), which must
be HTTPS: the viewer answers only at that address. Set it on your computer in
**Settings → Artifacts**. Each **Open** asks the server for a single-use ticket
that expires within a minute, as the desktop does, and the viewer removes it
from the address bar at once. The page's scripts run in the browser view, never
in the app.

## Unpair and revoke

In the app, open **Settings** and choose **Unpair from** the server. If the
server cannot be reached, the app offers to forget it anyway; the server then
keeps listing the phone until you revoke it with `devices revoke <id>` (see
[Security and data](bot-fleet.md#security-and-data)). A revoked phone shows
**This phone was removed** and offers to pair again. Unpairing or revoking a
phone also removes its push registration from the server.

## Data on the phone

- The device token for each server is in the iOS Keychain or the Android
  Keystore, readable after the first unlock and never moved to another device.
- The list of paired servers, your theme, language and notification choices, the
  defaults for new chats, and messages not yet sent are kept in the app's
  storage. Photos and files waiting to be sent stay in the app's cache until
  they are.
- The app talks only to the servers you paired and, when you turn notifications
  on, to Expo's push service and the phone's (Apple's or Google's) to get a push
  token. It sends no telemetry.
- Dictation uses the phone's speech recognition: Apple's on iOS, Google's (or
  the phone maker's) on Android. They may process the audio on their servers,
  under their own privacy policies. Maestrly and your server never receive the
  audio, only the text you then send. The microphone is on only while the
  listening indicator shows.

## Develop

```sh
npm run dev:mobile
```

This builds the bot fleet protocol and starts Expo. Scan the QR code Metro
prints with **Expo Go** on a phone on the same network. Expo Go lacks the
speech recognition module, so it shows no microphone; for dictation and
notifications, install a `preview` build from EAS (see [Release](#release)).

- **Web preview:** press `w` in Metro, or run
  `npm run web --workspace @maestrly/mobile`. A browser cannot pair: it sends an
  `Origin` header the gateway refuses. Use **Explore a demo server**.
- **Simulators:** in development, the app also accepts a loopback HTTP address,
  such as `http://127.0.0.1:7443`. On the Android emulator, run
  `adb reverse tcp:7443 tcp:7443` first.
- **Checks:** `npm run check:mobile` type checks, runs the unit tests and bundles
  both platforms with `expo export`.
- **Web flows:** `npm run test:e2e:mobile` builds the web version and goes
  through the demo server in Chromium at a phone's size: talking to a bot,
  dictation, compaction, an approval, a published page, a new chat, its setup,
  the settings and the dark theme. It fails on any console error, and on any
  control without a name for screen readers. It needs Playwright's Chromium
  (`npx playwright install chromium`) and runs in CI with the platform's
  end-to-end tests.
- **Icons:** `npm run icons --workspace @maestrly/mobile` renders the app icon,
  Android's adaptive and monochrome icons, the splash, the notification icon and
  the favicon from the mark in `src/ui/BrandMark.tsx`. It needs Playwright's
  Chromium (`npx playwright install chromium`); the images are committed.
- **React version:** the app uses the React version Expo SDK 57 renders with,
  which differs from the web and desktop apps. `metro.config.cjs` resolves
  `react` and `react-dom` from the app wherever npm hoisted `react-native`;
  `test/react-pin.test.ts` checks both.

## Release

Store builds come from [EAS](https://docs.expo.dev/build/introduction/), with
the profiles in `apps/mobile/eas.json`: `preview` for internal testing (an APK
on Android) and `production` for the stores, with build numbers kept by EAS.
Run the commands in `apps/mobile`, with the EAS CLI signed in to the Expo account
that owns the app.

1. **Project:** `npx eas-cli init` creates the Expo project. Set its id and
   owner as `MAESTRLY_EAS_PROJECT_ID` and `MAESTRLY_EAS_OWNER`, in your shell and
   as EAS environment variables of the `preview` and `production` environments.
   Without a project id, builds work but cannot get push tokens.
2. **Android push:** create a Firebase project for
   `io.github.antonioducs.maestrly.mobile`, upload its FCM V1 service account
   key with `npx eas-cli credentials`, and add its `google-services.json` as an
   EAS file variable named `MAESTRLY_GOOGLE_SERVICES_FILE`. The file is never
   committed.
3. **iOS:** `npx eas-cli build --profile production --platform ios` signs in to
   your Apple Developer account and creates the certificates, the provisioning
   profile and the push key.
4. **Build and submit:** `npx eas-cli build --profile production --platform all`,
   then `npx eas-cli submit --profile production` for each platform.

On EAS machines, the repository's `postinstall` skips the desktop setup.

For App Review and the stores:

- The app needs no account, but it needs a bot server. Reviewers can use
  **Explore a demo server** on the first screen; say so in the review notes.
- The app declares no tracking and no data collected by the developer; its iOS
  privacy manifest lists the reasons for the system APIs React Native and Expo
  use. Everything the app sends goes to servers the person runs, and to the
  phone's push and speech services. Describe those in the privacy answers as
  your policy requires.
- Export compliance: the app uses only the system's encryption
  (`ITSAppUsesNonExemptEncryption` is false).

## Troubleshooting

| You see | Check |
| --- | --- |
| **Can’t reach** the server | The address is `https://`, the phone reaches it (Tailscale running on both, same tailnet), and the phone's clock is right. |
| **Update the bot server to pair a phone** on the computer | The server predates the `device-pairing` feature. Update it, or use `maestrly-bot-gateway pair`. |
| **This code has expired** | Codes last ten minutes and work once. Create a new one. |
| **This phone was removed** | The phone was revoked or unpaired elsewhere. Pair it again. |
| **This server runs a version this app can’t use** | Update the bot server and the app. |
| **The workspaces host isn’t running** | Start the workspaces environment from Maestrly on your computer. Messages you send wait on the phone. |
| **Update the bot server to use chats on this phone** | The server or its workspaces environment predates the mobile API. Update both. |
| **Update this app to use chats on** a server | The server's workspaces environment uses another version of the mobile API than this app. |
| A notification setting says the server **sends no notifications** | The server sets `MAESTRLY_GATEWAY_PUSH=off`. |
| **Pages open on a phone through the server's public HTTPS address** | Set an HTTPS **Public address** in **Settings → Artifacts** on your computer. |

## Device checklist

Before a release, on a real phone with a `preview` build:

1. On the computer, choose **Settings → Bot server → Pair a phone** and scan the
   code with the app. Expect the confirmation with the server's address, then
   the bots, and the offer to turn notifications on.
2. Send a message to a bot and watch the reply arrive as it streams.
3. Approve a request from its card.
4. In **Chats**, start a new chat in a workspace, send a message, and change its
   mode from the setup pill.
5. Lock the phone and have a bot ask for approval: a notification arrives;
   tapping it opens the bot. **Send a test notification** arrives too.
6. Dictate a message, in English and in Portuguese.
7. Ask a chat for an artifact and open it from its card.
8. Turn on airplane mode and send a message: it shows **Not sent yet**. Turn
   airplane mode off: it sends on its own.
9. Close and reopen the app: it is still paired.
10. Unpair from **Settings**: `devices list` on the server shows the phone as
    revoked, and it receives no more notifications.
