import type { Automation, AutomationStatus, AutomationTriggerType } from '@/types/automation.types';

const MAX_TRIGGER_TYPES_SHOWN = 2;

export type AutomationRowAction =
  | { kind: 'activate'; label: 'Activate' }
  | { kind: 'pause'; label: 'Pause' }
  | { kind: 'resume'; label: 'Resume' };

export function formatAutomationTimestamp(value?: string): string {
  if (!value) return '—';
  const date = new Date(value.includes(' ') ? value.replace(' ', 'T') : value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function automationStatusBadgeVariant(
  status: Automation['status']
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'Active':
      return 'default';
    case 'Error':
      return 'destructive';
    case 'Archived':
      return 'outline';
    default:
      return 'secondary';
  }
}

export function automationTriggerTypesLabel(types: AutomationTriggerType[]): string {
  if (types.length === 0) return 'No triggers';
  const shown = types.slice(0, MAX_TRIGGER_TYPES_SHOWN);
  const overflow = types.length - shown.length;
  return overflow > 0 ? `${shown.join(', ')} +${overflow} more` : shown.join(', ');
}

export function automationStatusToggleAction(status: AutomationStatus): AutomationRowAction | null {
  switch (status) {
    case 'Draft':
    case 'Error':
      return { kind: 'activate', label: 'Activate' };
    case 'Active':
      return { kind: 'pause', label: 'Pause' };
    case 'Paused':
      return { kind: 'resume', label: 'Resume' };
    case 'Archived':
      return null;
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function automationCanRunNow(status: AutomationStatus): boolean {
  return status !== 'Archived';
}
