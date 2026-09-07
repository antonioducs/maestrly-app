# GPT-6 Astra harness smoke test

Use an entitled ChatGPT subscription and, separately, an OpenAI BYOK key. Do not record prompts, call IDs, or
reasoning payloads in diagnostics.

1. With `chat.astraHarness=true`, run Agent, Plan, Ask, and Maestro turns on Sol and Astra. Confirm Sol → Astra →
   Sol creates a native-thread boundary only on each profile crossing and that changing then reverting the model
   without sending does not retire the binding.
2. On BYOK, run a default Responses model, Astra, and Astra → default. Confirm Astra uses the dedicated prompt,
   encrypted reasoning replay, 30-minute prompt-cache TTL, server compaction, and no steering/async controls.
3. Exercise default/off, low, high, and native ultra. Confirm Astra never sends `none`/`minimal` or the synthetic
   Maestrly Ultra prompt block.
4. During an Astra subscription stream, send ordinary text and change effort. Confirm steering is reported as
   queued and live effort is applied; repeat with a stale turn/disconnect and confirm one queue fallback only.
   Attachments, skill/agent mentions, and Maestro Live must keep their existing queue paths.
5. Exercise `request_user_input_async` with a session that announces it and one that does not. Confirm only the
   announced session receives text-only async-question guidance and both use the existing question card/broker.
6. Drive context beyond the threshold. Confirm Astra compacts the same native thread first; force native
   compaction failure and confirm the portable fallback retires the old binding.
7. Set `chat.astraHarness=false` and send another Astra turn. Confirm model selection remains Astra while prompt,
   personality, queue, compaction, context flags, and effort behavior revert to the current default harness.
