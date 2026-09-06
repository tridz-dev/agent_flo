# How to Make WebPreview and Artifact Components Work

This guide explains how to implement proper AI-powered WebPreview and Artifact functionality in HUF, including the required prompts, output formats, and code changes.

## Table of Contents

1. [Understanding the Problem](#understanding-the-problem)
2. [Solution Architecture](#solution-architecture)
3. [Implementing Artifacts](#implementing-artifacts)
4. [Implementing Web Preview](#implementing-web-preview)
5. [Example Prompts for GPT/Claude](#example-prompts-for-gptclaude)
6. [Code Implementation](#code-implementation)
7. [Mermaid Diagram Support](#mermaid-diagram-support)

---

## Understanding the Problem

The current implementation has WebPreview and Artifact components but they are "dumb" UI containers:

1. **No detection**: The system doesn't detect when AI output contains artifacts
2. **No parsing**: There's no logic to parse structured content from AI responses
3. **No rendering**: The components are never instantiated in the message flow

## Solution Architecture

### Required Components

```
AI Response → Parser/Detector → Message Type Router → Component Renderer
     ↓              ↓                   ↓                    ↓
  Raw text    Detect artifacts    Route by type      Render UI component
              Extract content
```

### Output Format Options

**Option A: XML Tags (Recommended)**
```xml
<artifact type="code" language="python" title="Hello World">
print("Hello, World!")
</artifact>
```

**Option B: JSON Blocks**
```json
{"artifact": {"type": "code", "language": "python", "title": "Hello World", "content": "print(\"Hello, World!\")"}}
```

**Option C: Custom Markdown Extensions**
```markdown
:::artifact{type="code" language="python" title="Hello World"}
print("Hello, World!")
:::
```

---

## Implementing Artifacts

### Step 1: Define Artifact Types

Create a new types file or add to existing types:

```typescript
// frontend/src/types/artifact.types.ts

export type ArtifactType =
  | 'code'
  | 'document'
  | 'html'
  | 'svg'
  | 'mermaid'
  | 'react-component'
  | 'markdown';

export interface ParsedArtifact {
  id: string;
  type: ArtifactType;
  title?: string;
  language?: string;
  content: string;
}
```

### Step 2: Create Artifact Parser

```typescript
// frontend/src/utils/artifactParser.ts

import type { ParsedArtifact, ArtifactType } from '@/types/artifact.types';

const ARTIFACT_REGEX = /<artifact\s+([^>]*)>([\s\S]*?)<\/artifact>/gi;
const ATTR_REGEX = /(\w+)=["']([^"']*)["']/g;

export function parseArtifacts(content: string): {
  text: string;
  artifacts: ParsedArtifact[];
} {
  const artifacts: ParsedArtifact[] = [];
  let index = 0;

  const text = content.replace(ARTIFACT_REGEX, (match, attrs, body) => {
    const attributes: Record<string, string> = {};
    let attrMatch;
    while ((attrMatch = ATTR_REGEX.exec(attrs)) !== null) {
      attributes[attrMatch[1]] = attrMatch[2];
    }

    artifacts.push({
      id: `artifact-${index++}`,
      type: (attributes.type || 'code') as ArtifactType,
      title: attributes.title,
      language: attributes.language,
      content: body.trim(),
    });

    return `[ARTIFACT:${index - 1}]`; // Placeholder for rendering
  });

  return { text, artifacts };
}

export function hasArtifacts(content: string): boolean {
  return ARTIFACT_REGEX.test(content);
}
```

### Step 3: Create Artifact Renderer

```tsx
// frontend/src/components/chat/ArtifactRenderer.tsx

import { useState } from 'react';
import {
  Artifact,
  ArtifactHeader,
  ArtifactTitle,
  ArtifactActions,
  ArtifactAction,
  ArtifactContent,
  ArtifactClose,
} from '@/components/ai-elements/artifact';
import { CodeBlock } from '@/components/ai-elements/code-block';
import { MessageResponse } from '@/components/ai-elements/message';
import { CopyIcon, DownloadIcon, MaximizeIcon, XIcon } from 'lucide-react';
import type { ParsedArtifact } from '@/types/artifact.types';

interface ArtifactRendererProps {
  artifact: ParsedArtifact;
  onClose?: () => void;
}

export function ArtifactRenderer({ artifact, onClose }: ArtifactRendererProps) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(artifact.content);
  };

  const handleDownload = () => {
    const blob = new Blob([artifact.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = artifact.title || `artifact.${artifact.language || 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderContent = () => {
    switch (artifact.type) {
      case 'code':
        return (
          <CodeBlock
            code={artifact.content}
            language={artifact.language || 'text'}
            showLineNumbers
          />
        );
      case 'html':
        return (
          <iframe
            srcDoc={artifact.content}
            sandbox="allow-scripts"
            className="w-full h-96 border-0"
            title={artifact.title || 'HTML Preview'}
          />
        );
      case 'svg':
        return (
          <div
            className="flex items-center justify-center p-4"
            dangerouslySetInnerHTML={{ __html: artifact.content }}
          />
        );
      case 'markdown':
      case 'document':
        return <MessageResponse>{artifact.content}</MessageResponse>;
      case 'mermaid':
        // Requires mermaid.js integration
        return <MermaidRenderer content={artifact.content} />;
      default:
        return <pre className="whitespace-pre-wrap">{artifact.content}</pre>;
    }
  };

  return (
    <Artifact className={isFullscreen ? 'fixed inset-4 z-50' : ''}>
      <ArtifactHeader>
        <ArtifactTitle>{artifact.title || `${artifact.type} artifact`}</ArtifactTitle>
        <ArtifactActions>
          <ArtifactAction
            icon={CopyIcon}
            tooltip="Copy"
            onClick={handleCopy}
          />
          <ArtifactAction
            icon={DownloadIcon}
            tooltip="Download"
            onClick={handleDownload}
          />
          <ArtifactAction
            icon={MaximizeIcon}
            tooltip={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            onClick={() => setIsFullscreen(!isFullscreen)}
          />
          {onClose && <ArtifactClose onClick={onClose} />}
        </ArtifactActions>
      </ArtifactHeader>
      <ArtifactContent>{renderContent()}</ArtifactContent>
    </Artifact>
  );
}

// Mermaid support component
function MermaidRenderer({ content }: { content: string }) {
  // Basic implementation - requires mermaid.js
  return (
    <div className="mermaid">
      <CodeBlock code={content} language="mermaid" />
      {/* TODO: Add mermaid.js rendering */}
    </div>
  );
}
```

### Step 4: Integrate into ChatWindow

Update `ChatWindow.tsx` to handle artifacts:

```tsx
// In ChatWindow.tsx, update the message rendering section

import { parseArtifacts, hasArtifacts } from '@/utils/artifactParser';
import { ArtifactRenderer } from './ArtifactRenderer';

// Inside the message map function:
{versions.map((version) => {
  // Parse artifacts from content
  const { text, artifacts } = hasArtifacts(version.content)
    ? parseArtifacts(version.content)
    : { text: version.content, artifacts: [] };

  return (
    <Message from={message.from} key={`${message.key}-${version.id}`}>
      <MessageContent>
        {/* Render text content */}
        {text && <MessageResponse>{text}</MessageResponse>}

        {/* Render artifacts */}
        {artifacts.map((artifact) => (
          <ArtifactRenderer key={artifact.id} artifact={artifact} />
        ))}
      </MessageContent>
    </Message>
  );
})}
```

---

## Implementing Web Preview

### Step 1: Define WebPreview Message Type

```typescript
// Add to MessageType in ChatWindow.tsx or types file

type MessageType = {
  // ... existing fields
  webPreview?: {
    url: string;
    title?: string;
  };
};
```

### Step 2: Create WebPreview Parser

```typescript
// frontend/src/utils/webPreviewParser.ts

const WEB_PREVIEW_REGEX = /<web-preview\s+url=["']([^"']+)["'](?:\s+title=["']([^"']+)["'])?\s*\/?>(?:<\/web-preview>)?/gi;

export interface ParsedWebPreview {
  url: string;
  title?: string;
}

export function parseWebPreviews(content: string): {
  text: string;
  previews: ParsedWebPreview[];
} {
  const previews: ParsedWebPreview[] = [];

  const text = content.replace(WEB_PREVIEW_REGEX, (match, url, title) => {
    previews.push({ url, title });
    return ''; // Remove from text
  });

  return { text: text.trim(), previews };
}
```

### Step 3: Create WebPreview Integration

```tsx
// frontend/src/components/chat/WebPreviewRenderer.tsx

import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
  WebPreviewBody,
  WebPreviewConsole,
} from '@/components/ai-elements/web-preview';
import { ArrowLeftIcon, ArrowRightIcon, RefreshCwIcon, ExternalLinkIcon } from 'lucide-react';
import type { ParsedWebPreview } from '@/utils/webPreviewParser';

interface WebPreviewRendererProps {
  preview: ParsedWebPreview;
}

export function WebPreviewRenderer({ preview }: WebPreviewRendererProps) {
  return (
    <WebPreview defaultUrl={preview.url} className="h-96 my-4">
      <WebPreviewNavigation>
        <WebPreviewNavigationButton tooltip="Back">
          <ArrowLeftIcon size={16} />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton tooltip="Forward">
          <ArrowRightIcon size={16} />
        </WebPreviewNavigationButton>
        <WebPreviewNavigationButton tooltip="Refresh">
          <RefreshCwIcon size={16} />
        </WebPreviewNavigationButton>
        <WebPreviewUrl />
        <WebPreviewNavigationButton
          tooltip="Open in new tab"
          onClick={() => window.open(preview.url, '_blank')}
        >
          <ExternalLinkIcon size={16} />
        </WebPreviewNavigationButton>
      </WebPreviewNavigation>
      <WebPreviewBody />
    </WebPreview>
  );
}
```

---

## Example Prompts for GPT/Claude

### System Prompt for Artifact Support

```
You are an AI assistant that can generate various types of content artifacts. When generating code, documents, diagrams, or other structured content that should be displayed in a special container, wrap it in artifact tags.

## Artifact Format

Use the following XML format for artifacts:

<artifact type="TYPE" language="LANGUAGE" title="TITLE">
CONTENT HERE
</artifact>

## Supported Types

- `code` - Source code (specify language attribute)
- `html` - HTML content for preview
- `svg` - SVG graphics
- `mermaid` - Mermaid diagrams
- `markdown` - Formatted documents
- `document` - Plain text documents

## Examples

### Code Artifact
<artifact type="code" language="python" title="Hello World Script">
def greet(name: str) -> str:
    return f"Hello, {name}!"

if __name__ == "__main__":
    print(greet("World"))
</artifact>

### HTML Artifact
<artifact type="html" title="Interactive Button">
<!DOCTYPE html>
<html>
<body>
  <button onclick="alert('Hello!')">Click me</button>
</body>
</html>
</artifact>

### Mermaid Diagram
<artifact type="mermaid" title="User Flow">
graph TD
    A[User] --> B[Login Page]
    B --> C{Valid?}
    C -->|Yes| D[Dashboard]
    C -->|No| E[Error]
</artifact>

## Web Preview Format

When you want to show a web preview of an external URL:

<web-preview url="https://example.com" title="Example Site" />

## Guidelines

1. Use artifacts for substantial code blocks (>5 lines)
2. Always specify the language for code artifacts
3. Give meaningful titles
4. Keep explanatory text OUTSIDE the artifact tags
5. You can have multiple artifacts in one response
```

### Example User Interaction (GPT-4)

**User**: Write a Python function that calculates fibonacci numbers

**Assistant**:
Here's a function that calculates Fibonacci numbers using dynamic programming:

<artifact type="code" language="python" title="Fibonacci Calculator">
def fibonacci(n: int) -> int:
    """
    Calculate the nth Fibonacci number using dynamic programming.

    Args:
        n: The position in the Fibonacci sequence (0-indexed)

    Returns:
        The nth Fibonacci number
    """
    if n < 0:
        raise ValueError("n must be non-negative")
    if n <= 1:
        return n

    # Use iterative approach to avoid recursion overhead
    prev, curr = 0, 1
    for _ in range(2, n + 1):
        prev, curr = curr, prev + curr

    return curr


# Example usage
if __name__ == "__main__":
    for i in range(10):
        print(f"F({i}) = {fibonacci(i)}")
</artifact>

This implementation uses O(n) time and O(1) space by only keeping track of the two previous values.

### Example with Multiple Artifacts

**User**: Create a simple React counter component with a flow diagram

**Assistant**:
Here's a simple React counter component:

<artifact type="code" language="tsx" title="Counter Component">
import { useState } from 'react';

interface CounterProps {
  initialValue?: number;
}

export function Counter({ initialValue = 0 }: CounterProps) {
  const [count, setCount] = useState(initialValue);

  return (
    <div className="flex items-center gap-4">
      <button onClick={() => setCount(c => c - 1)}>-</button>
      <span className="text-xl font-bold">{count}</span>
      <button onClick={() => setCount(c => c + 1)}>+</button>
    </div>
  );
}
</artifact>

And here's the component flow:

<artifact type="mermaid" title="Counter State Flow">
stateDiagram-v2
    [*] --> Initial: Component Mounts
    Initial --> Updated: User Clicks +/-
    Updated --> Updated: User Clicks +/-

    state Updated {
        [*] --> SetCount
        SetCount --> ReRender
        ReRender --> [*]
    }
</artifact>

The component uses React's `useState` hook to manage the counter state.

---

## Code Implementation

### Full Integration Example

Here's a complete example of updating `ChatWindow.tsx`:

```tsx
// frontend/src/components/chat/ChatWindow.tsx

// Add imports
import { parseArtifacts, hasArtifacts } from '@/utils/artifactParser';
import { parseWebPreviews } from '@/utils/webPreviewParser';
import { ArtifactRenderer } from './ArtifactRenderer';
import { WebPreviewRenderer } from './WebPreviewRenderer';

// Update the message rendering (around line 896-1000)
{versions.map((version) => {
  // Parse structured content
  let textContent = version.content;
  let artifacts: ParsedArtifact[] = [];
  let webPreviews: ParsedWebPreview[] = [];

  if (hasArtifacts(textContent)) {
    const parsed = parseArtifacts(textContent);
    textContent = parsed.text;
    artifacts = parsed.artifacts;
  }

  const webParsed = parseWebPreviews(textContent);
  textContent = webParsed.text;
  webPreviews = webParsed.previews;

  return (
    <Message from={message.from} key={`${message.key}-${version.id}`}>
      <div>
        {/* Sources and reasoning (existing code) */}
        {message.sources?.length && /* ... */}
        {message.reasoning && /* ... */}

        {/* Tools (existing code) */}
        {message.tools && message.tools.length > 0 ? (
          /* existing tool rendering */
        ) : (
          <>
            <MessageContent>
              {/* Text content */}
              {textContent && <MessageResponse>{textContent}</MessageResponse>}

              {/* Artifacts */}
              {artifacts.map((artifact) => (
                <ArtifactRenderer key={artifact.id} artifact={artifact} />
              ))}

              {/* Web Previews */}
              {webPreviews.map((preview, idx) => (
                <WebPreviewRenderer key={`preview-${idx}`} preview={preview} />
              ))}
            </MessageContent>
          </>
        )}
      </div>
    </Message>
  );
})}
```

---

## Mermaid Diagram Support

### Option 1: Add @streamdown/mermaid Plugin

```bash
npm install @streamdown/mermaid
# or
yarn add @streamdown/mermaid
```

Update Streamdown usage:

```tsx
// frontend/src/components/ai-elements/message.tsx
import { Streamdown } from "streamdown";
import { mermaid } from "@streamdown/mermaid";

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn("size-full [&>*:first-child]:mt-0", className)}
      plugins={{ mermaid }}  // Add mermaid plugin
      {...props}
    />
  ),
  (prevProps, nextProps) => prevProps.children === nextProps.children
);
```

### Option 2: Direct Mermaid.js Integration

```bash
npm install mermaid
```

Create a Mermaid component:

```tsx
// frontend/src/components/ui/mermaid.tsx
import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';

interface MermaidProps {
  chart: string;
  className?: string;
}

mermaid.initialize({
  startOnLoad: false,
  theme: 'neutral',
  securityLevel: 'strict',
});

export function Mermaid({ chart, className }: MermaidProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string>('');

  useEffect(() => {
    const render = async () => {
      try {
        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
        const { svg } = await mermaid.render(id, chart);
        setSvg(svg);
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to render diagram');
      }
    };
    render();
  }, [chart]);

  if (error) {
    return <div className="text-red-500 p-4 border rounded">{error}</div>;
  }

  return (
    <div
      ref={containerRef}
      className={className}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
```

---

## Summary

To make WebPreview and Artifact work:

1. **Define output format**: Use XML tags that the AI can generate
2. **Create parsers**: Detect and extract structured content from AI responses
3. **Update prompts**: Instruct the AI on the expected format
4. **Create renderers**: Build React components that render parsed content
5. **Integrate**: Update ChatWindow to use parsers and renderers

### Quick Checklist

- [ ] Add `artifactParser.ts` utility
- [ ] Add `webPreviewParser.ts` utility
- [ ] Create `ArtifactRenderer.tsx` component
- [ ] Create `WebPreviewRenderer.tsx` component
- [ ] Update `ChatWindow.tsx` to use parsers
- [ ] Update agent system prompts with artifact format instructions
- [ ] (Optional) Install `@streamdown/mermaid` for diagram support
- [ ] (Optional) Install `mermaid` for direct diagram rendering

### Key Files to Modify

| File | Change |
|------|--------|
| `frontend/src/utils/artifactParser.ts` | NEW - Artifact parsing |
| `frontend/src/utils/webPreviewParser.ts` | NEW - WebPreview parsing |
| `frontend/src/components/chat/ArtifactRenderer.tsx` | NEW - Artifact UI |
| `frontend/src/components/chat/WebPreviewRenderer.tsx` | NEW - WebPreview UI |
| `frontend/src/components/chat/ChatWindow.tsx` | UPDATE - Integration |
| `huf/huf/doctype/agent/agent.py` | UPDATE - System prompts |

---

## JSX Preview with Recharts Support

HUF supports dynamic JSX rendering for interactive data visualizations. This allows the AI to generate charts and UI components that render directly in the chat.

### Supported Artifact Types

Two artifact types support JSX rendering:
- `jsx` - General JSX/React code
- `chart` - Data visualizations (same rendering, semantic distinction)

### Available Recharts Components

The following Recharts components are available for rendering:

| Component | Description |
|-----------|-------------|
| `LineChart`, `Line` | Line charts for trends |
| `BarChart`, `Bar` | Bar charts for comparisons |
| `PieChart`, `Pie`, `Cell` | Pie charts for proportions |
| `AreaChart`, `Area` | Area charts for cumulative data |
| `ScatterChart`, `Scatter` | Scatter plots for correlations |
| `RadarChart`, `Radar` | Radar charts for multi-variable comparisons |
| `ComposedChart` | Mixed chart types |
| `Treemap` | Hierarchical data visualization |
| `FunnelChart`, `Funnel` | Funnel charts for stages |
| `XAxis`, `YAxis` | Axis components |
| `CartesianGrid` | Grid lines |
| `Tooltip` | Interactive tooltips |
| `Legend` | Chart legends |
| `ResponsiveContainer` | Responsive wrapper |
| `PolarGrid`, `PolarAngleAxis`, `PolarRadiusAxis` | Polar coordinate components |

### Default Bindings

These are available in JSX expressions:
- `COLORS` - Default color palette: `['#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#00C49F', '#FFBB28', '#FF8042', '#0088FE']`
- `Math`, `JSON`, `Array`, `Object`, `console` - Standard JavaScript utilities

### System Prompt for Chart Generation

Add this to your agent's system prompt:

```
## Chart/JSX Artifact Format

When generating data visualizations or interactive UI components, use the following artifact format:

<artifact type="chart" title="CHART TITLE">
JSX CODE HERE
</artifact>

## Available Components

You have access to all Recharts components:
- LineChart, Line, BarChart, Bar, PieChart, Pie, Cell
- AreaChart, Area, ScatterChart, Scatter
- RadarChart, Radar, ComposedChart, Treemap
- FunnelChart, Funnel
- XAxis, YAxis, CartesianGrid, Tooltip, Legend
- ResponsiveContainer, PolarGrid, PolarAngleAxis, PolarRadiusAxis

## Available Variables

- `COLORS` - Array of chart colors: ['#8884d8', '#82ca9d', '#ffc658', ...]

## Chart Examples

### Line Chart
<artifact type="chart" title="Monthly Sales">
<ResponsiveContainer width="100%" height={300}>
  <LineChart data={[
    { month: 'Jan', sales: 4000 },
    { month: 'Feb', sales: 3000 },
    { month: 'Mar', sales: 5000 },
    { month: 'Apr', sales: 4500 },
    { month: 'May', sales: 6000 }
  ]}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="month" />
    <YAxis />
    <Tooltip />
    <Legend />
    <Line type="monotone" dataKey="sales" stroke="#8884d8" strokeWidth={2} />
  </LineChart>
</ResponsiveContainer>
</artifact>

### Bar Chart
<artifact type="chart" title="Product Comparison">
<ResponsiveContainer width="100%" height={300}>
  <BarChart data={[
    { name: 'Product A', value: 400 },
    { name: 'Product B', value: 300 },
    { name: 'Product C', value: 500 },
    { name: 'Product D', value: 280 }
  ]}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="name" />
    <YAxis />
    <Tooltip />
    <Legend />
    <Bar dataKey="value" fill="#82ca9d" />
  </BarChart>
</ResponsiveContainer>
</artifact>

### Pie Chart
<artifact type="chart" title="Market Share">
<ResponsiveContainer width="100%" height={300}>
  <PieChart>
    <Pie
      data={[
        { name: 'Chrome', value: 65 },
        { name: 'Firefox', value: 15 },
        { name: 'Safari', value: 12 },
        { name: 'Edge', value: 8 }
      ]}
      dataKey="value"
      nameKey="name"
      cx="50%"
      cy="50%"
      outerRadius={100}
      label
    >
      {[0, 1, 2, 3].map((index) => (
        <Cell key={`cell-${index}`} fill={COLORS[index]} />
      ))}
    </Pie>
    <Tooltip />
    <Legend />
  </PieChart>
</ResponsiveContainer>
</artifact>

### Multi-Line Chart
<artifact type="chart" title="Revenue vs Expenses">
<ResponsiveContainer width="100%" height={300}>
  <LineChart data={[
    { month: 'Jan', revenue: 4000, expenses: 2400 },
    { month: 'Feb', revenue: 3000, expenses: 1398 },
    { month: 'Mar', revenue: 5000, expenses: 3800 },
    { month: 'Apr', revenue: 4780, expenses: 3908 }
  ]}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="month" />
    <YAxis />
    <Tooltip />
    <Legend />
    <Line type="monotone" dataKey="revenue" stroke="#8884d8" />
    <Line type="monotone" dataKey="expenses" stroke="#82ca9d" />
  </LineChart>
</ResponsiveContainer>
</artifact>

### Area Chart
<artifact type="chart" title="User Growth">
<ResponsiveContainer width="100%" height={300}>
  <AreaChart data={[
    { month: 'Jan', users: 1000 },
    { month: 'Feb', users: 1500 },
    { month: 'Mar', users: 2300 },
    { month: 'Apr', users: 3200 },
    { month: 'May', users: 4800 }
  ]}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="month" />
    <YAxis />
    <Tooltip />
    <Area type="monotone" dataKey="users" stroke="#8884d8" fill="#8884d8" fillOpacity={0.3} />
  </AreaChart>
</ResponsiveContainer>
</artifact>

## Guidelines for Chart Generation

1. Always wrap charts in `<ResponsiveContainer width="100%" height={300}>` for responsiveness
2. Include `CartesianGrid`, `Tooltip`, and `Legend` for better UX
3. Use the `COLORS` array for consistent coloring
4. Inline the data directly in the JSX (no external variables)
5. Keep chart height between 250-400px for readability
6. Use meaningful labels and titles
7. For pie charts, use `<Cell>` components with `COLORS` for each segment
```

### Example User Interactions

**User**: Show me a chart of quarterly sales data

**Assistant**:
Here's a visualization of quarterly sales:

<artifact type="chart" title="Quarterly Sales 2024">
<ResponsiveContainer width="100%" height={300}>
  <BarChart data={[
    { quarter: 'Q1', sales: 45000, target: 40000 },
    { quarter: 'Q2', sales: 52000, target: 50000 },
    { quarter: 'Q3', sales: 48000, target: 55000 },
    { quarter: 'Q4', sales: 61000, target: 60000 }
  ]}>
    <CartesianGrid strokeDasharray="3 3" />
    <XAxis dataKey="quarter" />
    <YAxis />
    <Tooltip formatter={(value) => `$${value.toLocaleString()}`} />
    <Legend />
    <Bar dataKey="sales" fill="#8884d8" name="Actual Sales" />
    <Bar dataKey="target" fill="#82ca9d" name="Target" />
  </BarChart>
</ResponsiveContainer>
</artifact>

The chart shows actual sales vs targets for each quarter. Q4 exceeded targets while Q3 fell short.

---

**User**: Create a pie chart showing browser market share

**Assistant**:
<artifact type="chart" title="Browser Market Share 2024">
<ResponsiveContainer width="100%" height={350}>
  <PieChart>
    <Pie
      data={[
        { name: 'Chrome', value: 64.7 },
        { name: 'Safari', value: 19.3 },
        { name: 'Firefox', value: 3.0 },
        { name: 'Edge', value: 5.2 },
        { name: 'Other', value: 7.8 }
      ]}
      dataKey="value"
      nameKey="name"
      cx="50%"
      cy="50%"
      outerRadius={120}
      label={({ name, value }) => `${name}: ${value}%`}
    >
      {[0, 1, 2, 3, 4].map((index) => (
        <Cell key={`cell-${index}`} fill={COLORS[index]} />
      ))}
    </Pie>
    <Tooltip formatter={(value) => `${value}%`} />
    <Legend />
  </PieChart>
</ResponsiveContainer>
</artifact>

Chrome dominates with nearly 65% market share, followed by Safari at 19%.

### Export Functionality

Charts can be exported by users:
- **PNG Export**: Uses `html2canvas` for high-quality image capture
- **SVG Export**: Extracts the SVG element directly for vector graphics

The export buttons appear in the top-right corner of each chart artifact.

### Streaming Support

The JSXPreview component handles streaming responses by:
1. Auto-completing unclosed JSX tags during streaming
2. Gracefully handling partial/incomplete JSX
3. Re-rendering as more content arrives

### Error Handling

If JSX parsing fails:
- An error message is displayed in the artifact area
- The raw JSX source is available in the "View Source" section
- Errors are logged to the console for debugging

### Custom Components

To add custom components beyond Recharts:

```typescript
// In jsx-preview.tsx, add to availableComponents:
const availableComponents: Record<string, ComponentType<any>> = {
  // ... existing Recharts components
  // Add custom components:
  CustomCard: MyCustomCardComponent,
  DataTable: MyDataTableComponent,
};
```

### Best Practices for AI-Generated Charts

1. **Data Format**: Always inline data arrays directly in the JSX
2. **Responsive Design**: Use `ResponsiveContainer` for all charts
3. **Accessibility**: Include `Tooltip` and `Legend` components
4. **Consistent Styling**: Use the `COLORS` array for visual consistency
5. **Appropriate Chart Types**:
   - Line charts: Trends over time
   - Bar charts: Categorical comparisons
   - Pie charts: Part-to-whole relationships (limit to 5-7 segments)
   - Area charts: Cumulative values over time
   - Scatter plots: Correlations between variables
