import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Zap, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { PageFrame } from '@/layouts/PageFrame';
import { FilterBar, GridView, ItemCard, EmptyState } from '@/components/dashboard';
import { usePageData } from '@/hooks/dashboard/usePageData';
import { useAutomationsList } from '@/hooks/useAutomationsList';
import { buildAutomationActions } from '@/utils/automationActions';
import {
  formatAutomationTimestamp,
  automationStatusBadgeVariant,
  automationTriggerTypesLabel,
} from '@/utils/automationDisplay';
import type { AutomationRow } from '@/types/automation.types';

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
  const list = useAutomationsList();

  const { data: rows, allData, search, setSearch, filters, setFilters, setData } =
    usePageData<AutomationRow>({
      searchFields: ['automation_name', 'description'],
      filterFn: (item, activeFilters) =>
        !activeFilters.status || activeFilters.status === 'all' || item.status === activeFilters.status,
    });

  // usePageData's fetch effect has [] deps and can't compose with a hook
  // that also fetches, so useAutomationsList() owns the actual fetch here
  // and usePageData is kept only for the search/filter layer on top --
  // seed it from list.rows whenever the shared hook's data changes.
  useEffect(() => {
    setData(list.rows);
  }, [list.rows, setData]);

  useEffect(() => {
    if (list.error) {
      toast.error('Failed to load automations', {
        description: list.error.message || 'An error occurred while fetching automations.',
      });
    }
  }, [list.error]);

  const setStatusFilter = (value: string) => setFilters((prev) => ({ ...prev, status: value }));

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
        loading={list.loading}
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
          const descriptors = buildAutomationActions(automation, {
            list,
            onOpen: (a) => navigate(`/automations/${a.name}`),
          });
          const byKey = Object.fromEntries(descriptors.map((d) => [d.key, d]));

          const inlineActions = [byKey.open, byKey.run]
            .filter((d): d is NonNullable<typeof d> => !!d)
            .map((d) => ({
              icon: d.busy ? Loader2 : d.icon,
              label: d.label,
              onClick: d.onClick,
            }));

          const menuActions = [byKey.toggle, byKey.archive]
            .filter((d): d is NonNullable<typeof d> => !!d)
            .map((d) => ({
              icon: d.icon,
              label: d.label,
              onClick: d.onClick,
              ...(d.key === 'archive' ? { variant: 'destructive' as const } : {}),
            }));

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
              actions={inlineActions}
              menuActions={menuActions}
              onClick={() => navigate(`/automations/${automation.name}`)}
            />
          );
        }}
        keyExtractor={(automation) => automation.name}
      />
      {!list.loading && allData.length > 0 && (
        <div className="text-center py-4 text-sm text-muted-foreground">
          Showing {rows.length} of {allData.length} automation{allData.length === 1 ? '' : 's'}
        </div>
      )}
    </PageFrame>
  );
}

export default AutomationsPage;
