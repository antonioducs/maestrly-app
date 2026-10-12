# Mobile app

Maestrly for iOS and Android (`apps/mobile`) follows and directs the bots on
your [bot server](bot-fleet.md) from your phone.

## What it does in this version

- **Pairing:** scan the QR code your computer shows, or enter the server address
  and a pairing code.
- **Bots:** see every bot by environment, with what it is doing right now and
  what waits on you.
- **Conversations:** read a bot's conversation as it streams, scroll back
  through older messages, and send text, photos and files.
- **Requests:** approve or deny a command, answer a question, or mark a request
  for help as resolved.
- **Setup:** change a bot's model, reasoning effort, Fast and permissions; start,
  pause, resume, restart or stop a bot; run a routine now.
- **Offline:** messages you send without a connection wait on the phone and go
  out in order when the server is reachable again.

Chats and workspaces from your computers, and notifications, come in later
versions.

## Requirements

Your phone reaches the bot server over **HTTPS**. iOS and Android refuse plain
HTTP, so an address that works on your computer, such as an SSH tunnel on
`http://127.0.0.1`, does not work on the phone. The simplest way is Tailscale
Serve on the server and Tailscale on the phone: see
[With a server you manage](bot-fleet.md#with-a-server-you-manage).

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

## Unpair and revoke

In the app, open **Settings** and choose **Unpair from** the server. If the
server cannot be reached, the app offers to forget it anyway; the server then
keeps listing the phone until you revoke it with `devices revoke <id>` (see
[Security and data](bot-fleet.md#security-and-data)). A revoked phone shows
**This phone was removed** and offers to pair again.

## Data on the phone

- The device token for each server is in the iOS Keychain or the Android
  Keystore, readable after the first unlock and never moved to another device.
- The list of paired servers, your theme and language, and messages not yet sent
  are kept in the app's storage. Photos and files waiting to be sent stay in the
  app's cache until they are.
- The app talks only to the servers you paired. It sends no telemetry.

## Develop

```sh
npm run dev:mobile
```

This builds the bot fleet protocol and starts Expo. Scan the QR code Metro
prints with **Expo Go** on a phone on the same network.

- **Web preview:** press `w` in Metro, or run
  `npm run web --workspace @maestrly/mobile`. Development builds offer
  **Explore a demo server**, an in-memory server with sample bots, because a
  browser cannot pair: it sends an `Origin` header, which the gateway refuses.
- **Simulators:** in development, the app also accepts a loopback HTTP address,
  such as `http://127.0.0.1:7443`. On the Android emulator, run
  `adb reverse tcp:7443 tcp:7443` first.
- **Checks:** `npm run check:mobile` type checks, runs the unit tests and bundles
  both platforms with `expo export`.
- **React version:** the app uses the React version Expo SDK 57 renders with,
  which differs from the web and desktop apps. `metro.config.cjs` resolves
  `react` and `react-dom` from the app wherever npm hoisted `react-native`;
  `test/react-pin.test.ts` checks both.

## Troubleshooting

| You see | Check |
| --- | --- |
| **Can’t reach** the server | The address is `https://`, the phone reaches it (Tailscale running on both, same tailnet), and the phone's clock is right. |
| **Update the bot server to pair a phone** on the computer | The server predates the `device-pairing` feature. Update it, or use `maestrly-bot-gateway pair`. |
| **This code has expired** | Codes last ten minutes and work once. Create a new one. |
| **This phone was removed** | The phone was revoked or unpaired elsewhere. Pair it again. |
| **This server runs a version this app can’t use** | Update the bot server and the app. |

## Device checklist

Before a release, on a real phone with Expo Go:

1. Run `npm run dev:mobile` and open the app from the Metro QR code.
2. On the computer, choose **Settings → Bot server → Pair a phone** and scan the
   code with the app. Expect the confirmation with the server's address, then
   the bots.
3. Send a message to a bot and watch the reply arrive as it streams.
4. Approve a request from its card.
5. Turn on airplane mode and send a message: it shows **Not sent yet**. Turn
   airplane mode off: it sends on its own.
6. Close and reopen the app: it is still paired.
7. Unpair from **Settings**: `devices list` on the server shows the phone as
   revoked.
