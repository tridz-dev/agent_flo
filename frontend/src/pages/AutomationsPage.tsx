import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Play, Pause, Archive, ExternalLink, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PageFrame } from '@/layouts/PageFrame';
import { FilterBar, GridView, ItemCard, EmptyState } from '@/components/dashboard';
import { usePageData } from '@/hooks/dashboard/usePageData';
import {
  listAutomations,
  listTriggers,
  runAutomationNow,
  pauseAutomation,
  resumeAutomation,
  archiveAutomation,
} from '@/services/automationApi';
import {
  formatAutomationTimestamp,
  automationStatusBadgeVariant,
  automationTriggerTypesLabel,
  automationStatusToggleAction,
  automationCanRunNow,
} from '@/utils/automationDisplay';
import type { Automation, AutomationTriggerType } from '@/types/automation.types';

interface AutomationRow extends Automation {
  triggerTypes: AutomationTriggerType[];
}

const statusOptions = [
  { label: 'All statuses', value: 'all' },
  { label: 'Active', value: 'Active' },
  { label: 'Draft', value: 'Draft' },
  { label: 'Paused', value: 'Paused' },
  { label: 'Error', value: 'Error' },
  { label: 'Archived', value: 'Archived' },
];

export function AutomationsPage() {
  const navigate = useNavigate();
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const fetchAutomations = useCallback(async () => {
    const automations = await listAutomations();
    const withTriggers = await Promise.all(
      automations.map(async (automation) => {
        const triggers = await listTriggers(automation.name);
        const triggerTypes = triggers
          .map((trigger) => trigger.trigger_type)
          .filter((type): type is AutomationTriggerType => !!type);
        return { ...automation, triggerTypes };
      })
    );
    return withTriggers;
  }, []);

  const { data: rows, allData, loading, error, search, setSearch, filters, setFilters, refresh } =
    usePageData<AutomationRow>({
      fetchFn: fetchAutomations,
      searchFields: ['automation_name', 'description'],
      filterFn: (item, activeFilters) =>
        !activeFilters.status || activeFilters.status === 'all' || item.status === activeFilters.status,
    });

  useEffect(() => {
    if (error) {
      toast.error('Failed to load automations', {
        description: error.message || 'An error occurred while fetching automations.',
      });
    }
  }, [error]);

  const setStatusFilter = (value: string) => setFilters((prev) => ({ ...prev, status: value }));

  const handleRunNow = async (automation: AutomationRow) => {
    setPendingAction(`run:${automation.name}`);
    try {
      await runAutomationNow(automation.name);
      toast.success(`Running "${automation.automation_name}"`);
    } catch (err) {
      toast.error('Failed to run automation', {
        description: err instanceof Error ? err.message : 'An error occurred.',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const handleTogglePause = async (automation: AutomationRow) => {
    setPendingAction(`pause:${automation.name}`);
    try {
      if (automation.status === 'Active') {
        await pauseAutomation(automation.name);
        toast.success('Automation paused');
      } else {
        await resumeAutomation(automation.name);
        toast.success('Automation resumed');
      }
      await refresh();
    } catch (err) {
      toast.error('Failed to update automation', {
        description: err instanceof Error ? err.message : 'An error occurred.',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const handleArchive = async (automation: AutomationRow) => {
    setPendingAction(`archive:${automation.name}`);
    try {
      await archiveAutomation(automation.name);
      toast.success('Automation archived');
      await refresh();
    } catch (err) {
      toast.error('Failed to archive automation', {
        description: err instanceof Error ? err.message : 'An error occurred.',
      });
    } finally {
      setPendingAction(null);
    }
  };

  const hasActiveFilters = !!search || (filters.status && filters.status !== 'all');

  return (
    <PageFrame
      title="Automations"
      actions={<Button onClick={() => navigate('/automations/new')}>New automation</Button>}
      filters={
        <FilterBar
          searchPlaceholder="Search automations..."
          searchValue={search}
          onSearchChange={setSearch}
          filters={[
            {
              label: 'Status',
              value: filters.status || 'all',
              options: statusOptions,
              onChange: setStatusFilter,
            },
          ]}
        />
      }
    >
      <GridView
        items={rows}
        columns={{ sm: 1, md: 2, lg: 3 }}
        loading={loading}
        emptyState={
          hasActiveFilters ? (
            <EmptyState
              variant="no-results"
              icon={Zap}
              title="No automations found"
              filterTerm={search}
              secondaryAction={{
                label: 'Clear filters',
                onClick: () => {
                  setSearch('');
                  setStatusFilter('all');
                },
              }}
            />
          ) : (
            <EmptyState
              variant="create"
              icon={Zap}
              title="No automations"
              description="An automation runs an Agent automatically, outside a normal chat -- on a schedule, when a document changes, or from an external event."
              action={{ label: 'New automation', onClick: () => navigate('/automations/new') }}
            />
          )
        }
        renderItem={(automation) => {
          const busy = pendingAction?.endsWith(`:${automation.name}`);
          const toggleAction = automationStatusToggleAction(automation.status);
          const canRunNow = automationCanRunNow(automation.status);

          // Map toggle action kind to icon
          const toggleActionIconMap: Record<string, any> = {
            activate: Zap,
            pause: Pause,
            resume: RotateCcw,
          };

          return (
            <ItemCard
              title={automation.automation_name}
              description={automation.description?.slice(0, 100) || 'No description'}
              icon={Zap}
              status={{
                label: automation.status,
                variant: automationStatusBadgeVariant(automation.status),
              }}
              metadata={[
                { label: 'Trigger', value: automationTriggerTypesLabel(automation.triggerTypes) },
                { label: 'Agent', value: automation.agent },
                { label: 'Last run', value: formatAutomationTimestamp(automation.last_execution) },
              ]}
              actions={[
                {
                  icon: ExternalLink,
                  label: 'Open',
                  onClick: () => navigate(`/automations/${automation.name}`),
                },
                ...(canRunNow
                  ? [
                      {
                        icon: busy && pendingAction === `run:${automation.name}` ? Loader2 : Play,
                        label: 'Run now',
                        onClick: () => handleRunNow(automation),
                      },
                    ]
                  : []),
              ]}
              menuActions={[
                ...(toggleAction
                  ? [
                      {
                        icon: toggleActionIconMap[toggleAction.kind],
                        label: toggleAction.label,
                        onClick: () => handleTogglePause(automation),
                      },
                    ]
                  : []),
                ...(automation.status === 'Archived'
                  ? []
                  : [
                      {
                        icon: Archive,
                        label: 'Archive',
                        variant: 'destructive' as const,
                        onClick: () => handleArchive(automation),
                      },
                    ]),
              ]}
              onClick={() => navigate(`/automations/${automation.name}`)}
            />
          );
        }}
        keyExtractor={(automation) => automation.name}
      />
      {!loading && allData.length > 0 && (
        <div className="text-center py-4 text-sm text-muted-foreground">
          Showing {rows.length} of {allData.length} automation{allData.length === 1 ? '' : 's'}
        </div>
      )}
    </PageFrame>
  );
}

export default AutomationsPage;
