"""
Huf Flow Engine -- the ``FlowRuntime`` adapter over the shared graph executor.

Execution itself lives in :mod:`huf.ai.graph.executor`, which both this module
and (T-23) ``ProcedureRuntime`` drive. This module is the Flow-profile adapter:
it owns the ``Flow Definition`` / ``Flow Run`` documents, the twelve Flow node
executors, Flow's realtime events, and Flow's approval lifecycle -- and nothing
about how a graph is walked.

What changed in T-22, and why (defect ids are from the track plan):

* **F-1 -- versioning.** ``Flow Definition.version`` was an integer bumped on
  every save, with no content identity, and ``run_flow`` re-fetched the
  *current* definition every time -- so a run resumed after an edit executed
  the new graph. A run now pins an immutable, content-addressed
  :class:`~huf.ai.graph.executor.PinnedVersion` (see :func:`_pinned_version`)
  and executes that exact graph for its whole life.
* **F-2 -- interpolation.** Four divergent ``{{...}}`` implementations with
  different semantics per node type are gone; there is no string templating
  left in the engine at all. Every node type resolves its config exclusively
  through the executor's single structured reference form,
  ``{"$from": "node.path"}`` (see :meth:`~huf.ai.graph.executor.GraphContext.resolve`),
  with :func:`_resolve_context_path` still used for a plain dotted-path
  read (``transform``'s copy/map/template operations).
* **F-3 -- loops.** Loop iteration no longer burns the run's hop budget; a
  bounded foreach carries its own iteration budget in the executor.
* **F-4 -- concurrency.** ``run_flow`` takes a distributed lock, and the
  executor refuses to advance a run that is not in an advanceable state, so
  two concurrent callers cannot both move the same cursor.
* **F-9 -- context.** ``context_json`` was re-parsed at roughly fifteen call
  sites. It is now parsed once per run into a
  :class:`~huf.ai.graph.executor.GraphContext` carried by
  :class:`FlowRunContext` and threaded through every executor.
* **I5 -- telemetry.** ``Agent Tool Call`` records are emitted by
  ``huf.ai.tool_invocation`` (through ``flow_tool_executor``), not assembled
  here. Exactly one record per atomic operation.
"""

import json

import frappe
from frappe import _
from frappe.utils import now_datetime
from frappe.desk.doctype.notification_log.notification_log import enqueue_create_notification
from frappe.desk.doctype.notification_settings.notification_settings import is_email_notifications_enabled

from huf.ai.flow_eval import safe_eval_expression
from huf.ai.flow_orchestrator import (
	build_flow_context_system_message,
	build_orchestrator_prompt,
	build_router_prompt,
	parse_decision,
)
from huf.ai.flow_tool_executor import execute as execute_tool
from huf.ai.flow_tool_executor import tool_run_context
from huf.ai.graph.executor import (
	ExecutionPolicy,
	ExecutionResult,
	ExecutionState,
	GraphContext,
	GraphExecutor,
	GraphProgram,
	NodeSpec,
	Outcome,
	PauseRequest,
	PinnedVersion,
	RoutingError,
	RoutingMode,
	Router,
)
from huf.ai.graph.expressions import evaluate_bool, parse_expression
from huf.ai.graph.transforms import Limits as TransformLimits
from huf.ai.graph.transforms import run_transform
from huf.ai.output_budget import OutputBudget, OutputBudgetExceeded, enforce_output_budget
from huf.ai.tool_invocation import RunContext
from huf.ai.transaction import commit_if_background


DEFAULT_MAX_HOPS = 100

RUN_LOCK_TTL_SECONDS = 600
"""How long a run lock survives if its holder dies mid-execution."""

WAITING_STATUSES = ("Waiting User", "Waiting Approval")

ADVANCEABLE_STATUSES = ("Running", "Queued")

#: How each Flow node type resolves its successor. One table, consulted in one
#: place by the executor's Router -- replacing the pre-T-22 split between the
#: ``_execute_node`` dispatch table and a type-switch inside ``_execute_loop``
#: (structural knot 3).
NODE_ROUTING = {
	"condition": RoutingMode.SELF_ROUTED,
	"router.llm": RoutingMode.SELF_ROUTED,
	"loop": RoutingMode.SELF_ROUTED_OPTIONAL,
	"end": RoutingMode.TERMINAL,
	# "output" is always terminal per spec/graph-ir.md section 2 ("next must be
	# absent or null") -- true for both the Procedure and Flow profiles.
	"output": RoutingMode.TERMINAL,
}

#: Node types whose handler may be paused by another subsystem writing the
#: ``Flow Run`` status (an agent asking the user a question, for instance).
#: For these -- and only these -- the adapter converts that external state
#: into a typed pause outcome, so the executor core still sees a value rather
#: than a status string it has to reload (structural knot 2).
EXTERNALLY_PAUSABLE_TYPES = ("agent.run", "router.llm")


# ---------------------------------------------------------------------------
# Run-scoped context (F-9, structural knot 1)
# ---------------------------------------------------------------------------


class FlowRunContext(dict):
	"""Everything a node executor needs about the run it is part of.

	It subclasses ``dict`` and carries the definition's ``settings`` as its
	mapping content, so it is drop-in wherever a bare ``settings`` dict used
	to be passed -- including from tests that pass ``{}``. What it adds is the
	run-scoped state the executors used to dig out of the ``Flow Run``
	Document one field at a time: the parsed context, the pinned version, the
	flow id, the mode, the shared conversation (structural knot 1), and the
	fact that the context is parsed exactly once per run (F-9).
	"""

	def __init__(self, settings=None, *, flow_run=None, version=None, context=None):
		super().__init__(settings or {})
		self.flow_run = flow_run
		self.version = version
		self.context = context if context is not None else GraphContext()
		self.flow_id = getattr(flow_run, "flow_id", None)
		self.run_id = getattr(flow_run, "name", None)
		self.mode = (getattr(flow_run, "mode", "") or "normal").lower()
		self.conversation = getattr(flow_run, "conversation", None)

	@property
	def definition(self) -> dict:
		return self.version.graph if self.version else {}

	@property
	def edges(self) -> list:
		return effective_edges(self.definition)

	def save_context(self) -> None:
		"""Write the in-memory context back to the ``Flow Run``."""
		if self.flow_run is None:
			return
		self.flow_run.db_set("context_json", self.context.to_json())
		self.context.dirty = False


def _run_context(settings) -> FlowRunContext | None:
	"""The run context, when the caller threaded one through."""
	return settings if isinstance(settings, FlowRunContext) else None


def _context_of(flow_run, settings) -> GraphContext:
	"""The run's :class:`GraphContext`, parsed once where one exists.

	Callers that predate the run context (and the frappe-free tests) get a
	context built from the document on the spot, so every executor has
	exactly one way to read run state either way.
	"""
	run_ctx = _run_context(settings)
	if run_ctx is not None:
		return run_ctx.context
	return GraphContext.from_json(getattr(flow_run, "context_json", None))


def _persist_context(flow_run, ctx: GraphContext, settings=None) -> None:
	"""Persist the context blob and commit if we are in a background job."""
	run_ctx = _run_context(settings)
	if run_ctx is not None:
		run_ctx.save_context()
	else:
		flow_run.db_set("context_json", ctx.to_json())
	commit_if_background()


# ---------------------------------------------------------------------------
# Version identity (F-1)
# ---------------------------------------------------------------------------


def load_definition(flow_id: str) -> dict:
	"""
	Load and return a parsed FlowDefinition.

	This returns whatever the definition record currently holds. Execution
	never calls it mid-run: a run resolves its graph once, through
	:func:`_pinned_version`, and keeps it (F-1).

	Args:
	    flow_id: The flow_id (= FlowDefinition name)

	Returns:
	    dict: Parsed definition JSON
	"""
	doc = frappe.get_doc("Flow Definition", flow_id)
	if doc.status != "Active":
		frappe.throw(_("Flow '{0}' is not active (status: {1})").format(flow_id, doc.status))

	defn = json.loads(doc.definition_json) if isinstance(doc.definition_json, str) else doc.definition_json
	return defn


def _pinned_version(flow_run) -> PinnedVersion:
	"""The exact graph this run executes, for the whole life of the run.

	If the run already carries a pinned snapshot, that snapshot is returned
	verbatim -- an edit to the ``Flow Definition`` since the run started
	cannot change what this run executes. If it does not (a run created
	before pinning existed, or a site whose ``Flow Run`` schema predates the
	snapshot field), the current definition is pinned now and recorded, so
	the very next step is already immune.
	"""
	pinned = PinnedVersion.from_json(getattr(flow_run, "pinned_definition", None))
	if pinned is not None:
		return pinned

	version = PinnedVersion.pin(load_definition(getattr(flow_run, "flow_id", None)))
	_store_pin(flow_run, version)
	return version


def _store_pin(flow_run, version: PinnedVersion) -> None:
	"""Record a pin on the run, where the schema can hold one.

	Guarded rather than assumed: a site whose ``Flow Run`` has not been
	migrated yet simply keeps resolving the pin per run instead of erroring.
	"""
	try:
		if not frappe.db.has_column("Flow Run", "pinned_definition"):
			return
		flow_run.db_set(
			{
				"pinned_fingerprint": version.fingerprint,
				"pinned_definition": version.to_json(),
			}
		)
	except Exception:
		# Pin persistence is an optimisation over re-resolving; never let it
		# take down a run.
		pass


# ---------------------------------------------------------------------------
# Run lock (F-4)
# ---------------------------------------------------------------------------


