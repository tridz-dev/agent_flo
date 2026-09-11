# Agent Runtime Audit — Doctype, Context, Cache, Tools/Memory, Data Management

**Date:** 2026-08-20
**Scope:** Agent doctype and related config doctypes, prompt caching/context handling,
tool settings & memory, and execution data lifecycle across the `huf` app.
**Method:** Parallel scoped audits (4 areas) synthesized and cross-checked; critical
claims independently re-verified against source before publishing (see "Verification"
at the end of each section).

This is a **findings and recommendations document** — no functional code has been
changed as part of this audit. It is meant to seed follow-up implementation PRs.

---

## Executive Summary

- **Unbounded growth is the dominant systemic pattern**, repeated across at least six
  independent tables (Agent Run, Agent Message, Agent Tool Call, Agent Run Analytics
  Rollup, Agent Context Artifact, conversation forks). This isn't six separate bugs —
  it's one missing capability: **no retention/purge framework exists for the
  execution/audit layer.**
- **A second systemic pattern: unbounded/unpaginated reads** (`limit_page_length=0`,
  no batching) in analytics rollups, stalled-run recovery, and history/fork queries.
  Same root cause (no pagination discipline) surfacing in 3+ unrelated modules.
- **Real security gaps in the tool execution path**: tool call args/results are
  persisted without secret redaction, a guest-permission bypass is set unconditionally
  once a doctype-pinning check passes, and LLM-supplied `extra_args` are merged into
  tool invocation args without a re-check of permissions on the resulting target.
  These should be treated as the highest priority items in this report.
- **Numeric/config validation is systematically absent** across the Agent doctype
  (temperature, top_p, summary_ratio, history_limit, max_turns, max_upload_size_mb) —
  every one of these fields documents a bound in its `description` but none enforce
  it in `validate()`. One missing pattern, seven findings.
- **Cache correctness is broken by design in one specific way**: the prompt-cache
  breakpoint hash is derived from the *last message's* content, but `trim_messages()`
  can change what the last message is — so trimmed/long conversations get repeated,
  silent cache misses. Combined with silent cache-disable when LiteLLM lacks pricing
  metadata, users can pay full token cost for a feature they believe is active.
- **Cascading delete / referential integrity is missing** everywhere a child record
  points at Agent Run or Agent Conversation — orphaned Agent Message, Agent Tool Call,
  and Agent Context Artifact rows are a direct, unavoidable consequence of no
  `on_delete` handling on those Links.
- A number of findings are cosmetic/low-risk (impossible `depends_on` condition,
  missing `field_order` entries, missing indexes, undocumented fields) — real, but not
  urgent relative to the above.

---

## Cross-Cutting Systemic Issues

These were not visible to any single scoped audit area — they only emerge by reading
across all four areas together.

1. **No retention/purge framework exists anywhere in the app.** Agent Run, Agent Run
   Analytics Rollup, Agent Tool Call, orphaned Agent Message rows, Agent Context
   Artifact, and unbounded conversation-fork copies are all instances of the same
   missing piece. Recommend building **one** generic retention/cascade utility
   (e.g. `huf/ai/retention.py` with a registry of `doctype → {retention_days,
   cascade_children}`) and wiring it once into `scheduler_events["daily"]`, rather than
   writing four bespoke purge functions.
2. **No pagination discipline for internal batch/analytics jobs.**
   `_affected_dimensions()`, `recover_stalled_agent_runs()`, `get_conversation_history()`,
   and full-history conversation fork copy all use unbounded fetches
   (`limit_page_length=0` or no cap at all). This is a single coding-standard gap —
   worth a shared `batched_get_all()` helper and/or a lint rule flagging
   `limit_page_length=0` in scheduler-triggered code.
3. **No numeric-bounds validation convention in Agent-family doctypes.** `temperature`,
   `top_p`, `summary_ratio`, `reasoning_budget_tokens`, `max_upload_size_mb`,
   `history_limit`, `max_turns` all describe bounds in their field `description` but
   enforce none in `agent.py`. One shared `_validate_range(field, lo, hi)` helper fixes
   all of these at once.
