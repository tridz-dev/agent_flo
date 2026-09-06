# OpenAI Container Tools - Code Examples

## Example Implementation Structure

### 1. Container Tools Module (`huf/ai/container_tools.py`)

```python
"""
OpenAI Container Management Tools

Provides functions for managing OpenAI Code Interpreter containers.
These tools are automatically available to agents using OpenAI provider.
"""

import frappe
import litellm
import os
from typing import Optional, Dict, List, Any


def _get_openai_api_key(provider_name: str) -> str:
    """Get OpenAI API key from AI Provider DocType"""
    try:
        provider_doc = frappe.get_doc("AI Provider", provider_name)
        api_key = provider_doc.get_password("api_key")
        if not api_key:
            frappe.throw("OpenAI API key not configured in AI Provider")
        return api_key
    except Exception as e:
        frappe.throw(f"Failed to get API key: {str(e)}")


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
        expires_after: Expiration settings {"anchor": "last_active_at", "minutes": 20}
        file_ids: List of file IDs to include
        provider_name: Provider name (for API key lookup)
    
    Returns:
        Dict with container details or error
    """
    try:
        api_key = _get_openai_api_key(provider_name)
        
        # Set API key for LiteLLM
        os.environ["OPENAI_API_KEY"] = api_key
        
        # Prepare parameters
        params = {
            "name": name,
            "custom_llm_provider": "openai"
        }
        
        if expires_after:
            params["expires_after"] = expires_after
        
        if file_ids:
            params["file_ids"] = file_ids
        
        # Create container using LiteLLM
        container = litellm.create_container(**params)
        
        return {
            "success": True,
            "container": {
                "id": container.id,
                "name": container.name,
                "status": getattr(container, "status", "active"),
                "created_at": getattr(container, "created_at", None),
                "expires_at": getattr(container, "expires_at", None)
            }
        }
    except Exception as e:
        frappe.log_error(f"Error creating container: {str(e)}", "Container Tools")
        return {
            "success": False,
            "error": str(e)
        }


def list_containers(
    limit: int = 20,
    order: str = "desc",
    after: Optional[str] = None,
    provider_name: str = "openai"
) -> Dict[str, Any]:
    """
    List OpenAI Code Interpreter containers.
    
    Args:
        limit: Maximum number of containers to return (1-100)
        order: Sort order ("asc" or "desc")
        after: Cursor for pagination
        provider_name: Provider name (for API key lookup)
    
    Returns:
        Dict with list of containers or error
    """
    try:
        api_key = _get_openai_api_key(provider_name)
        os.environ["OPENAI_API_KEY"] = api_key
        
        params = {
            "custom_llm_provider": "openai",
            "limit": min(max(limit, 1), 100),  # Clamp between 1-100
            "order": order
        }
        
        if after:
            params["after"] = after
        
        containers = litellm.list_containers(**params)
        
        return {
            "success": True,
            "containers": [
                {
                    "id": c.id,
                    "name": c.name,
                    "status": getattr(c, "status", None),
                    "created_at": getattr(c, "created_at", None)
                }
                for c in containers.data
            ],
            "has_more": getattr(containers, "has_more", False),
            "first_id": getattr(containers, "first_id", None),
            "last_id": getattr(containers, "last_id", None)
        }
    except Exception as e:
        frappe.log_error(f"Error listing containers: {str(e)}", "Container Tools")
        return {
            "success": False,
            "error": str(e)
        }


def retrieve_container(
    container_id: str,
    provider_name: str = "openai"
) -> Dict[str, Any]:
    """
    Retrieve details of a specific container.
    
    Args:
        container_id: Container ID (e.g., "cntr_123...")
        provider_name: Provider name (for API key lookup)
    
    Returns:
        Dict with container details or error
    """
    try:
        if not container_id:
            return {"success": False, "error": "container_id is required"}
        
        api_key = _get_openai_api_key(provider_name)
        os.environ["OPENAI_API_KEY"] = api_key
        
        container = litellm.retrieve_container(
            container_id=container_id,
            custom_llm_provider="openai"
        )
        
        return {
            "success": True,
            "container": {
                "id": container.id,
                "name": container.name,
                "status": getattr(container, "status", None),
                "created_at": getattr(container, "created_at", None),
                "last_active_at": getattr(container, "last_active_at", None),
                "expires_at": getattr(container, "expires_at", None),
                "file_ids": getattr(container, "file_ids", [])
            }
        }
    except Exception as e:
        frappe.log_error(f"Error retrieving container: {str(e)}", "Container Tools")
        return {
            "success": False,
            "error": str(e)
        }


def delete_container(
    container_id: str,
    provider_name: str = "openai"
) -> Dict[str, Any]:
    """
    Delete a container.
    
    Args:
        container_id: Container ID (e.g., "cntr_123...")
        provider_name: Provider name (for API key lookup)
    
    Returns:
        Dict with deletion result or error
    """
    try:
        if not container_id:
            return {"success": False, "error": "container_id is required"}
        
        api_key = _get_openai_api_key(provider_name)
        os.environ["OPENAI_API_KEY"] = api_key
        
        result = litellm.delete_container(
            container_id=container_id,
            custom_llm_provider="openai"
        )
        
        return {
            "success": True,
            "deleted": getattr(result, "deleted", False),
            "container_id": getattr(result, "id", container_id)
        }
    except Exception as e:
        frappe.log_error(f"Error deleting container: {str(e)}", "Container Tools")
        return {
            "success": False,
            "error": str(e)
        }
```

