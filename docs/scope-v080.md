# v0.8 scope and acceptance

Source: the owner's explicit 2026-09-14 implementation request. Baseline: `9045c1c`.
This specification supersedes earlier Task / provisional-WEB-queue architecture.

1. Preserve ChatGPT's native composer, Send, interruption/supplement, model selection and attachments. No second chat input, backend, API client, chat runtime or framework.
2. Home `/` and project home `/g/.../project`: usage only. Formal normal/project `*/c/<id>`: usage, per-conversation Queue and completion notification. ChatGPT's own transient `/c/WEB:<id>` is usage-only; never allocate or migrate a queue there. Preserve one UI root across SPA transitions.
3. UI lives outside the React composer tree. No whole-page MutationObserver, streamed-token scan or recurring destroy/remount. Buttons remain clickable while typing/streaming or replacing the native composer.
4. Queue reads native text only when explicitly enqueued; local persistence before clearing. View/edit/delete/reorder/pause/resume/send-now. Empty native composer and genuinely finished prior turn are prerequisites for automatic or immediate send. Never overwrite a draft, attachment or IME composition.
5. Durable single-writer claim/lease and pre-click submission intent; receipt must identify a new matching native user message. Unknown delivery fails closed, requiring explicit human resolution, never automatic retries. Reload/multitab must neither lose queues nor duplicate sends.
6. Observe manual and queued native generation. Network completion only wakes an exact-document semantic probe using the same stable outcome gate as the page sampler. Running/unavailable/stale/timeout probes stay silent; a hidden confirmed completion may use a no-content notice. Recoverable terminal errors may advance existing Queue work without retrying the old request, with a two-consecutive-error pause. Stop, blockers, unknown failures and ambiguous sends cannot auto-continue. Attention stays nonterminal and never auto-approves. Notify human-action boundaries even if Queue work remains. See ADR-0005 (2026-09-16), which supersedes the earlier unavailable-probe generic fallback.
7. This account's configured allowance is 50/week. First known use is 2026-09-09; historical used count is unknown. Prefer official data if actually exposed; do not invent counters or a precise reset timestamp. Count only observed allowance-sharing Pro models, deduplicate observations, allow manual correction and confirmed reset schedules. Label local versus manual data and other-device limitations.
8. Reuse the validated native DOM adapter, completion controls and notifications; adapt only the MIT YOLO outbox operations needed here. Remove old Task/Queue runtime, temporary queue migration and obsolete compatibility tests. No unrelated features.
9. Validate real MV3 browser integration, live authenticated ChatGPT routes/behavior, draft/attachment safety, failure/reload/multitab, completion notification and usage. Distinguish controlled fixtures from live service evidence.
10. Independently review standards and requirements, fix findings, rerun relevant tests, inspect full diff, commit and push the current branch.

## Primary-source usage investigation

OpenAI Help Center article 20001354, verified again on 2026-09-14, describes GPT-6 Pro and GPT-5.6 Sol Pro as sharing the included Chat allowance for plans where that allowance is pooled. The current table lists 50/week for Pro $100 and Business Premium, while other plans have different limits, so 50/week is treated here as this account's configured allowance rather than a universal product rule. The article says ChatGPT displays reset time when that information is available; no reset timestamp is inferred from the first-use date. Article 20001516 concerns Work/Codex and must not be used as the Chat reset rule.

- https://help.openai.com/fi-fi/articles/20001354
- https://help.openai.com/fr-fr/articles/20001354
- https://help.openai.com/en/articles/20001516

The prior logged-in investigation recorded native `models` slugs `gpt-6-pro`, `gpt-5-6-pro`, `gpt-5-6-thinking`, and Work-only `gpt-6-astra-wm`. Native `conversation/init` had `model_limits: []`; remaining/reset entries belonged only to deep research and image generation. Bootstrap had no GPT-6 counter/reset. These are dated observations, not a public API contract or a guarantee for another account. September 9 alone is insufficient to manufacture an official reset timestamp.

The runtime does not invoke those endpoints. Current local counting observes eligible native conversation POSTs read-only: parse minimal identifiers at `onBeforeRequest`, count at `onSendHeaders`, and deduplicate a later DOM fallback by the same native user-message ID. Request metadata is transient `storage.session` data; current document/account identity is checked rather than trusting an old tab-to-account cache. Regeneration completion identity is deliberately separate from usage identity. Browser send observation is not proof of server billing, and absence of a DOM model marker never permits guessing.
