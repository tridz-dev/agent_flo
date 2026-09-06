# OpenAI Container Management Tools - Implementation Plan

## Overview

This document outlines the plan for implementing OpenAI Code Interpreter container management tools as model-specific tools accessible to OpenAI agents in Huf.

## Current Architecture

### Tool System Flow
1. **Tool Definition**: Tools are defined in `Agent Tool Function` DocType
2. **Tool Creation**: `create_agent_tools()` in `sdk_tools.py` creates `FunctionTool` objects
3. **Tool Serialization**: `serialize_tools()` converts tools to provider-compatible format
4. **Tool Execution**: Tools are executed via `on_invoke_tool` handlers
5. **Provider Integration**: LiteLLM handles API calls and tool calling

### Current Limitations
- No model-specific tool filtering
- All tools are available to all agents regardless of provider/model
- No automatic tool injection based on provider capabilities

## Requirements

### Functional Requirements
1. **Container Management Operations**:
   - Create container (`create_container`)
   - List containers (`list_containers`)
   - Retrieve container (`retrieve_container`)
   - Delete container (`delete_container`)

2. **Provider/Model Restrictions**:
   - Only available for OpenAI provider
   - Should work with any OpenAI model (gpt-4, gpt-4-turbo, etc.)
   - Should be automatically available (no manual configuration needed)

3. **Integration Points**:
   - Use LiteLLM's container management APIs
   - Access API key from `AI Provider` DocType
   - Support async operations
   - Proper error handling and logging

### Technical Requirements
- Maintain backward compatibility
- Follow existing tool patterns
- Use LiteLLM for API calls (consistent with current architecture)
- Support both sync and async execution
- Proper error handling and user feedback

## Design Options

### Option A: Automatic Tool Injection (Recommended)
**Approach**: Automatically inject container tools in `create_agent_tools()` when provider is OpenAI.

**Pros**:
- No manual configuration needed
- Clean separation of concerns
- Easy to extend for other provider-specific tools
- Follows existing patterns

**Cons**:
- Tools always available (but only work with OpenAI anyway)
- Need to check provider before execution

**Implementation**:
- Add provider check in `create_agent_tools()`
- Create container tool functions in new module `huf/ai/container_tools.py`
- Inject tools automatically for OpenAI agents

### Option B: New Tool Type with Provider Filtering
**Approach**: Add new tool type "OpenAI Container" with provider/model restrictions.

**Pros**:
- Explicit configuration
- Can be disabled if needed
- Clear intent in UI

**Cons**:
- Requires manual configuration
- More complex DocType changes
- Not as seamless

### Option C: Conditional Tool Availability
**Approach**: Add provider/model restrictions to existing tool system.

**Pros**:
- Flexible for future use cases
- Can filter any tool by provider/model

**Cons**:
- Requires schema changes
- More complex implementation
- Overkill for this use case

## Recommended Solution: Option A

We'll implement **Option A** - automatic tool injection for OpenAI agents.

## Implementation Plan

### Phase 1: Core Container Tool Functions

#### 1.1 Create Container Tools Module
**File**: `huf/ai/container_tools.py`

**Functions to implement**:
- `create_container(name, expires_after=None, file_ids=None)`
- `list_containers(limit=20, order="desc", after=None)`
- `retrieve_container(container_id)`
- `delete_container(container_id)`

**Implementation details**:
- Use LiteLLM's container management APIs
- Access API key from `AI Provider` DocType via context
- Return standardized response format
- Handle errors gracefully

#### 1.2 SDK Tool Handlers
**File**: `huf/ai/sdk_tools.py`

**Add handlers**:
- `handle_create_container(...)`
- `handle_list_containers(...)`
- `handle_retrieve_container(...)`
- `handle_delete_container(...)`

**Pattern**: Follow existing handler patterns (e.g., `handle_get_document`)

### Phase 2: Tool Injection Logic

#### 2.1 Provider Detection
**File**: `huf/ai/sdk_tools.py` - `create_agent_tools()`

**Changes**:
- Check if provider is OpenAI
- If yes, inject container tools automatically
- Use provider name from `agent_doc.provider` (Link field)

