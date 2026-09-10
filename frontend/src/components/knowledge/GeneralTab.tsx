import { FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown } from 'lucide-react';
import { UseFormReturn } from 'react-hook-form';
import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { knowledgeTypes, knowledgeScopes, knowledgeTypePresets, chromaModes, isVectorKnowledgeType } from '@/data/knowledge';
import type { KnowledgeTypePresetId } from '@/data/knowledge';
import { linkRoutes } from '@/lib/link-routes';
import type { KnowledgeSourceFormValues } from './types';
import { AdvancedConfigFields } from './AdvancedConfigFields';

interface ProviderOption {
  name: string;
  provider_name?: string;
}

interface GeneralTabProps {
  form: UseFormReturn<KnowledgeSourceFormValues>;
  isNew: boolean;
  providers?: ProviderOption[];
}

const scopeDescriptions: Record<string, string> = {
  Site: 'Only agents and users on this site can query this knowledge base.',
  Workspace: 'Shared across agents within the same workspace on this site.',
  Agent: 'Private to a single agent — other agents cannot query it.',
  Global: 'Available to every agent and site that can reach this instance.',
};

function presetIdForKnowledgeType(knowledgeType: string | undefined): KnowledgeTypePresetId {
  const preset = knowledgeTypePresets.find((p) => p.knowledgeType === knowledgeType);
  return preset ? preset.id : 'custom';
}

