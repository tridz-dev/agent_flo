# AI Elements Usage in HUF Frontend

This document explains how the AI Elements library is implemented and wired up in the HUF (formerly AgentFlo) React frontend.

## Overview

**Important**: HUF uses a **custom implementation** of AI Elements components, NOT the official `@anthropic-ai/ai-elements` or Vercel's `ai-elements` library. The components are inspired by similar UI patterns from the [AI SDK Elements](https://elements.ai-sdk.dev) library but are built from scratch.

## Dependencies

The frontend uses these key dependencies for AI rendering:

```json
{
  "ai": "^5.0.106",           // Vercel AI SDK - provides types like UIMessage, FileUIPart, ToolUIPart
  "streamdown": "^1.5.1",     // Markdown rendering optimized for AI streaming
  "shiki": "^3.19.0"          // Syntax highlighting for code blocks
}
```

## Component Architecture

### Directory Structure

All custom AI Elements are located in:
```
frontend/src/components/ai-elements/
├── message.tsx              # Message container and response rendering
├── tool.tsx                 # Tool execution display
├── image.tsx                # Generated image display
├── code-block.tsx           # Syntax-highlighted code
├── conversation.tsx         # Scrollable conversation container
├── prompt-input.tsx         # Input with attachments
├── reasoning.tsx            # Thinking/reasoning display
├── sources.tsx              # Citation display
├── artifact.tsx             # Artifact container (UI-only)
├── web-preview.tsx          # Web preview iframe (UI-only)
└── ... (30+ component files)
```

### Types

Type definitions are located in `frontend/src/components/ai-elements/types.ts`:
```typescript
export type ExtendedToolState =
  | ToolUIPart["state"]        // from "ai" package: input-streaming, input-available, output-available, output-error
  | "approval-requested"
  | "approval-responded"
  | "output-denied";
```

## How Components Work

### 1. Markdown Rendering (WORKS)

**Component**: `MessageResponse` in `message.tsx:309-322`

Uses the `streamdown` library which handles:
- GitHub Flavored Markdown (tables, task lists, strikethrough)
- Code blocks with syntax highlighting via Shiki
- Basic text formatting (bold, italic, links, etc.)

```tsx
import { Streamdown } from "streamdown";

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);
```

**Why it works**: Streamdown automatically parses markdown in the AI response text and renders it appropriately.

### 2. Code Blocks (WORKS)

**Component**: `CodeBlock` in `code-block.tsx`

Uses Shiki for syntax highlighting with light/dark theme support:

```tsx
import { codeToHtml, type BundledLanguage } from "shiki";

export async function highlightCode(code: string, language: BundledLanguage) {
  return await Promise.all([
    codeToHtml(code, { lang: language, theme: "one-light" }),
    codeToHtml(code, { lang: language, theme: "one-dark-pro" }),
  ]);
}
```

