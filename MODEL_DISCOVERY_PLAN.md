# Model Discovery & Registry — Implementation Plan

This document maps the proposed model discovery/registry schema against the current Huf codebase, identifies every file that needs to change, and details what must be added, modified, or removed.

---

## 1. Current State Summary

### AI Provider (`huf/huf/doctype/ai_provider/`)

**Current fields:**

| Field | Type | Notes |
|-------|------|-------|
| `provider_name` | Data (unique, required) | Display name, e.g. "OpenAI" |
| `api_key` | Password (required) | Encrypted credential |
| `slug` | Data | Informal identifier |
| `chef` | Data | Provider standard name used for LiteLLM prefix mapping |
| `is_local_llm` | Check | Toggles local LLM URL/port fields |
| `url` | Data | Local LLM endpoint |
| `port` | Int | Local LLM port |

**Controller** (`ai_provider.py`): Empty `Document` subclass + `get_provider_settings()` whitelisted method.

**JS** (`ai_provider.js`): "Provider Settings" custom button navigating to singleton settings DocTypes.

### AI Model (`huf/huf/doctype/ai_model/`)

**Current fields:**

| Field | Type | Notes |
|-------|------|-------|
| `model_name` | Data (unique, required) | e.g. "gpt-4-turbo" |
| `provider` | Link → AI Provider (required) | Parent provider |

**Controller** (`ai_model.py`): Empty `Document` subclass — no validation, no sync logic.

**JS** (`ai_model.js`): Empty.

### How Models Are Used Today

1. **Agent form**: User picks a provider, then model (filtered by provider via `frm.set_query`).
2. **`run.py` → `litellm.py`**: `_normalize_model_name(model, provider)` builds the LiteLLM model string using a hardcoded `provider_prefix_map`.
3. **Cost tracking**: `litellm.completion_cost()` computed per request — no cached cost data on the model record.
4. **Capability checks**: Only `supports_prompt_caching()` is checked, inline in `agent.py` validate and `litellm.py` run/run_stream. No other capability metadata exists.
5. **No discovery**: Models are created manually. No sync from provider APIs or LiteLLM's model registry.

### Agent Settings (`huf/huf/doctype/agent_settings/`)

**Current fields:** `default_provider` (Link → AI Provider), `default_model` (Link → AI Model). Singleton.

---

## 2. Target Schema

### 2.1 AI Provider — New/Changed Fields

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `provider_name` | Data (unique) | **Keep** | Rename display usage to `display_name` semantics but field stays |
| `provider_key` | Data (unique) | **Add** | LiteLLM provider key: `openai`, `anthropic`, `vertex_ai`, etc. Replaces the role of `chef` and the hardcoded `provider_prefix_map` |
| `display_name` | Data | **Add** | Human-readable: "OpenAI", "Anthropic", "Google Vertex AI" |
| `provider_type` | Select | **Add** | `cloud` \| `aggregator` \| `local`. Replaces `is_local_llm` boolean |
| `is_active` | Check | **Add** | Soft-disable a provider without deleting |
| `supports_discovery` | Check | **Add** | Whether this provider exposes a model listing API |
| `discovery_endpoint` | Data | **Add** | Optional custom endpoint URL for model discovery |
| `notes` | Small Text | **Add** | Admin notes |
| `api_key` | Password | **Keep** | No change |
| `url` | Data | **Keep** | Repurpose: base URL for any provider (not just local) |
| `port` | Int | **Keep** | Still useful for local providers |
| `slug` | Data | **Remove** | Replaced by `provider_key` |
| `chef` | Data | **Remove** | Replaced by `provider_key` |
| `is_local_llm` | Check | **Remove** | Replaced by `provider_type = "local"` |

