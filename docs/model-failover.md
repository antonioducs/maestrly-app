# Model fallback

When the model a conversation uses fails for a reason another model can fix, Maestrly can continue the work on
another provider and model, including API-key (BYOK) providers. Configure it in **Settings → Models and agents →
Fallback models**.

## Setting it up

1. Add models with **Add model**. Each one has its own effort and Fast mode; a fallback never inherits the
   conversation's, because an effort such as Claude's `max` does not exist on other providers. **Default** lets the
   provider decide.
2. Order them with **Try earlier** and **Try later**. Maestrly tries them in this order and skips the model the
   conversation already uses.
3. The list turns on with its first model. The switch turns it off without losing the list.

The list is off until it has a model, and it is global: it applies to every conversation, subagent and background
task of this computer. A bot server keeps its own settings; this list is not synced to it.

To keep one conversation on its model, open the model chip in the composer and turn on **Pin this model (no
fallback)**. A failure then ends the turn, as it does without a list.

## When it switches

Claude and Codex subscriptions first rotate across their own accounts (**Automatic account rotation** in
**Accounts**). Subscription accounts keep their own holds and resets. The fallback list takes over only when that rotation gave up, or for any other provider when its
model fails with:

| Failure | What happens |
| --- | --- |
| Usage limit or quota, billing, revoked or missing login | The next model continues; the account cools down. |
| Rate limit | Short waits are retried in place. A wait over 60 seconds switches models when one is ready. |
| Overloaded, server error, timeout, unknown model | Retried in place first; then the next model continues. |
| Context window exceeded | The next model whose window holds the conversation goes first. In a conversation turn, when the error reveals a smaller window than Maestrly knew, the same model is compacted and retried once. |

Maestrly never switches after you stop a turn, after a turn submitted its plan with `review_plan`, when a provider
rejects a request on content-policy grounds, or for a malformed request. A lost Claude sign-in refresh race is
retried as before and does not switch.

## What you see

- The failed response keeps its partial output and its error. The same turn continues in a new response on the
  next model, from a hidden instruction not to repeat completed work or tool calls. A notice says which model
  continues and why.
- The conversation's own model never changes. The next turn starts on it again, unless a fallback just served
  after a usage limit, rate limit, billing problem or overload: that fallback then goes first for the conversation
  until it is idle for 10 minutes (30 minutes at most), so a model that is out of quota is not retried on every
  message.
- A turn switches at most four times. If every model fails, the turn shows the last error.
- Moving to another runtime (for example from a Claude subscription to an API key) ends the previous runtime's
  session for the conversation, as changing the model does. Its next turn rebuilds that session from the
  conversation, so its first request does not reuse the provider's cache.

## Subagents and background tasks

- **Subagents** move to the next model with a frozen profile of their own and continue the same task from what the
  failed attempt reported (its partial text, the tools it used and the files it touched).
- **Memory extraction, image descriptions and compaction summaries** retry on the next model of the list. Image
  descriptions use only fallbacks known to see images.
- Executions whose selection is frozen keep their model: review loops, bot commands and their subagents, a bot's
  routed delegations, and background compaction with its own model. Their account rotation still works as before.

## Cooldowns

Failures put the blamed account or model on hold, in memory, until Maestrly restarts:

| Failure | Hold |
| --- | --- |
| Rate limit | Exactly the reset time the provider gave; none without one |
| Quota | Until the reset the provider reported, else 5 minutes |
| Billing | 10 minutes, doubling up to 24 hours |
| Login failure | 10 minutes, doubling up to 1 hour |
| Overloaded, server error, timeout, unknown model | 30 seconds, then 60 seconds, then 5 minutes |

A model on hold is skipped when a turn starts: the turn starts on the first model that is free, and the notice says
so. A rate limit or overload on one model does not hold the other models of the same account. Counters reset after a
success or 24 hours without failures.

## Context windows of local servers

For local and custom OpenAI-compatible servers, Maestrly reads the context window the server actually uses, so
compaction happens in time:

- Ollama: `num_ctx` of the model's parameters, else its trained context length.
- LM Studio: the loaded instance's context length, else the model's maximum.
- llama.cpp: `n_ctx` from `/props`.
- vLLM and other servers: window fields of `/models`, such as `max_model_len`.

These requests go only to the configured base URL, with a 2.5-second timeout, and are cached for five minutes. A
limit named in an overflow error is remembered for that model, and only a smaller value replaces it. Setting a
context limit for the model in the context meter clears the remembered one.

## Costs

A fallback can be a more expensive model. Only the models you list are used, a notice tells you each time, and a
conversation can be pinned. Subagent usage is reported under the model that finished the task.
