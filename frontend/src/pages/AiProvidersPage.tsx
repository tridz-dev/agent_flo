import { ArrowRight, Check, CheckCircle2, Cloud, ExternalLink, KeyRound, Loader2, Settings, Sparkles, Trash2, XCircle } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Badge } from '../components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Checkbox } from '../components/ui/checkbox';
import { PageFrame } from '@/layouts/PageFrame';
import { ProviderModelTabs } from '@/components/settings/ProviderModelTabs';
import { FilterBar, GridView, ItemCard, LoadMoreButton, EmptyState } from '../components/dashboard';
import { useInfiniteScroll } from '../hooks/useInfiniteScroll';
import {
  createModel,
  getModels,
  getProvider,
  getProviders,
  updateProvider,
  createProvider,
  deleteProvider,
  testProviderConnection,
} from '../services/providerApi';
import type { ProviderConnectionTestResult } from '../services/providerApi';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { AIProvider, AIModel } from '../types/agent.types';
import { getFrappeErrorMessage } from '@/lib/frappe-error';
import { ProviderBrandSelect } from '@/components/providers/ProviderBrandSelect';
import { ProviderBrandIcon } from '@/components/providers/ProviderBrandIcon';
import { suggestBrandFromProviderName, resolveProviderBrand } from '@/utils/providerBrands';
import { useSaveShortcut } from '@/hooks/useSaveShortcut';

interface AiProvidersPageProps {
  addProviderKey?: number;
}

type StarterPath = 'openrouter' | 'google';

const STARTER_PATHS: Record<StarterPath, {
  providerName: string;
  providerBrand: string;
  modelName: string;
  title: string;
  description: string;
  caution: string;
  signupUrl: string;
  signupLabel: string;
  freePricing: boolean;
}> = {
  openrouter: {
    providerName: 'OpenRouter',
    providerBrand: 'openrouter',
    modelName: 'openrouter/free',
    title: 'Try OpenRouter free',
    description: 'Start with a zero-cost router that selects an available free model for each request.',
    caution: 'Best for learning and demos. Free models rotate often, have lower limits, and are not a production reliability tier. Visit openrouter.ai/models?max_price=0 to pick a specific free model.',
    signupUrl: 'https://openrouter.ai/keys',
    signupLabel: 'Get an OpenRouter key',
    freePricing: true,
  },
  google: {
    providerName: 'Google',
    providerBrand: 'google',
    modelName: 'gemini-3.5-flash',
    title: 'Try Gemini with Google AI Studio',
    description: 'Use Gemini 3.5 Flash with the Google Gemini API free tier to explore Huf.',
    caution: 'Free-tier limits apply. Google states that free-tier content may be used to improve its products; avoid sensitive production data.',
    signupUrl: 'https://aistudio.google.com/app/apikey',
    signupLabel: 'Get a Google AI Studio key',
    freePricing: false,
  },
};