4. **Missing `on_delete`/cascade wiring for every Link to Agent Run / Agent
   Conversation.** Agent Message, Agent Tool Call, and Agent Context Artifact all
   silently orphan on parent deletion. Fix by auditing every Link field pointing at
   these two parent doctypes and either setting cascade behavior or a uniform purge
   hook — not three separate bugs.
5. **Silent failure / silent downgrade as a recurring anti-pattern.** Cache
   auto-disable, swallowed exceptions in cache-capability detection, tool arg/result
   truncation with no flag, and missing-required-tool-parameter omission all follow the
   same shape: a capability quietly degrades instead of surfacing a signal. Worth a
   review checklist item: *"no silent truncation or silent capability downgrade
   without a logged/flagged signal."*

---

## Findings by Section

### 1. Agent Doctype & Config

| # | Severity | Issue | Fix | Implication if unfixed |
|---|---|---|---|---|
| A1 | Critical | `temperature`, `top_p`, `summary_ratio`, `reasoning_budget_tokens` have no server-side bounds check (`huf/huf/doctype/agent/agent.json` — description text only; nothing in `agent.py validate()`) | Add range checks in `agent.py validate()` for each field | Invalid configs save silently and fail at LLM call time, wasting API calls and confusing users |
| A2 | Critical (confirmed) | Impossible `depends_on` in `huf/huf/doctype/agent_tool_function/agent_tool_function.json:122`: `"eval: doc.types == \"Custom Function\" && doc.types == 'Client Side Tool'"` — a field can never equal two different values with `&&` | Change `&&` to `\|\|` | `pass_parameters_as_json` can never be shown/configured in the UI |
| A3 | High | `max_upload_size_mb` has no upper-bound enforcement despite the field description stating a 25MB cap | `frappe.throw` if `> 25` in `validate()` | Uploads silently truncated/rejected at runtime, contradicting the saved config |
| A4 | High | `history_limit` / `max_turns` have no upper bound | Cap at a sane maximum (e.g. 1000 / 100) | Runaway context size (cost) or unbounded tool-call loops |
| A5 | Medium | `agent_trigger.json` defines `seeding_metadata_section`, `source_app`, `source_file` but they're missing from `field_order` | Add the three fields to `field_order` | Fields render outside the intended layout or are effectively hidden; breaks metadata tracking for externally-seeded triggers |
| A6 | Medium | Missing index on `agent.disabled`, `agent_trigger.disabled`, `agent_trigger.trigger_type` | Add `"index": 1` to each | List/filter queries full-scan as row counts grow |
| A7 | Medium | Redundant state: `agent_trigger.disabled` (bool, user-facing) vs `status` (select, hidden) — no code keeps them in sync | Sync `disabled → status` in `validate()`, or drop one field | Inconsistent state if only one is modified |
| A8 | Low | `async` field is hidden, undocumented, and its relation to `run_immediately` is unclear | Add a description or remove if dead | Maintainer confusion; risk of relying on a deprecated flag |
| A9 | Low | `interval_count` has no unit documentation | Add description clarifying units | Misconfigured schedules (e.g. 5 seconds vs 5 days) |
| A10 | Low | Custom Function tool validation doesn't check path safety, determinism, or JSON-serializable return | Add allow-listing / serializability check | A misbehaving custom function can hang or crash agent runs |
| A11 | Low | `agent_tool.json` fetches `type` from `tool.types` into every child row (unnecessary denormalization) | Remove or scope to display-only | Extra sync burden whenever `tool.types` changes |

**Verification:** A2 independently re-confirmed by reading the file directly (note:
correct path is `huf/huf/doctype/agent_tool_function/agent_tool_function.json`, not a
triple-nested path). A1/A3/A4 pattern confirmed by inspecting `agent.py` — no
`validate()` bounds logic exists for these fields.

