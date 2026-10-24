/* Line icons from the approved prototype (prototypes/mobile-app/app.js), drawn on a 24-unit grid. */
export const ICON_PATHS = {
  menu: '<path d="M4 8h16M4 16h11"/>',
  compose:
    '<path d="M12 3.5H6a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 6 20.5h12a2.5 2.5 0 0 0 2.5-2.5v-6"/><path d="M18.4 2.8a2 2 0 0 1 2.8 2.8L12.5 14.3l-3.8 1 1-3.8Z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
  'chev-down': '<path d="m6 9 6 6 6-6"/>',
  'chev-up': '<path d="m6 15 6-6 6 6"/>',
  'chev-right': '<path d="m9 6 6 6-6 6"/>',
  'chev-left': '<path d="m15 6-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  'arrow-up': '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  'arrow-down': '<path d="M12 5v14M5.5 12.5 12 19l6.5-6.5"/>',
  smartphone: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  laptop: '<rect x="4.5" y="5" width="15" height="10" rx="1.5"/><path d="M2.5 19h19"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2" fill="currentColor" stroke="none"/>',
  settings:
    '<path d="M4 6.5h9M17 6.5h3M4 12h3M11 12h9M4 17.5h11M19 17.5h1"/><circle cx="15" cy="6.5" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17.5" r="2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  pause: '<path d="M9 5.5v13M15 5.5v13"/>',
  play: '<path d="M7.5 5.5v13l11-6.5Z"/>',
  restart: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/>',
  'wifi-off':
    '<path d="m3 3 18 18"/><path d="M8.5 16.4a5 5 0 0 1 7 0M5 12.9a10 10 0 0 1 5-2.7M19 12.9a10 10 0 0 0-2.4-1.7M2 8.8a15 15 0 0 1 4.3-2.7M22 8.8A15 15 0 0 0 11 5"/><path d="M12 20h.01"/>',
  server:
    '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1"/><path d="M14 14h3v3h-3zM20.5 14v.01M14 20.5h.01M17 20.5h3.5V17"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
  image:
    '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><circle cx="9" cy="9" r="1.8"/><path d="m20.5 15-5-5L5 20.5"/>',
  camera:
    '<path d="M14.5 4.5h-5L7.5 7H5a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-2.5Z"/><circle cx="12" cy="13" r="3.5"/>',
  file: '<path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10Z"/><path d="M14 3.5v5h5"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="10" rx="2.5"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  terminal: '<path d="m5 7 5 5-5 5M12.5 18h6.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17"/>',
  pencil: '<path d="M16.6 3.6a2.1 2.1 0 0 1 3 3L8 18.2 4 19.5l1.3-4Z"/>',
  tools: '<path d="M14.5 6.5a4 4 0 0 0 5 5l-8 8a2.1 2.1 0 0 1-3-3l8-8a4 4 0 0 0-2-2Z"/>',
  bot: '<rect x="4.5" y="8" width="15" height="11.5" rx="3"/><path d="M12 4.5V8M9 13h.01M15 13h.01M2.5 13v2M21.5 13v2"/>',
  zap: '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12Z"/>',
  'zap-fill': '<path d="M13 2.5 4.5 13.5H12l-1 8 8.5-11H12Z" fill="currentColor"/>',
  hand: '<path d="M8 12.5V6a1.5 1.5 0 0 1 3 0v5.5M11 11V4.5a1.5 1.5 0 0 1 3 0V11M14 11V6a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7h-.5a6 6 0 0 1-4.6-2.2L3.6 15a1.5 1.5 0 0 1 2.3-1.9L8 15.5"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.3 2.9 7.6 7 9 4.1-1.4 7-4.7 7-9V6Z"/><path d="M12 9v3.5M12 15.5h.01"/>',
  brain:
    '<path d="M9 4.5a2.5 2.5 0 0 0-2.5 2.5v.3A3 3 0 0 0 4.5 10a3 3 0 0 0 .8 2A3 3 0 0 0 7 17.3 2.7 2.7 0 0 0 12 18V6.5a2 2 0 0 0-3-2Z"/><path d="M15 4.5a2.5 2.5 0 0 1 2.5 2.5v.3a3 3 0 0 1 2 2.7 3 3 0 0 1-.8 2 3 3 0 0 1-1.7 5.3A2.7 2.7 0 0 1 12 18"/>',
  gauge: '<path d="M4 17a8.5 8.5 0 1 1 16 0"/><path d="m12 13.5 3.5-4"/>',
  message: '<path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12Z"/>',
  'message-plus':
    '<path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12Z"/><path d="M12 8.5v7M8.5 12h7"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.1a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
  sparkles:
    '<path d="M11 3.5 12.7 8.3 17.5 10 12.7 11.7 11 16.5 9.3 11.7 4.5 10 9.3 8.3Z"/><path d="M18 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>',
  'chev-updown': '<path d="m8 9 4-4 4 4M8 15l4 4 4-4"/>',
  mic: '<rect x="9" y="3" width="6" height="11.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
  bell: '<path d="M6 8.5a6 6 0 0 1 12 0c0 6.5 2.5 8.5 2.5 8.5h-17S6 15 6 8.5"/><path d="M10.3 20.5a1.9 1.9 0 0 0 3.4 0"/>',
  'bell-off':
    '<path d="M8.7 3.6A6 6 0 0 1 18 8.5c0 3 .6 5 1.3 6.4M17 17H3.5S6 15 6 8.5c0-.4 0-.8.1-1.2"/><path d="M10.3 20.5a1.9 1.9 0 0 0 3.4 0M3 3l18 18"/>',
  artifact: '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><path d="M3.5 9h17M9 20.5V9"/>',
  palette:
    '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-1 .8-1.7 1.8-1.7h2.1a3.8 3.8 0 0 0 3.8-3.8c0-4-3.8-7.2-8.5-7.2Z"/><circle cx="7.8" cy="11" r="1"/><circle cx="10.5" cy="7.5" r="1"/><circle cx="15" cy="7.8" r="1"/>',
  clipboard: '<rect x="5" y="4.5" width="14" height="16" rx="2.5"/><path d="M9 4.5V3.5h6v1M9 10.5h6M9 14.5h4"/>',
  skills: '<path d="M12 3.5 20.5 8 12 12.5 3.5 8Z"/><path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5"/>',
  plug: '<path d="M9 3.5V8M15 3.5V8M6.5 8h11v3a5.5 5.5 0 0 1-11 0ZM12 16.5v4"/>',
  branch:
    '<circle cx="7" cy="5.5" r="2"/><circle cx="7" cy="18.5" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 7.5v9M17 10c0 4-10 2.5-10 6.5"/>',
  compress: '<path d="M4 9.5h16M4 14.5h16M12 2.5v4.5M9.5 5 12 7.5 14.5 5M12 21.5V17M9.5 19l2.5-2.5 2.5 2.5"/>',
  // A bot's side conversations: its routine runs and its conversations with other bots.
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1L3.5 8.5"/><path d="M3.5 3.5v5h5"/><path d="M12 8v4l2.8 1.8"/>',
  swap: '<path d="m16 3.5 4 4-4 4"/><path d="M20 7.5H4"/><path d="m8 20.5-4-4 4-4"/><path d="M4 16.5h16"/>',
  repeat:
    '<path d="m17 2.5 3.5 3.5-3.5 3.5"/><path d="M3.5 11.5v-1a4 4 0 0 1 4-4h13"/><path d="m7 21.5-3.5-3.5 3.5-3.5"/><path d="M20.5 12.5v1a4 4 0 0 1-4 4h-13"/>',
  moon: '<path d="M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10Z"/>',
  pin: '<path d="M9 3.5h6M10 3.5v6l-3 4h10l-3-4v-6M12 13.5v7"/>',
  cite: '<path d="M5 4.5v6a4 4 0 0 0 4 4h10"/><path d="m15 10.5 4 4-4 4"/>',
  'bring-back': '<path d="M19 4.5v6a4 4 0 0 1-4 4H5"/><path d="m9 10.5-4 4 4 4"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  // A bot's screen on the phone: where the bot stopped, the whole screen, its keys and gestures.
  target:
    '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  backspace:
    '<path d="M8.5 5.5h11A1.5 1.5 0 0 1 21 7v10a1.5 1.5 0 0 1-1.5 1.5h-11L3 12Z"/><path d="m11.5 9.5 5 5M16.5 9.5l-5 5"/>',
  return: '<path d="M19.5 5.5v6a3 3 0 0 1-3 3h-12"/><path d="m8.5 10.5-4 4 4 4"/>',
  tap: '<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="7.5"/>',
  drag: '<path d="M12 3.5v17M3.5 12h17M12 3.5 9.8 5.7M12 3.5l2.2 2.2M12 20.5l-2.2-2.2M12 20.5l2.2-2.2M3.5 12l2.2-2.2M3.5 12l2.2 2.2M20.5 12l-2.2-2.2M20.5 12l-2.2 2.2"/>',
  pinch: '<path d="M4.5 4.5 10 10M4.5 4.5v4M4.5 4.5h4M19.5 19.5 14 14M19.5 19.5v-4M19.5 19.5h-4"/>',
} as const
