import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  listAutomations,
  listTriggers,
  runAutomationNow,
  pauseAutomation,
  resumeAutomation,
  archiveAutomation,
  getAutomationRuntimeMode,
} from '@/services/automationApi';
import type { Automation, AutomationRow, AutomationTriggerType } from '@/types/automation.types';
import { automationStatusToggleAction } from '@/utils/automationDisplay';

export interface UseAutomationsListResult {
  rows: AutomationRow[];
  loading: boolean;
  error: Error | null;
  pendingAction: string | null;
  isBusy: (name: string, verb?: 'run' | 'pause' | 'archive') => boolean;
  refresh: () => Promise<void>;
  runNow: (automation: AutomationRow) => Promise<void>;
  toggleStatus: (automation: AutomationRow) => Promise<void>;
  archive: (automation: AutomationRow) => Promise<void>;
  runtimeMode: 'new' | 'legacy';
}

/**
 * Shared data layer for the top-level /automations list page and the
 * per-agent Automations tab. Fetches Automations (optionally scoped to a
 * single agent), resolves each row's trigger types, and exposes the
 * run-now / pause-resume / archive actions with consistent toast and
 * pending-state handling.
 */
export function useAutomationsList(opts?: { agent?: string }): UseAutomationsListResult {
  const agent = opts?.agent;
  const [rows, setRows] = useState<AutomationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<'new' | 'legacy'>('new');

  const fetchRows = useCallback(async (): Promise<AutomationRow[]> => {
    const automations = await listAutomations(agent ? { agent } : undefined);
    return Promise.all(
      automations.map(async (automation: Automation) => {
        const triggers = await listTriggers(automation.name);
        const triggerTypes = triggers
          .map((trigger) => trigger.trigger_type)
          .filter((type): type is AutomationTriggerType => !!type);
        return { ...automation, triggerTypes } as AutomationRow;
      })
    );
  }, [agent]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const withTriggers = await fetchRows();
      setRows(withTriggers);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [fetchRows]);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    fetchRows()
      .then((withTriggers) => {
        if (cancelled) return;
        setRows(withTriggers);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [fetchRows]);

  useEffect(() => {
    getAutomationRuntimeMode().then((response) => setRuntimeMode(response.mode));
  }, []);

  const isBusy = useCallback(
    (name: string, verb?: 'run' | 'pause' | 'archive') => {
      if (!pendingAction) return false;
      if (verb) return pendingAction === `${verb}:${name}`;
      return pendingAction.split(':')[1] === name;
    },
    [pendingAction]
  );

  const runNow = useCallback(
    async (automation: AutomationRow) => {
      setPendingAction(`run:${automation.name}`);
      try {
        await runAutomationNow(automation.name);
        toast.success(`${automation.automation_name} started`);
        await refresh();
      } catch {
        // runAutomationNow already surfaces a toast via handleFrappeError.
      } finally {
        setPendingAction(null);
      }
    },
    [refresh]
  );

  const toggleStatus = useCallback(
    async (automation: AutomationRow) => {
      const action = automationStatusToggleAction(automation.status);
      if (!action) {
        console.warn(`No toggle action available for automation "${automation.name}" with status "${automation.status}"`);
        return;
      }

      setPendingAction(`pause:${automation.name}`);
      try {
        if (action.kind === 'pause') {
          await pauseAutomation(automation.name);
          toast.success(`${automation.automation_name} paused`);
        } else {
          await resumeAutomation(automation.name);
          toast.success(`${automation.automation_name} resumed`);
        }
        await refresh();
      } catch {
        // pauseAutomation/resumeAutomation already surface a toast on failure.
      } finally {
        setPendingAction(null);
      }
    },
    [refresh]
  );

  const archive = useCallback(
    async (automation: AutomationRow) => {
      setPendingAction(`archive:${automation.name}`);
      try {
        await archiveAutomation(automation.name);
        toast.success(`${automation.automation_name} archived`);
        await refresh();
      } catch {
        // archiveAutomation already surfaces a toast on failure.
      } finally {
        setPendingAction(null);
      }
    },
    [refresh]
  );

  return {
    rows,
    loading,
    error,
    pendingAction,
    isBusy,
    refresh,
    runNow,
    toggleStatus,
    archive,
    runtimeMode,
  };
}
