import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

import {
  getAgentSettings,
  updateAgentSettings,
  type AgentSettingsDoc,
} from '@/services/agentSettingsApi';

import {
  getProviders,
  getModels,
  createProvider,
  createModel,
} from '@/services/providerApi';

import type { AIProvider, AIModel } from '@/types/agent.types';
import { settleAll } from '@/lib/settleAll';
import { getFrappeErrorMessage } from '@/lib/frappe-error';

export { AgentSettingsTab };
export default AgentSettingsTab;

function AgentSettingsTab() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [providers, setProviders] = useState<AIProvider[]>([]);
  const [models, setModels] = useState<AIModel[]>([]);

  const [defaultProvider, setDefaultProvider] = useState<string | undefined>();
  const [defaultModel, setDefaultModel] = useState<string | undefined>();

  const [providerSearch, setProviderSearch] = useState('');
  const [modelSearch, setModelSearch] = useState('');

  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);

  const [newProviderName, setNewProviderName] = useState('');
  const [newProviderApiKey, setNewProviderApiKey] = useState('');
  const [newModelName, setNewModelName] = useState('');

  const [creatingProvider, setCreatingProvider] = useState(false);
  const [creatingModel, setCreatingModel] = useState(false);

  useEffect(() => {
    (async () => {
      setLoading(true);

      const errorLabels = ['providers', 'agent settings'];

      const [providersRes, settings] = await settleAll(
        [getProviders(), getAgentSettings()],
        (index, error) => {
          toast.error(
            `Failed to load ${errorLabels[index]}: ${getFrappeErrorMessage(error)}`,
          );
        },
      );

      if (providersRes) {
        setProviders(
          Array.isArray(providersRes) ? providersRes : providersRes.items,
        );
      }

      setDefaultProvider(settings?.default_provider || undefined);
      setDefaultModel(settings?.default_model || undefined);

      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (!defaultProvider) {
      setModels([]);
      return;
    }

    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        const result = await getModels({
          provider: defaultProvider,
          search: modelSearch || undefined,
          limit: 50,
        });

        if (!cancelled) {
          setModels(Array.isArray(result) ? result : result.items);
        }
      } catch {
        if (!cancelled) {
          setModels([]);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [defaultProvider, modelSearch]);

  useEffect(() => {
    let cancelled = false;

    const timer = setTimeout(async () => {
      try {
        const result = await getProviders({
          search: providerSearch || undefined,
          limit: 50,
        });

        if (!cancelled) {
          setProviders(
            Array.isArray(result) ? result : result.items,
          );
        }
      } catch {
        if (!cancelled) {
          setProviders([]);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [providerSearch]);

  const handleProviderChange = (value: string) => {
    setDefaultProvider(value || undefined);
    setDefaultModel(undefined);
    setModelSearch('');
  };

  const handleAddProvider = () => {
    setNewProviderName('');
    setNewProviderApiKey('');
    setProviderDialogOpen(true);
  };

  const handleCreateProvider = async () => {
    const providerName = newProviderName.trim();

    if (!providerName) {
      toast.error('Provider name is required');
      return;
    }

    setCreatingProvider(true);

    try {
      const created = await createProvider({
        provider_name: providerName,
        api_key: newProviderApiKey.trim() || undefined,
      });

      const result = await getProviders({
        limit: 50,
      });

      const refreshedProviders = Array.isArray(result)
        ? result
        : result.items;

      setProviders(refreshedProviders);

      const createdName = created.name || providerName;

      setDefaultProvider(createdName);
      setDefaultModel(undefined);
      setProviderDialogOpen(false);

      toast.success('Provider created');
    } catch {
      // createProvider already handles the Frappe error
    } finally {
      setCreatingProvider(false);
    }
  };

  const handleAddModel = () => {
    if (!defaultProvider) {
      toast.error('Select a provider first');
      return;
    }

    setNewModelName('');
    setModelDialogOpen(true);
  };

  const handleCreateModel = async () => {
    const modelName = newModelName.trim();

    if (!modelName) {
      toast.error('Model name is required');
      return;
    }

    if (!defaultProvider) {
      toast.error('Select a provider first');
      return;
    }

    setCreatingModel(true);

    try {
      const created = await createModel({
        model_name: modelName,
        provider: defaultProvider,
      });

      const result = await getModels({
        provider: defaultProvider,
        limit: 50,
      });

      const refreshedModels = Array.isArray(result)
        ? result
        : result.items;

      setModels(refreshedModels);

      const createdName = created.name || modelName;

      setDefaultModel(createdName);
      setModelDialogOpen(false);

      toast.success('Model created');
    } catch {
      // createModel already handles the Frappe error
    } finally {
      setCreatingModel(false);
    }
  };

  const handleSave = async () => {
    if (
      defaultModel &&
      !models.some((model) => model.name === defaultModel)
    ) {
      toast.error(
        'Default Model must belong to the selected Default Provider',
      );
      return;
    }

    setSaving(true);

    try {
      const data: Partial<AgentSettingsDoc> = {
        default_provider: defaultProvider || undefined,
        default_model: defaultModel || undefined,
      };

      await updateAgentSettings(data);

      toast.success('Agent Settings saved');
    } catch {
      // handleFrappeError in the service already surfaces a toast
    } finally {
      setSaving(false);
    }
  };

  const providerOptions = [
    ...providers.map((provider) => ({
      value: provider.name,
      label: provider.provider_name || provider.name,
    })),
    {
      value: '__add_provider__',
      label: '+ Add Provider',
      action: handleAddProvider,
    },
  ];

  const modelOptions = [
    ...models.map((model) => ({
      value: model.name,
      label: model.model_name || model.name,
    })),
    ...(defaultProvider
      ? [
          {
            value: '__add_model__',
            label: '+ Add Model',
            action: handleAddModel,
          },
        ]
      : []),
  ];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="max-w-2xl space-y-6">
        <p className="text-sm text-muted-foreground">
          Default provider and model applied when a new agent doesn't specify
          its own.
        </p>

        <Card>
          <CardHeader>
            <CardTitle>Defaults</CardTitle>

            <CardDescription>
              Used as a fallback for new agents that don't select a
              provider/model explicitly.
            </CardDescription>
          </CardHeader>

          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>Default provider</Label>

              <Combobox
                options={providerOptions}
                value={defaultProvider}
                onValueChange={handleProviderChange}
                onSearchChange={setProviderSearch}
                shouldFilter={false}
                placeholder="None"
                searchPlaceholder="Search providers..."
                emptyText="No providers found"
              />
            </div>

            <div className="space-y-2">
              <Label>Default model</Label>

              <Combobox
                options={modelOptions}
                value={defaultModel}
                onValueChange={(value) =>
                  setDefaultModel(value || undefined)
                }
                onSearchChange={setModelSearch}
                shouldFilter={false}
                disabled={!defaultProvider}
                placeholder={
                  defaultProvider
                    ? 'Select model'
                    : 'Select a provider first'
                }
                searchPlaceholder="Search models..."
                emptyText={
                  defaultProvider
                    ? 'No models found'
                    : 'Select a provider first'
                }
              />
            </div>
          </CardContent>

          <div className="flex justify-end p-6 pt-0">
            <Button onClick={handleSave} disabled={saving}>
              {saving && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Save
            </Button>
          </div>
        </Card>
      </div>

      <Dialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Provider</DialogTitle>

            <DialogDescription>
              Create a new AI provider.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Provider name</Label>

              <Input
                value={newProviderName}
                onChange={(event) =>
                  setNewProviderName(event.target.value)
                }
                placeholder="e.g. OpenAI"
              />
            </div>

            <div className="space-y-2">
              <Label>API key</Label>

              <Input
                type="password"
                value={newProviderApiKey}
                onChange={(event) =>
                  setNewProviderApiKey(event.target.value)
                }
                placeholder="Optional"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setProviderDialogOpen(false)}
              disabled={creatingProvider}
            >
              Cancel
            </Button>

            <Button
              onClick={handleCreateProvider}
              disabled={creatingProvider}
            >
              {creatingProvider && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Create Provider
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={modelDialogOpen}
        onOpenChange={setModelDialogOpen}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Model</DialogTitle>

            <DialogDescription>
              Create a new model for the selected provider.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Provider</Label>

              <Input
                value={defaultProvider || ''}
                disabled
              />
            </div>

            <div className="space-y-2">
              <Label>Model name</Label>

              <Input
                value={newModelName}
                onChange={(event) =>
                  setNewModelName(event.target.value)
                }
                placeholder="e.g. gpt-5"
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setModelDialogOpen(false)}
              disabled={creatingModel}
            >
              Cancel
            </Button>

            <Button
              onClick={handleCreateModel}
              disabled={creatingModel}
            >
              {creatingModel && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Create Model
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