export function GeneralTab({ form, isNew, providers = [] }: GeneralTabProps) {
  const watchKnowledgeType = form.watch('knowledge_type');
  const watchChromaMode = form.watch('chroma_mode');
  const watchPGVectorConnectionMode = form.watch('pgvector_connection_mode');

  const [presetId, setPresetId] = useState<KnowledgeTypePresetId>(() =>
    presetIdForKnowledgeType(form.getValues('knowledge_type')),
  );

  const providerOptions = useMemo(
    () => providers.map((p) => ({ value: p.name, label: p.provider_name || p.name })),
    [providers],
  );

  const handlePresetChange = (id: KnowledgeTypePresetId) => {
    setPresetId(id);
    const preset = knowledgeTypePresets.find((p) => p.id === id);
    if (!preset || preset.knowledgeType === null) return;
    form.setValue('knowledge_type', preset.knowledgeType, { shouldDirty: true, shouldValidate: true });
    if ('defaults' in preset && preset.defaults) {
      if (!form.getValues('embedding_model')?.trim()) {
        form.setValue('embedding_model', preset.defaults.embedding_model, { shouldDirty: true });
      }
      if (!form.getValues('vector_dimension')) {
        form.setValue('vector_dimension', preset.defaults.vector_dimension, { shouldDirty: true });
      }
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
          <CardDescription>Name and description for this knowledge source</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          {isNew && (
            <FormField
              control={form.control}
              name="source_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Product documentation" {...field} />
                  </FormControl>
                  <FormDescription>A friendly title for this knowledge source, shown throughout the app</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}

          <FormField
            control={form.control}
            name="description"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Description</FormLabel>
                <FormControl>
                  <Textarea
                    placeholder="What this knowledge source contains"
                    className="min-h-[80px] resize-y"
                    {...field}
                  />
                </FormControl>
                <FormDescription>Human-readable description of the knowledge source</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="scope"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Scope</FormLabel>
                <Select onValueChange={field.onChange} value={field.value}>
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select scope" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {knowledgeScopes.map((scope) => (
                      <SelectItem key={scope.value} value={scope.value}>
                        {scope.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Controls who can query this knowledge base. {scopeDescriptions[field.value] ?? ''}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Search type</CardTitle>
          <CardDescription>How this knowledge source is indexed and searched</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6">
          <RadioGroup
            value={presetId}
            onValueChange={(value) => handlePresetChange(value as KnowledgeTypePresetId)}
            className="grid gap-3 sm:grid-cols-3"
          >
            {knowledgeTypePresets.map((preset) => (
              <label
                key={preset.id}
                htmlFor={`knowledge-type-preset-${preset.id}`}
                className={cn(
                  'flex cursor-pointer flex-col gap-2 rounded-lg border p-4 text-sm transition-colors',
                  presetId === preset.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                )}
              >
                <div className="flex items-center gap-2">
                  <RadioGroupItem value={preset.id} id={`knowledge-type-preset-${preset.id}`} />
                  <span className="font-medium">{preset.label}</span>
                </div>
                <span className="text-muted-foreground">{preset.description}</span>
              </label>
            ))}
          </RadioGroup>

          {presetId === 'custom' && (
            <FormField
              control={form.control}
              name="knowledge_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Knowledge type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {knowledgeTypes.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>Backend used for indexing and retrieval</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </CardContent>
      </Card>

      {isVectorKnowledgeType(watchKnowledgeType) && (
        <Card>
          <CardHeader>
            <CardTitle>Vector settings</CardTitle>
            <CardDescription>Configure embedding model for vector-based retrieval</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="embedding_model"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Embedding model</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="text-embedding-3-small"
                      {...field}
                      value={field.value ?? ''}
                    />
                  </FormControl>
                  <FormDescription>LiteLLM model identifier, e.g. openai/text-embedding-3-small</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="vector_dimension"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Vector dimension</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      placeholder="1536"
                      {...field}
                      value={field.value ?? 1536}
                      onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                    />
                  </FormControl>
                  <FormDescription>Must match the embedding model output dimensionality</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="embedding_provider"
              render={({ field }) => (
                <FormItem className="sm:col-span-2">
                  <FormLabel>Embedding provider</FormLabel>
                  <FormControl>
                    <Combobox
                      options={providerOptions}
                      value={field.value ?? ''}
                      onValueChange={field.onChange}
                      placeholder="Select AI Provider..."
                      searchPlaceholder="Search providers..."
                      emptyText="No providers found."
                      linkTo={linkRoutes.aiProvider}
                    />
                  </FormControl>
                  <FormDescription>AI Provider for API key resolution</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          </CardContent>
        </Card>
      )}

      {watchKnowledgeType === 'chroma' && (
        <Card>
          <CardHeader>
            <CardTitle>Chroma connection settings</CardTitle>
            <CardDescription>Configure how this knowledge source connects to ChromaDB</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="chroma_mode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Chroma mode</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select mode" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {chromaModes.map((mode) => (
                        <SelectItem key={mode.value} value={mode.value}>
                          {mode.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>File: store on disk. Server: connect to a running Chroma server.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {watchChromaMode === 'Server' && (
              <>
                <FormField
                  control={form.control}
                  name="chroma_host"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Chroma host</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="localhost"
                          {...field}
                          value={field.value ?? ''}
                        />
                      </FormControl>
                      <FormDescription>Hostname or IP of the Chroma server</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="chroma_port"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Chroma port</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder="8000"
                          {...field}
                          value={field.value ?? 8000}
                          onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                        />
                      </FormControl>
                      <FormDescription>Port of the Chroma server</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="chroma_ssl"
                  render={({ field }) => (
                    <FormItem className="flex flex-row items-start space-x-3 space-y-0 sm:col-span-2">
                      <FormControl>
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                      <div className="space-y-1 leading-none">
                        <FormLabel>Use SSL (HTTPS)</FormLabel>
                        <FormDescription>Enable if your Chroma server uses HTTPS</FormDescription>
                      </div>
                    </FormItem>
                  )}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}

      {watchKnowledgeType === 'pgvector' && (
        <Card>
          <CardHeader>
            <CardTitle>PGVector connection settings</CardTitle>
            <CardDescription>Connect HUF Knowledge to PostgreSQL with the pgvector extension</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="pgvector_connection_mode"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Connection mode</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value ?? 'External PostgreSQL'}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select mode" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="External PostgreSQL">External PostgreSQL</SelectItem>
                      <SelectItem value="Site PostgreSQL">Site PostgreSQL</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormDescription>Use external PostgreSQL for MariaDB-backed Frappe sites</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="pgvector_table_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Table name</FormLabel>
                  <FormControl>
                    <Input placeholder="huf_knowledge_vectors" {...field} value={field.value ?? ''} />
                  </FormControl>
                  <FormDescription>PostgreSQL table used for vector chunks</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="pgvector_distance_metric"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Distance metric</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value ?? 'cosine'}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select metric" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="cosine">Cosine</SelectItem>
                      <SelectItem value="l2">L2</SelectItem>
                      <SelectItem value="inner_product">Inner product</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="pgvector_index_type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Index type</FormLabel>
                  <Select onValueChange={field.onChange} value={field.value ?? 'hnsw'}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Select index" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="hnsw">HNSW</SelectItem>
                      <SelectItem value="ivfflat">IVFFlat</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {watchPGVectorConnectionMode === 'External PostgreSQL' && (
              <>
                <FormField
                  control={form.control}
                  name="pgvector_host"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Host</FormLabel>
                      <FormControl>
                        <Input placeholder="localhost" {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="pgvector_port"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Port</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          placeholder="5432"
                          {...field}
                          value={field.value ?? 5432}
                          onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : undefined)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="pgvector_database"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Database</FormLabel>
                      <FormControl>
                        <Input placeholder="huf_vectors" {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="pgvector_user"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>User</FormLabel>
                      <FormControl>
                        <Input placeholder="postgres" {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="pgvector_password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Password</FormLabel>
                      <FormControl>
                        <Input type="password" {...field} value={field.value ?? ''} />
                      </FormControl>
                      <FormDescription>Stored in Frappe as a Password field</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="pgvector_sslmode"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>SSL mode</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value ?? 'prefer'}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="Select SSL mode" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="prefer">Prefer</SelectItem>
                          <SelectItem value="require">Require</SelectItem>
                          <SelectItem value="disable">Disable</SelectItem>
                          <SelectItem value="allow">Allow</SelectItem>
                          <SelectItem value="verify-ca">Verify CA</SelectItem>
                          <SelectItem value="verify-full">Verify full</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </>
            )}

            <div className="sm:col-span-2 pt-2">
              <h4 className="text-sm font-medium mb-2">Advanced Configuration</h4>
              <AdvancedConfigFields knowledgeType={watchKnowledgeType} />
            </div>
          </CardContent>
        </Card>
      )}

      {watchKnowledgeType === 'zvec' && (
        <Card>
          <CardHeader>
            <CardTitle>zvec Settings</CardTitle>
            <CardDescription>
              Embedded vector database — runs in-process, stores to a portable file, no server needed
            </CardDescription>
          </CardHeader>
          <CardContent>
            <h4 className="text-sm font-medium mb-2">Advanced Configuration</h4>
            <AdvancedConfigFields knowledgeType={watchKnowledgeType} />
          </CardContent>
        </Card>
      )}

      {watchKnowledgeType === 'redis' && (
        <Card>
          <CardHeader>
            <CardTitle>Redis connection settings</CardTitle>
            <CardDescription>
              Connect HUF Knowledge to Redis with RediSearch vector search
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <h4 className="text-sm font-medium mb-2">Advanced Configuration</h4>
            <AdvancedConfigFields knowledgeType={watchKnowledgeType} />
          </CardContent>
        </Card>
      )}

      {watchKnowledgeType === 'sqlite_hybrid' && (
        <Card>
          <CardHeader>
            <CardTitle>SQLite Hybrid settings</CardTitle>
            <CardDescription>
              Combines SQLite FTS keyword search with SQLite Vec similarity search (reciprocal rank fusion)
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <AdvancedConfigFields knowledgeType={watchKnowledgeType} />
          </CardContent>
        </Card>
      )}

      {watchKnowledgeType === 'weaviate' && (
        <Card>
          <CardHeader>
            <CardTitle>Weaviate connection settings</CardTitle>
            <CardDescription>Connect HUF Knowledge to a Weaviate vector database</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <AdvancedConfigFields knowledgeType={watchKnowledgeType} />
          </CardContent>
        </Card>
      )}

      {watchKnowledgeType === 'faiss' && (
        <Card>
          <CardHeader>
            <CardTitle>FAISS settings</CardTitle>
            <CardDescription>
              Embedded similarity search index — runs in-process, stores to a local file
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <AdvancedConfigFields knowledgeType={watchKnowledgeType} />
          </CardContent>
        </Card>
      )}

      {watchKnowledgeType === 'pinecone' && (
        <Card>
          <CardHeader>
            <CardTitle>Pinecone connection settings</CardTitle>
            <CardDescription>Connect HUF Knowledge to a Pinecone vector database</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-6">
            <AdvancedConfigFields knowledgeType={watchKnowledgeType} />
          </CardContent>
        </Card>
      )}

      <Collapsible defaultOpen={false}>
        <Card>
          <CollapsibleTrigger asChild>
            <CardHeader className="cursor-pointer select-none">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Advanced settings</CardTitle>
                  <CardDescription>Control how content is split into chunks for indexing</CardDescription>
                </div>
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 [[data-state=open]_&]:rotate-180" />
              </div>
            </CardHeader>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <CardContent className="grid gap-6 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="chunk_size"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Chunk size</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="512"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : 512)}
                      />
                    </FormControl>
                    <FormDescription>Number of tokens per chunk (minimum 100)</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="chunk_overlap"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Chunk overlap</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        placeholder="50"
                        {...field}
                        onChange={(e) => field.onChange(e.target.value ? Number(e.target.value) : 50)}
                      />
                    </FormControl>
                    <FormDescription>Overlap between adjacent chunks</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  );
}