**Why it works**: Streamdown detects fenced code blocks (```language) in markdown and renders them with syntax highlighting.

### 3. JSON Rendering (WORKS)

**Component**: `JsonViewer` in `ui/json-viewer.tsx`

Uses `CodeBlock` with `language="json"`:

```tsx
export function JsonViewer({ value }: JsonViewerProps) {
  const jsonString = JSON.stringify(typeof value === 'string' ? JSON.parse(value) : value, null, 2);
  return <CodeBlock code={jsonString} language="json" showLineNumbers={false} />;
}
```

**Why it works**: JSON is displayed as a code block with syntax highlighting. The tool output specifically uses this component.

### 4. Images (WORKS)

**Component**: `Image` in `image.tsx`

Handles both base64 and URL-based images:

```tsx
export function Image({ src, showDownloadButton, onLoad, ...props }) {
  // Handles base64 or URL images
  // Provides download functionality
}
```

**Usage in ChatMessage.tsx:88-104**:
```tsx
{message.kind === 'Image' && message.generatedImage && (
  <Image
    src={message.generatedImage}
    showDownloadButton={true}
  />
)}
```

**Why it works**: The backend specifically marks image messages with `kind: 'Image'` and provides the image URL/base64 in `generatedImage`. The frontend explicitly checks for this and renders the Image component.

### 5. Tool Calls (WORKS)

**Component**: `Tool`, `ToolHeader`, `ToolContent`, `ToolInput`, `ToolOutput` in `tool.tsx`

Shows tool execution with status indicators:

```tsx
<Tool>
  <ToolHeader title={tool.name} state={tool.status} />
  <ToolContent>
    <ToolInput input={tool.parameters} />
    <ToolOutput output={tool.result} errorText={tool.error} />
  </ToolContent>
</Tool>
```

**Why it works**: The backend sends real-time socket events (`tool_call_started`, `tool_call_completed`) that update the message state with tool information. The frontend explicitly handles messages with `tools` array.

## Why WebPreview and Artifact DON'T Work

### 6. Web Preview (NOT WORKING)

**Component**: `WebPreview` in `web-preview.tsx:43-78`

The component exists but is **never used in the chat rendering flow**:

```tsx
export const WebPreview = ({ defaultUrl, onUrlChange }: WebPreviewProps) => {
  const [url, setUrl] = useState(defaultUrl);
  return (
    <WebPreviewContext.Provider value={{ url, setUrl, ... }}>
      <div className="flex size-full flex-col rounded-lg border bg-card">
        <WebPreviewNavigation />
        <WebPreviewBody src={url} />  {/* iframe */}
        <WebPreviewConsole logs={logs} />
      </div>
    </WebPreviewContext.Provider>
  );
};
```

**Why it doesn't work**:
1. **No parsing logic**: There is no code to detect when AI output contains a web preview request
2. **No integration**: The component is not imported or used in `ChatMessage.tsx` or `ChatWindow.tsx`
3. **No message type**: There is no `kind: 'WebPreview'` or similar type in the message handling
4. **No URL extraction**: No logic exists to extract URLs from AI responses for iframe rendering

### 7. Artifact (NOT WORKING)

**Component**: `Artifact` in `artifact.tsx`

Pure UI container with no content rendering logic:

```tsx
export const Artifact = ({ className, ...props }: ArtifactProps) => (
  <div className={cn("flex flex-col overflow-hidden rounded-lg border", className)} {...props} />
);

export const ArtifactHeader = ({ ... }) => <div ... />;
export const ArtifactContent = ({ ... }) => <div ... />;
export const ArtifactActions = ({ ... }) => <div ... />;
```

**Why it doesn't work**:
1. **No parsing logic**: There is no code to detect or parse artifact blocks in AI responses
2. **No integration**: The component is not used in message rendering
3. **No structured output**: The AI is not prompted to output artifacts in a specific format
4. **No content type detection**: No logic to differentiate artifact types (code, document, etc.)

### 8. Mermaid Diagrams (PARTIAL/NOT WORKING)

**Why it doesn't work fully**:
1. **Missing plugin**: The project uses `streamdown` but does NOT include `@streamdown/mermaid`
2. **No plugin configuration**: Streamdown is used without any plugins:
   ```tsx
   <Streamdown>{content}</Streamdown>  // No plugins prop
   ```
3. **Expected usage** (not implemented):
   ```tsx
   import { mermaid } from "@streamdown/mermaid";
   <Streamdown plugins={{ mermaid }}>{content}</Streamdown>
   ```

## Message Flow

The complete message rendering flow in `ChatWindow.tsx`:

```
1. User sends message
   ↓
2. Backend processes via agent
   ↓
3. Socket events update message state:
   - ToolCallEvent → updates message.tools[]
   - NewAgentMessageEvent → updates message content, kind, generatedImage
   ↓
4. MessageBranch renders message:
   - If message.tools[] exists → render <Tool> components
   - Else if message.kind === 'Image' → render <Image>
   - Else → render <MessageResponse> (markdown via Streamdown)
```

## What's Missing for WebPreview/Artifact

To make WebPreview and Artifact work, you would need:

1. **Structured AI Output Format**: The AI needs to output in a parseable format (e.g., XML tags or JSON)
2. **Parser/Detector**: Logic to detect and extract artifact/preview content from AI responses
3. **Message Type Handling**: Add new `kind` types like `'Artifact'` or `'WebPreview'`
4. **Component Integration**: Render the appropriate component based on message type
5. **Backend Support**: Socket events and API responses that indicate artifact/preview content

## Summary Table

| Component | Status | Why |
|-----------|--------|-----|
| Markdown | **WORKS** | Streamdown auto-parses markdown |
| Code Blocks | **WORKS** | Streamdown + Shiki handle fenced code |
| JSON | **WORKS** | Explicitly rendered via JsonViewer/CodeBlock |
| Images | **WORKS** | Backend sends `kind: 'Image'`, frontend handles it |
| Tools | **WORKS** | Socket events + explicit tool rendering |
| Mermaid | **NOT WORKING** | @streamdown/mermaid plugin not installed |
| WebPreview | **NOT WORKING** | Component exists but not integrated |
| Artifact | **NOT WORKING** | Component exists but not integrated |

## File References

- Message rendering: `frontend/src/components/chat/ChatWindow.tsx:896-1000`
- Tool rendering: `frontend/src/components/ai-elements/tool.tsx`
- Markdown rendering: `frontend/src/components/ai-elements/message.tsx:309-322`
- Image rendering: `frontend/src/components/ai-elements/image.tsx`
- Unused WebPreview: `frontend/src/components/ai-elements/web-preview.tsx`
- Unused Artifact: `frontend/src/components/ai-elements/artifact.tsx`