---

### 2. Context & Prompt Caching

| # | Severity | Issue | Fix | Implication if unfixed |
|---|---|---|---|---|
| C1 | Critical | Cache silently disables when LiteLLM lacks pricing metadata for a model (`huf/ai/prompt_cache_capabilities.py:18-48`) | Surface a warning/flag to the UI and logs when caching is disabled | Users believe caching is active and pay full token cost with no visibility |
| C2 | Critical (confirmed) | Cache breakpoint hash is derived from the *last message's* content (`huf/ai/context_segments.py:~107`), but `trim_messages()` (`huf/ai/providers/litellm.py:~782`) can change what the last message is, invalidating the hash | Derive the cache hash from a stable prefix boundary independent of trim state | Repeated cache misses on any trimmed/long conversation, defeating caching entirely |
| C3 | High | Exceptions during cache-capability detection are swallowed silently (`huf/ai/context_segments.py:94-97`) | Log the exception; propagate a capability-unknown state instead of silently assuming "no cache" | Cache failures become undiagnosable |
| C4 | High | `get_conversation_history()` has no hard cap; `summarize_conversation()` appears to be a stub that never calls the LLM (`huf/ai/conversation_manager.py:540-573`) | Add a hard limit; implement the actual summarization call | OOM risk on very large conversations; summarization silently no-ops |
| C5 | High | Full-history conversation fork copies unlimited messages (`huf/ai/conversation_fork.py:202-215`) | Bound fork copy size, tie to agent's `history_limit` | Forking a large conversation doubles storage and can insert 10k+ rows in one call |
| C6 | Medium | `cache_control_type="auto"` is selectable even for providers (e.g. Anthropic) that don't support it | Validate `cache_control_type` against a provider capability list | Runtime `BadRequest` errors from the provider |
| C7 | Medium | Forked conversations inherit cache settings without resetting cache state | Reset/recompute the cache reference on fork | Guaranteed cache misses immediately after fork |
| C8 | Medium | Fork summary mode hardcodes a 200-message fetch regardless of the agent's `history_limit` | Read from `agent.history_limit` | Inconsistent behavior vs. the agent's configured window |
| C9 | Medium | Possible race condition in concurrent fork+summarize with no transactional isolation | Add locking/transaction around the fork+summarize sequence | Corrupted conversation state under concurrent access |
| C10 | Medium | Cache-skip is logged internally only, never surfaced to the caller/UI | Surface to Agent Run / UI | Users/agents unaware caching was skipped for a given call |

**Verification:** C2 independently re-confirmed — `litellm.py` calls `trim_messages()`
at the cited line, and `context_segments.py` computes the prefix hash from
`history[-1]` at the cited line; the mismatch is real given the trim step runs
independently. C1/C3-C10 taken from the scoped audit report and are internally
consistent with the codebase's known patterns (queue-first execution, LiteLLM
routing) but were not independently re-read line-by-line in this pass — treat as
**PLAUSIBLE**, not fully independently verified, until reviewed against source.

---

### 3. Tool Settings & Memory

