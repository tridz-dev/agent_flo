import { useMemo, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { AlertCircle, ChevronDown, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react';
import { formatTimeAgo } from '@/utils/time';
import { cn } from '@/lib/utils';
import { testSearch } from '@/services/knowledgeApi';
import { getFrappeErrorMessage } from '@/lib/frappe-error';
import type { KnowledgeInputDoc, KnowledgeSourceDoc } from '@/types/knowledge.types';

interface StatusTabProps {
  source: KnowledgeSourceDoc | null;
  inputs: KnowledgeInputDoc[];
  inputsLoading: boolean;
  onReprocessInput: (name: string) => Promise<void> | void;
  onDeleteInput: (name: string) => Promise<void> | void;
}

interface TestSearchResultChunk {
  text?: string;
  content?: string;
  score?: number;
  relevance?: number;
  source?: string;
  file_name?: string;
  [key: string]: unknown;
}

function getStatusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'success' | 'outline' {
  switch (status) {
    case 'Ready':
    case 'Indexed':
      return 'success';
    case 'Indexing':
    case 'Rebuilding':
    case 'Processing':
      return 'outline';
    case 'Error':
      return 'destructive';
    default:
      return 'secondary';
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function getInputLabel(input: KnowledgeInputDoc): string {
  switch (input.input_type) {
    case 'File':
      return input.file_name || input.file || 'Untitled file';
    case 'URL':
      return input.url || 'Untitled URL';
    case 'Text':
      return input.text?.slice(0, 60) || 'Text input';
    default:
      return input.name;
  }
}

function normalizeTestSearchResults(raw: unknown): TestSearchResultChunk[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw as TestSearchResultChunk[];
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.results)) return obj.results as TestSearchResultChunk[];
    if (Array.isArray(obj.chunks)) return obj.chunks as TestSearchResultChunk[];
  }
  return [];
}

export function StatusTab({ source, inputs, inputsLoading, onReprocessInput, onDeleteInput }: StatusTabProps) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<TestSearchResultChunk[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [expandedError, setExpandedError] = useState<string | null>(null);

  const counts = useMemo(() => {
    const result = { indexed: 0, processing: 0, pending: 0, error: 0 };
    for (const input of inputs) {
      if (input.status === 'Indexed') result.indexed += 1;
      else if (input.status === 'Processing') result.processing += 1;
      else if (input.status === 'Pending') result.pending += 1;
      else if (input.status === 'Error') result.error += 1;
    }
    return result;
  }, [inputs]);

  const failedInputs = useMemo(() => inputs.filter((input) => input.status === 'Error'), [inputs]);

  const handleTestSearch = async () => {
    if (!source || !query.trim()) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await testSearch(source.name, query.trim());
      setSearchResults(normalizeTestSearchResults(result));
    } catch (error) {
      const msg = getFrappeErrorMessage(error);
      setSearchError(msg || 'Failed to run test search');
    } finally {
      setSearching(false);
    }
  };

  if (!source) {
    return (
      <Card>
        <CardContent className="py-12 text-center font-body text-steel">
          Save the knowledge source first to see status information.
        </CardContent>
      </Card>
    );
  }

  const inputsSummary = `${inputs.length} ${inputs.length === 1 ? 'input' : 'inputs'} · ${counts.indexed} indexed${
    counts.processing ? ` · ${counts.processing} processing` : ''
  }${counts.pending ? ` · ${counts.pending} pending` : ''}${counts.error ? ` · ${counts.error} failed` : ''}`;

  return (
    <div className="space-y-6">
      {source.status === 'Error' && source.error_message && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Indexing Error</AlertTitle>
          <AlertDescription className="mt-2 whitespace-pre-wrap">
            {source.error_message}
          </AlertDescription>
        </Alert>
      )}

      {failedInputs.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {failedInputs.length} {failedInputs.length === 1 ? 'input' : 'inputs'} failed to process
          </AlertTitle>
          <AlertDescription className="mt-2">
            <ul className="list-disc pl-4 space-y-0.5">
              {failedInputs.map((input) => (
                <li key={input.name} className="text-sm">
                  {getInputLabel(input)}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Index status</CardTitle>
          <CardDescription>Current state of the knowledge source index</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-sm font-medium text-steel">Status</p>
              <Badge variant={getStatusVariant(source.status)}>{source.status}</Badge>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium text-steel">Last Indexed</p>
              <p className="text-sm">
                {source.last_indexed_at ? formatTimeAgo(source.last_indexed_at) : 'Never'}
              </p>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium text-steel">Total Chunks</p>
              <p className="text-sm">{source.total_chunks.toLocaleString()}</p>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium text-steel">Inputs</p>
              <p className="text-sm">{inputsSummary}</p>
            </div>

            <div className="space-y-1">
              <p className="text-sm font-medium text-steel">Index Size</p>
              <p className="text-sm">{formatBytes(source.index_size_bytes)}</p>
            </div>

            {source.knowledge_type === 'chroma' && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-steel">Chroma Connection</p>
                {source.chroma_mode === 'Server' ? (
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-mono text-xs">
                      {source.chroma_host || 'localhost'}:{source.chroma_port ?? 8000}
                    </p>
                    {source.chroma_ssl === 1 && (
                      <Badge variant="outline">SSL</Badge>
                    )}
                  </div>
                ) : (
                  <p className="text-sm">Local ChromaDB (file-backed)</p>
                )}
              </div>
            )}
          </div>

          {source.sqlite_file_path && source.knowledge_type !== 'chroma' && (
            <Collapsible className="mt-6 border-t pt-4">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex items-center gap-1.5 text-sm font-medium text-steel hover:text-foreground"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                  Advanced / technical details
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-3 space-y-1">
                <p className="text-xs text-steel-soft">Internal storage path (server filesystem)</p>
                <p className="text-sm font-mono text-xs break-all">{source.sqlite_file_path}</p>
              </CollapsibleContent>
            </Collapsible>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Inputs</CardTitle>
          <CardDescription>Individual content items and their processing status</CardDescription>
        </CardHeader>
        <CardContent>
          {inputsLoading && inputs.length === 0 ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-5 h-5 animate-spin text-steel-soft" />
            </div>
          ) : inputs.length === 0 ? (
            <div className="text-center py-8 font-body text-steel text-sm">
              No knowledge inputs yet. Add one to get started.
            </div>
          ) : (
            <div className="space-y-2">
              {inputs.map((input) => {
                const isErrored = input.status === 'Error';
                const isExpanded = expandedError === input.name;
                return (
                  <div key={input.name} className="rounded-md border p-3 space-y-2">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{getInputLabel(input)}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant={getStatusVariant(input.status)} size="sm">
                            {input.status}
                          </Badge>
                          <span className="text-xs text-steel-soft">
                            {input.chunks_created.toLocaleString()} chunks
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {isErrored && input.error_message && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setExpandedError(isExpanded ? null : input.name)}
                          >
                            {isExpanded ? 'Hide error' : 'Show error'}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => void onReprocessInput(input.name)}
                          title="Retry"
                          disabled={input.status === 'Pending' || input.status === 'Processing'}
                        >
                          <RefreshCw
                            className={cn('w-3.5 h-3.5', input.status === 'Processing' && 'animate-spin')}
                          />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => void onDeleteInput(input.name)}
                          title="Remove"
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                    {isErrored && isExpanded && input.error_message && (
                      <p className="text-xs text-destructive whitespace-pre-wrap break-words rounded bg-destructive/5 p-2">
                        {input.error_message}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test search</CardTitle>
          <CardDescription>Run a query against this knowledge source to verify it returns useful results</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Input
              placeholder="Ask a question or enter search terms..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void handleTestSearch();
                }
              }}
            />
            <Button onClick={() => void handleTestSearch()} disabled={searching || !query.trim()}>
              {searching ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
              Search
            </Button>
          </div>

          {searchError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{searchError}</AlertDescription>
            </Alert>
          )}

          {!searchError && searchResults !== null && (
            searchResults.length === 0 ? (
              <p className="text-sm text-steel py-4 text-center">No matching results found.</p>
            ) : (
              <div className="space-y-2">
                {searchResults.map((result, index) => {
                  const text = result.text ?? result.content ?? '';
                  const score = result.score ?? result.relevance;
                  const label = result.file_name ?? result.source;
                  return (
                    <div key={index} className="rounded-md border p-3 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        {label ? (
                          <p className="text-xs font-medium text-steel truncate">{String(label)}</p>
                        ) : (
                          <span />
                        )}
                        {typeof score === 'number' && (
                          <Badge variant="outline" size="sm">
                            score {score.toFixed(3)}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm whitespace-pre-wrap">{String(text)}</p>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
