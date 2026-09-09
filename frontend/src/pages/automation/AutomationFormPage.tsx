import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Combobox } from '@/components/ui/combobox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  TriggerEditor,
  type EditableAutomationTrigger,
} from '@/components/automation/TriggerEditor';
import { AUTOMATION_TRIGGER_TYPES } from '@/components/automation/TriggerFieldsConfig';
import {
  createAutomation,
  createTrigger,
  deleteTrigger,
  getAutomation,
  listTriggers,
  updateAutomation,
  updateTrigger,
} from '@/services/automationApi';
import { getAgents, getAIModels, type AIModelItem } from '@/services/agentApi';
import { listProjects } from '@/services/projectApi';
import { db } from '@/lib/frappe-sdk';
import { doctype } from '@/data/doctypes';
import type {
  Automation,
  AutomationConversationMode,
  AutomationStatus,
  AutomationTrigger as AutomationTriggerDoc,
} from '@/types/automation.types';
import type { AgentDoc } from '@/types/agent.types';
import type { HufProject } from '@/services/projectApi';

const AUTOMATION_STATUSES: AutomationStatus[] = ['Draft', 'Active', 'Paused', 'Error', 'Archived'];
const CONVERSATION_MODES: AutomationConversationMode[] = ['New', 'Dedicated', 'No-UI'];

let localTriggerCounter = 0;
function nextLocalId(): string {
  localTriggerCounter += 1;
  return `local-${Date.now()}-${localTriggerCounter}`;
}

/** A trigger row being edited: either an existing Automation Trigger (has
 * `name`) or one added in this session that hasn't been saved yet (only has
 * `_localId`). */
interface TriggerRow extends EditableAutomationTrigger {
  _localId: string;
  _isNew: boolean;
  _isDirty: boolean;
}

function toTriggerRow(trigger: AutomationTriggerDoc): TriggerRow {
  return {
    ...trigger,
    trigger_type: trigger.trigger_type || 'Schedule',
    _localId: trigger.name,
    _isNew: false,
    _isDirty: false,
  };
}

/**
 * Automation Trigger's autoname is `field:trigger_name` (reqd, unique) --
 * the UI never surfaces a "trigger name" field to the user (not in this
 * track's field lists for any trigger type), so generate a stable, unique
 * one client-side. NOTE: as of this writing `automation_api.create_trigger`
 * deliberately excludes `trigger_name` from the set of fields it copies out
 * of `kwargs` (see its `_TRIGGER_FIELDS` docstring -- the exclusion was
 * meant to stop *renames* going through the generic update path, but
 * `create_trigger` uses the same tuple and so also drops it on create,
 * which will make `doc.insert()` fail on the field's `reqd` constraint).
 * This is a pre-existing backend gap outside this task's file list
 * (`automation_api.py`) -- sending the value here is still correct so the
 * frontend contract is right the moment that gap is closed.
 */
function generateTriggerName(automationName: string, triggerType: string): string {
  const slug = `${automationName}-${triggerType}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug}-${Date.now().toString(36)}`;
}

function newTriggerRow(): TriggerRow {
  return {
    trigger_type: 'Schedule',
    disabled: 0,
    scheduled_interval: 'Daily',
    interval_count: 1,
    _localId: nextLocalId(),
    _isNew: true,
    _isDirty: false,
  };
}

interface UserOption {
  name: string;
  full_name?: string;
}

/**
 * Standalone create/edit page for an Automation and its Automation Trigger
 * rows. Reached from `AutomationsTab.tsx`'s "Open" / "+ Add automation"
 * actions -- routed at `/automations/:automationId` (":automationId" of
 * "new" is create mode, mirroring `/agents/:id`'s convention).
 */