export function AiProvidersPage({ addProviderKey }: AiProvidersPageProps) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const configureHandledRef = useRef(false);
  const [models, setModels] = useState<AIModel[]>([]);
  const [configureModalOpen, setConfigureModalOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<AIProvider | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [loadingProvider, setLoadingProvider] = useState(false);
  const [saving, setSaving] = useState(false);
  const [starterPath, setStarterPath] = useState<StarterPath | null>(null);
  const [completedStarter, setCompletedStarter] = useState<StarterPath | null>(null);
  const [starterApiKey, setStarterApiKey] = useState('');
  const [starterSaving, setStarterSaving] = useState(false);
  const [formData, setFormData] = useState({
    provider_name: '',
    api_key: '',
    provider_brand: '',
    is_local_llm: false,
    api_base_url: '',
  });
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionTest, setConnectionTest] = useState<ProviderConnectionTestResult | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AIProvider | null>(null);
  const [deleting, setDeleting] = useState(false);

  const emptyFormData = {
    provider_name: '',
    api_key: '',
    provider_brand: '',
    is_local_llm: false,
    api_base_url: '',
  };

  const {
    items: providers,
    hasMore,
    initialLoading,
    loadingMore,
    search,
    setSearch,
    loadMore,
    total,
    reset,
    error,
  } = useInfiniteScroll<
    { page?: number; limit?: number; start?: number; search?: string },
    AIProvider
  >({
    fetchFn: async (params) => {
      const response = await getProviders({
        page: params.page,
        limit: params.limit,
        start: params.start,
        search: params.search,
      });

      // Handle both old (array) and new (paginated) response formats
      if (Array.isArray(response)) {
        return {
          data: response,
          hasMore: false,
          total: response.length,
        };
      }

      // Convert PaginatedProvidersResponse to PaginatedResponse format
      return {
        data: response.items,
        hasMore: response.hasMore,
        total: response.total,
      };
    },
    initialParams: {},
    pageSize: 9,
    debounceMs: 300,
    autoLoad: true,
  });

  // Show error toast when there's an error
  useEffect(() => {
    if (error) {
      toast.error('Failed to load providers', {
        description: error.message || 'An error occurred while fetching providers. Please try again.',
        duration: 5000,
      });
    }
  }, [error]);

  useEffect(() => {
    getModels().then((modelsData) => {
      const modelsArray: AIModel[] = Array.isArray(modelsData)
        ? modelsData
        : ((modelsData as { items?: AIModel[] }).items ?? []);
      setModels(modelsArray);
    }).catch((error) => {
      console.error('Error fetching models:', error);
      toast.error('Failed to load models', {
        description: error instanceof Error ? error.message : 'An error occurred while fetching models.',
        duration: 5000,
      });
    });
  }, []);

  const getModelCountForProvider = (providerName: string) => {
    return models.filter(m => m.provider === providerName).length;
  };

  const handleAddProvider = () => {
    setSelectedProvider(null);
    setIsEditing(false);
    setConnectionTest(null);
    setFormData({ ...emptyFormData });
    setConfigureModalOpen(true);
  };

  // Listen for add provider trigger from header
  useEffect(() => {
    if (addProviderKey && addProviderKey > 0) {
      handleAddProvider();
    }
  }, [addProviderKey]);

  const handleConfigure = async (provider: AIProvider) => {
    setSelectedProvider(provider);
    setIsEditing(true);
    setConfigureModalOpen(true);
    setLoadingProvider(true);
    setConnectionTest(null);

    try {
      const details = await getProvider(provider.name);
      setFormData({
        provider_name: details.provider_name || '',
        api_key: details.api_key || '',
        provider_brand: details.provider_brand || '',
        is_local_llm: details.is_local_llm === 1,
        api_base_url: details.api_base_url || '',
      });
    } catch (error) {
      toast.error('Failed to load provider details');
      console.error(error);
    } finally {
      setLoadingProvider(false);
    }
  };

  useEffect(() => {
    const starterParam = searchParams.get('starter');
    if (starterParam && (starterParam === 'openrouter' || starterParam === 'google')) {
      setStarterPath(starterParam as StarterPath);
      setSearchParams({}, { replace: true });
      return;
    }

    const configureId = searchParams.get('configure');
    if (!configureId || configureHandledRef.current) {
      return;
    }

    configureHandledRef.current = true;
    let cancelled = false;

    const openFromDeepLink = async () => {
      try {
        const listMatch = providers.find((provider) => provider.name === configureId);
        if (listMatch) {
          await handleConfigure(listMatch);
        } else {
          const details = await getProvider(configureId);
          await handleConfigure(details);
        }
      } catch (loadError) {
        if (!cancelled) {
          toast.error('Failed to open provider configuration');
          console.error(loadError);
        }
      } finally {
        if (!cancelled) {
          setSearchParams({}, { replace: true });
        }
      }
    };

    openFromDeepLink();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const handleSave = async () => {
    // Validate provider name is required
    if (!isEditing && !formData.provider_name.trim()) {
      toast.error('Provider name is required');
      return;
    }

    // Local providers need an endpoint URL instead of an API key
    if (formData.is_local_llm && !formData.api_base_url.trim()) {
      toast.error('API Base URL is required for local providers');
      return;
    }

    const providerBrand =
      formData.provider_brand ||
      suggestBrandFromProviderName(formData.provider_name) ||
      'other';

    setSaving(true);
    try {
      if (isEditing && selectedProvider) {
        await updateProvider(selectedProvider.name, {
          api_key: formData.api_key,
          provider_brand: providerBrand,
          is_local_llm: formData.is_local_llm ? 1 : 0,
          api_base_url: formData.api_base_url.trim(),
        });
        toast.success('Provider updated successfully');
      } else {
        await createProvider({
          provider_name: formData.provider_name.trim(),
          api_key: formData.api_key,
          provider_brand: providerBrand,
          is_local_llm: formData.is_local_llm ? 1 : 0,
          api_base_url: formData.api_base_url.trim(),
        });
        toast.success('Provider created successfully');
      }
      setConfigureModalOpen(false);
      // Reset form
      setFormData({ ...emptyFormData });
      // Refresh the list
      reset();
    } catch (error) {
      toast.error(`Failed to ${isEditing ? 'update' : 'create'} provider`, {
        description: getFrappeErrorMessage(error),
        duration: 8000,
      });
      console.error(error);
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    if (!selectedProvider) return;

    setTestingConnection(true);
    setConnectionTest(null);
    try {
      // Test what's in the form, not what was last saved. The API key is a
      // Password field, so it never comes back when the form is opened —
      // without sending the in-progress values, a key the user just typed
      // would never be the thing actually tested. These are used for the
      // probe only and are not persisted, so Cancel still discards edits.
      // `api_key` is omitted when blank so the saved key is used instead.
      const result = await testProviderConnection(selectedProvider.name, {
        ...(formData.api_key ? { api_key: formData.api_key } : {}),
        api_base_url: formData.api_base_url.trim(),
        provider_brand:
          formData.provider_brand || suggestBrandFromProviderName(formData.provider_name) || 'other',
        is_local_llm: formData.is_local_llm ? 1 : 0,
      });
      setConnectionTest(result);
    } catch (error) {
      toast.error('Connection test failed', {
        description: getFrappeErrorMessage(error),
        duration: 8000,
      });
      console.error(error);
    } finally {
      setTestingConnection(false);
    }
  };

  const handleStarterSetup = async () => {
    if (!starterPath || !starterApiKey.trim()) {
      toast.error('Enter an API key to continue');
      return;
    }

    const starter = STARTER_PATHS[starterPath];
    setStarterSaving(true);
    try {
      const providersResponse = await getProviders({ limit: 100 });
      const allProviders = Array.isArray(providersResponse) ? providersResponse : providersResponse.items;
      const existingProvider = allProviders.find(
        (provider) => provider.provider_name.toLowerCase() === starter.providerName.toLowerCase(),
      );
      const provider = existingProvider
        ? await updateProvider(existingProvider.name, {
            api_key: starterApiKey.trim(),
            provider_brand: starter.providerBrand,
          })
        : await createProvider({
            provider_name: starter.providerName,
            api_key: starterApiKey.trim(),
            provider_brand: starter.providerBrand,
          });

      const currentModels = await getModels();
      const modelExists = currentModels.some(
        (model) => model.model_name === starter.modelName && model.provider === provider.name,
      );
      if (!modelExists) {
        await createModel({
          model_name: starter.modelName,
          provider: provider.name,
          modalities: 'Text',
          use_custom_pricing: starter.freePricing ? 1 : 0,
          input_cost_per_1m_tokens: starter.freePricing ? 0 : null,
          output_cost_per_1m_tokens: starter.freePricing ? 0 : null,
        });
      }

      toast.success(`${starter.providerName} is ready`, {
        description: `You can now create an agent with ${starter.modelName}. The key has not been tested yet.`,
      });
      setCompletedStarter(starterPath);
      setStarterPath(null);
      setStarterApiKey('');
      reset();
      const refreshedModels = await getModels();
      setModels(refreshedModels);
    } catch (setupError) {
      toast.error('Could not finish starter setup', {
        description: 'Huf could not save this starter setup. Check the details and try again.',
      });
      console.error(setupError);
    } finally {
      setStarterSaving(false);
    }
  };

  useSaveShortcut({
    onSave: handleSave,
    enabled: configureModalOpen && !loadingProvider,
    isSubmitting: saving,
    allowInDialog: true,
  });

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteProvider(deleteTarget.name);
      toast.success('Provider deleted');
      setDeleteTarget(null);
      reset();
    } catch (deleteError) {
      toast.error('Failed to delete provider', {
        description: getFrappeErrorMessage(deleteError),
        duration: 8000,
      });
      console.error(deleteError);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <PageFrame
      title="AI providers"
      filters={
        <FilterBar
          searchPlaceholder="Search providers..."
          searchValue={search}
          onSearchChange={setSearch}
        />
      }
    >
      <ProviderModelTabs />
      <div className="bg-[color-mix(in_srgb,var(--signal)_6%,white)] rounded-xl p-4 space-y-3">
        <div className="flex items-start gap-3">
          <Sparkles className="h-4 w-4 mt-0.5 text-signal shrink-0" />
          <div>
            <h3 className="text-[14px] font-semibold text-ink">Get started with AI</h3>
            <p className="font-body text-[13px] text-steel mt-0.5">
              Pick a free-friendly starter path, add its key, and Huf will prepare a model for your first agent.
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          {completedStarter ? (
            <div className="flex w-full flex-col gap-3 border border-line bg-paper p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-good" />
                <div>
                  <p className="font-body text-[13px] font-medium text-ink">Your {STARTER_PATHS[completedStarter].providerName} starter is ready</p>
                  <p className="font-body text-xs text-steel">Next, create an agent and choose {STARTER_PATHS[completedStarter].modelName}.</p>
                </div>
              </div>
              <Button className="shrink-0" onClick={() => navigate('/agents/new')}>
                Create your first agent<ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          ) : (Object.entries(STARTER_PATHS) as [StarterPath, typeof STARTER_PATHS[StarterPath]][]).map(([path, starter]) => (
            <Button key={path} variant="ghost" className="h-auto flex-1 justify-between whitespace-normal text-left rounded-md bg-panel hover:bg-panel hover:shadow-md" onClick={() => setStarterPath(path)}>
              <span>
                <span className="block font-body font-medium text-[13px] text-ink">{starter.title}</span>
                <span className="mt-1 block font-mono text-[11px] text-steel-soft">{starter.modelName}</span>
              </span>
              <ArrowRight className="ml-3 h-4 w-4 shrink-0 text-steel" />
            </Button>
          ))}
        </div>
      </div>
      {error && !initialLoading && (
        <div className="text-center py-12">
          <p className="text-destructive mb-4">Failed to load providers</p>
          <p className="text-sm text-steel mb-4">{error.message || 'An error occurred while fetching providers.'}</p>
        </div>
      )}
      <GridView
        items={providers}
        columns={{ sm: 1, md: 2, lg: 3 }}
        loading={initialLoading}
        emptyState={
          search ? (
            <EmptyState
              variant="no-results"
              icon={Cloud}
              title="No providers found"
              filterTerm={search}
              secondaryAction={{ label: 'Clear search', onClick: () => setSearch('') }}
            />
          ) : (
            <EmptyState
              variant="create"
              icon={Cloud}
              title="No providers"
              description="Add an AI provider to connect models and start building agents."
              action={{ label: 'Add provider', onClick: handleAddProvider }}
            />
          )
        }
        renderItem={(provider) => {
          const providerModels = models.filter(m => m.provider === provider.name);
          const modelCount = getModelCountForProvider(provider.name);
          return (
            <ItemCard
              key={provider.name}
              title={provider.provider_name}
              description={provider.is_local_llm ? 'Self-hosted endpoint' : 'Cloud API provider'}
              icon={() => (
                <ProviderBrandIcon
                  brand={resolveProviderBrand(provider.provider_brand, provider.provider_name)}
                  size="sm"
                  showFallback
                />
              )}
              status={{ label: provider.is_local_llm ? 'Local' : 'Configured', variant: 'success' }}
              metadata={[
                { label: 'Models', value: `${modelCount}`, icon: undefined },
                { label: 'Brand', value: resolveProviderBrand(provider.provider_brand, provider.provider_name) || 'other', icon: undefined },
              ]}
              badges={[
                ...providerModels.slice(0, 3).map(model => ({
                  label: model.model_name,
                  variant: 'secondary' as const,
                })),
                ...(providerModels.length > 3
                  ? [{ label: `+${providerModels.length - 3} more`, variant: 'outline' as const }]
                  : []),
              ]}
              actions={[
                {
                  icon: Settings,
                  label: 'Configure',
                  onClick: () => handleConfigure(provider),
                  variant: 'ghost',
                },
              ]}
              menuActions={[
                {
                  icon: Trash2,
                  label: 'Delete',
                  onClick: () => setDeleteTarget(provider),
                  variant: 'destructive',
                },
              ]}
              onClick={() => handleConfigure(provider)}
            />
          );
        }}
        keyExtractor={(provider) => provider.name}
      />
      <LoadMoreButton
        hasMore={hasMore}
        loading={loadingMore}
        onLoadMore={loadMore}
        disabled={!!search || initialLoading}
      />
      {!hasMore && providers.length > 0 && (
        <div className="text-center py-4 text-sm font-body text-steel">
          {total !== undefined ? `Showing all ${total} providers` : 'No more providers to load'}
        </div>
      )}

      {/* Configure Provider Modal */}
      <Dialog open={configureModalOpen} onOpenChange={setConfigureModalOpen}>
        <DialogContent className="sm:max-w-[500px] max-h-[90vh] overflow-y-auto min-h-[500px]">
          <DialogHeader>
            <DialogTitle>
              {isEditing ? `Configure ${selectedProvider?.provider_name || 'Provider'}` : 'Add provider'}
            </DialogTitle>
            <DialogDescription>
              {isEditing ? 'Update provider configuration settings' : 'Create a new AI provider'}
            </DialogDescription>
          </DialogHeader>

          {loadingProvider ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-steel-soft" />
            </div>
          ) : (
            <div className="space-y-4 py-4">
              {!isEditing && (
                <div className="space-y-2">
                  <Label htmlFor="provider_name">
                    Provider name <span className="text-destructive">*</span>
                  </Label>
                  <Input
                    id="provider_name"
                    type="text"
                    placeholder="Enter provider name (e.g., OpenAI, Anthropic)"
                    value={formData.provider_name}
                    onChange={(e) => setFormData({ ...formData, provider_name: e.target.value })}
                    required
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor="api_key">
                  {formData.is_local_llm ? 'API Key (optional for local)' : 'API Key'}
                </Label>
                <Input
                  id="api_key"
                  type="password"
                  placeholder="Enter API key"
                  value={formData.api_key}
                  onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
                />
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="is_local_llm"
                  checked={formData.is_local_llm}
                  onCheckedChange={(checked) =>
                    setFormData({ ...formData, is_local_llm: checked === true })
                  }
                />
                <Label htmlFor="is_local_llm" weight="normal" className="cursor-pointer">
                  Is local LLM (self-hosted endpoint)
                </Label>
              </div>

              <div className="space-y-2">
                <Label htmlFor="api_base_url">
                  API Base URL
                  {formData.is_local_llm && <span className="text-destructive"> *</span>}
                </Label>
                <Input
                  id="api_base_url"
                  type="text"
                  placeholder={
                    formData.is_local_llm
                      ? 'http://host.docker.internal:11434'
                      : 'Leave blank to use the provider default (e.g. https://api.openai.com/v1)'
                  }
                  value={formData.api_base_url}
                  onChange={(e) => setFormData({ ...formData, api_base_url: e.target.value })}
                />
                {!formData.is_local_llm && (
                  <p className="text-xs text-muted-foreground">
                    Only needed for a custom or self-hosted endpoint (Azure, Moonshot, a LiteLLM proxy, etc.).
                  </p>
                )}
              </div>

              <ProviderBrandSelect
                value={formData.provider_brand}
                onChange={(provider_brand) => setFormData({ ...formData, provider_brand })}
                providerName={formData.provider_name}
                required
              />

              {isEditing && (
                <div className="space-y-3 rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label>Connection</Label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleTestConnection}
                      disabled={testingConnection || saving}
                    >
                      {testingConnection ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Testing...
                        </>
                      ) : (
                        'Test Connection'
                      )}
                    </Button>
                  </div>
                  {connectionTest && (
                    <div className="space-y-2 text-sm">
                      <div className="flex items-start gap-2">
                        {connectionTest.provider.ok ? (
                          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-good" />
                        ) : (
                          <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
                        )}
                        <div className="min-w-0">
                          <span className={connectionTest.provider.ok ? 'text-good' : 'text-destructive'}>
                            {connectionTest.provider.ok ? 'Endpoint reachable' : 'Endpoint unreachable'}
                          </span>
                          {connectionTest.provider.error && (
                            <p className="text-xs text-destructive break-words">{connectionTest.provider.error}</p>
                          )}
                        </div>
                      </div>
                      {connectionTest.models.map((model) => (
                        <div key={model.name} className="flex items-start gap-2">
                          {model.ok ? (
                            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-good" />
                          ) : (
                            <XCircle className="w-4 h-4 mt-0.5 shrink-0 text-destructive" />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1">
                              <span className="font-medium">{model.name}</span>
                              {model.capabilities?.map((cap) => (
                                <Badge key={cap} variant="secondary" size="sm">
                                  {cap}
                                </Badge>
                              ))}
                            </div>
                            {model.error && (
                              <p className="text-xs text-destructive break-words">{model.error}</p>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfigureModalOpen(false)}
              disabled={saving || loadingProvider}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || loadingProvider}
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {isEditing ? 'Saving...' : 'Creating...'}
                </>
              ) : (
                isEditing ? 'Save' : 'Create'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={starterPath !== null} onOpenChange={(open) => !open && setStarterPath(null)}>
        <DialogContent className="sm:max-w-[520px]">
          {starterPath && (() => {
            const starter = STARTER_PATHS[starterPath];
            return <>
              <DialogHeader>
                <DialogTitle>{starter.title}</DialogTitle>
                <DialogDescription>{starter.description}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                  <strong className="text-foreground">Good to know: </strong>{starter.caution}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="starter-api-key">API key</Label>
                  <Input id="starter-api-key" type="password" autoComplete="off" placeholder="Paste your API key" value={starterApiKey} onChange={(event) => setStarterApiKey(event.target.value)} />
                  <a className="inline-flex items-center gap-1 text-sm text-primary hover:underline" href={starter.signupUrl} target="_blank" rel="noreferrer">
                    {starter.signupLabel}<ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  {starterPath === 'openrouter' && (
                    <a
                      className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
                      href="https://openrouter.ai/models?max_price=0"
                      target="_blank"
                      rel="noreferrer"
                    >
                      Browse free models<ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                </div>
                <div className="rounded-md border p-3 text-sm">
                  <p className="font-medium">Huf will configure</p>
                  <p className="mt-1 text-muted-foreground">Provider: {starter.providerName} · Model: <code>{starter.modelName}</code></p>
                  <p className="mt-2 flex items-center gap-1 text-muted-foreground"><Check className="h-4 w-4 text-primary" /> Your key is stored in Huf's encrypted password field.</p>
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setStarterPath(null)} disabled={starterSaving}>Cancel</Button>
                <Button onClick={handleStarterSetup} disabled={starterSaving || !starterApiKey.trim()}>
                  {starterSaving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Setting up…</> : <><KeyRound className="mr-2 h-4 w-4" />Set up starter</>}
                </Button>
              </DialogFooter>
            </>;
          })()}
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!deleting && !open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.provider_name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the provider. Models linked to this provider will need
              a different provider before they can be used. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageFrame>
  );
}
