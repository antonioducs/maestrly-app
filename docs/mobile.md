# Mobile app

Maestrly for iOS and Android (`apps/mobile`) follows and directs the bots, chats
and workspaces on your [bot server](bot-fleet.md) from your phone.

## What it does

- **Pairing:** scan the QR code your computer shows, or enter the server address
  and a pairing code.
- **Bots:** see every bot by environment, with what it is doing right now and
  what waits on you. Read a bot's conversation as it streams, scroll back
  through older messages, and send text, photos and files. With an image copied,
  **Paste image** shows above the message field and in its **+** menu.
- **Chats and workspaces:** the chats and workspaces of the server's
  [workspaces environment](remote-workspaces.md#on-a-phone), in the menu's
  **Chats** and **Workspaces** tabs. The **Workspaces** tab lists every chat of
  each workspace; chats that share a branch sit in a folder named after it, as
  in the desktop sidebar. Open a chat, start a new one on its own or in a
  workspace, and change its mode, model, effort, skills, MCP servers and
  context limit. A new chat in a workspace works on a new branch, named by you
  or after the chat, from the branch you choose (the default branch unless you
  change it), or on an existing local or remote branch. A [plugin](plugins.md)'s skills and servers are listed where
  the plugin applies, and each account of a server with several signed-in
  accounts has a switch of its own. A card shows the conversations an agent started from a chat,
  each with a way to open it, and a message, report or result another
  conversation sent names that conversation, which opens from its name.
- **Interactive answers:** an
  [interface](chat-context.md#interactive-answers) in a reply runs in an
  isolated web view once its block is complete, with no access to the app or
  the network. When it asks to send a message as you or to open a page, the app
  asks you first. **Show code** shows its source.
- **Files and videos from bots:** a file a bot shares shows with its name and
  size. A video downloads to the phone and plays in the conversation; any other
  file downloads and opens the system's share sheet.
- **Requests:** approve or deny a command, answer a question, or mark a request
  for help as resolved; in a chat, also review a plan and confirm the
  conversations an agent wants to start.
- **New bots:** **New bot** at the end of the **Bots** tab, or **+** beside an
  environment, creates a bot in an environment that already exists. Give it a
  name and what it does, choose where it runs, its permissions and the bots it
  can talk to. It uses that environment's accounts, skills, MCP servers and
  site logins, so it is ready once it sets up its profile, and its conversation
  opens. Full, stopped and older-image environments cannot be chosen; the list
  says why. A new environment, with its own accounts from your computer, is
  created from Maestrly on your computer.
- **Setup:** change a bot's model, reasoning effort, Fast and permissions; start,
  pause, resume, restart or stop a bot; run a routine now; compact a bot's
  conversation. New chats start with the defaults you choose in **Settings →
  New chats**.
- **Notifications:** hear when a bot or chat needs you, finishes a turn you
  started, finishes a routine, or fails. See [Notifications](#notifications).
- **Dictation:** the microphone in the message field turns what you say into
  text with the phone's own speech recognition. It listens in the language
  chosen in **Settings → Language** or, with **System**, in the phone's. When
  the phone's region has no recognizer for that language, it listens in the
  language's main one: an iPhone in English set to Brazil dictates in US
  English. On iOS 26 and later, it uses Apple's newer on-device transcriber
  for the languages it covers, which punctuates and handles long messages
  much better. The first time you dictate in such a language, iOS downloads
  the language's model in the background, and that dictation uses the
  previous recognizer. See [Data on the phone](#data-on-the-phone).
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
as the server, only the same mobile API. A server with
[several workspaces environments](remote-workspaces.md#several-scopes-on-one-server)
shows the phone the chats of one of them at a time. Choose which under the
server's name in the menu; the phone remembers it, and until you choose it opens
the first that runs and speaks to phones. Each environment keeps its own
workspaces, chats and messages waiting to be sent.

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
| **Routine reports** | A bot's routine finishes. With [routine runs in conversations of their own](bot-fleet.md#routine-runs), the bot's **Tell me about finished runs** setting chooses which runs notify. |
| **Problems** | A turn fails, or a bot stops unexpectedly. |

**Send a test notification** asks the server for one. A notification for the
conversation already on screen does not show a banner. Tapping a notification
opens its bot or chat, on the server that sent it and, for a chat, on its
workspaces environment.

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
keeps listing the phone until you remove it from another device or with
`devices revoke <id>` (see [Security and data](bot-fleet.md#security-and-data)).

**Settings → Paired devices** lists the phones and computers paired with the
server, with when each paired and was last active, and removes one you no longer
use or have lost; it can no longer reach the server. On a computer, the same list
is in **Settings → Bot server**. It needs a bot server that offers it. A revoked phone shows
**This phone was removed** and offers to pair again. Unpairing or revoking a
phone also removes its push registration from the server.

## Data on the phone

- The device token for each server is in the iOS Keychain or the Android
  Keystore, readable after the first unlock and never moved to another device.
- The list of paired servers, your theme, language and notification choices, the
  defaults for new chats, and messages not yet sent are kept in the app's
  storage. Photos, pasted images and files waiting to be sent stay in the app's
  cache until they are. The app checks whether the clipboard holds an image
  without reading it, and reads it only when you choose **Paste image**.
- The app talks only to the servers you paired and, when you turn notifications
  on, to Expo's push service and the phone's (Apple's or Google's) to get a push
  token. It sends no telemetry.
- Dictation uses the phone's speech recognition: Apple's on iOS, Google's (or
  the phone maker's) on Android. They may process the audio on their servers,
  under their own privacy policies. On iOS 26 and later, the newer transcriber
  keeps the audio on the phone for the languages it covers. Maestrly and your
  server never receive the audio, only the text you then send. The microphone
  is on only while the listening indicator shows.

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
  (`npx playwright install chromium`). CI runs it on Linux with the desktop's
  end-to-end tests, and `npm run verify:pr -- --full` runs it too.
- **Android build on this computer:** with JDK 17 and the Android SDK
  (`ANDROID_HOME`), run `npx expo prebuild --platform android` in `apps/mobile`,
  then `./gradlew assembleRelease` in `apps/mobile/android`, and install the APK
  on an emulator or phone with `adb install`. The release build runs on Hermes,
  as the store app does; the web preview runs on the browser's engine and can
  hide what Hermes lacks, such as `Intl.PluralRules`. Use a checkout whose path
  has no spaces. `ios/` and `android/` are generated and never committed.
- **Icons:** `npm run icons --workspace @maestrly/mobile` renders the app icon,
  Android's adaptive and monochrome icons, the notification icon and the favicon
  from the logo in `src/ui/brand.ts`, which `test/brand.test.ts` keeps identical
  to the desktop brand assets. It needs Playwright's Chromium
  (`npx playwright install chromium`); the images are committed.
- **Intro:** the native splash is only a dark background (its image is
  transparent). `src/ui/Intro.tsx` then draws the logo over it: the whole
  animation the first time the app opens, the logo alone afterwards, and a still
  logo while the system reduces motion. It fades into the app once the app is
  ready.
- **React version:** the app uses the React version its Expo SDK renders with,
  which can differ from the desktop app's. `metro.config.cjs` resolves
  `react` and `react-dom` from the app wherever npm hoisted `react-native`;
  `test/react-pin.test.ts` checks both.
- **Expo SDK upgrades:** the app is on Expo SDK 58. Each SDK pins React, React
  Native and the native modules it was built with, so they move together: run
  `npx expo install expo@^<next> --fix` in `apps/mobile`, pin the exact versions
  it installed in `package.json`, update the `react-native-reanimated` and
  `react-native-worklets` overrides in the root `package.json`, and check the
  app with `npx expo-doctor@latest`. Dependabot only proposes patches within the
  current SDK (`.github/dependabot.yml`). An upgrade reaches phones with the next
  store build.

## Release

Store builds come from [EAS](https://docs.expo.dev/build/introduction/), with
the profiles in `apps/mobile/eas.json`: `preview` for internal testing (an APK
on Android) and `production` for the stores, with build numbers kept by EAS.
Run the commands in `apps/mobile`, with the EAS CLI signed in to the Expo account
that owns the app.

On EAS machines, the repository's `postinstall` skips the desktop setup, and the
app's `eas-build-post-install` script builds the bot fleet protocol before the
app is bundled.

### Set up once

1. **Project:** `npx eas-cli init` creates the Expo project. Set its id and
   owner as `MAESTRLY_EAS_PROJECT_ID` and `MAESTRLY_EAS_OWNER`, in your shell and
   as EAS environment variables of the `preview` and `production` environments.
   Without a project id, builds work but cannot get push tokens.
2. **Android push:** create a Firebase project for
   `io.github.antonioducs.maestrly.mobile`, upload its FCM V1 service account
   key with `npx eas-cli credentials`, and add its `google-services.json` as an
   EAS file variable named `MAESTRLY_GOOGLE_SERVICES_FILE`. The file is never
   committed.
3. **iOS signing:** in App Store Connect, under **Users and Access →
   Integrations**, create a team API key with the **Admin** role. Then run
   `npx eas-cli credentials -p ios` for the `production` profile:
   - **Build Credentials → All** registers the bundle identifier and creates the
     distribution certificate and the provisioning profile. With the API key in
     `EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID`, `EXPO_ASC_ISSUER_ID` and
     `EXPO_APPLE_TEAM_ID`, the CLI needs no Apple ID. If it cannot turn Push
     Notifications on for the identifier, turn it on in the developer portal and
     run it again with `EXPO_NO_CAPABILITY_SYNC=1`.
   - **Push Notifications** takes an APNs key, created in the developer portal
     under **Keys** for **Sandbox & Production**.
   - **App Store Connect** takes the API key, which EAS then uses to upload builds
     and push the store listing.
4. **App Store Connect:** create the app with the bundle identifier and put its
   Apple ID in `ascAppId` of the `production` submit profile in `eas.json`. Set
   the price and the countries, and answer **App Privacy** (see below). The
   listing itself comes from the repository.
5. **GitHub:** create a `mobile-ios` environment that deploys only `main` and
   `mobile-v*` tags, with:

   | Name | Kind | Value |
   | --- | --- | --- |
   | `EXPO_TOKEN` | Secret | An access token of a robot of the Expo account |
   | `ASC_API_KEY` | Secret | The App Store Connect key's `.p8` file, in base64 |
   | `ASC_API_KEY_ID`, `ASC_API_ISSUER` | Secrets | The key's id and its issuer id |
   | `APP_REVIEW_FIRST_NAME`, `APP_REVIEW_LAST_NAME`, `APP_REVIEW_EMAIL`, `APP_REVIEW_PHONE` | Secrets | Who App Review calls with questions |
   | `MAESTRLY_EAS_PROJECT_ID`, `MAESTRLY_EAS_OWNER` | Variables | As in step 1 |
   | `APPLE_TEAM_ID` | Variable | The team id under **Membership details** in the developer portal |

### Release on iOS

The phone app has versions of its own, apart from the desktop app's.

1. Set the new version in `apps/mobile/package.json` and `app.config.ts`; a test
   keeps them equal. Write what's new in it, in English and Portuguese, in
   `RELEASE_NOTES` of `apps/mobile/store.config.cjs`: the listing refuses to
   load a version after the first without them, because App Store Connect would
   otherwise show "Bug fixes and improved stability". When the screens changed,
   run `npm run screenshots --workspace @maestrly/mobile`: it renders the
   6.9-inch iPhone screenshots from the demo server into
   `apps/mobile/store/screenshots/`. Merge to `main`.
2. Tag the merged commit with `mobile-v` and the version, and push the tag:

   ```sh
   git fetch origin main
   git tag mobile-v0.1.1 origin/main
   git push origin mobile-v0.1.1
   ```

   **Mobile iOS** checks that the tag names the app's version and is on `main`,
   runs the app's checks, builds the app on EAS and uploads the build to
   TestFlight. A tag never submits to App Review. Running **Mobile iOS** by hand
   with `upload` (`gh workflow run mobile-ios.yml --ref main -f action=upload`)
   does the same without a tag, for another build of the same version.
3. Go through the [device checklist](#device-checklist) with the TestFlight build.
4. Run **Mobile iOS** by hand with `submit`
   (`gh workflow run mobile-ios.yml --ref main -f action=submit`). It pushes the
   listing in `apps/mobile/store.config.cjs` (texts, What's New, keywords,
   screenshots, categories, age rating and the review notes), waits until App
   Store Connect has processed the version's newest build, attaches it and
   submits the version to App Review.
   `upload-and-submit` does both in one run. A language added to the listing
   reaches App Store Connect without its texts the first time; when App Review
   then refuses the version for missing texts, run `submit` again.
5. Approval does not publish the version: release it from App Store Connect.

The same steps run from a computer: `npx eas-cli build --platform ios --profile
production --auto-submit`, `npx eas-cli metadata:push --profile production` with
the `MAESTRLY_APP_REVIEW_*` variables of the contact, and
`node scripts/submit-for-review.mjs` with the `ASC_API_*` variables.

For App Review and the stores:

- The app needs no account, but it needs a bot server. The review notes point
  reviewers to **Explore a demo server** on the first screen. They also answer
  what App Review asks new developer accounts under Guideline 2.1: the app's
  purpose and audience, setup and access, external services, regional
  differences and regulated material. Edit them in `store.config.cjs`, not in
  App Store Connect, because each `submit` overwrites them.
- App Review can also ask for a screen recording on a physical device, from
  launch through the typical flow, including pairing and **Unpair**. Attach it
  to the reply in App Store Connect.
- The app declares no tracking and no data collected by the developer, so
  **App Privacy** is **Data Not Collected**; its iOS privacy manifest lists the
  reasons for the system APIs React Native and Expo use. Everything the app
  sends goes to servers the person runs, and to the phone's push and speech
  services. App Store Connect offers these answers only on its website.
- Export compliance: the app uses only the system's encryption
  (`ITSAppUsesNonExemptEncryption` is false).
- The app is not offered in mainland China, which requires an ICP filing number.

## Troubleshooting

| You see | Check |
| --- | --- |
| **Can’t reach** the server | The address is `https://`, the phone reaches it (Tailscale running on both, same tailnet), and the phone's clock is right. |
| **Update the bot server to pair a phone** on the computer | The server predates the `phones` feature. Update it, or use `maestrly-bot-gateway pair`. |
| **This code has expired** | Codes last ten minutes and work once. Create a new one. |
| **This phone was removed** | The phone was revoked or unpaired elsewhere. Pair it again. |
| **This server runs a version this app can’t use** | Update the bot server and the app. |
| **The workspaces host isn’t running** | Start the workspaces environment from Maestrly on your computer. Messages you send wait on the phone. |
| An environment **is stopped** | Tap **Start** in the menu, or start it from Maestrly on your computer. |
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
4. In **Chats**, start a new chat in a workspace on a new branch from a branch
   you choose, send a message, and change its mode from the setup pill. Attach
   a photo and a file from **+**, and paste a copied image.
5. Lock the phone and have a bot ask for approval: a notification arrives;
   tapping it opens the bot. **Send a test notification** arrives too.
6. Dictate a message with **Settings → Language** on English, then on
   Português: each listens in its language.
7. Ask a chat for an artifact and open it from its card.
8. Turn on airplane mode and send a message: it shows **Not sent yet**. Turn
   airplane mode off: it sends on its own.
9. Close and reopen the app: it is still paired.
10. Unpair from **Settings**: `devices list` on the server shows the phone as
    revoked, and it receives no more notifications.