### 2.2 AI Model — New/Changed Fields

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `model_name` | Data (unique) | **Keep** | Remains the Frappe document name |
| `model_id` | Data | **Add** | Canonical LiteLLM name: `gpt-4.1`, `claude-3.7-sonnet` |
| `provider` | Link → AI Provider | **Keep** | No change |
| `provider_model_id` | Data | **Add** | Raw provider-specific ID if different from `model_id` |
| `display_name` | Data | **Add** | User-friendly label |
| `description` | Small Text | **Add** | Model description / notes |
| `supports_chat` | Check | **Add** | Capability flag |
| `supports_vision` | Check | **Add** | Capability flag |
| `supports_audio` | Check | **Add** | Capability flag |
| `supports_tools` | Check | **Add** | Capability flag — replaces runtime tool/json conflict detection |
| `supports_json` | Check | **Add** | Capability flag |
| `supports_streaming` | Check | **Add** | Capability flag |
| `context_window` | Int | **Add** | Max context tokens (from LiteLLM enrichment) |
| `max_output_tokens` | Int | **Add** | Max output tokens |
| `input_cost_per_1k` | Currency | **Add** | Cost per 1K input tokens |
| `output_cost_per_1k` | Currency | **Add** | Cost per 1K output tokens |
| `status` | Select | **Add** | `ACTIVE` \| `HIDDEN` \| `DEPRECATED` \| `BROKEN` |
| `is_default` | Check | **Add** | Mark one model as default per provider or globally |
| `last_seen_at` | Datetime | **Add** | Last time model appeared in provider API response |
| `last_synced_at` | Datetime | **Add** | Last time sync job touched this record |
| `source` | Select | **Add** | `provider_api` \| `litellm` \| `manual` |
| `raw_metadata` | JSON | **Add** | Store full raw response from provider/LiteLLM for debugging |

### 2.3 AI Model Capability (Optional Child Table — New DocType)

If the boolean explosion on AI Model becomes unwieldy, extract to a child table:

| Field | Type | Notes |
|-------|------|-------|
| `capability` | Select | `vision` \| `tools` \| `json` \| `audio` \| `embeddings` \| `image_gen` |
| `notes` | Data | Optional annotation |

**Recommendation**: Start with inline booleans (simpler queries, Frappe list filters work natively). Migrate to child table only if the capability list grows past ~10 items.

### 2.4 Agent Settings — Changes

| Field | Action | Notes |
|-------|--------|-------|
| `default_provider` | **Keep** | No change |
| `default_model` | **Keep** | No change |
| `auto_sync_models` | **Add** | Check — enable/disable periodic model sync |
| `sync_interval` | **Add** | Select — `Daily` \| `Weekly` \| `Manual Only` |
| `last_sync_at` | **Add** | Datetime — last global sync timestamp |

---

## 3. Files to Change

### 3.1 DocType Schema Files (JSON)

| File | Action | Details |
|------|--------|---------|
| `huf/huf/doctype/ai_provider/ai_provider.json` | **Modify** | Add `provider_key`, `display_name`, `provider_type`, `is_active`, `supports_discovery`, `discovery_endpoint`, `notes`. Remove `slug`, `chef`, `is_local_llm` |
| `huf/huf/doctype/ai_model/ai_model.json` | **Modify** | Add all new fields from §2.2 (identity, display, capabilities, limits/cost, lifecycle, system) |
| `huf/huf/doctype/agent_settings/agent_settings.json` | **Modify** | Add `auto_sync_models`, `sync_interval`, `last_sync_at` |
| `huf/huf/doctype/ai_model_capability/` | **Add** (optional) | New child table DocType if capability extraction is desired |

### 3.2 DocType Controllers (Python)

| File | Action | Details |
|------|--------|---------|
| `huf/huf/doctype/ai_provider/ai_provider.py` | **Modify** | Add `validate()`: ensure `provider_key` is lowercase/slugified, validate `provider_type` vs `url`/`port`. Update `get_provider_settings()` if needed |
| `huf/huf/doctype/ai_model/ai_model.py` | **Modify** | Add `validate()`: ensure `model_id` is set (default from `model_name`), validate `status` transitions. Add `before_save()`: auto-populate `display_name` from `model_id` if empty |
| `huf/huf/doctype/agent_settings/agent_settings.py` | **Modify** | Add `validate()` for sync settings |

### 3.3 DocType Client Scripts (JS)

| File | Action | Details |
|------|--------|---------|
| `huf/huf/doctype/ai_provider/ai_provider.js` | **Modify** | Add "Sync Models" button that calls the discovery API. Update "Provider Settings" logic. Show/hide `url`/`port` based on `provider_type` instead of `is_local_llm` |
| `huf/huf/doctype/ai_model/ai_model.js` | **Modify** | Add status indicator, capability display, cost info display. Possibly add "Refresh from Provider" button |
| `huf/huf/doctype/agent_settings/agent_settings.js` | **Add/Modify** | Add "Sync All Models Now" button |

### 3.4 Dashboard Files