def _run_lock_key(flow_run_name: str) -> str:
	return f"huf:flow:run_lock:{flow_run_name}"


def _acquire_run_lock(flow_run_name: str) -> bool:
	"""Take the single-writer lock for a run.

	Same shape as the distributed lock in ``agent_integration.py``: a Redis
	``SET key value EX ttl NX``, which is atomic, so exactly one of two
	concurrent callers gets ``True``. Before T-22 ``run_flow`` took no lock at
	all and two concurrent calls could both advance the same cursor (F-4).
	"""
	try:
		return bool(frappe.cache().set(_run_lock_key(flow_run_name), 1, ex=RUN_LOCK_TTL_SECONDS, nx=True))
	except Exception:
		# A cache that cannot serve the lock must not silently serialize
		# nothing *and* block execution; the executor's status guard is the
		# second line of defence.
		return True


def _release_run_lock(flow_run_name: str) -> None:
	try:
		frappe.cache().delete_value(_run_lock_key(flow_run_name))
	except Exception:
		pass


# ---------------------------------------------------------------------------
# Public entry points
# ---------------------------------------------------------------------------


def create_flow_run(
	flow_id: str,
	payload: dict | None = None,
	mode: str | None = None,
	conversation_mode: str | None = None,
	trigger_type: str = "Manual",
) -> "frappe.Document":
	"""
	Create a new FlowRun document from a FlowDefinition.

	The run pins the definition's content fingerprint at creation, and stores
	the graph itself alongside it, so the run is immune to later edits (F-1).

	Args:
	    flow_id: The flow_id to run
	    payload: Initial trigger payload / input
	    mode: Override mode (normal/agentic). If None, uses definition settings.
	    conversation_mode: Override conversation_mode. If None, uses definition settings.
	    trigger_type: Manual / Webhook / Schedule / Doc Event

	Returns:
	    Flow Run document
	"""
	defn_doc = frappe.get_doc("Flow Definition", flow_id)
	defn = json.loads(defn_doc.definition_json) if isinstance(defn_doc.definition_json, str) else defn_doc.definition_json

	version = PinnedVersion.pin(defn)

	settings = defn.get("settings", {})
	resolved_mode = mode or settings.get("mode", "normal")
	max_hops = settings.get("max_hops", DEFAULT_MAX_HOPS)

	# Create shared conversation if configured
	conversation = None
	conv_mode = conversation_mode or settings.get("conversation_mode", "flow_shared")
	if conv_mode == "flow_shared":
		conversation = _create_flow_conversation(flow_id, defn.get("entry"))

	fields = {
		"doctype": "Flow Run",
		"flow_definition": flow_id,
		"flow_id": flow_id,
		"flow_version": defn_doc.version,
		"mode": resolved_mode.capitalize(),
		"status": "Queued",
		"current_node_id": defn.get("entry"),
		"hop_count": 0,
		"max_hops": max_hops,
		"context_json": json.dumps(payload or {}),
		"trigger_type": trigger_type,
		"trigger_payload": json.dumps(payload or {}),
		"conversation": conversation.name if conversation else None,
		"started_at": now_datetime(),
	}
	if _has_pin_columns():
		fields["pinned_fingerprint"] = version.fingerprint
		fields["pinned_definition"] = version.to_json()

	flow_run = frappe.get_doc(fields)
	# Authenticated callers are already verified by the public API.
	# Webhook triggers run as Guest after HMAC validation, so the internal
	# Flow Run record must be created on behalf of the system.
	if frappe.session.user == "Guest":
		flow_run.insert(ignore_permissions=True)
	else:
		if not frappe.has_permission("Flow Run", "create", doc=flow_run):
			frappe.throw(_("Not permitted to create Flow Run"), frappe.PermissionError)
		flow_run.insert()
	commit_if_background()

	return flow_run


def _has_pin_columns() -> bool:
	try:
		return bool(frappe.db.has_column("Flow Run", "pinned_definition"))
	except Exception:
		return False


def run_flow(flow_run_name: str):
	"""
	Execute a flow run from its current position until completion or pause.

	Loads the run's *pinned* graph, takes the run lock, and hands the walk to
	the shared :class:`~huf.ai.graph.executor.GraphExecutor`.

	Args:
	    flow_run_name: Name of the Flow Run document
	"""
	if not _acquire_run_lock(flow_run_name):
		# Another worker is already advancing this run; a second cursor
		# writer is exactly the race F-4 describes.
		return

	try:
		flow_run = frappe.get_doc("Flow Run", flow_run_name)
		version = _pinned_version(flow_run)
		defn = version.graph

		nodes_map = {n["id"]: n for n in defn.get("nodes", [])}
		edges_list = effective_edges(defn)
		run_ctx = _build_run_context(flow_run, version)

		flow_run.db_set({"status": "Running", "last_error": ""})
		commit_if_background()

		try:
			_execute_loop(flow_run, nodes_map, edges_list, run_ctx)
		except Exception as e:
			_fail_flow_run(flow_run, str(e))
			frappe.log_error(f"Flow engine error: {frappe.get_traceback()}", "Flow Engine")
	finally:
		_release_run_lock(flow_run_name)


def _build_run_context(flow_run, version: PinnedVersion) -> FlowRunContext:
	"""Build the run-scoped context once, for the whole run (F-9)."""
	context = GraphContext.from_json(
		getattr(flow_run, "context_json", None),
		run_id=getattr(flow_run, "name", None),
		mode=(getattr(flow_run, "mode", "") or "normal"),
		metadata={
			"flow_id": getattr(flow_run, "flow_id", None),
			"conversation": getattr(flow_run, "conversation", None),
			"fingerprint": version.fingerprint,
		},
	)
	return FlowRunContext(
		version.graph.get("settings", {}),
		flow_run=flow_run,
		version=version,
		context=context,
	)


def resume_flow_run(flow_run_name: str, user_input: dict | None = None):
	"""
	Resume a paused flow run (Waiting User / Waiting Approval).

	A pause records where to continue (structural knot 2), so resuming
	*advances past* the node that paused rather than re-executing it. That is
	both the correct semantics -- re-running a node that already produced its
	side effects is a bug -- and what keeps a resumed run independent of any
	edit made to the definition while it was waiting (F-1).

	Args:
	    flow_run_name: Name of the Flow Run
	    user_input: Optional input to merge into context
	"""
	flow_run = frappe.get_doc("Flow Run", flow_run_name)

	if flow_run.status not in WAITING_STATUSES:
		frappe.throw(_("Flow Run is not in a waiting state (status: {0})").format(flow_run.status))

	version = _pinned_version(flow_run)
	run_ctx = _build_run_context(flow_run, version)

	if user_input:
		run_ctx.context.update(user_input)
		run_ctx.save_context()

	waiting = _load_waiting(flow_run)
	paused_node = flow_run.current_node_id
	next_node_id = waiting.get("resume_node") or _evaluate_edges(
		flow_run, paused_node, {"status": "success"}, run_ctx.edges, context=run_ctx.context
	)

	flow_run.db_set({"waiting": None, "status": "Running"})
	commit_if_background()

	if not next_node_id:
		# The node that paused was the last step on its chain.
		_complete_flow_run(flow_run)
		return

	flow_run.db_set("current_node_id", next_node_id)
	flow_run.db_set("hop_count", (flow_run.hop_count or 0) + 1)
	commit_if_background()

	run_flow(flow_run_name)


def _load_waiting(flow_run) -> dict:
	raw = getattr(flow_run, "waiting", None)
	if not raw:
		return {}
	try:
		data = json.loads(raw) if isinstance(raw, str) else raw
	except (json.JSONDecodeError, TypeError):
		return {}
	return data if isinstance(data, dict) else {}


@frappe.whitelist()
def approve_flow_run(flow_run_name: str, decision: str, comment: str | None = None):
	"""
	Approve or reject a flow run waiting for approval.

	Routing goes through the same :class:`~huf.ai.graph.executor.Router` every
	other node uses -- the ``meta.outcome`` convention is now just an
	outcome-labelled edge, not a third inline routing implementation
	(structural knot 4).

	Args:
	    flow_run_name: Name of the Flow Run
	    decision: "approved" or "rejected"
	    comment: Optional comment
	"""
	flow_run = frappe.get_doc("Flow Run", flow_run_name)

	if flow_run.status != "Waiting Approval":
		frappe.throw(_("Flow Run is not waiting for approval (status: {0})").format(flow_run.status))

	# Permission is verified before anything is mutated.
	waiting = _load_waiting(flow_run)
	_verify_approval_permission(waiting)

	version = _pinned_version(flow_run)
	run_ctx = _build_run_context(flow_run, version)
	edges_list = run_ctx.edges
	current_node = flow_run.current_node_id

	run_ctx.context.set(
		waiting.get("store_decision_in_context", "approval"),
		{
			"decision": decision,
			"comment": comment,
			"approved_by": frappe.session.user,
			"approved_at": str(now_datetime()),
		},
	)
	run_ctx.save_context()

	router = _build_router(flow_run, run_ctx, edges_list, ExecutionState(cursor=current_node))
	next_node = router.resolve_labelled(current_node, decision)

	if not next_node and decision == "approved":
		next_node = _evaluate_edges(
			flow_run, current_node, {"status": "success"}, edges_list, context=run_ctx.context
		)

	if not next_node:
		if decision == "rejected":
			# Rejection without an explicit 'rejected' edge must not route
			# like an approval down a success-shaped path.
			flow_run.db_set("waiting", None)
			_fail_flow_run(
				flow_run,
				f"Approval rejected by {frappe.session.user}" + (f": {comment}" if comment else ""),
			)
			_clear_flow_notifications(flow_run)
			return
		# No outgoing edges -- approval was the final step, complete gracefully
		if not _get_outgoing_edges(current_node, edges_list):
			flow_run.db_set({"waiting": None, "status": "Running"})
			commit_if_background()
			_complete_flow_run(flow_run)
			return
		_fail_flow_run(flow_run, f"No edge found for outcome '{decision}' from node '{current_node}'")
		return

	flow_run.db_set({"current_node_id": next_node, "waiting": None, "status": "Running"})
	flow_run.db_set("hop_count", (flow_run.hop_count or 0) + 1)
	commit_if_background()

	_clear_flow_notifications(flow_run)

	run_flow(flow_run.name)


