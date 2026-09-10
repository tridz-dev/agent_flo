import { useNavigate, Link } from 'react-router-dom';
import { Plus, Loader2, Workflow, AlertCircle } from 'lucide-react';
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
import { useAutomationsList } from '@/hooks/useAutomationsList';
import { buildAutomationActions } from '@/utils/automationActions';
import type { AutomationRow } from '@/types/automation.types';
import {
  formatAutomationTimestamp,
  automationStatusBadgeVariant,
  automationTriggerTypesLabel,
} from '@/utils/automationDisplay';

interface AutomationsTabProps {
  agentId: string;
}

const formatTimestamp = formatAutomationTimestamp;
const statusBadgeVariant = automationStatusBadgeVariant;
const triggerTypesLabel = automationTriggerTypesLabel;

export function AutomationsTab({ agentId }: AutomationsTabProps) {
  const navigate = useNavigate();
  const list = useAutomationsList({ agent: agentId });

  const handleAddAutomation = () => {
    navigate(`/automations/new?agent=${encodeURIComponent(agentId)}`);
  };

  const handleOpen = (automation: AutomationRow) => {
    navigate(`/automations/${encodeURIComponent(automation.name)}`);
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <div className="space-y-1.5">
          <CardTitle>Automations using this agent</CardTitle>
          <p className="font-body text-[13px] text-steel-soft max-w-[60ch]">
            These automations reference this agent. Changing or deprecating the agent affects every automation listed here.
          </p>
        </div>
        <Button onClick={handleAddAutomation} size="sm" type="button">
          <Plus className="w-4 h-4 mr-2" />
          Add automation
        </Button>
      </CardHeader>
      <CardContent>
        {list.runtimeMode === 'legacy' && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Legacy Automation Runtime Active</AlertTitle>
            <AlertDescription>
              This site is running in legacy mode. New Automations defined in this interface will not execute. Contact your administrator to enable the new automation runtime.
            </AlertDescription>
          </Alert>
        )}
        {list.loading ? (
          <div className="flex items-center justify-center py-12 text-steel-soft">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : list.rows.length === 0 ? (
          <EmptyState
            variant="create"
            icon={Workflow}
            title="No automations use this agent"
            description="Nothing runs this agent automatically yet. Create an automation to run it on a schedule, a document change, or an external event."
            action={{ label: 'Add automation', onClick: handleAddAutomation }}
          />
        ) : (
          <>
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
                {list.rows.map((automation) => {
                  const actions = buildAutomationActions(automation, {
                    list,
                    onOpen: handleOpen,
                  });
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
                          {actions.map((action) => (
                            <Button
                              key={action.key}
                              type="button"
                              variant="ghost"
                              size="sm"
                              title={action.label}
                              onClick={action.onClick}
                              disabled={action.disabled}
                            >
                              {action.busy ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <action.icon className="w-4 h-4" />
                              )}
                            </Button>
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <div className="mt-3 flex justify-end">
              <Link to="/automations" className="text-sm text-muted-foreground hover:underline">
                View all automations
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