| File | Action | Details |
|------|--------|---------|
| `huf/huf/doctype/ai_provider/ai_provider_dashboard.py` | **Review** | May need update if field names change |
| `huf/huf/doctype/ai_model/ai_model_dashboard.py` | **Review** | May need update |

### 3.5 New Backend Module: Model Discovery

| File | Action | Details |
|------|--------|---------|
| `huf/ai/model_discovery.py` | **Add** | Core discovery logic |

This module needs:

```
sync_models_for_provider(provider_name)
    → Calls provider discovery API or LiteLLM model list
    → Upserts AI Model documents
    → Updates capabilities, cost, limits
    → Sets last_seen_at, last_synced_at

sync_all_providers()
    → Iterates active providers with supports_discovery=True
    → Calls sync_models_for_provider for each

enrich_model_from_litellm(model_doc)
    → Uses litellm.model_cost / litellm.get_model_info()
    → Fills context_window, max_output_tokens, cost fields
    → Sets capability flags (supports_tools, supports_vision, etc.)

resolve_model_status(model_doc)
    → Checks if model is still available
    → Updates status: ACTIVE → DEPRECATED → BROKEN
    → Checks last_seen_at staleness

get_active_models(provider=None, capability=None)
    → Query helper: returns only status=ACTIVE models
    → Optional filters by provider, capability flags
```

**Whitelisted API endpoints** (for frontend and Agent form):

```python
@frappe.whitelist()
def sync_provider_models(provider_name):
    """Trigger model sync for a specific provider."""

@frappe.whitelist()
def sync_all_models():
    """Trigger model sync for all active providers."""

@frappe.whitelist()
def get_model_info(model_name):
    """Return enriched model info for UI display."""
```

### 3.6 Scheduler Integration

| File | Action | Details |
|------|--------|---------|
| `huf/hooks.py` | **Modify** | Add scheduler entry for periodic model sync (e.g., `daily` or configurable via Agent Settings) |
| `huf/ai/model_discovery.py` | (see above) | `sync_all_providers()` is the scheduler target |

Example hooks.py addition:
```python
scheduler_events = {
    ...existing...,
    "daily": [
        "huf.ai.model_discovery.scheduled_sync"
    ]
}
```

### 3.7 LiteLLM Provider — Model Resolution Refactor

| File | Action | Details |
|------|--------|---------|
| `huf/ai/providers/litellm.py` | **Modify** | Major changes to `_normalize_model_name()` and capability handling |

**Changes needed:**

1. **`_normalize_model_name(model, provider)`** — Replace hardcoded `provider_prefix_map` with a lookup against `AI Provider.provider_key`:
   ```python
   def _normalize_model_name(model: str, provider: str) -> str:
       if "/" in model:
           return model
       # Look up provider_key from AI Provider DocType
       provider_key = frappe.db.get_value("AI Provider", provider, "provider_key")
       if not provider_key:
           provider_key = provider.lower()
       return f"{provider_key}/{model}"
   ```

2. **`_setup_api_key()`** — Replace hardcoded `env_var_providers` dict with a lookup or convention based on `provider_key`. Consider storing the env var name on the AI Provider DocType, or using a convention like `{PROVIDER_KEY.upper()}_API_KEY`.

3. **Capability-aware tool handling** — Replace the `_L1_CAPABILITY_CACHE` / runtime conflict detection with a pre-check against `AI Model.supports_tools` and `AI Model.supports_json`:
   ```python
   model_doc = frappe.get_cached_doc("AI Model", model)
   if tools and not model_doc.supports_tools:
       tools = None  # Strip tools for models that don't support them
   ```

4. **Cost tracking** — After `completion_cost()` call, optionally cross-reference with `AI Model.input_cost_per_1k` / `output_cost_per_1k` for fallback or validation.

### 3.8 Run Provider Router

| File | Action | Details |
|------|--------|---------|
| `huf/ai/run.py` | **Modify** | Minor — may want to check `AI Provider.is_active` before routing. Add model status check (reject `BROKEN`/`DEPRECATED` models with a warning) |

### 3.9 Agent Integration

| File | Action | Details |
|------|--------|---------|
| `huf/ai/agent_integration.py` | **Modify** | Update model/provider resolution to use new fields. Use `model_id` for LiteLLM calls instead of `model_name` if `model_id` is set. Populate `AI Model.model_id` into the run context |

### 3.10 Agent DocType