| # | Severity | Issue | Fix | Implication if unfixed |
|---|---|---|---|---|
| T1 | Critical | No retention/cleanup exists for `Agent Tool Call` records | Add a daily purge scheduler task (e.g. delete records older than N days) | Unbounded DB growth; indefinite storage of potentially sensitive logs |
| T2 | Critical (confirmed) | `tool_args`/`tool_result` are persisted to `Agent Tool Call` verbatim with no redaction step (`huf/ai/agent_integration.py:~735, ~760`) | Add a `_sanitize_tool_args()` pass masking known secret-shaped values before persisting | Anyone with read access to Agent Tool Call can harvest API keys/credentials passed through tool arguments |
| T3 | High (confirmed) | For guest-allowed tools, `ignore_permissions=True` is set unconditionally once the doctype-pinning check passes (`huf/ai/sdk_tools.py:~465-467`) | Require an explicit, narrower authorization check before bypassing permissions, not just "allowed_for_guest" | Guest users can potentially access doctypes beyond the intended scope |
| T4 | High (confirmed) | LLM-supplied `extra_args` are merged into the invocation args dict after parsing and before execution with no re-validation of permissions on the resulting target (`huf/ai/sdk_tools.py:~452-453`) | Re-run `frappe.has_permission()` against the merged/final target inside CRUD handlers | LLM-crafted arguments could access unintended records — a real authorization bypass path |
| T5 | High | No configurable timeout/retry limit per tool invocation | Add `timeout_seconds`/`max_retries` fields; wrap invocation (e.g. `asyncio.wait_for`) | A single hanging tool call can stall an entire agent run |
| T6 | Medium | Memory Policy is checked at save time but not re-checked if the policy is later deleted/disabled | Check policy existence/enabled state at the point of `save_memory_record()`, not just at config save | Blocked record types can be written with no audit trail after the policy is removed |
| T7 | Medium | Tool args/results are truncated (observed cap ~140,000 chars) with no logging or flag when truncation occurs | Log a warning and set a `was_truncated` flag on truncation | Debugging becomes impossible when truncated data caused the failure |
| T8 | Medium | HTTP header validation only checks for CRLF injection, not full RFC 7230 token rules | Add a strict token-char validation regex | Malformed header keys could cause parser confusion at the HTTP layer |
| T9 | Medium | No record of the executing user / permission state at tool-call time on `Agent Tool Call` | Add `executed_by` and a permission-state snapshot field | Cannot answer "who ran this, and did they have permission at the time" for compliance/audit |
| T10 | Medium | Custom function calls have no timeout/resource limit (overlaps T5) | Apply the same timeout fix specifically to the custom-function execution path | A slow/blocking custom function freezes the whole agent run |
| T11 | Low | Truncated tool results carry no explicit marker returned to the agent/model | Append an explicit truncation marker to the value | The agent reasons over incomplete data believing it's complete |
| T12 | Low | Missing required tool parameters are silently omitted rather than raising an error | Diff required params against supplied kwargs; return an explicit error | Misconfigured tools fail silently, hard to debug from logs alone |

**Verification:** T2, T3, T4 all independently re-confirmed against the current source
in `agent_integration.py` and `sdk_tools.py` — these three are the highest-confidence,
highest-severity findings in the entire audit and should be prioritized. T1, T5-T12
taken from the scoped report as PLAUSIBLE, not independently re-read line-by-line.

---

### 4. Data Management

| # | Severity | Issue | Fix | Implication if unfixed |
|---|---|---|---|---|
| D1 | High | No retention policy exists for `Agent Run` | Add a daily purge job for terminal-status runs older than N days | Unbounded table growth; slower analytics as row counts climb into the millions |
| D2 | High | `Agent Run Analytics Rollup` never purges old rollups after refresh | Delete rollups outside the configured retention window after each refresh | Query time on the rollup table grows linearly forever |
| D3 | High | Hard-deleting a conversation clears the Link on messages but doesn't delete the `Agent Message` rows themselves (`huf/ai/agent_chat.py:~1168-1191`) | Cascade-delete `Agent Message` (and `Agent Tool Call`) rows in the hard-delete path | Orphaned audit rows accumulate indefinitely |
| D4 | Medium (confirmed) | `_affected_dimensions()` fetches all matching Agent Run rows with `limit_page_length=0` (`huf/ai/agent_run_analytics.py:~31-38`) | Batch/paginate the fetch | Memory spike that can block the scheduler tick on large sites |
| D5 | Medium | Missing index on `Agent Message.conversation` | Add `search_index: 1` | Full table scan on every chat history load |
| D6 | Medium | Missing index on `Agent Run.start_time` | Add `search_index: 1` | Full scan on every analytics date-range query |
| D7 | Medium | `Agent Tool Call` orphaned on Agent Run/Conversation deletion — no `on_delete` handling | Cascade delete or explicit cleanup in the delete paths | Audit table bloat with no retention |
| D8 | Medium | `Agent Context Artifact` has no retention/cleanup job | Add a cleanup job removing artifacts tied to deleted messages | Unbounded growth, no archival strategy |
| D9 | Low | `Agent Run.reference_doctype`/`reference_name` can dangle if the referenced document is externally deleted | Add a cleanup job nulling dangling references | Orphaned references; downstream code may assume validity and error |
| D10 | Low (line numbers approximate, logic confirmed) | `recover_stalled_agent_runs()` scans all Started/Queued runs unbounded on a recurring interval (`huf/ai/agent_integration.py`, two `frappe.db.get_all` calls with no `limit_page_length`) | Batch processing with offset/limit | Periodic memory/CPU spikes as run volume grows |
| D11 | Low | Orphaned `Agent Message` rows (`conversation=NULL`) are listable but never purged | Add a daily purge job for orphans older than the retention window | Dead rows accumulate in the Agent Message table indefinitely |