### 2. SDK Tool Handlers (`huf/ai/sdk_tools.py` - additions)

```python
# Add these handler functions

def handle_create_container(name: str, expires_after: dict = None, file_ids: list = None, **kwargs):
    """Handler for create_container tool"""
    from huf.ai.container_tools import create_container
    
    provider_name = kwargs.get("provider_name", "openai")
    
    try:
        result = create_container(
            name=name,
            expires_after=expires_after,
            file_ids=file_ids,
            provider_name=provider_name
        )
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def handle_list_containers(limit: int = 20, order: str = "desc", after: str = None, **kwargs):
    """Handler for list_containers tool"""
    from huf.ai.container_tools import list_containers
    
    provider_name = kwargs.get("provider_name", "openai")
    
    try:
        result = list_containers(
            limit=limit,
            order=order,
            after=after,
            provider_name=provider_name
        )
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def handle_retrieve_container(container_id: str, **kwargs):
    """Handler for retrieve_container tool"""
    from huf.ai.container_tools import retrieve_container
    
    provider_name = kwargs.get("provider_name", "openai")
    
    try:
        result = retrieve_container(
            container_id=container_id,
            provider_name=provider_name
        )
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def handle_delete_container(container_id: str, **kwargs):
    """Handler for delete_container tool"""
    from huf.ai.container_tools import delete_container
    
    provider_name = kwargs.get("provider_name", "openai")
    
    try:
        result = delete_container(
            container_id=container_id,
            provider_name=provider_name
        )
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def create_container_tools(provider_name: str = "openai") -> list[FunctionTool]:
    """
    Create container management tools for OpenAI agents.
    
    Returns:
        List of FunctionTool objects for container management
    """
    tools = []
    
    # Create container tool
    create_tool = create_function_tool(
        name="create_container",
        description="Create a new OpenAI Code Interpreter container for executing code in isolated environments. Containers provide isolated execution environments for code interpreter sessions.",
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
                            "description": "Anchor point for expiration (currently only 'last_active_at' is supported)"
                        },
                        "minutes": {
                            "type": "integer",
                            "description": "Minutes until expiration from anchor point"
                        }
                    },
                    "description": "Container expiration settings"
                },
                "file_ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "List of file IDs to include in the container"
                }
            },
            "required": ["name"],
            "additionalProperties": False
        },
        extra_args={"provider_name": provider_name}
    )
    
    if create_tool:
        tools.append(create_tool)
    
    # List containers tool
    list_tool = create_function_tool(
        name="list_containers",
        description="List OpenAI Code Interpreter containers. Returns a paginated list of containers with their status and metadata.",
        tool_name="huf.ai.sdk_tools.handle_list_containers",
        parameters={
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "Number of items to return (1-100, default: 20)",
                    "default": 20,
                    "minimum": 1,
                    "maximum": 100
                },
                "order": {
                    "type": "string",
                    "enum": ["asc", "desc"],
                    "description": "Sort order: 'asc' for oldest first, 'desc' for newest first",
                    "default": "desc"
                },
                "after": {
                    "type": "string",
                    "description": "Cursor for pagination (container ID from previous response)"
                }
            },
            "required": [],
            "additionalProperties": False
        },
        extra_args={"provider_name": provider_name}
    )
    
    if list_tool:
        tools.append(list_tool)
    
    # Retrieve container tool
    retrieve_tool = create_function_tool(
        name="retrieve_container",
        description="Retrieve details of a specific OpenAI Code Interpreter container including its status, creation time, and expiration settings.",
        tool_name="huf.ai.sdk_tools.handle_retrieve_container",
        parameters={
            "type": "object",
            "properties": {
                "container_id": {
                    "type": "string",
                    "description": "The ID of the container to retrieve (e.g., 'cntr_123...')"
                }
            },
            "required": ["container_id"],
            "additionalProperties": False
        },
        extra_args={"provider_name": provider_name}
    )
    
    if retrieve_tool:
        tools.append(retrieve_tool)
    
    # Delete container tool
    delete_tool = create_function_tool(
        name="delete_container",
        description="Delete an OpenAI Code Interpreter container. This permanently removes the container and all associated data.",
        tool_name="huf.ai.sdk_tools.handle_delete_container",
        parameters={
            "type": "object",
            "properties": {
                "container_id": {
                    "type": "string",
                    "description": "The ID of the container to delete (e.g., 'cntr_123...')"
                }
            },
            "required": ["container_id"],
            "additionalProperties": False
        },
        extra_args={"provider_name": provider_name}
    )
    
    if delete_tool:
        tools.append(delete_tool)
    
    return tools


# Modify create_agent_tools() to inject container tools

def create_agent_tools(agent) -> list[FunctionTool]:
    """
    Create function tools for Huf Agent
    """
    tools = []

    # Existing tool creation logic...
    if hasattr(agent, "agent_tool") and agent.agent_tool:
        for func in agent.agent_tool:
            # ... existing code ...
            pass

    # Inject OpenAI container tools if provider is OpenAI
    try:
        provider_doc = frappe.get_doc("AI Provider", agent.provider)
        provider_name = provider_doc.provide_name.lower() if hasattr(provider_doc, "provide_name") else ""
        
        if provider_name == "openai":
            container_tools = create_container_tools(provider_name=agent.provider)
            if container_tools:
                tools.extend(container_tools)
                frappe.logger().debug(f"Injected {len(container_tools)} container tools for OpenAI agent")
    except Exception as e:
        frappe.log_error(
            f"Error injecting container tools: {str(e)}",
            "Container Tools Injection"
        )

    return tools
```

