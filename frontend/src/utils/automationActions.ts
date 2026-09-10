import { ExternalLink, Play, Zap, Pause, RotateCcw, Copy, Archive } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AutomationRow } from '@/types/automation.types';
import { automationStatusToggleAction, automationCanRunNow, type AutomationRowAction } from '@/utils/automationDisplay';
import type { UseAutomationsListResult } from '@/hooks/useAutomationsList';

export interface AutomationActionDescriptor {
  key: 'open' | 'run' | 'toggle' | 'archive' | 'duplicate';
  icon: LucideIcon;
  label: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface BuildAutomationActionsCtx {
  list: Pick<UseAutomationsListResult, 'isBusy' | 'runNow' | 'toggleStatus' | 'archive'>;
  onOpen: (automation: AutomationRow) => void;
  onDuplicate?: (automation: AutomationRow) => void; // omit to exclude the Duplicate action entirely
}

const TOGGLE_ICON_MAP: Record<AutomationRowAction['kind'], LucideIcon> = {
  activate: Zap,
  pause: Pause,
  resume: RotateCcw,
};

export function buildAutomationActions(
  automation: AutomationRow,
  ctx: BuildAutomationActionsCtx
): AutomationActionDescriptor[] {
  const actions: AutomationActionDescriptor[] = [];

  actions.push({
    key: 'open',
    icon: ExternalLink,
    label: 'Open',
    busy: false,
    onClick: () => ctx.onOpen(automation),
  });

  if (automationCanRunNow(automation.status)) {
    actions.push({
      key: 'run',
      icon: Play,
      label: 'Run now',
      busy: ctx.list.isBusy(automation.name, 'run'),
      disabled: ctx.list.isBusy(automation.name),
      onClick: () => ctx.list.runNow(automation),
    });
  }

  const toggleAction = automationStatusToggleAction(automation.status);
  if (toggleAction) {
    actions.push({
      key: 'toggle',
      icon: TOGGLE_ICON_MAP[toggleAction.kind],
      label: toggleAction.label,
      busy: ctx.list.isBusy(automation.name, 'pause'),
      onClick: () => ctx.list.toggleStatus(automation),
    });
  }

  if (ctx.onDuplicate) {
    actions.push({
      key: 'duplicate',
      icon: Copy,
      label: 'Duplicate',
      busy: false,
      onClick: () => ctx.onDuplicate!(automation),
    });
  }

  actions.push({
    key: 'archive',
    icon: Archive,
    label: 'Archive',
    busy: ctx.list.isBusy(automation.name, 'archive'),
    disabled: ctx.list.isBusy(automation.name) || automation.status === 'Archived',
    onClick: () => ctx.list.archive(automation),
  });

  return actions;
}