# ---------------------------------------------------------------------------
# Core execution -- the adapter onto GraphExecutor
# ---------------------------------------------------------------------------


def _build_program(nodes_map: dict, edges_list: list, settings) -> GraphProgram:
	"""Normalize a Flow graph into the executor's vocabulary.

	This is the whole of the Flow profile's shape knowledge: which node types
	route themselves, which are terminal, and which carry a bounded loop body.
	"""
	run_ctx = _run_context(settings)
	if run_ctx is not None and run_ctx.version is not None:
		version = run_ctx.version
	else:
		version = PinnedVersion.pin(
			{"nodes": list(nodes_map.values()), "edges": edges_list, "settings": dict(settings or {})}
		)

	specs = {}
	for node_id, node in nodes_map.items():
		config = node.get("config") or {}
		node_type = node.get("type")
		specs[node_id] = NodeSpec(
			id=node_id,
			type=node_type,
			config=config,
			routing=NODE_ROUTING.get(node_type, RoutingMode.DEFAULT),
			raw=node,
			loop_body=config.get("loop_node") if node_type == "loop" else None,
		)
	return GraphProgram(version, specs, version.graph.get("entry"), settings=dict(settings or {}))


def _build_router(flow_run, settings, edges_list: list, state: ExecutionState) -> Router:
	"""One routing path for every node type (structural knots 3 and 4)."""
	run_ctx = _run_context(settings)
	is_agentic = (run_ctx.mode if run_ctx is not None else "normal") == "agentic"
	orch_policy = (settings or {}).get("orchestrator_call_policy", "after_each_node")

	def default_resolver(node: NodeSpec, outcome: Outcome, context: GraphContext):
		node_result = outcome.extra or {"status": outcome.status}
		if is_agentic and _should_call_orchestrator(orch_policy, state.completed_nodes):
			candidates = _get_outgoing_edges(node.id, edges_list)
			if not candidates:
				return None
			chosen = _call_orchestrator(
				flow_run, node.id, node_result, candidates, settings, state.completed_nodes
			)
			if not chosen:
				raise RoutingError("Orchestrator did not return a valid next_node_id")
			return chosen
		return _evaluate_edges(flow_run, node.id, node_result, edges_list, context=context)

	def labelled_resolver(node_id: str, label: str):
		for edge in edges_list:
			if edge.get("from") != node_id:
				continue
			if (edge.get("meta") or {}).get("outcome") == label:
				return edge.get("to")
		return None

	program = _build_program({}, edges_list, settings)
	return Router(program, default_resolver=default_resolver, labelled_resolver=labelled_resolver)


def _flow_state(flow_run) -> ExecutionState:
	status = (getattr(flow_run, "status", "") or "").strip()
	return ExecutionState(
		cursor=getattr(flow_run, "current_node_id", None),
		hop_count=getattr(flow_run, "hop_count", 0) or 0,
		status="running" if status in ADVANCEABLE_STATUSES else status.lower(),
	)


class _FlowStateStore:
	"""Write-through persistence for the cursor and hop count.

	This is the opt-in half of the executor's persistence seam: Flow wants
	every step durable because a run can pause for days, while a Procedure
	(T-23) keeps the default in-memory store and never touches the database
	on its hot path.
	"""

	def __init__(self, flow_run):
		self.flow_run = flow_run

	def save_cursor(self, cursor: str) -> None:
		self.flow_run.db_set("current_node_id", cursor)

	def save_hops(self, hop_count: int) -> None:
		self.flow_run.db_set("hop_count", hop_count)


class _FlowEventListener:
	"""Publishes the realtime events the Flow UI subscribes to."""

	def __init__(self, flow_run):
		self.flow_run = flow_run

	def node_start(self, node: NodeSpec) -> None:
		_publish_flow_event(
			self.flow_run,
			"flow_node_start",
			{
				"node_id": node.id,
				"node_type": node.type,
				"node_label": node.raw.get("_label", node.id),
			},
		)

	def node_end(self, node: NodeSpec, outcome: Outcome) -> None:
		_publish_flow_event(
			self.flow_run,
			"flow_node_end",
			{"node_id": node.id, "node_type": node.type, "status": outcome.status},
		)


def _make_node_handler(flow_run, settings):
	"""Bridge one Flow node executor into the executor's handler contract."""

	def handler(node: NodeSpec, context: GraphContext, state: ExecutionState):
		result = _execute_node(flow_run, node.raw, settings)
		outcome = Outcome.from_mapping(result)
		if not outcome.is_paused and node.type in EXTERNALLY_PAUSABLE_TYPES:
			# Another subsystem may have parked this run while the node ran.
			# Convert that into a typed pause here, in the adapter, so the
			# executor core never reads a status string (structural knot 2).
			try:
				flow_run.reload()
			except Exception:
				pass
			if getattr(flow_run, "status", None) in WAITING_STATUSES:
				return Outcome.paused(PauseRequest(kind="user", status_label=flow_run.status))
		return outcome

	return handler


def _execute_loop(flow_run, nodes_map: dict, edges_list: list, settings: dict):
	"""Drive a Flow run to completion, a pause, or a failure.

	Everything about *how* the graph is walked -- hop budget, foreach budget,
	terminal detection, routing -- belongs to
	:class:`~huf.ai.graph.executor.GraphExecutor`. What is left here is
	Flow-specific: mapping the executor's result onto the ``Flow Run``
	document's status vocabulary.
	"""
	program = _build_program(nodes_map, edges_list, settings)
	state = _flow_state(flow_run)
	router = _build_router(flow_run, settings, edges_list, state)
	handler = _make_node_handler(flow_run, settings)
	handlers = {node_type: handler for node_type in _NODE_TYPES}

	policy = ExecutionPolicy(
		max_hops=getattr(flow_run, "max_hops", None) or DEFAULT_MAX_HOPS,
		max_foreach_iterations=(settings or {}).get("max_foreach_iterations")
		or ExecutionPolicy.max_foreach_iterations,
	)

	executor = GraphExecutor(
		program,
		handlers,
		router=router,
		policy=policy,
		store=_FlowStateStore(flow_run),
		listener=_FlowEventListener(flow_run),
	)

	result = executor.run(_context_of(flow_run, settings), state)

	if result.status == ExecutionResult.REFUSED:
		# The run is not advanceable (already finished, or being advanced by
		# another writer). Leave it exactly as it is (F-4).
		return result

	if result.status == ExecutionResult.PAUSED:
		_publish_flow_event(
			flow_run,
			"flow_paused",
			{"node_id": result.node_id, "status": getattr(flow_run, "status", None)},
		)
		return result

	if result.status == ExecutionResult.FAILED:
		_publish_flow_event(flow_run, "flow_error", {"error": result.error})
		_fail_flow_run(flow_run, result.error)
		return result

	_complete_flow_run(flow_run)
	_publish_flow_event(flow_run, "flow_completed", {"node_id": result.node_id, "status": "Success"})
	return result


# ---------------------------------------------------------------------------
# Node executors
# ---------------------------------------------------------------------------


def _execute_node(flow_run, node: dict, settings: dict) -> dict:
	"""
	Execute a single node and return the result.

	Dispatches to the appropriate executor based on node type. This table is
	now purely a dispatch table: it no longer also decides routing, which
	lives in :data:`NODE_ROUTING` and the executor's Router (knot 3).
	"""
	node_type = node.get("type")
	config = node.get("config", {})

	executor = _NODE_EXECUTORS.get(node_type)
	if not executor:
		frappe.throw(_("Unknown node type: {0}").format(node_type))

	return executor(flow_run, node, config, settings)


