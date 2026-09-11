import type { Filter } from 'frappe-js-sdk/lib/db/types';
import { db } from '@/lib/frappe-sdk';
import { doctype } from '@/data/doctypes';
import { handleFrappeError } from '@/lib/frappe-error';
import { fetchPaginatedCount } from './utilsApi';

/**
 * Agent Run document from Frappe
 */
export interface AgentRunDoc {
  name: string;
  agent: string;
  conversation?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  status?: string;
  cached_tokens?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost?: number | null;
  cost_source?: string | null;
  is_child?: number | boolean;
}

/**
 * One child Agent Run — a step within a parent run's execution trace
 * (sub-agent spawn or orchestration step). See `parent_run` / `is_child`
 * / `sequence` on the Agent Run doctype.
 */
export interface AgentRunStep {
  name: string;
  sequence?: number | null;
  agent?: string | null;
  run_kind?: string | null;
  status?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  provider?: string | null;
  model?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cost?: number | null;
  error_code?: string | null;
  error_message?: string | null;
}

/**
 * Fetch the child runs (trace steps) of a parent Agent Run, in execution
 * order. Returns an empty array — never a fabricated step — when the run
 * has no children, which is the common case for a direct (non-orchestrated)
 * run.
 */
export async function getChildRuns(parentRunId: string): Promise<AgentRunStep[]> {
  if (!parentRunId) return [];
  try {
    const rows = await db.getDocList(doctype['Agent Run'], {
      fields: [
        'name',
        'sequence',
        'agent',
        'run_kind',
        'status',
        'start_time',
        'end_time',
        'provider',
        'model',
        'input_tokens',
        'output_tokens',
        'cost',
        'error_code',
        'error_message',
      ],
      filters: [['parent_run', '=', parentRunId]] as Filter<Record<string, unknown>>[],
      orderBy: { field: 'sequence', order: 'asc' },
      limit: 500,
    });
    return rows as AgentRunStep[];
  } catch (error) {
    handleFrappeError(error, 'Error fetching run trace');
    return [];
  }
}

/**
 * Pagination parameters for fetching agent runs
 */
export interface GetAgentRunsParams {
  page?: number;
  limit?: number;
  start?: number;
  search?: string;
  status?: 'Started' | 'Queued' | 'Success' | 'Failed' | 'all';
  agents?: string[];
  filters?: Array<[string, string, unknown]>
}

/**
 * Paginated response for agent runs
 */
export interface PaginatedAgentRunsResponse {
  items: AgentRunDoc[];
  hasMore: boolean;
  total?: number;
}

/**
 * Fetch agent runs from Frappe
 * Supports pagination and search by agent name
 */
export async function getAgentRuns(
  params?: GetAgentRunsParams
): Promise<PaginatedAgentRunsResponse | AgentRunDoc[]> {
  try {
    // Backward compatibility: if no params, return simple array
    if (!params) {
      const runs = await db.getDocList(doctype['Agent Run'], {
        fields: ['name', 'agent', 'start_time', 'end_time', 'status', 'is_child', 'cached_tokens', 'cost'],
        limit: 1000,
        orderBy: { field: 'creation', order: 'desc' },
      });
      return runs as AgentRunDoc[];
    }

    const {
      page = 1,
      limit = 20,
      start = (page - 1) * limit,
      search,
      status,
      agents,
      filters:passedFilters
    } = params;

    // Build filters
    const filters: Array<[string, string, unknown]> = [];

    if (search && search.trim()) {
      filters.push(['agent', 'like', `%${search.trim()}%`]);
    }

    if (status && status !== 'all') {
      filters.push(['status', '=', status]);
    }

    if (agents && agents.length > 0) {
      filters.push(['agent', 'in', agents]);
    }

    if (passedFilters && passedFilters?.length>0){
      passedFilters.forEach((fil)=>filters.push(fil))
    }

    // Fetch data
    const runs = await db.getDocList(doctype['Agent Run'], {
      fields: ['name', 'agent', 'start_time', 'end_time', 'status', 'is_child', 'cached_tokens', 'cost'],
      filters: filters.length > 0 ? (filters as Filter<Record<string, unknown>>[]) : undefined,
      limit: limit + 1, // Fetch one extra to check if there's more
      ...(start > 0 && { limit_start: start }),
      orderBy: { field: 'creation', order: 'desc' },
    });

    const mappedRuns = runs as AgentRunDoc[];
    const hasMore = mappedRuns.length > limit;
    const items = hasMore ? mappedRuns.slice(0, limit) : mappedRuns;

    const total = await fetchPaginatedCount(
      page,
      items.length,
      doctype['Agent Run'],
      filters
    );

    return {
      items,
      hasMore,
      total,
    };
  } catch (error) {
    handleFrappeError(error, 'Error fetching agent runs');
    return {
      items: [],
      hasMore: false,
      total: 0,
    };
  }
}