export function AutomationFormPage() {
  const { automationId } = useParams<{ automationId: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const isNew = !automationId || automationId === 'new';
  const preselectedAgent = searchParams.get('agent') || undefined;

  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState('general');
  const [automation, setAutomation] = useState<Automation | null>(null);

  // General
  const [automationName, setAutomationName] = useState('');
  const [description, setDescription] = useState('');
  const [agent, setAgent] = useState(preselectedAgent || '');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState<AutomationStatus>('Draft');

  // Task
  const [instruction, setInstruction] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  const [conversationMode, setConversationMode] = useState<AutomationConversationMode>('New');

  // Execution
  const [runAsUser, setRunAsUser] = useState('');
  const [notifyUser, setNotifyUser] = useState<0 | 1>(0);

  // Trigger rows
  const [triggerRows, setTriggerRows] = useState<TriggerRow[]>([]);
  const [deletedTriggerNames, setDeletedTriggerNames] = useState<string[]>([]);

  // Option lists
  const [agents, setAgents] = useState<AgentDoc[]>([]);
  const [projects, setProjects] = useState<HufProject[]>([]);
  const [models, setModels] = useState<AIModelItem[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);

  useEffect(() => {
    Promise.all([
      getAgents().then((result) => (Array.isArray(result) ? result : result.items)),
      listProjects(),
      getAIModels(),
      db.getDocList(doctype.User, {
        fields: ['name', 'full_name'],
        filters: [['enabled', '=', 1]],
        limit: 500,
      }),
    ]).then(([agentList, projectList, modelList, userList]) => {
      setAgents(agentList || []);
      setProjects(projectList || []);
      setModels(modelList || []);
      setUsers((userList as UserOption[]) || []);
    });
  }, []);

  const loadExisting = useCallback(async (name: string) => {
    setLoading(true);
    try {
      const [automationDoc, triggers] = await Promise.all([getAutomation(name), listTriggers(name)]);
      if (!automationDoc) {
        toast.error('Automation not found');
        navigate('/automations/new', { replace: true });
        return;
      }
      setAutomation(automationDoc);
      setAutomationName(automationDoc.automation_name);
      setDescription(automationDoc.description || '');
      setAgent(automationDoc.agent);
      setProject(automationDoc.project || '');
      setStatus(automationDoc.status);
      setInstruction(automationDoc.instruction || '');
      setModelOverride(automationDoc.model_override || '');
      setConversationMode(automationDoc.conversation_mode || 'New');
      setRunAsUser(automationDoc.run_as_user || '');
      setNotifyUser(automationDoc.notify_user ? 1 : 0);
      setTriggerRows((triggers as unknown as AutomationTriggerDoc[]).map(toTriggerRow));
      setDeletedTriggerNames([]);
    } finally {
      setLoading(false);
    }
  }, [navigate]);

  useEffect(() => {
    if (!isNew && automationId) {
      loadExisting(automationId);
    }
  }, [isNew, automationId, loadExisting]);

  const agentOptions = useMemo(
    () => agents.map((a) => ({ value: a.name, label: a.agent_name || a.name })),
    [agents]
  );
  const projectOptions = useMemo(
    () => projects.map((p) => ({ value: p.name, label: p.project_name || p.name })),
    [projects]
  );
  const modelOptions = useMemo(
    () => models.map((m) => ({ value: m.id, label: `${m.modelName} (${m.providerBrandLabel})` })),
    [models]
  );
  const userOptions = useMemo(
    () => users.map((u) => ({ value: u.name, label: u.full_name ? `${u.full_name} (${u.name})` : u.name })),
    [users]
  );

  const handleAddTrigger = () => {
    setTriggerRows((rows) => [...rows, newTriggerRow()]);
  };

  const handleTriggerChange = (localId: string, patch: Partial<TriggerRow>) => {
    setTriggerRows((rows) =>
      rows.map((row) => (row._localId === localId ? { ...row, ...patch, _isDirty: true } : row))
    );
  };

  const handleRemoveTrigger = (row: TriggerRow) => {
    if (!row._isNew && row.name) {
      setDeletedTriggerNames((names) => [...names, row.name as string]);
    }
    setTriggerRows((rows) => rows.filter((r) => r._localId !== row._localId));
  };

  const validate = (): string | null => {
    if (!automationName.trim()) return 'Name is required.';
    if (!agent) return 'Select an Agent.';
    if (!instruction.trim()) return 'Task instruction is required.';
    for (const row of triggerRows) {
      if (row.trigger_type === 'Schedule' && (!row.scheduled_interval || !row.interval_count)) {
        return 'Every Schedule trigger needs an interval and a count.';
      }
      if (row.trigger_type === 'Doc Event' && (!row.reference_doctype || !row.doc_event)) {
        return 'Every Doc Event trigger needs a DocType and a doc event.';
      }
      if (row.trigger_type === 'App Event' && (!row.app_name || !row.event_name)) {
        return 'Every App Event trigger needs an app name and event name.';
      }
    }
    return null;
  };

  const handleSave = async () => {
    const error = validate();
    if (error) {
      toast.error(error);
      return;
    }

    setSaving(true);
    try {
      let automationName_: string;

      if (isNew) {
        const created = await createAutomation({
          automation_name: automationName.trim(),
          agent,
          instruction: instruction.trim(),
          description: description.trim() || undefined,
          project: project || undefined,
          model_override: modelOverride || undefined,
          run_as_user: runAsUser || undefined,
          conversation_mode: conversationMode,
          notify_user: notifyUser,
        });
        automationName_ = created.name;
        setAutomation(created);
      } else {
        const updated = await updateAutomation({
          automation: automationId as string,
          automation_name: automationName.trim(),
          description: description.trim(),
          agent,
          project: project || undefined,
          status,
          model_override: modelOverride || undefined,
          run_as_user: runAsUser || undefined,
          instruction: instruction.trim(),
          conversation_mode: conversationMode,
          notify_user: notifyUser,
        });
        automationName_ = updated.name;
        setAutomation(updated);
      }

      // Delete removed triggers first.
      await Promise.all(deletedTriggerNames.map((name) => deleteTrigger(name)));
      setDeletedTriggerNames([]);

      // Create/update trigger rows; capture server-generated fields
      // (webhook_slug/webhook_key, trigger name) back into local state.
      const nextRows: TriggerRow[] = [];
      for (const row of triggerRows) {
        const { _localId, _isNew, _isDirty, ...fields } = row;
        if (_isNew) {
          const created = await createTrigger({
            automation: automationName_,
            trigger_type: fields.trigger_type,
            trigger_name: fields.trigger_name || generateTriggerName(automationName_, fields.trigger_type),
            disabled: fields.disabled,
            scheduled_interval: fields.scheduled_interval,
            interval_count: fields.interval_count,
            execution_mode: fields.execution_mode,
            reference_doctype: fields.reference_doctype,
            doc_event: fields.doc_event,
            condition: fields.condition,
            prompt_field: fields.prompt_field,
            prompt_field_mode: fields.prompt_field_mode,
            file_attachments: fields.file_attachments,
            app_name: fields.app_name,
            event_name: fields.event_name,
          });
          nextRows.push(toTriggerRow(created));
        } else if (_isDirty && row.name) {
          const updated = await updateTrigger({
            trigger: row.name,
            disabled: fields.disabled,
            scheduled_interval: fields.scheduled_interval,
            interval_count: fields.interval_count,
            execution_mode: fields.execution_mode,
            reference_doctype: fields.reference_doctype,
            doc_event: fields.doc_event,
            condition: fields.condition,
            prompt_field: fields.prompt_field,
            prompt_field_mode: fields.prompt_field_mode,
            file_attachments: fields.file_attachments,
            app_name: fields.app_name,
            event_name: fields.event_name,
          });
          // list_triggers/update_trigger never return webhook_key again
          // after creation -- preserve whatever this session already has
          // in memory rather than letting the response's absence blank it.
          nextRows.push({ ...toTriggerRow(updated), webhook_key: row.webhook_key });
        } else {
          nextRows.push({ ...row, _isDirty: false });
        }
      }
      setTriggerRows(nextRows);

      toast.success(isNew ? 'Automation created' : 'Automation saved');
      if (isNew) {
        navigate(agent ? `/agents/${encodeURIComponent(agent)}#triggers` : '/automations', { replace: true });
      }
    } catch {
      // createAutomation/updateAutomation/createTrigger/updateTrigger
      // already surface a toast via handleFrappeError.
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-steel-soft">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-xl">{isNew ? 'New automation' : automationName || 'Automation'}</h1>
          <p className="font-body text-[13px] text-steel-soft max-w-[60ch]">
            An automation runs an Agent automatically, outside a normal chat -- on a schedule, when a
            document changes, or from an external event.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              navigate(agent ? `/agents/${encodeURIComponent(agent)}#triggers` : '/automations', { replace: true })
            }
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            {isNew ? 'Create automation' : 'Save'}
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="w-full">
          <TabsTrigger value="general">General</TabsTrigger>
          <TabsTrigger value="task">Task</TabsTrigger>
          <TabsTrigger value="trigger">
            Trigger{triggerRows.length > 0 ? ` (${triggerRows.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="execution">Execution</TabsTrigger>
          {!isNew && automation && <TabsTrigger value="history">History</TabsTrigger>}
        </TabsList>

      {/* General */}
      <TabsContent value="general" className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>General</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input
              value={automationName}
              onChange={(e) => setAutomationName(e.target.value)}
              placeholder="e.g. Weekly usage digest"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this automation do? (optional)"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Agent</Label>
              <Combobox
                options={agentOptions}
                value={agent}
                onValueChange={setAgent}
                placeholder="Select agent"
                searchPlaceholder="Search agents..."
                emptyText="No agent found."
              />
            </div>
            <div className="space-y-1.5">
              <Label>Project (optional)</Label>
              <Combobox
                options={projectOptions}
                value={project}
                onValueChange={setProject}
                placeholder="No project"
                searchPlaceholder="Search projects..."
                emptyText="No project found."
              />
            </div>
          </div>
          {!isNew && (
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select onValueChange={(v) => setStatus(v as AutomationStatus)} value={status}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUTOMATION_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-steel-soft">
                Prefer the Automations tab&apos;s Pause/Resume actions for normal use -- this is a direct
                override.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
      </TabsContent>

      {/* Task */}
      <TabsContent value="task" className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Task</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Instruction</Label>
            <Textarea
              className="min-h-[120px]"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="What should the agent do when this automation runs?"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Model override (optional)</Label>
              <Combobox
                options={modelOptions}
                value={modelOverride}
                onValueChange={setModelOverride}
                placeholder="Agent default"
                searchPlaceholder="Search models..."
                emptyText="No model found."
              />
            </div>
            <div className="space-y-1.5">
              <Label>Conversation mode</Label>
              <Select
                onValueChange={(v) => setConversationMode(v as AutomationConversationMode)}
                value={conversationMode}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONVERSATION_MODES.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-steel-soft">
                New starts a fresh conversation each run; Dedicated reuses one conversation across runs;
                No-UI runs without creating a visible conversation.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
      </TabsContent>

      {/* Trigger */}
      <TabsContent value="trigger" className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Trigger</CardTitle>
            <p className="font-body text-[13px] text-steel-soft max-w-[60ch]">
              What starts this automation. Add more than one if it should run from several sources.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={handleAddTrigger}>
            <Plus className="w-4 h-4 mr-2" />
            Add trigger
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {triggerRows.length === 0 && (
            <p className="text-sm text-steel-soft rounded-lg border border-dashed p-4">
              No triggers yet -- this automation can still be run manually (Run now, from chat, or by
              another automation). Add a trigger above to also run it automatically.
            </p>
          )}
          {triggerRows.map((row) => (
            <div key={row._localId} className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <Badge variant="secondary">
                  {AUTOMATION_TRIGGER_TYPES.includes(row.trigger_type) ? row.trigger_type : 'Trigger'}
                </Badge>
                <Button type="button" variant="ghost" size="sm" onClick={() => handleRemoveTrigger(row)}>
                  <Trash2 className="w-4 h-4 mr-1" />
                  Remove
                </Button>
              </div>
              <TriggerEditor
                trigger={row}
                onChange={(patch) => handleTriggerChange(row._localId, patch)}
                permissions={{ canEdit: true }}
              />
            </div>
          ))}
        </CardContent>
      </Card>
      </TabsContent>

      {/* Execution */}
      <TabsContent value="execution" className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Execution</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>Run as (optional)</Label>
            <Combobox
              options={userOptions}
              value={runAsUser}
              onValueChange={setRunAsUser}
              placeholder="Runs as this automation's owner"
              searchPlaceholder="Search users..."
              emptyText="No user found."
            />
            <p className="text-xs text-steel-soft">
              Only a System Manager may set this to someone other than the automation&apos;s owner.
            </p>
          </div>
          <div className="flex flex-row items-center justify-between rounded-md border p-4">
            <div className="space-y-0.5">
              <Label className="text-sm">Notify on completion</Label>
              <p className="text-xs text-steel-soft">Notify the run-as user when this automation finishes.</p>
            </div>
            <Switch checked={notifyUser === 1} onCheckedChange={(checked) => setNotifyUser(checked ? 1 : 0)} />
          </div>
        </CardContent>
      </Card>
      </TabsContent>

      {/* History */}
      {!isNew && automation && (
        <TabsContent value="history" className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 text-sm">
              <HistoryField label="Last run" value={automation.last_execution} />
              <HistoryField label="Last status" value={automation.last_status} />
              <HistoryField label="Next run" value={automation.next_execution} />
              <HistoryField label="Total runs" value={automation.total_runs?.toString()} />
            </div>
            {automation.last_error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs font-mono text-destructive">
                {automation.last_error}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => navigate(`/executions?agents=${encodeURIComponent(automation.agent)}`)}
            >
              View this agent&apos;s runs
            </Button>
          </CardContent>
        </Card>
        </TabsContent>
      )}
      </Tabs>
    </div>
    </div>
  );
}

function HistoryField({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <div className="text-xs text-steel-soft">{label}</div>
      <div>{value || '—'}</div>
    </div>
  );
}
