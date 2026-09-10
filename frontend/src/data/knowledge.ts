/**
 * Knowledge Source and Knowledge Input configuration constants.
 * Centralised so select options can be updated in one place.
 */

export const knowledgeTypes = [
	{ label: 'SQLite FTS', value: 'sqlite_fts' },
	{ label: 'SQLite Vec', value: 'sqlite_vec' },
	{ label: 'SQLite Hybrid (FTS + Vec)', value: 'sqlite_hybrid' },
	{ label: 'ChromaDB', value: 'chroma' },
	{ label: 'PGVector', value: 'pgvector' },
	{ label: 'zvec (Embedded)', value: 'zvec' },
	{ label: 'Redis', value: 'redis' },
	{ label: 'Weaviate', value: 'weaviate' },
	{ label: 'FAISS', value: 'faiss' },
	{ label: 'Pinecone', value: 'pinecone' },

] as const;

/**
 * Preset options shown on the Knowledge Source form to steer first-time users
 * away from raw backend names. "Connect my own vector database" reveals the
 * full `knowledgeTypes` select plus per-backend advanced settings.
 */
export const knowledgeTypePresets = [
	{
		id: 'keyword',
		label: 'Keyword search (no setup)',
		description: 'Fast full-text search out of the box. No embedding model or extra configuration required.',
		knowledgeType: 'sqlite_fts' as const,
	},
	{
		id: 'semantic',
		label: 'Semantic search (recommended)',
		description: 'Understands meaning, not just keywords. Runs in-process with a portable file — no server to run.',
		knowledgeType: 'zvec' as const,
		defaults: {
			embedding_model: 'text-embedding-3-small',
			vector_dimension: 1536,
		},
	},
	{
		id: 'custom',
		label: 'Connect my own vector database',
		description: 'Choose a specific backend (ChromaDB, PGVector, Redis, Weaviate, FAISS, Pinecone, etc.) and configure its connection directly.',
		knowledgeType: null,
	},
] as const;

export type KnowledgeTypePresetId = (typeof knowledgeTypePresets)[number]['id'];

export type KnowledgeTypeOption = (typeof knowledgeTypes)[number]['value'];

export const VECTOR_KNOWLEDGE_TYPES = [
	'sqlite_vec',
	'sqlite_hybrid',
	'chroma',
	'pgvector',
	'redis',
	'zvec',
	'weaviate',
	'faiss',
	'pinecone',
] as const;


export function isVectorKnowledgeType(type: string): boolean {
	return (VECTOR_KNOWLEDGE_TYPES as readonly string[]).includes(type);
}

export const knowledgeTypeLabels: Record<string, string> = {
	sqlite_fts: 'FTS',
	sqlite_vec: 'Vec',
	sqlite_hybrid: 'Hybrid',
	chroma: 'Chroma',
	pgvector: 'PGVector',
	zvec: 'zvec',
	redis: 'Redis',
	weaviate: 'Weaviate',
	faiss: 'FAISS',
	pinecone: 'Pinecone',

};

export const chromaModes = [
	{ label: 'File', value: 'File' },
	{ label: 'Server', value: 'Server' },
] as const;

export type ChromaModeOption = (typeof chromaModes)[number]['value'];

export const knowledgeScopes = [
	{ label: 'Site', value: 'Site' },
	{ label: 'Workspace', value: 'Workspace' },
	{ label: 'Agent', value: 'Agent' },
	{ label: 'Global', value: 'Global' },
] as const;

export type KnowledgeScopeOption = (typeof knowledgeScopes)[number]['value'];

export const knowledgeSourceStatuses = [
	{ label: 'Pending', value: 'Pending' },
	{ label: 'Indexing', value: 'Indexing' },
	{ label: 'Ready', value: 'Ready' },
	{ label: 'Error', value: 'Error' },
	{ label: 'Rebuilding', value: 'Rebuilding' },
] as const;

export type KnowledgeSourceStatusOption = (typeof knowledgeSourceStatuses)[number]['value'];

export const knowledgeStorageModes = [
	{ label: 'Frappe File', value: 'Frappe File' },
] as const;

export type KnowledgeStorageModeOption = (typeof knowledgeStorageModes)[number]['value'];

export const knowledgeInputTypes = [
	{ label: 'File', value: 'File' },
	{ label: 'Text', value: 'Text' },
	{ label: 'URL', value: 'URL' },
] as const;

export type KnowledgeInputTypeOption = (typeof knowledgeInputTypes)[number]['value'];

export const knowledgeInputStatuses = [
	{ label: 'Pending', value: 'Pending' },
	{ label: 'Processing', value: 'Processing' },
	{ label: 'Indexed', value: 'Indexed' },
	{ label: 'Error', value: 'Error' },
] as const;

export type KnowledgeInputStatusOption = (typeof knowledgeInputStatuses)[number]['value'];

/**
 * Mode options for Agent Knowledge child table (how the knowledge source is used).
 */
export const knowledgeModes = [
	{ label: 'Mandatory', value: 'Mandatory' },
	{ label: 'Optional', value: 'Optional' },
] as const;

export type KnowledgeModeOption = (typeof knowledgeModes)[number]['value'];

/**
 * Status filter options for the Knowledge Sources listing page.
 * Includes an "All" option plus source-level statuses and disabled.
 */
export const knowledgeSourceFilterStatuses = [
	{ label: 'All status', value: 'all' },
	{ label: 'Ready', value: 'ready' },
	{ label: 'Pending', value: 'pending' },
	{ label: 'Indexing', value: 'indexing' },
	{ label: 'Error', value: 'error' },
	{ label: 'Disabled', value: 'disabled' },
] as const;