**Code structure**:
```python
def create_agent_tools(agent) -> list[FunctionTool]:
    tools = []
    
    # Existing tool creation logic...
    
    # Inject OpenAI container tools if provider is OpenAI
    provider_doc = frappe.get_doc("AI Provider", agent.provider)
    if provider_doc.provide_name.lower() == "openai":
        container_tools = create_container_tools()
        tools.extend(container_tools)
    
    return tools
```

#### 2.2 Container Tool Creation
**File**: `huf/ai/sdk_tools.py`

**Function**: `create_container_tools() -> list[FunctionTool]`

**Creates 4 tools**:
1. `create_container` - Create a new container
2. `list_containers` - List all containers
3. `retrieve_container` - Get container details
4. `delete_container` - Delete a container

### Phase 3: LiteLLM Integration

#### 3.1 Container API Functions
**File**: `huf/ai/container_tools.py`

**Use LiteLLM functions**:
- `litellm.create_container()` / `litellm.acreate_container()`
- `litellm.list_containers()` / `litellm.alist_containers()`
- `litellm.retrieve_container()` / `litellm.aretrieve_container()`
- `litellm.delete_container()` / `litellm.adelete_container()`

**API Key Management**:
- Get from `AI Provider` DocType
- Pass via `custom_llm_provider="openai"` parameter
- Handle environment variable setup if needed

#### 3.2 Error Handling
- Handle API errors gracefully
- Return user-friendly error messages
- Log errors for debugging
- Validate inputs before API calls

### Phase 4: Tool Schema Definitions

#### 4.1 Parameter Schemas
Each tool needs proper JSON schema:

**create_container**:
```json
{
  "type": "object",
  "properties": {
    "name": {"type": "string", "description": "Name of the container"},
    "expires_after": {
      "type": "object",
      "properties": {
        "anchor": {"type": "string", "enum": ["last_active_at"]},
        "minutes": {"type": "integer"}
      }
    },
    "file_ids": {
      "type": "array",
      "items": {"type": "string"},
      "description": "List of file IDs to include"
    }
  },
  "required": ["name"]
}
```

**list_containers**:
```json
{
  "type": "object",
  "properties": {
    "limit": {"type": "integer", "default": 20},
    "order": {"type": "string", "enum": ["asc", "desc"], "default": "desc"},
    "after": {"type": "string", "description": "Cursor for pagination"}
  }
}
```

**retrieve_container**:
```json
{
  "type": "object",
  "properties": {
    "container_id": {"type": "string", "description": "Container ID"}
  },
  "required": ["container_id"]
}
```

**delete_container**:
```json
{
  "type": "object",
  "properties": {
    "container_id": {"type": "string", "description": "Container ID"}
  },
  "required": ["container_id"]
}
```

## File Structure

```
huf/ai/
├── container_tools.py          # NEW: Core container management functions
├── sdk_tools.py                # MODIFY: Add container tool injection
└── providers/
    └── litellm.py              # (No changes needed - uses existing LiteLLM integration)
```

## Implementation Details

### Container Tools Module (`container_tools.py`)

```python
"""
OpenAI Container Management Tools

Provides functions for managing OpenAI Code Interpreter containers.
These tools are automatically available to agents using OpenAI provider.
"""

import frappe
import litellm
from typing import Optional, Dict, List, Any


def create_container(
    name: str,
    expires_after: Optional[Dict[str, Any]] = None,
    file_ids: Optional[List[str]] = None,
    provider_name: str = "openai"
) -> Dict[str, Any]:
    """
    Create a new OpenAI Code Interpreter container.
    
    Args:
        name: Container name
        expires_after: Expiration settings (anchor, minutes)
        file_ids: List of file IDs to include
        provider_name: Provider name (for API key lookup)
    
    Returns:
        Dict with container details or error
    """
    # Implementation here
    pass


def list_containers(
    limit: int = 20,
    order: str = "desc",
    after: Optional[str] = None,
    provider_name: str = "openai"
) -> Dict[str, Any]:
    """
    List OpenAI Code Interpreter containers.
    
    Args:
        limit: Maximum number of containers to return
        order: Sort order ("asc" or "desc")
        after: Cursor for pagination
        provider_name: Provider name (for API key lookup)
    
    Returns:
        Dict with list of containers or error
    """
    # Implementation here
    pass


def retrieve_container(
    container_id: str,
    provider_name: str = "openai"
) -> Dict[str, Any]:
    """
    Retrieve details of a specific container.
    
    Args:
        container_id: Container ID
        provider_name: Provider name (for API key lookup)
    
    Returns:
        Dict with container details or error
    """
    # Implementation here
    pass


def delete_container(
    container_id: str,
    provider_name: str = "openai"
) -> Dict[str, Any]:
    """
    Delete a container.
    
    Args:
        container_id: Container ID
        provider_name: Provider name (for API key lookup)
    
    Returns:
        Dict with deletion result or error
    """
    # Implementation here
    pass
```