def _exec_trigger_webhook(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""Execute trigger.webhook node - mostly a passthrough for UI clarity."""
	ctx = _context_of(flow_run, settings)
	return {"status": "success", "output": ctx.as_dict()}


def _exec_trigger_schedule(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute trigger.schedule node - passthrough for scheduled execution.

	The actual scheduling is handled externally via Frappe Scheduler. This
	executor records when the schedule fired.
	"""
	ctx = _context_of(flow_run, settings)

	schedule_info = {
		"trigger_type": "schedule",
		"triggered_at": str(now_datetime()),
		"cron_expression": config.get("cron", ""),
		"schedule_name": config.get("schedule_name", ""),
	}

	ctx.set("_schedule_trigger", schedule_info)
	_persist_context(flow_run, ctx, settings)

	return {"status": "success", "trigger_type": "schedule", "schedule_info": schedule_info}


def _exec_trigger_doc_event(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute trigger.doc-event node - pass through with doc context.

	The payload is set during flow run creation by
	``flow_hooks.run_doc_event_flows()``; this executor enriches it with
	event metadata for downstream nodes.
	"""
	ctx = _context_of(flow_run, settings)

	trigger_info = ctx.get("trigger") or {}
	doc_data = ctx.get("doc") or {}

	doc_event_info = {
		"trigger_type": "doc_event",
		"triggered_at": str(now_datetime()),
		"doctype": trigger_info.get("doctype", ctx.get("doctype")),
		"docname": trigger_info.get("docname", ctx.get("docname")),
		"event": trigger_info.get("event", ctx.get("event")),
	}

	ctx.set("_doc_event_trigger", doc_event_info)
	if doc_data and not ctx.get("doc"):
		ctx.set("doc", doc_data)

	_persist_context(flow_run, ctx, settings)

	return {"status": "success", "trigger_type": "doc_event", "doc_event_info": doc_event_info}


def _exec_agent_run(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""Execute agent.run node - runs a Huf agent."""
	agent_name = config.get("agent_name")
	if not agent_name:
		return {"status": "failed", "error": "agent.run node missing agent_name in config"}

	run_ctx = _run_context(settings)
	ctx = _context_of(flow_run, settings)

	prompt = _build_agent_prompt(config, ctx)

	conv_mode = config.get("conversation_mode", "flow_shared")
	conversation_id = _conversation_of(flow_run, run_ctx) if conv_mode == "flow_shared" else None

	inject_context = config.get("input", {}).get("inject_flow_context")
	if inject_context is None:
		inject_context = config.get("inject_flow_context", False)

	if _mode_of(flow_run, run_ctx) == "agentic":
		inject_context = True

	try:
		from huf.ai.agent_integration import run_agent_sync

		result = run_agent_sync(
			agent_name=agent_name,
			prompt=prompt,
			conversation_id=conversation_id,
			channel_id="flow",
			flow_run_id=flow_run.name,
			flow_node_id=node.get("id"),
			run_kind="agent",
			now=True,
		)

		if result and result.get("agent_run_id"):
			flow_run.db_set("last_agent_run", result["agent_run_id"])

		output_config = config.get("output", {})
		save_key = output_config.get("save_response_to_context") or config.get("save_response_to_context")
		if save_key:
			ctx.set(save_key, result.get("response", ""))
			_persist_context(flow_run, ctx, settings)

		commit_if_background()

		return {
			"status": "success" if result.get("success") else "failed",
			"response": result.get("response", ""),
			"agent_run_id": result.get("agent_run_id"),
			"error": result.get("error"),
		}
	except Exception as e:
		return {"status": "failed", "error": str(e)}


def _exec_tool_call(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""Execute tool.call node - deterministic tool execution.

	Argument substitution resolves ``{"$from": ...}`` references through the
	executor's single structured reference form (F-2), not a local flat-key
	variant -- ``GraphContext.resolve`` explicitly replaces the four divergent
	``{{...}}`` string-interpolation implementations this used to have (GT-04),
	so no separate dotted-path template substitution runs here any more.

	For a built-in tool, the ``Agent Tool Call`` telemetry record is emitted
	by the invocation service rather than assembled here -- exactly one
	record per call (I5, GT-05). An MCP tool bypasses that service entirely
	(``execute_mcp_tool`` has no telemetry of its own), so this function owns
	its ``Agent Tool Call`` record directly, the same way the pre-T-22
	implementation did for every tool call.
	"""
	# ``tool_id``/``input`` are the graph-IR schema's canonical field names for a
	# tool.call node (huf/ai/graph/graph_ir.schema.json) -- the only shape
	# huf.huf.doctype.flow_definition.flow_definition.FlowDefinition.validate()
	# will ever let through save_flow_definition, since the schema node also sets
	# additionalProperties: false. ``tool_name``/``args``/``parameters`` are kept
	# as a read-only fallback for any flow definition JSON constructed directly
	# (e.g. in tests) rather than through the validated save path.
	tool_name = config.get("tool_id") or config.get("tool_name")
	if not tool_name:
		return {"status": "failed", "error": "tool.call node missing tool_id in config"}

	args = dict(config.get("input") or config.get("args") or config.get("parameters") or {})
	run_ctx = _run_context(settings)
	ctx = _context_of(flow_run, settings)
	args = ctx.resolve(args)

	run_doc = _create_flow_agent_run(
		flow_run=flow_run,
		node=node,
		run_kind="tool",
		prompt=f"Tool: {tool_name}\nArgs: {json.dumps(args, default=str)}",
		agent_name=config.get("agent_name") or config.get("agent"),
	)

	# Check MCP tool info: prefer the explicit config, fall back to lookup
	# by tool name for backward compatibility with existing flow definitions.
	mcp_server = config.get("mcp_server")
	if not mcp_server:
		mcp_tool_entry = frappe.db.get_value("MCP Server Tool", {"tool_name": tool_name, "enabled": 1}, "parent")
		if mcp_tool_entry:
			mcp_server = mcp_tool_entry

	invocation_ctx = RunContext(
		conversation_id=_conversation_of(flow_run, run_ctx),
		agent_run_id=getattr(run_doc, "name", None),
	)

	tool_call_doc = None
	if mcp_server:
		from uuid import uuid4

		# Create Agent Tool Call audit record ourselves -- see the docstring
		# above on why the MCP path can't rely on the invocation service.
		tool_call_doc = frappe.get_doc({
			"doctype": "Agent Tool Call",
			"agent_run": run_doc.name,
			"conversation": getattr(flow_run, "conversation", None),
			"tool": tool_name,
			"is_mcp_tool": 1,
			"mcp_server": mcp_server,
			"tool_args": json.dumps(args, default=str) if args else None,
			"status": "Started",
			"call_id": f"call_{uuid4().hex[:12]}",
		})
		tool_call_doc.insert(ignore_permissions=True)

	try:
		if mcp_server:
			from huf.ai.mcp_client import execute_mcp_tool

			# execute_mcp_tool is async; run it to completion the same way
			# huf/ai/flow_tool_executor.py already does for coroutine results
			# from sync flow-engine code.
			import asyncio

			coro = execute_mcp_tool(server_name=mcp_server, tool_name=tool_name, arguments=args)
			loop = asyncio.new_event_loop()
			asyncio.set_event_loop(loop)
			try:
				result = loop.run_until_complete(coro)
			finally:
				loop.close()
			if not isinstance(result, dict):
				result = {"success": True, "result": result}
		else:
			with tool_run_context(invocation_ctx):
				result = execute_tool(tool_name, args)

		is_success = result.get("success", False) if isinstance(result, dict) else bool(result)
		error_msg = result.get("error", "") if isinstance(result, dict) else ""

		if tool_call_doc is not None:
			tool_result = result.get("result", result) if isinstance(result, dict) else result
			if isinstance(tool_result, (dict, list)):
				formatted_result = tool_result
			else:
				formatted_result = {"output": str(tool_result)} if tool_result is not None else None
			tool_call_doc.update({
				"status": "Completed" if is_success else "Failed",
				"tool_result": formatted_result,
				"error_message": error_msg or None,
			})
			tool_call_doc.save(ignore_permissions=True)

		run_doc.db_set(
			{
				"status": "Success" if is_success else "Failed",
				"response": json.dumps(result, default=str),
				"error_message": error_msg,
				"end_time": now_datetime(),
			}
		)
		flow_run.db_set("last_agent_run", run_doc.name)

		output_config = config.get("output", {})
		save_key = output_config.get("save_result_to_context") or config.get("save_result_to_context")
		if save_key:
			ctx.set(save_key, result.get("result", result))
			_persist_context(flow_run, ctx, settings)

		commit_if_background()

		return {
			"status": "success" if result.get("success") else "failed",
			"result": result.get("result"),
			"error": result.get("error"),
		}
	except Exception as e:
		if tool_call_doc is not None:
			tool_call_doc.update({"status": "Failed", "error_message": str(e)})
			tool_call_doc.save(ignore_permissions=True)
		run_doc.db_set({"status": "Failed", "error_message": str(e), "end_time": now_datetime()})
		commit_if_background()
		return {"status": "failed", "error": str(e)}


def _exec_router_llm(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""Execute router.llm node - LLM-based routing.

	Candidates come from the run's *pinned* graph (structural knot 5). The
	pre-T-22 implementation re-loaded the whole ``Flow Definition`` from the
	database in the middle of execution, which is precisely how an edit could
	change a running graph's routing under it.
	"""
	router_agent_name = config.get("router_agent_name")
	if not router_agent_name:
		return {"status": "failed", "error": "router.llm node missing router_agent_name in config"}

	run_ctx = _run_context(settings)
	ctx = _context_of(flow_run, settings)
	edges_list = run_ctx.edges if run_ctx is not None else effective_edges(load_definition(flow_run.flow_id))

	candidates = _get_outgoing_edges(node.get("id"), edges_list)
	if not candidates:
		return {"status": "failed", "error": "router.llm node has no outgoing edges"}

	valid_node_ids = {c["to"] for c in candidates}

	prompt = build_router_prompt(
		node_config=config,
		candidates=candidates,
		flow_context=ctx.as_dict(),
		last_node_result=None,
	)

	conv_mode = config.get("conversation_mode", "flow_shared")
	conversation_id = _conversation_of(flow_run, run_ctx) if conv_mode == "flow_shared" else None

	try:
		from huf.ai.agent_integration import run_agent_sync

		result = run_agent_sync(
			agent_name=router_agent_name,
			prompt=prompt,
			conversation_id=conversation_id,
			channel_id="flow_router",
			flow_run_id=flow_run.name,
			flow_node_id=node.get("id"),
			run_kind="orchestrator",
			now=True,
		)

		if not result.get("success"):
			return {"status": "failed", "error": result.get("error", "Router agent failed")}

		decision = parse_decision(result.get("response", ""), valid_node_ids)

		if decision.get("context_patch"):
			ctx.update(decision["context_patch"])
			_persist_context(flow_run, ctx, settings)

		flow_run.db_set("last_agent_run", result.get("agent_run_id"))
		commit_if_background()

		return {
			"status": "success",
			"next_node_id": decision["next_node_id"],
			"message": decision.get("message", ""),
			"reason": decision.get("reason", ""),
		}
	except Exception as e:
		return {"status": "failed", "error": str(e)}


def _exec_human_approval(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""Execute human.approval node - pause for human decision.

	Returns a pause as a *value*; the executor never has to reload the
	document and compare status strings to notice (structural knot 2).
	"""
	if flow_run.status == "Waiting Approval" and flow_run.current_node_id == node.get("id"):
		return {"status": "waiting_approval"}

	ctx = _context_of(flow_run, settings)
	context_summary = config.get("context_summary", "")
	reference_name = config.get("reference_name", "")
	if context_summary:
		context_summary = ctx.resolve(context_summary)
	if reference_name:
		reference_name = ctx.resolve(reference_name)

	waiting_data = {
		"type": "approval",
		"node_id": node.get("id"),
		"approval_type": config.get("approval_type", "role"),
		"approver_role": config.get("approver_role"),
		"approver_users": config.get("approver_users", []),
		"title": config.get("title", "Approval Required"),
		"instructions": config.get("instructions", ""),
		"context_summary": context_summary,
		"reference_doctype": config.get("reference_doctype", ""),
		"reference_name": reference_name,
		"store_decision_in_context": config.get("store_decision_in_context", "approval"),
	}

	flow_run.db_set({"status": "Waiting Approval", "waiting": json.dumps(waiting_data)})
	commit_if_background()

	_send_approval_notifications(flow_run, node, config, waiting_data)

	return {"status": "waiting_approval"}


def _exec_http_request(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute http_request node - makes an HTTP request.

	Config keys:
	    url (str): Target URL (may be a ``{"$from": ...}`` reference)
	    method (str): GET, POST, PUT, DELETE (default: GET)
	    headers (dict): Optional request headers
	    body (dict|str): Optional request body for POST/PUT
	    timeout (int): Request timeout in seconds (default: 30)
	    save_result_to_context (str): Context key to store result
	"""
	import requests as http_lib

	ctx = _context_of(flow_run, settings)

	url = ctx.resolve(config.get("url"))
	if not url:
		return {"status": "failed", "error": "http_request node missing 'url' in config"}

	method = (config.get("method") or "GET").upper()
	headers = ctx.resolve(config.get("headers") or {})
	if isinstance(headers, dict):
		headers = {k: str(v) for k, v in headers.items()}

	body = config.get("body")
	if isinstance(body, (dict, list, str)):
		body = ctx.resolve(body)

	timeout = config.get("timeout", 30)

	try:
		kwargs = {"headers": headers, "timeout": timeout}
		if method in ("POST", "PUT", "PATCH") and body:
			if isinstance(body, dict):
				kwargs["json"] = body
			else:
				kwargs["data"] = body

		resp = http_lib.request(method, url, **kwargs)

		try:
			result_data = resp.json()
		except (json.JSONDecodeError, TypeError):
			frappe.log_error(
				frappe.get_traceback(),
				"HTTP response JSON parse failed — falling back to text",
			)
			result_data = resp.text

		result = {
			"status_code": resp.status_code,
			"data": result_data,
			"headers": dict(resp.headers),
		}

		output_config = config.get("output", {})
		save_key = output_config.get("save_result_to_context") or config.get("save_result_to_context")
		if save_key:
			ctx.set(save_key, result)
			_persist_context(flow_run, ctx, settings)

		commit_if_background()

		is_success = 200 <= resp.status_code < 400
		return {"status": "success" if is_success else "failed", "result": result}
	except Exception as e:
		return {"status": "failed", "error": str(e)}


def _exec_condition(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute condition node - evaluates a boolean expression and routes to
	true_node or false_node.

	Config keys:
	    expression (str): Boolean expression to evaluate against context
	    true_node (str): Node ID to go to if expression is true
	    false_node (str): Node ID to go to if expression is false
	"""
	expression = config.get("expression", "")
	# on_true/on_false, not true_node/false_node -- these are the shared graph-IR's own
	# field names for a ConditionNode's branch targets (graph_ir.schema.json
	# ConditionNode), not a Flow-only convention any more.
	true_node = config.get("on_true")
	false_node = config.get("on_false")

	if not expression:
		return {"status": "failed", "error": "condition node missing 'expression' in config"}

	if not true_node and not false_node:
		return {"status": "failed", "error": "condition node needs at least one of 'on_true' or 'on_false'"}

	ctx = _context_of(flow_run, settings)

	try:
		result = safe_eval_expression(expression, ctx.as_dict())
		chosen_node = true_node if result else false_node

		if not chosen_node:
			# The chosen branch has no target: this chain simply ends here.
			return {"status": "success", "result": result, "next_node_id": None}

		return {
			"status": "success",
			"result": result,
			"branch": "true" if result else "false",
			"next_node_id": chosen_node,
		}
	except Exception as e:
		return {"status": "failed", "error": f"Condition evaluation failed: {str(e)}"}


def _exec_transform(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute transform node - applies one of the shared graph-IR's
	:class:`~huf.ai.graph.transforms.TransformOp` operations to a resolved
	input mapping.

	Config keys (graph_ir.schema.json ``TransformNode``, ``additionalProperties: false``):
	    op (str): a ``TransformOp`` name (see ``huf.ai.graph.transforms``)
	    input (dict): values, each resolved via ``GraphContext.resolve`` against
	        the run's context, then passed to ``run_transform``

	This used to read ``config.get("transformations")`` -- a Flow-only
	``[{source_field, target_field, operation}]`` shape that the schema never
	defined (``additionalProperties: false`` on ``TransformNode.config``
	rejects it outright), so every schema-valid ``transform`` node's ``op``/
	``input`` were silently ignored. ``run_transform`` is the same function
	:mod:`huf.ai.graph.procedure_runtime` uses for the Procedure profile's
	``transform`` node -- one implementation of the operation, shared by both
	profiles, per graph_ir.schema.json's single ``TransformNode`` definition.
	"""
	ctx = _context_of(flow_run, settings)
	resolved_input = ctx.resolve(config.get("input") or {})
	result = run_transform(config.get("op"), resolved_input, TransformLimits())

	if not result.ok:
		err = result.error
		return {"status": "failed", "error": err.message if err else f"transform '{config.get('op')}' failed"}

	return {"status": "success", "result": result.value, "output": result.value}


def _exec_loop_node(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute loop node - a bounded foreach over an array in context.

	Each visit either binds the next item and routes into the body, or
	finishes and routes to ``done_node``. Iteration is bounded by this node's
	own ``max_iterations`` and is *not* charged against the run's hop budget
	(F-3): before T-22 a loop with more items than ``max_hops`` could never
	complete.

	Config keys:
	    iterate_over (str): Context key containing the array to iterate
	    item_key (str): Context key for the current item (default: 'loop_item')
	    index_key (str): Context key for the index (default: 'loop_index')
	    loop_node (str): Node ID of the loop body
	    done_node (str): Node ID to go to when iteration completes
	    max_iterations (int): Iteration ceiling (default: 100)
	"""
	ctx = _context_of(flow_run, settings)

	iterate_over = config.get("iterate_over", "")
	item_key = config.get("item_key", "loop_item")
	index_key = config.get("index_key", "loop_index")
	loop_node = config.get("loop_node")
	done_node = config.get("done_node")
	max_iter = config.get("max_iterations", 100)

	if not iterate_over:
		return {"status": "failed", "error": "loop node missing 'iterate_over' in config"}

	items = _resolve_context_path(ctx.as_dict(), iterate_over)
	if not isinstance(items, list):
		return {"status": "failed", "error": f"'{iterate_over}' is not a list in context"}

	current_index = ctx.as_dict().get(index_key, 0)
	if not isinstance(current_index, int):
		current_index = 0

	if current_index >= max_iter or current_index >= len(items):
		reason = "max_iterations reached" if current_index >= max_iter else "iteration_complete"
		ctx.pop(item_key, None)
		ctx.pop(index_key, None)
		ctx.pop_foreach()
		_persist_context(flow_run, ctx, settings)
		return {"status": "success", "result": reason, "next_node_id": done_node}

	ctx.set(item_key, items[current_index])
	ctx.set(index_key, current_index + 1)
	ctx.push_foreach(items[current_index], current_index)
	_persist_context(flow_run, ctx, settings)
	return {"status": "success", "result": items[current_index], "next_node_id": loop_node}


def _exec_end(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""Execute end node - marks success."""
	return {"status": "success", "output": "flow_complete"}


def _flow_nodes_by_id(settings: dict) -> dict:
	"""Every node in the pinned graph, by id -- for looking up a ``foreach``
	``body`` or ``parallel`` ``branches`` member, which per spec/graph-ir.md
	section 2 lives in the same top-level ``nodes`` array as the main chain.
	"""
	run_ctx = _run_context(settings)
	graph = run_ctx.definition if run_ctx is not None else {}
	return {n["id"]: n for n in graph.get("nodes", []) if isinstance(n, dict) and "id" in n}


def _run_sub_chain(flow_run, settings: dict, node_ids: list) -> dict:
	"""Walk one self-contained chain of node ids (a ``foreach`` body or a
	``parallel`` branch) to completion, re-using :func:`_execute_node`'s own
	dispatch table so every node type -- including a nested ``condition`` --
	behaves exactly as it would on the main chain. Bounded by the chain's own
	length (+2 headroom, mirroring ``procedure_runtime._sub_executor``): this
	is a distinct budget from the run's ``max_hops``, never charged against it.

	Records each visited node's output into the shared ``GraphContext`` (the
	same ``node_id -> output`` bookkeeping ``GraphExecutor.run`` does for the
	main chain, executor.py:744) so a ``foreach.config.collect`` reference
	into a body node's output -- or any ``{"$from": "<node_id>...."}`` inside
	the chain itself -- resolves, instead of silently returning ``None``.
	"""
	ctx = _context_of(flow_run, settings)
	by_id = _flow_nodes_by_id(settings)
	cursor = node_ids[0] if node_ids else None
	max_hops = len(node_ids) + 2
	hops = 0
	last_result = {"status": "success"}

	while cursor is not None:
		hops += 1
		if hops > max_hops:
			return {"status": "failed", "error": f"sub-chain exceeded its hop budget ({max_hops})"}

		node = by_id.get(cursor)
		if node is None:
			return {"status": "failed", "error": f"sub-chain references unknown node '{cursor}'"}

		last_result = _execute_node(flow_run, node, settings)
		ctx.record_output(cursor, last_result.get("output", last_result.get("result")))
		if last_result.get("status") == "failed":
			on_error = node.get("on_error")
			if not on_error:
				return last_result
			cursor = on_error
			continue

		if NODE_ROUTING.get(node.get("type")) == RoutingMode.SELF_ROUTED:
			cursor = last_result.get("next_node_id")
		else:
			cursor = node.get("next")

	return last_result


def _exec_foreach(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute foreach node - a bounded batch over ``config.items``, running
	``config.body`` once per item (graph_ir.schema.json ``ForeachNode``).

	Unlike the old ``loop`` node (still registered below for any run pinned
	before this fix, but no longer schema-reachable), ``foreach`` never
	re-enters the main chain -- its body is a self-contained chain walked by
	:func:`_run_sub_chain`, and its iteration cap is its own budget, never the
	run's ``max_hops`` (spec/graph-ir.md section 2.1).
	"""
	node_id = node.get("id")
	ctx = _context_of(flow_run, settings)
	items = ctx.resolve(config.get("items"))
	if not isinstance(items, list):
		return {"status": "failed", "error": f"foreach node '{node_id}' 'items' did not resolve to a list"}

	run_ctx = _run_context(settings)
	contract_limits = ((run_ctx.definition.get("contract") or {}).get("limits") or {}) if run_ctx is not None else {}
	caps = [c for c in (config.get("max_iterations"), contract_limits.get("max_foreach_iterations")) if c is not None]
	effective_cap = min(caps) if caps else len(items)
	if len(items) > effective_cap:
		return {
			"status": "failed",
			"error": f"foreach '{node_id}' has {len(items)} items, exceeds max_iterations ({effective_cap})",
		}

	body_ids = config.get("body") or []
	collect_ref = config.get("collect")
	on_item_error = config.get("on_item_error", "fail")

	results = []
	for index, item in enumerate(items):
		ctx.push_foreach(item, index)
		try:
			outcome = _run_sub_chain(flow_run, settings, body_ids)
			if outcome.get("status") != "success":
				if on_item_error == "skip":
					continue
				return {"status": "failed", "error": f"foreach '{node_id}' item {index} failed: {outcome.get('error')}"}
			results.append(ctx.resolve(collect_ref) if collect_ref is not None else None)
		finally:
			ctx.pop_foreach()

	_persist_context(flow_run, ctx, settings)
	return {"status": "success", "result": results, "output": results}


def _exec_parallel(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute parallel node - bounded fan-out over ``config.branches``
	(graph_ir.schema.json ``ParallelNode``). ``join`` is always ``"all"``: the
	node completes only once every branch has completed or failed.

	Branches run sequentially, in declaration order -- not concurrently. Real
	bounded concurrency (mirroring ``huf.ai.graph.scheduler.run_parallel_branches``,
	used by the Procedure profile's own ``parallel`` node) is future work; this
	keeps Flow's ``parallel`` schema-valid and runnable today without adding
	threading to a runtime whose steps are already persisted and replayed one
	at a time (``_FlowStateStore``), and produces the same per-branch results a
	concurrent run would, just not concurrently.
	"""
	node_id = node.get("id")
	branches = config.get("branches") or []
	if not branches:
		return {"status": "success", "result": {"branches_completed": 0, "join": config.get("join", "all")}}

	for index, branch_ids in enumerate(branches):
		outcome = _run_sub_chain(flow_run, settings, branch_ids)
		if outcome.get("status") != "success":
			return {"status": "failed", "error": f"parallel '{node_id}' branch {index} failed: {outcome.get('error')}"}

	return {
		"status": "success",
		"result": {"branches_completed": len(branches), "join": config.get("join", "all")},
	}


def _exec_validate(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute validate node - fails closed if any ``config.assertions`` entry
	evaluates falsy (graph_ir.schema.json ``ValidateNode``).

	``expression`` is a ``$defs/Expression`` -- "evaluated by the shared
	expression evaluator (graph-ir.md section 4)" per the schema's own
	description, i.e. ``huf.ai.graph.expressions.evaluate_bool``/
	``parse_expression`` against ``GraphContext.reference_roots()`` (the same
	evaluator ``procedure_runtime._handle_validate`` uses for the Procedure
	profile), never Flow's older ``flow_eval.safe_eval_expression`` (a
	different, ``context["key"]``-subscript grammar predating the shared IR).
	"""
	ctx = _context_of(flow_run, settings)
	bindings = ctx.reference_roots()
	failures = []
	for assertion in config.get("assertions", []):
		try:
			parsed = parse_expression(assertion["expression"])
			truthy = evaluate_bool(parsed, bindings)
		except Exception as e:
			return {
				"status": "failed",
				"error": f"validate node '{node.get('id')}' assertion expression failed: {e}",
			}
		if not truthy:
			failures.append({"code": assertion["code"], "message": assertion["message"]})

	if failures:
		return {"status": "failed", "error": json.dumps(failures)}
	return {"status": "success", "result": {"assertions_passed": len(config.get("assertions", []))}}


def _exec_output(flow_run, node: dict, config: dict, settings: dict) -> dict:
	"""
	Execute output node - always terminal (see ``NODE_ROUTING``). Resolves
	``config.value`` and enforces the graph's output budget (I7, mirroring
	``procedure_runtime._Runner._handle_output``): a value that breaches
	``max_rows``/``max_output_bytes`` fails the node rather than being
	silently truncated.
	"""
	ctx = _context_of(flow_run, settings)
	value = ctx.resolve(config.get("value"))

	run_ctx = _run_context(settings)
	limits = ((run_ctx.definition.get("contract") or {}).get("limits") or {}) if run_ctx is not None else {}
	budget_kwargs = {}
	if limits.get("max_rows") is not None:
		budget_kwargs["max_rows"] = limits["max_rows"]
	if limits.get("max_output_bytes") is not None:
		budget_kwargs["max_bytes"] = limits["max_output_bytes"]
	budget = OutputBudget(**budget_kwargs) if budget_kwargs else OutputBudget()

	if isinstance(value, list):
		try:
			enforce_output_budget(value, budget=budget)
		except OutputBudgetExceeded as exc:
			return {"status": "failed", "error": str(exc)}
	elif isinstance(value, dict):
		size = len(json.dumps(value, default=str, ensure_ascii=False).encode("utf-8"))
		if size > budget.max_bytes:
			return {
				"status": "failed",
				"error": f"output node '{node.get('id')}' value is {size} bytes, exceeds max_output_bytes ({budget.max_bytes}); refusing to truncate",
			}
		for key, field_value in value.items():
			if isinstance(field_value, list) and len(field_value) > budget.max_rows:
				return {
					"status": "failed",
					"error": f"output node '{node.get('id')}' field '{key}' has {len(field_value)} rows, exceeds max_rows ({budget.max_rows}); refusing to truncate",
				}

	return {"status": "success", "output": value, "result": value}


#: "http_request", "loop" and "end" are not in FLOW_NODE_TYPES
#: (huf.ai.graph.validator) at all -- no schema-valid Flow Definition can be
#: *saved* with one of these types any more (superseded by "tool.call",
#: "foreach" and a plain no-``next`` chain end, respectively). They stay
#: registered here, not removed, because a ``Flow Run`` created before this
#: schema existed pins its graph at creation (``PinnedVersion``, F-1 in this
#: module's docstring) and keeps executing that exact graph for its whole
#: life -- an already-running or paused run using one of these types must
#: still be able to advance. Remove an entry here only once no such pinned
#: run can still be outstanding.
_NODE_EXECUTORS = {
	"trigger.webhook": _exec_trigger_webhook,
	"trigger.schedule": _exec_trigger_schedule,
	"trigger.doc-event": _exec_trigger_doc_event,
	"agent.run": _exec_agent_run,
	"tool.call": _exec_tool_call,
	"router.llm": _exec_router_llm,
	"human.approval": _exec_human_approval,
	"http_request": _exec_http_request,
	"condition": _exec_condition,
	"transform": _exec_transform,
	"loop": _exec_loop_node,
	"end": _exec_end,
	"foreach": _exec_foreach,
	"parallel": _exec_parallel,
	"validate": _exec_validate,
	"output": _exec_output,
}

_NODE_TYPES = tuple(_NODE_EXECUTORS)


# ---------------------------------------------------------------------------
# Edge evaluation
# ---------------------------------------------------------------------------


def effective_edges(defn: dict) -> list[dict]:
	"""The edge list to route with, for either graph shape a pinned run may carry.

	A ``Flow Run`` pins its whole graph at creation time (F-1) and keeps executing
	that exact pinned copy for its entire life, however long that run takes -- so a run
	created before this migration may still be executing against the pre-migration
	shape (a real top-level ``edges`` array) well after Flow Definition's own validator
	has moved on to requiring the shared graph-IR shape. Both are handled here: an
	explicit ``edges`` key (the old shape, or a caller/test that hands routing in
	directly) is used as-is; its absence (the shared graph-IR shape saved and validated
	via ``huf.huf.doctype.flow_definition.flow_definition._validate_definition_json``)
	falls back to :func:`edges_from_nodes`.
	"""
	if "edges" in defn:
		return defn.get("edges") or []
	return edges_from_nodes(defn.get("nodes", []))


def edges_from_nodes(nodes: list) -> list[dict]:
	"""Derive this module's internal edge list from the shared graph-IR's node-native
	routing pointers.

	The shared IR (``huf/ai/graph/graph_ir.schema.json``) has no independent top-level
	``edges`` array any more: every node carries its own successor pointer (``next``)
	and error route (``on_error``), and the three self-routing node types carry their
	branch targets in their own ``config`` -- ``condition.on_true``/``on_false``,
	``router.llm.options``/``default``, ``human.approval.approve_next``/``reject_next``.
	This function is the one place that knowledge is decoded back into the ``{from, to,
	type, meta}`` edge shape the rest of this module's routing machinery
	(:func:`_evaluate_edges`, :func:`_get_outgoing_edges`, :class:`Router`'s labelled
	resolution) still speaks -- so that machinery did not have to be rewritten to walk
	five different per-node-type shapes directly.
	"""
	edges: list[dict] = []
	for node in nodes:
		if not isinstance(node, dict):
			continue
		node_id = node.get("id")
		node_type = node.get("type")
		config = node.get("config") or {}

		if node_type == "condition":
			on_true = config.get("on_true")
			on_false = config.get("on_false")
			if on_true:
				edges.append(
					{
						"from": node_id,
						"to": on_true,
						"type": "expression",
						"condition": config.get("expression") or "true",
						"priority": 1,
					}
				)
			if on_false:
				edges.append({"from": node_id, "to": on_false, "type": "always"})
		elif node_type == "router.llm":
			for option in config.get("options") or []:
				to = (option or {}).get("node_id")
				if to:
					edges.append({"from": node_id, "to": to, "type": "always", "meta": {"label": (option or {}).get("label")}})
			default = config.get("default")
			if default:
				edges.append({"from": node_id, "to": default, "type": "always", "meta": {"label": "default"}})
		elif node_type == "human.approval":
			approve_next = config.get("approve_next")
			reject_next = config.get("reject_next")
			if approve_next:
				edges.append(
					{"from": node_id, "to": approve_next, "type": "on_success", "meta": {"outcome": "approved"}}
				)
			if reject_next:
				edges.append(
					{"from": node_id, "to": reject_next, "type": "on_failure", "meta": {"outcome": "rejected"}}
				)
		else:
			next_id = node.get("next")
			if next_id:
				edges.append({"from": node_id, "to": next_id, "type": "always"})

		on_error = node.get("on_error")
		if on_error:
			edges.append({"from": node_id, "to": on_error, "type": "on_failure"})

	return edges


def _evaluate_edges(
	flow_run, node_id: str, node_result: dict, edges_list: list, *, context=None
) -> str | None:
	"""
	Evaluate outgoing edges from a node and return the next node ID.

	Edges are sorted by priority (desc) and the first matching edge wins.

	``context`` lets a caller that already holds the run's parsed context pass
	it in rather than have it re-parsed here (F-9); callers that don't, get
	the old behaviour.
	"""
	outgoing = [e for e in edges_list if e.get("from") == node_id]
	if not outgoing:
		return None

	outgoing.sort(key=lambda e: e.get("priority", 0), reverse=True)

	ctx = context.as_dict() if context is not None else _load_context(flow_run)
	node_status = node_result.get("status", "success") if isinstance(node_result, dict) else "success"

	for edge in outgoing:
		edge_type = edge.get("type", "always")

		if edge_type == "always":
			return edge.get("to")

		elif edge_type == "on_success":
			if node_status == "success":
				return edge.get("to")

		elif edge_type == "on_failure":
			if node_status == "failed":
				return edge.get("to")

		elif edge_type == "expression":
			condition = edge.get("condition", "")
			try:
				if safe_eval_expression(condition, ctx):
					return edge.get("to")
			except Exception as e:
				frappe.log_error(title="Flow Engine Edge Eval", message=f"Edge expression error ({condition}): {str(e)}")

	return None


def _get_outgoing_edges(node_id: str, edges_list: list) -> list[dict]:
	"""Get outgoing edges from a node as candidate list."""
	candidates = []
	for edge in edges_list:
		if edge.get("from") == node_id:
			candidates.append(
				{
					"to": edge.get("to"),
					"edge_id": edge.get("id"),
					"label": edge.get("meta", {}).get("label", ""),
					"meta": edge.get("meta", {}),
				}
			)
	return candidates


# ---------------------------------------------------------------------------
# Agentic mode helpers
# ---------------------------------------------------------------------------


def _should_call_orchestrator(policy: str, completed_nodes: list) -> bool:
	"""Determine if orchestrator should be called based on policy."""
	if policy == "start_and_after_each_node":
		return True
	if policy == "after_each_node":
		return len(completed_nodes) > 0
	return False


def _call_orchestrator(
	flow_run, current_node_id: str, node_result: dict, candidates: list, settings: dict, completed_nodes: list
) -> str | None:
	"""Call the orchestrator agent and return the chosen next_node_id."""
	orchestrator_agent = (settings or {}).get("orchestrator_agent")
	if not orchestrator_agent:
		frappe.log_error("Agentic mode requires orchestrator_agent in settings", "Flow Engine")
		return None

	run_ctx = _run_context(settings)
	ctx = _context_of(flow_run, settings)
	valid_node_ids = {c["to"] for c in candidates}

	prompt = build_orchestrator_prompt(
		current_node_id=current_node_id,
		current_node_result=node_result,
		flow_context=ctx.as_dict(),
		candidates=candidates,
		completed_summary=", ".join(completed_nodes),
	)

	conv_mode = (settings or {}).get("conversation_mode", "flow_shared")
	conversation_id = _conversation_of(flow_run, run_ctx) if conv_mode == "flow_shared" else None

	try:
		from huf.ai.agent_integration import run_agent_sync

		result = run_agent_sync(
			agent_name=orchestrator_agent,
			prompt=prompt,
			conversation_id=conversation_id,
			channel_id="flow_orchestrator",
			flow_run_id=flow_run.name,
			flow_node_id=current_node_id,
			run_kind="orchestrator",
			now=True,
		)

		if not result.get("success"):
			frappe.log_error(title="Flow Engine Orchestrator", message=f"Orchestrator failed: {result.get('error')}")
			return None

		decision = parse_decision(result.get("response", ""), valid_node_ids)

		if decision.get("context_patch"):
			ctx.update(decision["context_patch"])
			_persist_context(flow_run, ctx, settings)

		flow_run.db_set("last_agent_run", result.get("agent_run_id"))
		commit_if_background()

		return decision["next_node_id"]

	except Exception as e:
		frappe.log_error(title="Flow Engine Orchestrator", message=f"Orchestrator error: {str(e)}")
		return None


# ---------------------------------------------------------------------------
# Approval notifications
# ---------------------------------------------------------------------------


def _send_approval_notifications(flow_run, node: dict, config: dict, waiting_data: dict):
	"""
	Send notification to approvers when a flow reaches human.approval node.
	
	Supports two notification methods:
	1. Frappe Notification Log (bell icon in UI)
	2. Email notification (if email is configured)
	
	Args:
		flow_run: The Flow Run document
		node: The current node dict
		config: Node configuration
		waiting_data: The waiting state data
	"""
	approval_type = waiting_data.get("approval_type", "role")
	approvers = []
	
	# Determine approvers based on approval_type
	if approval_type == "role":
		approver_role = waiting_data.get("approver_role")
		if approver_role:
			# Optimized role lookup: Get all users with this role directly from Has Role table
			approver_names = frappe.get_all(
				"Has Role",
				filters={"role": approver_role, "parenttype": "User"},
				pluck="parent"
			)
			if approver_names:
				# Filter to ensure we only notify enabled System Users
				approvers = frappe.get_all(
					"User",
					filters={
						"name": ["in", approver_names],
						"enabled": 1,
						"user_type": "System User",
					},
					pluck="name"
				)
	elif approval_type in ("user", "users"):
		approver_users = waiting_data.get("approver_users", [])
		if isinstance(approver_users, str):
			# Handle comma-separated string
			approver_users = [u.strip() for u in approver_users.split(",") if u.strip()]
		approvers = approver_users
	
	# Ensure unique recipients to avoid duplicate emails
	if approvers:
		approvers = list(set(approvers))
	
	if not approvers:
		frappe.log_error(
			title="Flow Approval Notification",
			message=f"No approvers found for flow run {flow_run.name}",
		)
		return
	
	title = waiting_data.get("title", "Approval Required")
	instructions = waiting_data.get("instructions", "Please review and approve this flow.")
	
	flow_run_path = f"/huf/flows/{flow_run.flow_id}?run={flow_run.name}"
	
	_host = (frappe.conf.get("host_name") or frappe.utils.get_url()).rstrip("/")
	flow_run_url = f"{_host}{flow_run_path}"

	
	# Create notification for each approver
	for user in approvers:
		try:
			# Get user email for notification (enqueue_create_notification expects emails)
			user_email = frappe.db.get_value("User", user, "email") or user
			
			# 1. Create Frappe Notification Log (appears in bell icon)
			enqueue_create_notification(user_email, {
				"type": "Assignment",
				"document_type": "Flow Run",
				"document_name": flow_run.name,
				"subject": _("Approval Required: {0}").format(title),
				"email_content": f"""
					<p>{instructions}</p>
					<p><strong>{_("Flow")}:</strong> {flow_run.flow_id}</p>
					<p><strong>{_("Run ID")}:</strong> {flow_run.name}</p>
					<p><a href="{flow_run_url}">{_("View Flow Run")}</a></p>
				""",
			})
			
			if is_email_notifications_enabled(user):
				user_doc = frappe.get_doc("User", user)
				if user_doc.email:
					frappe.sendmail(
						recipients=[user_doc.email],
						subject=_("[HUF] Approval Required: {0}").format(title),
						message=f"""
							<p>{_("Dear")} {user_doc.full_name or user},</p>
							<p>{_("A flow is waiting for your approval.")}</p>
							<hr>
							<p><strong>{_("Flow")}:</strong> {flow_run.flow_id}</p>
							<p><strong>{_("Run ID")}:</strong> {flow_run.name}</p>
							<p><strong>{_("Instructions")}:</strong></p>
							<p>{instructions}</p>
							<hr>
							<p>
								<a href="{flow_run_url}" 
								   style="background-color: #171717; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
									{_("Review Approval")}
								</a>
							</p>
							<p style="color: #666; font-size: 12px;">
								{_("This is an automated message from the HUF Flow Engine.")}
							</p>
						""",
						delayed=True,
					)
		except Exception as e:
			# Log error but don't fail the flow
			frappe.log_error(
				title=_("Flow Approval Notification"),
				message=f"Failed to send approval notification to {user}: {str(e)}",
			)


def _clear_flow_notifications(flow_run):
	"""
	Mark all notifications for a specific flow run as read.
	Called when a human decision is made.
	"""
	try:
		# Standard Frappe approach: find notification log entries for this document
		# and mark them as read for all users who were notified.
		frappe.db.set_value(
			"Notification Log",
			{
				"document_type": "Flow Run",
				"document_name": flow_run.name,
				"read": 0
			},
			"read",
			1,
			update_modified=False
		)
		commit_if_background()
	except Exception:
		# Cleanup is best-effort
		pass


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _conversation_of(flow_run, run_ctx: FlowRunContext | None):
	if run_ctx is not None:
		return run_ctx.conversation
	return getattr(flow_run, "conversation", None)


def _mode_of(flow_run, run_ctx: FlowRunContext | None) -> str:
	if run_ctx is not None:
		return run_ctx.mode
	return (getattr(flow_run, "mode", "") or "").lower()


def _load_context(flow_run) -> dict:
	"""Load the flow context from the flow run document.

	Kept for callers outside a run (and for tests that drive a single node
	executor directly). Inside a run the context is parsed once and carried
	on :class:`FlowRunContext` instead (F-9).
	"""
	return GraphContext.from_json(getattr(flow_run, "context_json", None)).as_dict()


def _build_agent_prompt(config: dict, ctx: GraphContext) -> str:
	"""Build agent prompt from config template and context.

	``prompt_template`` resolves through the single structured reference
	form (F-2); this used to be a fourth, subtly different ``str.replace``
	loop over context keys.

	The flow builder writes ``prompt_template`` flat on ``config``; older or
	programmatic definitions nest it under ``config["input"]``. Accept both,
	preferring the nested form.
	"""
	input_config = config.get("input") or {}
	prompt_template = input_config.get("prompt_template") or config.get("prompt_template")

	if prompt_template:
		resolved = ctx.resolve(prompt_template)
		return resolved if isinstance(resolved, str) else json.dumps(resolved, default=str)

	# Default: serialize the context as the prompt
	return json.dumps(ctx.as_dict(), indent=2, default=str)


def _create_flow_agent_run(flow_run, node: dict, run_kind: str, prompt: str = "", agent_name: str = None) -> "frappe.Document":
	"""Create an Agent Run document linked to a flow run."""
	if not agent_name and node:
		config = node.get("config") or node.get("data", {}).get("config") or {}
		agent_name = config.get("agent_name") or config.get("agent")
	if not agent_name and getattr(flow_run, "last_agent_run", None):
		agent_name = frappe.db.get_value("Agent Run", flow_run.last_agent_run, "agent")
	if not agent_name and getattr(flow_run, "flow_id", None):
		try:
			flow_def = frappe.db.get_value("Flow Definition", flow_run.flow_id, "definition_json")
			if flow_def:
				flow_data = json.loads(flow_def) if isinstance(flow_def, str) else flow_def
				agent_name = flow_data.get("agent") or flow_data.get("agent_name")
		except Exception:
			pass

	run_doc = frappe.get_doc(
		{
			"doctype": "Agent Run",
			"agent": agent_name or None,
			"status": "Started",
			"prompt": prompt,
			"flow_run": flow_run.name,
			"conversation": getattr(flow_run, "conversation", None),
			"flow_node_id": node.get("id"),
			"flow_id": flow_run.flow_id,
			"run_kind": run_kind,
			"start_time": now_datetime(),
		}
	)
	# Agent Run records are internal execution logs. Authenticated users
	# create them through normal permission checks; Guest/webhook paths are
	# allowed because the engine is acting on behalf of the system.
	if frappe.session.user == "Guest":
		run_doc.insert(ignore_permissions=True)
	else:
		if not frappe.has_permission("Agent Run", "create", doc=run_doc):
			frappe.throw(_("Not permitted to create Agent Run"), frappe.PermissionError)
		run_doc.insert()
	commit_if_background()
	return run_doc


def _create_flow_conversation(flow_id: str, entry_node_id: str) -> "frappe.Document":
	"""Create a shared Agent Conversation for a flow run."""
	from uuid import uuid4

	conv = frappe.get_doc(
		{
			"doctype": "Agent Conversation",
			"title": f"Flow: {flow_id}",
			"session_id": f"flow:{flow_id}:{uuid4().hex[:8]}",
			"is_active": 1,
		}
	)
	# Flow conversations are created by the engine. Authenticated callers
	# use standard permissions; Guest/webhook triggers rely on the system.
	if frappe.session.user == "Guest":
		conv.insert(ignore_permissions=True)
	else:
		if not frappe.has_permission("Agent Conversation", "create", doc=conv):
			frappe.throw(_("Not permitted to create Agent Conversation"), frappe.PermissionError)
		conv.insert()
	commit_if_background()
	return conv


def _verify_approval_permission(waiting: dict):
	"""Verify that the current user has permission to approve."""
	approval_type = waiting.get("approval_type", "role")
	user = frappe.session.user

	if approval_type in ("user", "users"):
		approver_users = waiting.get("approver_users", [])
		if approver_users and user not in approver_users:
			frappe.throw(
				_("You are not authorized to approve this flow run"),
				frappe.PermissionError,
			)
	elif approval_type == "role":
		approver_role = waiting.get("approver_role")
		if approver_role:
			user_roles = frappe.get_roles(user)
			if approver_role not in user_roles:
				frappe.throw(
					_("You do not have the required role '{0}' to approve").format(approver_role),
					frappe.PermissionError,
				)


def _complete_flow_run(flow_run):
	"""Mark a flow run as successfully completed."""
	flow_run.db_set({"status": "Success", "completed_at": now_datetime()})
	commit_if_background()


def _fail_flow_run(flow_run, error_msg: str):
	"""Mark a flow run as failed."""
	flow_run.db_set({"status": "Failed", "last_error": error_msg, "completed_at": now_datetime()})
	commit_if_background()
	_publish_flow_event(flow_run, "flow_failed", {"error": error_msg})


# ---------------------------------------------------------------------------
# Realtime event publishing
# ---------------------------------------------------------------------------


def _publish_flow_event(flow_run, event_type: str, data: dict):
	"""Publish a Frappe Realtime event for live flow UI tracking."""
	try:
		frappe.publish_realtime(
			event=event_type,
			message={
				"flow_run_id": flow_run.name,
				"flow_id": flow_run.flow_id,
				**data,
			},
			after_commit=False,
		)
	except Exception:
		# Realtime is best-effort; don't break execution if it fails
		pass


# ---------------------------------------------------------------------------
# Context path resolution (F-2)
# ---------------------------------------------------------------------------


def _resolve_context_path(ctx: dict, path: str):
	"""Resolve a dotted path like 'user_data.email' from a context dict.

	Delegates to the executor's path resolver so the ``{{...}}`` form and the
	IR's ``{"$from": ...}`` form share one path grammar.
	"""
	parts = path.split(".")
	current = ctx
	for part in parts:
		if isinstance(current, dict):
			current = current.get(part)
		else:
			return None
	return current