## Usage Examples

### Example 1: Agent Creating a Container

**User Prompt**: "Create a new code interpreter container called 'Data Analysis Session'"

**Agent Response**: 
```json
{
  "success": true,
  "container": {
    "id": "cntr_6901d28b3c8881908b702815828a5bde0380b3408aeae8c7",
    "name": "Data Analysis Session",
    "status": "active",
    "created_at": 1234567890,
    "expires_at": null
  }
}
```

### Example 2: Agent Listing Containers

**User Prompt**: "Show me all my code interpreter containers"

**Agent Response**:
```json
{
  "success": true,
  "containers": [
    {
      "id": "cntr_123...",
      "name": "Data Analysis Session",
      "status": "active",
      "created_at": 1234567890
    },
    {
      "id": "cntr_456...",
      "name": "Python Script Runner",
      "status": "active",
      "created_at": 1234567880
    }
  ],
  "has_more": false
}
```

### Example 3: Agent Retrieving Container Details

**User Prompt**: "Get details for container cntr_123..."

**Agent Response**:
```json
{
  "success": true,
  "container": {
    "id": "cntr_123...",
    "name": "Data Analysis Session",
    "status": "active",
    "created_at": 1234567890,
    "last_active_at": 1234567900,
    "expires_at": 1234569090,
    "file_ids": ["file-abc123", "file-def456"]
  }
}
```

## Testing Examples

### Unit Test Example

```python
def test_create_container():
    """Test container creation"""
    result = create_container(
        name="Test Container",
        expires_after={"anchor": "last_active_at", "minutes": 20},
        provider_name="OpenAI"
    )
    
    assert result["success"] == True
    assert "container" in result
    assert "id" in result["container"]


def test_list_containers():
    """Test container listing"""
    result = list_containers(limit=10, order="desc", provider_name="OpenAI")
    
    assert result["success"] == True
    assert "containers" in result
    assert isinstance(result["containers"], list)
```

## Error Handling Examples

### Missing API Key
```json
{
  "success": false,
  "error": "OpenAI API key not configured in AI Provider"
}
```

### Invalid Container ID
```json
{
  "success": false,
  "error": "Container 'invalid_id' not found"
}
```

### Rate Limit Error
```json
{
  "success": false,
  "error": "Rate limit exceeded. Please try again later."
}
```