### SDK Tool Handlers (`sdk_tools.py`)

```python
def handle_create_container(name: str, expires_after: dict = None, file_ids: list = None, **kwargs):
    """Handler for create_container tool"""
    from huf.ai.container_tools import create_container
    
    # Get provider from context or agent
    provider_name = kwargs.get("provider_name", "openai")
    
    try:
        result = create_container(
            name=name,
            expires_after=expires_after,
            file_ids=file_ids,
            provider_name=provider_name
        )
        return {"success": True, "result": result}
    except Exception as e:
        return {"success": False, "error": str(e)}


def create_container_tools(provider_name: str = "openai") -> list[FunctionTool]:
    """
    Create container management tools for OpenAI agents.
    
    Args:
        provider_name: Provider name (for API key lookup)
    
    Returns:
        List of FunctionTool objects
    """
    tools = []
    
    # Create container tool
    create_tool = create_function_tool(
        name="create_container",
        description="Create a new OpenAI Code Interpreter container for executing code in isolated environments",
        tool_name="huf.ai.sdk_tools.handle_create_container",
        parameters={
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name of the container"
                },
                "expires_after": {
                    "type": "object",
                    "properties": {
                        "anchor": {
                            "type": "string",
                            "enum": ["last_active_at"],
                            "description": "Anchor point for expiration"
                        },
                        "minutes": {
                            "type": "integer",
                            "description": "Minutes until expiration from anchor"
                        }
                    }
                },
                "file_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of file IDs to include in the container"
                }
            },
            "required": ["name"]
        },
        extra_args={"provider_name": provider_name}
    )
    
    # Similar for list, retrieve, delete...
    
    return tools
```

## Testing Strategy

### Unit Tests
- Test container creation with various parameters
- Test container listing with pagination
- Test container retrieval
- Test container deletion
- Test error handling (invalid IDs, API errors)

### Integration Tests
- Test tool injection for OpenAI agents
- Test tool availability (should not appear for non-OpenAI agents)
- Test end-to-end container lifecycle
- Test with actual OpenAI API (if test credentials available)

### Edge Cases
- Missing API key
- Invalid container IDs
- Network errors
- Rate limiting
- Expired containers

## Future Enhancements

1. **Container Files Management**: Add tools for managing files within containers
2. **Code Execution**: Add tools for executing code in containers
3. **Other Provider-Specific Tools**: Extend pattern for other providers
4. **Tool Visibility Control**: Allow disabling automatic tool injection
5. **Container Monitoring**: Add tools for monitoring container status and usage

## Migration Notes

- No database migrations needed
- No breaking changes to existing tools
- Backward compatible with all existing agents
- New tools only appear for OpenAI agents automatically

## Documentation Updates

1. Update `AGENTS.md` with container tools documentation
2. Add examples of using container tools
3. Document provider-specific tool patterns
4. Update API documentation

## Timeline Estimate

- **Phase 1**: 2-3 hours (Core functions)
- **Phase 2**: 1-2 hours (Tool injection)
- **Phase 3**: 1-2 hours (LiteLLM integration)
- **Phase 4**: 1 hour (Schema definitions)
- **Testing**: 2-3 hours
- **Documentation**: 1 hour

**Total**: ~8-12 hours

## Open Questions

1. Should container tools be visible in the UI for non-OpenAI agents? (Probably not)
2. Should we add a toggle to disable automatic tool injection?
3. Do we need to track container usage/analytics?
4. Should we support container expiration notifications?
