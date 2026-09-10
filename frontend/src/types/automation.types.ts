/**
 * TypeScript interfaces mirroring the Automation and Automation Trigger
 * doctypes (see huf/huf/doctype/automation/automation.json and
 * huf/huf/doctype/automation_trigger/automation_trigger.json).
 */

export type AutomationStatus = 'Draft' | 'Active' | 'Paused' | 'Error' | 'Archived';

export type AutomationConversationMode = 'New' | 'Dedicated' | 'No-UI';

export type AutomationTriggerType = 'Schedule' | 'Doc Event' | 'Webhook' | 'App Event' | 'Manual';

export type AutomationTriggerStatus = 'Draft' | 'Active' | 'Disabled' | 'Error';

export type AutomationScheduleType = 'Interval' | 'Cron' | 'Once';

export type AutomationScheduledInterval = 'Hourly' | 'Daily' | 'Weekly' | 'Monthly' | 'Yearly';

export type AutomationMisfirePolicy = 'Skip' | 'Run Immediately' | 'Queue';

export type AutomationExecutionMode = 'Realtime' | 'Batch';

export type AutomationDocEvent =
  | 'before_insert'
  | 'after_insert'
  | 'validate'
  | 'before_save'
  | 'after_save'
  | 'before_submit'
  | 'on_submit'
  | 'on_update'
  | 'after_submit'
  | 'on_cancel'
  | 'before_rename'
  | 'after_rename'
  | 'on_trash'
  | 'after_delete';

export type AutomationPromptFieldMode = 'Supplement' | 'Override';

export type AutomationAllowedMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ANY';

export type AutomationAuthMode = 'None' | 'Webhook Key' | 'Signature' | 'Basic Auth' | 'Bearer Token';

export type AutomationResponseMode = 'Sync' | 'Async';

/**
 * Automation doctype (huf/huf/doctype/automation/automation.json).
 */
export interface Automation {
  name: string;
  automation_name: string;
  status: AutomationStatus;
  disabled?: 0 | 1;
  description?: string;
  agent: string;
  model_override?: string;
  project?: string;
  run_as_user?: string;
  instruction: string;
  input_template?: string;
  source_system?: string;
  is_virtual?: 0 | 1;
  metadata?: string | Record<string, unknown>;
  conversation_mode?: AutomationConversationMode;
  conversation?: string;
  notify_user?: 0 | 1;
  last_run?: string;
  last_execution?: string;
  last_status?: AutomationStatus | '';
  next_execution?: string;
  total_runs?: number;
  last_error?: string;
  source_app?: string;
  source_file?: string;
  owner?: string;
  creation?: string;
  modified?: string;
}

/** An Automation as rendered in a list, with its trigger types resolved. */
export interface AutomationRow extends Automation {
  triggerTypes: AutomationTriggerType[];
}

/**
 * Automation Trigger doctype
 * (huf/huf/doctype/automation_trigger/automation_trigger.json).
 *
 * Only `schedule_type`/`cron_expression` fields are populated for
 * Schedule-type triggers, `reference_doctype`/`doc_event`/... for Doc Event
 * triggers, and so on -- the doctype uses `depends_on` to show/hide field
 * groups per `trigger_type`, but on the wire every field is just optional.
 */
export interface AutomationTrigger {
  name: string;
  trigger_name: string;
  automation: string;
  status?: AutomationTriggerStatus | '';
  disabled?: 0 | 1;
  trigger_type: AutomationTriggerType | '';

  // -- Schedule fields --
  schedule_type?: AutomationScheduleType | '';
  cron_expression?: string;
  run_at?: string;
  /** Legacy interval field, preserved for migration compatibility. */
  scheduled_interval?: AutomationScheduledInterval | '';
  timezone?: string;
  start_at?: string;
  end_at?: string;
  misfire_policy?: AutomationMisfirePolicy | '';
  /** Legacy interval count field, preserved for migration compatibility. */
  interval_count?: number;
  /** Schedule-only. Defaults to 'Realtime' server-side. */
  execution_mode?: AutomationExecutionMode | '';
  last_execution?: string;
  next_execution?: string;

  // -- Doc Event fields --
  reference_doctype?: string;
  doc_event?: AutomationDocEvent | '';
  prompt_field?: string;
  prompt_field_mode?: AutomationPromptFieldMode | '';
  /** Also used by App Event triggers. */
  condition?: string;
  file_attachments?: AutomationTriggerAttachment[];

  // -- Webhook fields --
  webhook_slug?: string;
  webhook_key?: string;
  allowed_methods?: AutomationAllowedMethod | '';
  auth_mode?: AutomationAuthMode | '';
  signature_header?: string;
  secret?: string;
  response_mode?: AutomationResponseMode | '';

  // -- App Event fields --
  app_name?: string;
  event_name?: string;
  event_source?: string;
  /** Also used by Webhook triggers. */
  payload_mapping?: string;

  // -- Shared trailing fields --
  source_system?: string;
  metadata?: string | Record<string, unknown>;
  disabled_reason?: string;
  is_virtual?: 0 | 1;

  owner?: string;
  creation?: string;
  modified?: string;
}

/** Child table row for Automation Trigger's `file_attachments` field. */
export interface AutomationTriggerAttachment {
  name?: string;
  [key: string]: unknown;
}

/** Summary row shape returned by list_triggers. */
export interface AutomationTriggerSummary {
  name: string;
  trigger_name: string;
  automation: string;
  status?: AutomationTriggerStatus | '';
  disabled?: 0 | 1;
  trigger_type: AutomationTriggerType | '';
  schedule_type?: AutomationScheduleType | '';
  cron_expression?: string;
  last_execution?: string;
  next_execution?: string;
  modified?: string;
}

/** Row shape returned by list_scheduled_automations. */
export interface ScheduledAutomationSummary {
  name: string;
  automation_name: string;
  status: AutomationStatus;
  disabled?: 0 | 1;
  agent: string;
  project?: string;
  last_execution?: string;
  last_status?: AutomationStatus | '';
  next_execution?: string;
  trigger?: string;
  schedule_type?: AutomationScheduleType | '';
  cron_expression?: string;
  run_at?: string;
  scheduled_interval?: AutomationScheduledInterval | '';
  trigger_next_execution?: string;
}

/** Response shape returned by run_automation_now. */
export interface RunAutomationNowResponse {
  success: boolean;
  status?: string;
  agent_run_id?: string;
  conversation_id?: string;
  [key: string]: unknown;
}

export interface DeleteAutomationResponse {
  success: boolean;
}

export interface DeleteTriggerResponse {
  success: boolean;
}
