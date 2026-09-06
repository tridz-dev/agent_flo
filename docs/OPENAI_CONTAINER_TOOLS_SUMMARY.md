# OpenAI Container Tools - Implementation Summary

## Executive Summary

This document provides a concise summary of the plan to implement OpenAI Code Interpreter container management as tools accessible to OpenAI agents in Huf.

## Problem Statement

OpenAI provides container management APIs for Code Interpreter sessions, but Huf currently has no mechanism for:
1. Model-specific tool availability
2. Automatic tool injection based on provider capabilities
3. Provider-specific tool patterns

## Proposed Solution

**Automatic Tool Injection Pattern**: Automatically inject container management tools for agents using OpenAI provider.

### Key Design Decisions

1. **Automatic Injection** (vs manual configuration)
   - Tools automatically available for OpenAI agents
   - No manual setup required
   - Clean and seamless user experience

2. **Provider-Based Filtering** (vs model-based)
   - Check provider name, not specific model
   - Works with all OpenAI models (gpt-4, gpt-4-turbo, etc.)
   - Simpler implementation

3. **LiteLLM Integration** (vs direct OpenAI SDK)
   - Consistent with existing architecture
   - Leverages existing API key management
   - Unified error handling

## Architecture

```
Agent (OpenAI Provider)
    ↓
AgentManager.create_agent()
    ↓
create_agent_tools() [Checks provider]
    ↓
If OpenAI → Inject Container Tools
    ↓
Tool Serialization → LiteLLM → OpenAI API
```

## Implementation Components

### 1. Core Functions (`huf/ai/container_tools.py`)
- `create_container()` - Create new container
- `list_containers()` - List all containers
- `retrieve_container()` - Get container details
- `delete_container()` - Delete container

### 2. SDK Integration (`huf/ai/sdk_tools.py`)
- `create_container_tools()` - Create FunctionTool objects
- `handle_create_container()` - Tool execution handler
- Provider check in `create_agent_tools()`

### 3. Tool Schemas
- JSON schemas for each tool
- Parameter validation
- Error handling

## Benefits

1. **User Experience**: Tools automatically available, no configuration needed
2. **Extensibility**: Pattern can be reused for other provider-specific tools
3. **Consistency**: Follows existing tool patterns and architecture
4. **Maintainability**: Clean separation of concerns

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Tools appear but don't work for non-OpenAI | Provider check before injection |
| API errors not handled properly | Comprehensive error handling |
| Performance impact | Async operations, efficient API calls |
| Breaking changes | Backward compatible, no schema changes |

## Next Steps

1. **Review & Approval**: Get feedback on design approach
2. **Implementation**: Start with core container functions
3. **Testing**: Unit tests + integration tests
4. **Documentation**: Update user docs and API docs
5. **Deployment**: Roll out incrementally

## Alternative Approaches Considered

### Option B: Manual Tool Configuration
- **Pros**: Explicit control, can disable
- **Cons**: Requires manual setup, less seamless
- **Decision**: Rejected - automatic is better UX

### Option C: Provider Restrictions in DocType
- **Pros**: Flexible, reusable pattern
- **Cons**: Overkill, requires schema changes
- **Decision**: Rejected - too complex for this use case

## Questions for Discussion

1. Should we add a UI toggle to disable automatic tool injection?
2. Do we need container usage analytics/tracking?
3. Should we support container expiration notifications?
4. Future: Extend pattern for other provider-specific tools?

## References

- [Full Implementation Plan](./OPENAI_CONTAINER_TOOLS_PLAN.md)
- [LiteLLM Container Docs](https://docs.litellm.ai/docs/containers)
- [OpenAI Container API](https://platform.openai.com/docs/api-reference/containers)