**Verification:** D4 independently re-confirmed (`limit_page_length=0` at
`agent_run_analytics.py:31-38`). D10's core claim (unbounded scan, recurring) is
correct; the exact line numbers in the original scout report (2433-2465) are
approximate — verify against current `agent_integration.py` before implementing. D1,
D2, D3, D5-D9, D11 taken from the scoped report as PLAUSIBLE.

---

## Recommended Fix Priority

| Priority | Findings | Why first |
|---|---|---|
| 1 — Immediate (security) | T2, T3, T4 | Independently confirmed. Live security/data-exposure risk (secret leakage in logs, guest permission bypass, LLM-arg permission bypass) — not just hygiene |
| 2 — Immediate (correctness, cheap) | A2, C2 | Confirmed. Cheap, isolated fixes for functionality that is currently silently broken |
| 3 — This sprint (systemic) | Retention framework → fixes T1, D1, D2, D3, D7, D8, D11 in one pass | One piece of infrastructure resolves 7 findings |
| 4 — This sprint (systemic) | Numeric-bounds validator → fixes A1, A3, A4 | One validator function resolves 3 findings |
| 5 — This sprint (systemic) | Pagination/batching helper → fixes D4 (confirmed), D10, C4, C5 | Prevents memory spikes across 4 modules |
| 6 — Next sprint | T5/T10 (tool timeouts), C1/C10 (silent cache downgrade signaling), C3 (swallowed exception), T7/T11/T12 (silent truncation/omission) | Operational visibility and resource-exhaustion hardening |
| 7 — Next sprint | D5, D6, A6 (missing indexes) | Low-risk, straightforward, meaningful query-performance wins |
| 8 — Backlog | A5, A7, A8, A9, A10, A11, C6, C7, C8, C9, T6, T8, T9, D9 | Medium/low severity, schedule opportunistically |

---

## Methodology & Confidence Notes

- Findings were produced by four scoped audit passes (Agent doctype/config,
  context/cache, tool/memory, data management), synthesized into one document, then
  the highest-severity/highest-risk claims (7 of them, primarily the Critical/High
  security and correctness findings) were independently re-verified by re-reading the
  cited source directly.
- **Confirmed** = re-read against current source in this pass, quote/line matches.
- **Plausible** = consistent with the codebase's known architecture and not
  contradicted by anything reviewed, but not independently re-read line-by-line in
  this pass.
- Two line-number ranges (D4 exact lines, D10 exact lines) came from an initial pass
  with approximate line citations; D4 was confirmed precisely, D10's logic was
  confirmed but its line numbers should be re-checked against the current file before
  implementing a fix.
- No code changes were made as part of this audit — this document is the deliverable.
  Recommend opening tracked follow-up issues per priority tier above, starting with
  Tier 1 (T2/T3/T4) as security-sensitive work.
