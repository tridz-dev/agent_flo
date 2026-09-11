import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { useParams, useNavigate, useBlocker, useSearchParams, type Location } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Form } from '../components/ui/form';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { toast } from 'sonner';
import {
  getKnowledgeSource,
  createKnowledgeSource,
  updateKnowledgeSource,
  rebuildIndex,
  getKnowledgeInputs,
  reprocessInput,
  deleteKnowledgeInput,
} from '../services/knowledgeApi';
import type { KnowledgeInputDoc } from '../types/knowledge.types';
import { getProviders } from '../services/providerApi';
import type { AIProvider } from '../types/agent.types';
import { getFrappeErrorMessage } from '../lib/frappe-error';
import { KnowledgeSourceHeader } from '../components/knowledge/KnowledgeSourceHeader';
import { GeneralTab } from '../components/knowledge/GeneralTab';
import { StatusTab } from '../components/knowledge/StatusTab';
import { KnowledgeInputsModal } from '../components/knowledge/KnowledgeInputsModal';
import {
  knowledgeSourceFormSchema,
  type KnowledgeSourceFormValues,
} from '../components/knowledge/types';

function parseAdvancedConfig(value: unknown): Record<string, unknown> {
  if (typeof value === 'string' && value.trim()) {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringifyAdvancedConfig(value: Record<string, unknown> | undefined): string {
  return JSON.stringify(value || {});
}
import type { KnowledgeSourceDoc } from '../types/knowledge.types';
import { createFormSubmitHandler, type TabFieldMapping } from '../utils/formValidation';
import { useSaveShortcut } from '../hooks/useSaveShortcut';
import { UnsavedChangesDialog } from '../components/UnsavedChangesDialog';
import { linkKnowledgeToAgent } from '../services/agentApi';

export { KnowledgeSourceFormPage };
export default KnowledgeSourceFormPage;

function mapDocToFormValues(doc: Partial<KnowledgeSourceDoc>): KnowledgeSourceFormValues {
  return {
    source_name: doc.source_name || '',
    description: doc.description || '',
    knowledge_type: doc.knowledge_type || 'sqlite_fts',
    scope: doc.scope || 'Site',
    storage_mode: doc.storage_mode || 'Frappe File',
    chunk_size: doc.chunk_size ?? 512,
    chunk_overlap: doc.chunk_overlap ?? 50,
    disabled: doc.disabled === 1,
    embedding_model: doc.embedding_model || '',
    vector_dimension: doc.vector_dimension ?? 1536,
    embedding_provider: doc.embedding_provider || '',
    chroma_mode: doc.chroma_mode || 'File',
    chroma_host: doc.chroma_host || 'localhost',
    chroma_port: doc.chroma_port ?? 8000,
    chroma_ssl: doc.chroma_ssl === 1,
    pgvector_connection_mode: doc.pgvector_connection_mode || 'External PostgreSQL',
    pgvector_table_name: doc.pgvector_table_name || 'huf_knowledge_vectors',
    pgvector_distance_metric: doc.pgvector_distance_metric || 'cosine',
    pgvector_index_type: doc.pgvector_index_type || 'hnsw',
    pgvector_host: doc.pgvector_host || 'localhost',
    pgvector_port: doc.pgvector_port ?? 5432,
    pgvector_database: doc.pgvector_database || '',
    pgvector_user: doc.pgvector_user || '',
    pgvector_password: doc.pgvector_password || '',
    pgvector_sslmode: doc.pgvector_sslmode || 'prefer',
    advanced_config: parseAdvancedConfig(doc.advanced_config),
  };
}

function KnowledgeSourceFormPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const fromAgent = searchParams.get('agent');
  const autoOpenUpload = searchParams.get('upload') === '1';
  const isNew = id === 'new';
  const skipBlockRef = useRef(false);

  const tabConfig = {
    general: {
      label: 'General',
      fields: [
        'source_name',
        'description',
        'knowledge_type',
        'scope',
        'storage_mode',
        'chunk_size',
        'chunk_overlap',
        'embedding_model',
        'vector_dimension',
        'embedding_provider',
        'chroma_mode',
        'chroma_host',
        'chroma_port',
        'chroma_ssl',
        'pgvector_connection_mode',
        'pgvector_table_name',
        'pgvector_distance_metric',
        'pgvector_index_type',
        'pgvector_host',
        'pgvector_port',
        'pgvector_database',
        'pgvector_user',
        'pgvector_password',
        'pgvector_sslmode',
        'advanced_config',
      ],
      default: true,
      disabled: false,
    },
    status: {
      label: 'Status',
      fields: [],
      default: false,
      disabled: isNew,
    },
  } as const;

  const validTabs = useMemo(() => Object.keys(tabConfig), []);
  const defaultTab = useMemo(
    () => Object.entries(tabConfig).find(([, config]) => config.default)?.[0] || validTabs[0],
    [validTabs],
  );
  const tabFieldMapping: TabFieldMapping = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(tabConfig).map(([key, config]) => [key, [...config.fields]]),
      ),
    [],
  );
  const tabLabels = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(tabConfig).map(([key, config]) => [key, config.label]),
      ),
    [],
  );

  const [activeTab, setActiveTab] = useState<string>(() => {
    const hashFromUrl = window.location.hash.slice(1);
    return hashFromUrl && validTabs.includes(hashFromUrl) ? hashFromUrl : defaultTab;
  });

  useEffect(() => {
    const handleHashChange = () => {
      const hashFromUrl = window.location.hash.slice(1);
      const tab = hashFromUrl && validTabs.includes(hashFromUrl) ? hashFromUrl : defaultTab;
      setActiveTab(tab);
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [defaultTab, validTabs]);

  const handleTabChange = (value: string) => {
    setActiveTab(value);
    if (value === defaultTab) {
      window.history.replaceState(null, '', window.location.pathname);
    } else {
      window.location.hash = value;
    }
  };

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [inputsModalOpen, setInputsModalOpen] = useState(false);
  const [sourceDoc, setSourceDoc] = useState<KnowledgeSourceDoc | null>(null);
  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [inputs, setInputs] = useState<KnowledgeInputDoc[]>([]);
  const [inputsLoading, setInputsLoading] = useState(false);
  const allowNavigationRef = useRef(false);

  const form = useForm<KnowledgeSourceFormValues>({
    resolver: zodResolver(knowledgeSourceFormSchema),
    defaultValues: mapDocToFormValues({}),
  });

  const watchDisabled = form.watch('disabled');
  const isDirty = form.formState.isDirty;
  const [initialDisabled, setInitialDisabled] = useState(false);
  const disabledChanged = watchDisabled !== initialDisabled;
  const showSaveButton = isNew || isDirty || disabledChanged;
  // Deliberately excludes `isNew` - a blank new-source form has nothing to
  // lose, so it shouldn't block navigation until the user actually changes something.
  const hasUnsavedChanges = isDirty || disabledChanged;

  const shouldBlock = useCallback(
    ({ currentLocation, nextLocation }: { currentLocation: Location; nextLocation: Location }) => {
      if (skipBlockRef.current) {
        skipBlockRef.current = false;
        return false;
      }
      if (allowNavigationRef.current) return false;
      if (!hasUnsavedChanges) return false;
      return (
        currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search
      );
    },
    [hasUnsavedChanges]
  );

  const blocker = useBlocker(shouldBlock);

  const loadSource = useCallback(
    async (name: string) => {
      try {
        const data = await getKnowledgeSource(name);
        setSourceDoc(data);
        const formValues = mapDocToFormValues(data);
        form.reset(formValues);
        setInitialDisabled(formValues.disabled);
      } catch (error) {
        console.error('Error loading knowledge source:', error);
        const msg = getFrappeErrorMessage(error);
        toast.error(msg || 'Failed to load knowledge source');
      }
    },
    [form],
  );

  const loadInputs = useCallback(
    async (name: string) => {
      setInputsLoading(true);
      try {
        const data = await getKnowledgeInputs(name);
        setInputs(data);
      } catch (error) {
        console.error('Error loading knowledge inputs:', error);
      } finally {
        setInputsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    getProviders()
      .then((data) => setProviders(data as AIProvider[]))
      .catch((err) => console.error('Error loading providers:', err));
  }, []);

  useEffect(() => {
    if (id && !isNew) {
      Promise.all([loadSource(id), loadInputs(id)]).then(() => setLoading(false));
    } else if (isNew) {
      setLoading(false);
    }
  }, [id, isNew, loadSource, loadInputs]);

  // Poll source status + inputs while indexing/rebuilding is in flight, so the
  // Status tab reflects progress without the user manually refreshing.
  const IN_PROGRESS_SOURCE_STATUSES = useMemo(() => new Set(['Indexing', 'Rebuilding']), []);
  const IN_PROGRESS_INPUT_STATUSES = useMemo(() => new Set(['Pending', 'Processing']), []);
  const isSourceInProgress = !!sourceDoc && IN_PROGRESS_SOURCE_STATUSES.has(sourceDoc.status);
  const hasInProgressInput = inputs.some((input) => IN_PROGRESS_INPUT_STATUSES.has(input.status));
  const STATUS_POLL_INTERVAL_MS = 4000;

  useEffect(() => {
    if (isNew || !id) return;
    if (!isSourceInProgress && !hasInProgressInput) return;

    const intervalId = setInterval(() => {
      void Promise.all([loadSource(id), loadInputs(id)]);
    }, STATUS_POLL_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [isNew, id, isSourceInProgress, hasInProgressInput, loadSource, loadInputs]);

  // After a freshly-created source redirects here with ?upload=1, jump straight
  // into the inputs modal so uploading files doesn't need an extra click.
  useEffect(() => {
    if (!isNew && id && autoOpenUpload) {
      setInputsModalOpen(true);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('upload');
          return next;
        },
        { replace: true },
      );
    }
  }, [isNew, id, autoOpenUpload, setSearchParams]);

  const onSubmit = async (values: KnowledgeSourceFormValues) => {
    setSaving(true);
    try {
      const payload: Partial<KnowledgeSourceDoc> = {
        source_name: values.source_name,
        description: values.description || '',
        knowledge_type: values.knowledge_type,
        scope: values.scope,
        storage_mode: values.storage_mode as KnowledgeSourceDoc['storage_mode'],
        chunk_size: values.chunk_size,
        chunk_overlap: values.chunk_overlap,
        disabled: values.disabled ? 1 : 0,
        embedding_model: values.embedding_model || '',
        vector_dimension: values.vector_dimension ?? 1536,
        embedding_provider: values.embedding_provider || '',
        chroma_mode: values.chroma_mode,
        chroma_host: values.chroma_host || '',
        chroma_port: values.chroma_port ?? 8000,
        chroma_ssl: values.chroma_ssl ? 1 : 0,
        pgvector_connection_mode: values.pgvector_connection_mode,
        pgvector_table_name: values.pgvector_table_name || 'huf_knowledge_vectors',
        pgvector_distance_metric: values.pgvector_distance_metric,
        pgvector_index_type: values.pgvector_index_type,
        pgvector_host: values.pgvector_host || '',
        pgvector_port: values.pgvector_port ?? 5432,
        pgvector_database: values.pgvector_database || '',
        pgvector_user: values.pgvector_user || '',
        pgvector_password: values.pgvector_password || '',
        pgvector_sslmode: values.pgvector_sslmode,
        advanced_config: stringifyAdvancedConfig(values.advanced_config),
      };

      if (isNew) {
        const created = await createKnowledgeSource(payload);
        const formValues = mapDocToFormValues(created);
        form.reset(formValues);
        setInitialDisabled(formValues.disabled);

        if (fromAgent) {
          const linkedRow = await linkKnowledgeToAgent(fromAgent, created.name);
          toast.success('Knowledge source created and linked to agent');
          allowNavigationRef.current = true;
          navigate(`/agents/${fromAgent}#knowledge`, {
            state: { linkedKnowledge: linkedRow, showTab: 'knowledge' },
            replace: true,
          });
          return;
        }

        toast.success('Knowledge source created');
        setSourceDoc(created);
        allowNavigationRef.current = true;
        navigate(`/knowledge/${created.name}?upload=1`);
      } else if (id) {
        const updated = await updateKnowledgeSource(id, payload);
        toast.success('Knowledge source updated');
        setSourceDoc(updated);
        const formValues = mapDocToFormValues(updated);
        form.reset(formValues);
        setInitialDisabled(formValues.disabled);

        if (updated.name && updated.name !== id) {
          skipBlockRef.current = true;
          navigate(`/knowledge/${encodeURIComponent(updated.name)}`, { replace: true });
          return;
        }
      }
    } catch (error) {
      console.error('Error saving knowledge source:', error);
      const msg = getFrappeErrorMessage(error);
      toast.error(msg || 'Failed to save knowledge source');
    } finally {
      setSaving(false);
    }
  };

  const handleFormSubmit = useMemo(
    () => createFormSubmitHandler(form, activeTab, tabFieldMapping, tabLabels, onSubmit),
    [form, activeTab, tabFieldMapping, tabLabels],
  );

  useSaveShortcut({
    onSave: handleFormSubmit,
    enabled: showSaveButton,
    isSubmitting: saving,
  });

  const handleRebuildIndex = async () => {
    if (!id || isNew) return;
    setRebuilding(true);
    try {
      await rebuildIndex(id);
      toast.success('Rebuild started');
      await Promise.all([loadSource(id), loadInputs(id)]);
    } catch (error) {
      const msg = getFrappeErrorMessage(error);
      toast.error(msg || 'Failed to start rebuild');
    } finally {
      setRebuilding(false);
    }
  };

  const handleRefresh = async () => {
    if (!id || isNew) return;
    setRefreshing(true);
    try {
      await Promise.all([loadSource(id), loadInputs(id)]);
      toast.success('Refreshed');
    } catch {
      toast.error('Failed to refresh');
    } finally {
      setRefreshing(false);
    }
  };

  const handleSourceChanged = async () => {
    if (id && !isNew) {
      await Promise.all([loadSource(id), loadInputs(id)]);
    }
  };

  const handleReprocessInput = async (name: string) => {
    try {
      await reprocessInput(name);
      toast.success('Reprocessing started');
      if (id) await Promise.all([loadSource(id), loadInputs(id)]);
    } catch (error) {
      const msg = getFrappeErrorMessage(error);
      toast.error(msg || 'Failed to reprocess knowledge input');
    }
  };

  const handleDeleteInput = async (name: string) => {
    try {
      await deleteKnowledgeInput(name);
      toast.success('Knowledge input deleted');
      if (id) await Promise.all([loadSource(id), loadInputs(id)]);
    } catch (error) {
      const msg = getFrappeErrorMessage(error);
      toast.error(msg || 'Failed to delete knowledge input');
    }
  };

  const handleCancel = () => {
    navigate(-1);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="font-body text-steel-soft">Loading knowledge source...</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="p-6 space-y-6 max-w-6xl mx-auto">
        <KnowledgeSourceHeader
          form={form}
          watchDisabled={watchDisabled}
          isNew={isNew}
          showSaveButton={showSaveButton}
          saving={saving}
          rebuilding={rebuilding}
          refreshing={refreshing}
          sourceStatus={sourceDoc?.status}
          fromAgent={fromAgent || undefined}
          onSave={handleFormSubmit}
          onCancel={fromAgent ? handleCancel : undefined}
          onRebuildIndex={handleRebuildIndex}
          onRefresh={handleRefresh}
          onOpenInputs={() => setInputsModalOpen(true)}
        />

        <Form {...form}>
          <form onSubmit={handleFormSubmit} className="space-y-6">
            <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
              <TabsList layout="grid" cols={2}>
                {Object.entries(tabConfig).map(([tabKey, config]) => (
                  <TabsTrigger key={tabKey} value={tabKey} disabled={config.disabled}>
                    {config.label}
                  </TabsTrigger>
                ))}
              </TabsList>

              <TabsContent value="general" className="space-y-4">
                <GeneralTab form={form} isNew={isNew} providers={providers} />
              </TabsContent>

              <TabsContent value="status" className="space-y-4">
                <StatusTab
                  source={sourceDoc}
                  inputs={inputs}
                  inputsLoading={inputsLoading}
                  onReprocessInput={handleReprocessInput}
                  onDeleteInput={handleDeleteInput}
                />
              </TabsContent>
            </Tabs>
          </form>
        </Form>

        {!isNew && id && (
          <KnowledgeInputsModal
            open={inputsModalOpen}
            onOpenChange={setInputsModalOpen}
            knowledgeSource={id}
            onSourceChanged={handleSourceChanged}
          />
        )}

        <UnsavedChangesDialog blocker={blocker} />
      </div>
    </div>
  );
}