| File | Action | Details |
|------|--------|---------|
| `huf/huf/doctype/agent/agent.py` | **Modify** | Update prompt caching validation to use `AI Provider.provider_key` instead of `chef`. Use `AI Model.model_id` for the LiteLLM model name. Could also validate that selected model's `status` is `ACTIVE` |
| `huf/huf/doctype/agent/agent.js` | **Modify** | Update model query filter to include `status = 'ACTIVE'` so deprecated/broken models don't appear in dropdowns. Optionally show model capabilities (context window, cost) in the selection UI |

### 3.11 Frontend — Service Layer

| File | Action | Details |
|------|--------|---------|
| `frontend/src/services/providerApi.ts` | **Modify** | Update `getModels()` to fetch new fields (`model_id`, `display_name`, `status`, `supports_*`, `context_window`, `input_cost_per_1k`, etc.). Add `status = 'ACTIVE'` filter by default. Add `syncProviderModels(providerName)` and `syncAllModels()` API calls |
| `frontend/src/types/agent.types.ts` | **Modify** | Expand `AIProvider` type with `provider_key`, `provider_type`, `is_active`, `supports_discovery`. Expand `AIModel` type with all new fields |

### 3.12 Frontend — Components

| File | Action | Details |
|------|--------|---------|
| `frontend/src/components/ai-elements/model-selector.tsx` | **Modify** | Display richer model info: `display_name`, capability badges (vision, tools, streaming), context window, cost per 1K tokens. Group by provider. Show status indicator. Use `model_id` or `display_name` as display text |

### 3.13 Data Migration

| File | Action | Details |
|------|--------|---------|
| `huf/patches/` or `huf/install.py` | **Add** | Migration patch to populate new fields from existing data |

Migration steps:
1. **AI Provider**: Copy `chef` → `provider_key` (lowercase), set `display_name` = `provider_name`, set `provider_type` = `"local"` if `is_local_llm == 1` else `"cloud"`, set `is_active = 1` for all existing
2. **AI Model**: Set `model_id` = `model_name`, set `status` = `"ACTIVE"`, set `source` = `"manual"` for all existing models
3. Run initial enrichment from LiteLLM for all existing models (populate capabilities, cost, context window)

---

## 4. Discovery Data Sources

### 4.1 LiteLLM Model Registry

LiteLLM maintains a comprehensive model cost/info dictionary:

```python
import litellm

# Get all known model info
litellm.model_cost  # dict of model → {max_tokens, input_cost_per_token, output_cost_per_token, ...}

# Get specific model info
litellm.get_model_info("gpt-4.1")
# Returns: {max_tokens, max_input_tokens, max_output_tokens, input_cost_per_token,
#           output_cost_per_token, supports_function_calling, supports_vision, ...}
```

This is the primary enrichment source — no API calls needed, just reads LiteLLM's bundled data.

### 4.2 Provider APIs (for discovery)

| Provider | Discovery API | Notes |
|----------|--------------|-------|
| OpenAI | `GET /v1/models` | Returns list of available models |
| Anthropic | None (hardcoded in docs) | Use LiteLLM registry instead |
| Google / Vertex AI | `GET /v1beta/models` | Lists available Gemini models |
| OpenRouter | `GET /api/v1/models` | Lists all 500+ models with pricing |
| Mistral | `GET /v1/models` | Lists available models |
| Groq | `GET /openai/v1/models` | OpenAI-compatible endpoint |
| Together AI | `GET /v1/models` | Lists available models |
| Deepseek | None (hardcoded) | Use LiteLLM registry |

### 4.3 Sync Strategy

```
┌─────────────────────────────────────────────────────┐
│                  Sync Pipeline                       │
│                                                      │
│  1. Provider API Discovery (if supports_discovery)   │
│     → Fetches model IDs from provider's /models API  │
│     → Creates/updates AI Model documents             │
│     → Sets source = "provider_api"                   │
│     → Updates last_seen_at                           │
│                                                      │
│  2. LiteLLM Enrichment (always)                      │
│     → litellm.get_model_info(model_id)               │
│     → Fills: context_window, max_output_tokens       │
│     → Fills: input_cost_per_1k, output_cost_per_1k   │
│     → Fills: capability flags                        │
│     → Updates last_synced_at                         │
│                                                      │
│  3. Status Resolution (always)                       │
│     → Models not seen in N days → DEPRECATED         │
│     → Models that fail API calls → BROKEN            │
│     → New models → ACTIVE                            │
│                                                      │
│  4. UI / Agents query only status = ACTIVE           │
└─────────────────────────────────────────────────────┘
```

