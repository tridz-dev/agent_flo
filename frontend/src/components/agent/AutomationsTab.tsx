import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Play, Pause, Zap, RotateCcw, Copy, Archive, ExternalLink, Loader2, Workflow, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/dashboard/views/EmptyState';
import {
  listAutomations,
  listTriggers,
  runAutomationNow,
  pauseAutomation,
  resumeAutomation,
  archiveAutomation,
  getAutomationRuntimeMode,
} from '@/services/automationApi';
import type { Automation, AutomationTriggerType } from '@/types/automation.types';
import {
  formatAutomationTimestamp,
  automationStatusBadgeVariant,
  automationTriggerTypesLabel,
  automationStatusToggleAction,
  automationCanRunNow,
} from '@/utils/automationDisplay';

interface AutomationsTabProps {
  agentId: string;
}

/** Automation rows shown in the tab, each carrying its resolved trigger types. */
interface AutomationRow extends Automation {
  triggerTypes: AutomationTriggerType[];
}

const formatTimestamp = formatAutomationTimestamp;
const statusBadgeVariant = automationStatusBadgeVariant;
const triggerTypesLabel = automationTriggerTypesLabel;

export function AutomationsTab({ agentId }: AutomationsTabProps) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<AutomationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [runtimeMode, setRuntimeMode] = useState<'new' | 'legacy'>('new');

  const loadAutomations = useCallback(async () => {
    setLoading(true);
    try {
      const automations = await listAutomations({ agent: agentId });
      const withTriggers = await Promise.all(
        automations.map(async (automation) => {
          const triggers = await listTriggers(automation.name);
          const triggerTypes = triggers
            .map((trigger) => trigger.trigger_type)
            .filter((type): type is AutomationTriggerType => !!type);
          return { ...automation, triggerTypes };
        })
      );
      setRows(withTriggers);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    loadAutomations();
    getAutomationRuntimeMode().then((response) => setRuntimeMode(response.mode));
  }, [loadAutomations]);

  const handleAddAutomation = () => {
    navigate(`/automations/new?agent=${encodeURIComponent(agentId)}`);
  };

  const handleOpen = (automation: AutomationRow) => {
    navigate(`/automations/${encodeURIComponent(automation.name)}`);
  };

  const handleRunNow = async (automation: AutomationRow) => {
    setPendingAction(`run:${automation.name}`);
    try {
      await runAutomationNow(automation.name);
      toast.success(`${automation.automation_name} started`);
      await loadAutomations();
    } catch {
      // runAutomationNow already surfaces a toast via handleFrappeError.
    } finally {
      setPendingAction(null);
    }
  };

  const handleTogglePause = async (automation: AutomationRow) => {
    const isActive = automation.status === 'Active';
    setPendingAction(`pause:${automation.name}`);
    try {
      if (isActive) {
        await pauseAutomation(automation.name);
        toast.success(`${automation.automation_name} paused`);
      } else {
        await resumeAutomation(automation.name);
        toast.success(`${automation.automation_name} resumed`);
      }
      await loadAutomations();
    } catch {
      // pauseAutomation/resumeAutomation already surface a toast on failure.
    } finally {
      setPendingAction(null);
    }
  };

  const handleDuplicate = (automation: AutomationRow) => {
    // TODO: duplicating an Automation means cloning it plus every one of its
    // Automation Trigger child rows (create_automation + create_trigger per
    // row, since the API has no single "duplicate" endpoint). Deferred --
    // out of scope for S12/S13; wire this up alongside the Automation form
    // page (S17) where the trigger editor it needs already lives.
    toast.info(`Duplicate for "${automation.automation_name}" is not available yet`);
  };

  const handleArchive = async (automation: AutomationRow) => {
    setPendingAction(`archive:${automation.name}`);
    try {
      await archiveAutomation(automation.name);
      toast.success(`${automation.automation_name} archived`);
      await loadAutomations();
    } catch {
      // archiveAutomation already surfaces a toast on failure.
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div className="space-y-1.5">
          <CardTitle>Automations</CardTitle>
          <p className="font-body text-[13px] text-steel-soft max-w-[60ch]">
            Automations run this agent automatically — on a schedule, when a document changes, or from an external event.
          </p>
        </div>
        <Button onClick={handleAddAutomation} size="sm" type="button">
          <Plus className="w-4 h-4 mr-2" />
          Add automation
        </Button>
      </CardHeader>
      <CardContent>
        {runtimeMode === 'legacy' && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Legacy Automation Runtime Active</AlertTitle>
            <AlertDescription>
              This site is running in legacy mode. New Automations defined in this interface will not execute. Contact your administrator to enable the new automation runtime.
            </AlertDescription>
          </Alert>
        )}
        {loading ? (
          <div className="flex items-center justify-center py-12 text-steel-soft">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            variant="create"
            icon={Workflow}
            title="No automations yet"
            description="Add an automation to run this agent on a schedule, a document change, or an external event."
            action={{ label: 'Add automation', onClick: handleAddAutomation }}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Trigger type(s)</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last Run</TableHead>
                <TableHead>Next Run</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((automation) => {
                const isActive = automation.status === 'Active';
                const busyRun = pendingAction === `run:${automation.name}`;
                const busyPause = pendingAction === `pause:${automation.name}`;
                const busyArchive = pendingAction === `archive:${automation.name}`;
                const rowBusy = busyRun || busyPause || busyArchive;
                return (
                  <TableRow key={automation.name}>
                    <TableCell className="font-medium max-w-xs truncate">
                      {automation.automation_name}
                    </TableCell>
                    <TableCell>{triggerTypesLabel(automation.triggerTypes)}</TableCell>
                    <TableCell>
                      <Badge variant={statusBadgeVariant(automation.status)}>{automation.status}</Badge>
                    </TableCell>
                    <TableCell>{formatTimestamp(automation.last_execution)}</TableCell>
                    <TableCell>{formatTimestamp(automation.next_execution)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          title="Open"
                          onClick={() => handleOpen(automation)}
                          disabled={rowBusy}
                        >
                          <ExternalLink className="w-4 h-4" />
                        </Button>
                        {automationCanRunNow(automation.status) && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            title="Run now"
                            onClick={() => handleRunNow(automation)}
                            disabled={rowBusy}
                          >
                            {busyRun ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
                          </Button>
                        )}
                        {(() => {
                          const toggleAction = automationStatusToggleAction(automation.status);
                          if (!toggleAction) return null;

                          let icon;
                          switch (toggleAction.kind) {
                            case 'activate':
                              icon = <Zap className="w-4 h-4" />;
                              break;
                            case 'pause':
                              icon = <Pause className="w-4 h-4" />;
                              break;
                            case 'resume':
                              icon = <RotateCcw className="w-4 h-4" />;
                              break;
                          }

                          return (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              title={toggleAction.label}
                              onClick={() => handleTogglePause(automation)}
                              disabled={rowBusy}
                            >
                              {busyPause ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
                            </Button>
                          );
                        })()}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          title="Duplicate"
                          onClick={() => handleDuplicate(automation)}
                          disabled={rowBusy}
                        >
                          <Copy className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          title="Archive"
                          onClick={() => handleArchive(automation)}
                          disabled={rowBusy || automation.status === 'Archived'}
                        >
                          {busyArchive ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