---

## 5. Indexing Requirements

Add database indexes for query performance:

| Index | Fields | Rationale |
|-------|--------|-----------|
| Unique | `(provider, model_id)` | Prevent duplicate models per provider |
| Index | `status` | Filter active models in dropdowns |
| Index | `is_default` | Quick lookup of default model |
| Index | `supports_tools` | Filter tool-capable models |

In Frappe, unique constraints go in the JSON schema (`unique: 1`), and additional indexes can be added via `after_install` hooks or custom SQL.

---

## 6. Query Flow After Implementation

```
Agent Form Load
  └─ User selects Provider
      └─ frm.set_query("model", { provider: X, status: "ACTIVE" })
          └─ Returns models with display_name, capability badges, cost info
              └─ User selects Model
                  └─ Agent form shows: context_window, cost, capabilities

Agent Execution
  └─ agent_integration.py reads agent.model
      └─ Gets AI Model doc → model_id (canonical LiteLLM name)
          └─ Gets AI Provider doc → provider_key
              └─ Builds LiteLLM model string: "{provider_key}/{model_id}"
                  └─ No hardcoded prefix map needed
```

---

## 7. Implementation Order

### Phase 1: Schema & Migration (Foundation)
1. Update `ai_provider.json` — add new fields
2. Update `ai_model.json` — add all new fields
3. Update `agent_settings.json` — add sync settings
4. Write migration patch to populate existing data
5. Update AI Provider controller (`ai_provider.py`) with validation
6. Update AI Model controller (`ai_model.py`) with validation

### Phase 2: Discovery Engine (Core)
7. Create `huf/ai/model_discovery.py` — sync, enrichment, and resolution logic
8. Add whitelisted API endpoints for frontend
9. Add scheduler hook in `hooks.py`
10. Update AI Provider JS — "Sync Models" button
11. Update Agent Settings JS — "Sync All" button

### Phase 3: Provider Refactor (Integration)
12. Refactor `_normalize_model_name()` in `litellm.py` — use `provider_key`
13. Refactor `_setup_api_key()` — use `provider_key`
14. Replace `_L1_CAPABILITY_CACHE` with model doc capability checks
15. Update `run.py` — add `is_active` and `status` guards
16. Update `agent_integration.py` — use `model_id` for LiteLLM calls
17. Update `agent.py` — use `provider_key` for caching validation, filter by `status`

### Phase 4: Frontend (UX)
18. Update `agent.types.ts` — expand `AIProvider` and `AIModel` types
19. Update `providerApi.ts` — fetch new fields, add sync API calls
20. Update `model-selector.tsx` — richer model display with capabilities, cost, status
21. Update `agent.js` — filter by `status = ACTIVE` in model dropdown

### Phase 5: Cleanup
22. Remove `chef` and `slug` fields from AI Provider (after migration confirmed)
23. Remove hardcoded `provider_prefix_map` from `litellm.py`
24. Remove hardcoded `env_var_providers` if replaced by convention
25. Clean up `_L1_CAPABILITY_CACHE` if fully replaced by model doc checks

---

## 8. Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Inline capability booleans over child table | Simpler queries, native Frappe list filters, fewer DB joins. Migrate later if needed |
| `provider_key` as the single source of truth for LiteLLM prefix | Eliminates all hardcoded maps, makes new providers zero-code |
| `model_id` separate from `model_name` (Frappe doc name) | Frappe names have constraints; `model_id` can match LiteLLM exactly |
| LiteLLM as primary enrichment source | No API calls needed for cost/capability data; provider APIs only for discovery |
| Status-based lifecycle | Clean deprecation path; UI and agents never see stale models |
| `source` field on AI Model | Distinguishes auto-discovered from manually created; protects manual entries from sync overwrites |

---

## 9. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| LiteLLM model_cost data could be stale | `last_synced_at` field + periodic re-sync; allow manual override |
| Provider discovery APIs have different response formats | Abstract behind per-provider discovery adapters in `model_discovery.py` |
| Removing `chef`/`slug` breaks existing Agent validation | Migration patch runs first; `provider_key` populated before old fields removed |
| Large number of models from OpenRouter (500+) | Filter by popularity or allow admin to select which to import; `HIDDEN` status for bulk-imported models |
| Breaking existing Agent configurations | `model_id` defaults to `model_name` via migration; existing references continue to work |
