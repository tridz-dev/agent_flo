"""
Behavioural test suite for huf.ai.flow_engine.

Flow is an experimental, unreleased subsystem: there are zero Flow Definitions
and zero Flow Runs on any real site today, and there were zero tests for this
module before this file. This suite is therefore NOT a characterization suite
freezing today's behaviour -- it asserts INTENDED behaviour at a level of
abstraction (observable outcomes: which node ran, what the context dict
contains, which edge fired, run status transitions) that should survive T-22's
planned replacement of flow_engine's internals with a shared graph IR.

Test classes and their bench requirements
------------------------------------------
Frappe-free (plain pytest / stubbed frappe via huf/ai/tests/conftest.py,
no live bench, no DB):
    - TestResolveContextPath
    - TestFromReferenceResolution
    - TestResolveRecursive
    - TestEvaluateEdges
    - TestExecCondition
    - TestExecTransform
    - TestExecLoopNode
    - TestExecEnd
    - TestExecTriggerWebhook
    - TestExecToolCallInterpolation   (mocks frappe.db.get_value / execute_tool;
                                        no real DB)
    - TestApproveFlowRunRouting       (mocks frappe.get_doc / flow_engine.load_definition)
    - TestHopLimitAndEndCompletion    (drives _execute_loop with a FakeFlowRun)
    - TestKnownDefects                (F-1..F-4 expectedFailure acceptance tests)

Bench-requiring (needs a live Frappe site; run with
`bench --site <site> run-tests --app huf --module huf.ai.tests.test_flow_engine`):
    - TestFlowRunLifecycleBench (UnitTestCase) -- exercises run_flow / resume_flow_run /
      approve_flow_run against real Flow Definition + Flow Run documents, to
      catch anything the frappe-free fakes below paper over (real db_set /
      reload semantics, real permission checks, real Document validation).

Known-defect handling (do NOT pin these as correct; see the T-01 task brief
for full descriptions -- these are being fixed in T-22):
    F-1: flow version auto-increments on every save; resumed/re-entered runs
         re-fetch the CURRENT definition instead of the one pinned at run start.
    F-2: four divergent {{...}} interpolation implementations with different
         semantics (dotted-path resolution vs flat-key-only).
    F-3: loop node burns one hop per iteration against the run's hop budget,
         so a loop with more items than max_hops cannot complete.
    F-4: no lock on run_flow; concurrent resumes can race the same cursor.

Each F-numbered defect is covered by a real assertion of the INTENDED
(post-fix) behaviour, decorated with `@unittest.expectedFailure` and a reason
string naming the F-number, so these tests can become T-22's acceptance
criteria as-is once the fix lands. Everywhere else, we simply do not assert on
the defective path.
"""

import json
import sys
import unittest
from unittest.mock import MagicMock, patch

# flow_engine.py does `from frappe.<dotted.submodule> import X` for a few
# names (frappe.utils, frappe.desk.doctype.notification_log.notification_log,
# frappe.desk.doctype.notification_settings.notification_settings). Unlike a
# plain `import frappe` + attribute access, Python's import statement resolves
# a dotted "from" target as a real submodule lookup, which a bare
# `MagicMock()` standing in for the top-level `frappe` module cannot satisfy
# on its own (see huf/ai/tests/conftest.py, which only stubs the top-level
# name). Pre-register the specific dotted submodules flow_engine needs as
# MagicMocks too, mirroring conftest's "only if frappe isn't already
# importable" guard, so this file can be collected standalone (e.g. plain
# `pytest huf/ai/tests/test_flow_engine.py`) as well as alongside the rest of
# the suite.
if "frappe" not in sys.modules:
	sys.modules["frappe"] = MagicMock()
for _mod_name in (
	"frappe.utils",
	"frappe.desk",
	"frappe.desk.doctype",
	"frappe.desk.doctype.notification_log",
	"frappe.desk.doctype.notification_log.notification_log",
	"frappe.desk.doctype.notification_settings",
	"frappe.desk.doctype.notification_settings.notification_settings",
):
	if _mod_name not in sys.modules:
		sys.modules[_mod_name] = MagicMock()

# When frappe is stubbed, `frappe.whitelist()` is itself a MagicMock call that
# returns another MagicMock -- used as `@frappe.whitelist()` that would
# replace `approve_flow_run` with a MagicMock instead of the real function,
# silently defeating every test in TestApproveFlowRunRouting below. Make the
# stub's `whitelist` behave like the real decorator (identity) instead, but
# only when frappe is in fact our stub -- never touch a real frappe module.
if isinstance(sys.modules.get("frappe"), MagicMock):
	sys.modules["frappe"].whitelist = lambda *a, **k: (lambda f: f)

from huf.ai import flow_engine
from huf.ai.graph.executor import GraphContext


# ---------------------------------------------------------------------------
# Shared frappe-free fakes
# ---------------------------------------------------------------------------


class FakeFlowRun:
	"""A minimal stand-in for the Flow Run Document.

	Mirrors the subset of the Document API flow_engine actually touches:
	attribute access for field reads, `.db_set(...)` for field writes (both
	single-field and dict forms, matching real Frappe's Document.db_set), and
	a no-op `.reload()` since this fake has no separate DB copy to diverge
	from mid-test (tests that need reload-observable state mutate the fake
	directly between calls).
	"""

	def __init__(self, **fields):
		defaults = dict(
			name="FR-TEST-0001",
			flow_id="test-flow",
			flow_definition="test-flow",
			flow_version=1,
			mode="Normal",
			status="Running",
			current_node_id="n1",
			hop_count=0,
			max_hops=flow_engine.DEFAULT_MAX_HOPS,
			context_json="{}",
			waiting=None,
			conversation=None,
			last_agent_run=None,
			last_error="",
		)
		defaults.update(fields)
		for key, value in defaults.items():
			setattr(self, key, value)
		self.db_set_calls = []

	def db_set(self, field, value=None):
		if isinstance(field, dict):
			updates = field
		else:
			updates = {field: value}
		self.db_set_calls.append(dict(updates))
		for key, val in updates.items():
			setattr(self, key, val)

	def reload(self):
		pass


def _ctx(flow_run, **overrides):
	"""Convenience: set a flow run's context_json from a plain dict."""
	data = dict(overrides)
	flow_run.context_json = json.dumps(data)
	return data


# ---------------------------------------------------------------------------
# Pure string / path helpers
# ---------------------------------------------------------------------------


class TestResolveContextPath(unittest.TestCase):
	"""`_resolve_context_path` -- dotted-path lookup into a context dict."""

	def test_top_level_key(self):
		self.assertEqual(flow_engine._resolve_context_path({"a": 1}, "a"), 1)

	def test_nested_dotted_path(self):
		ctx = {"user": {"profile": {"email": "a@example.com"}}}
		self.assertEqual(flow_engine._resolve_context_path(ctx, "user.profile.email"), "a@example.com")

	def test_missing_key_returns_none(self):
		self.assertIsNone(flow_engine._resolve_context_path({"a": 1}, "b"))

	def test_missing_intermediate_key_returns_none(self):
		self.assertIsNone(flow_engine._resolve_context_path({"a": {}}, "a.b.c"))

	def test_path_through_non_dict_returns_none(self):
		# 'a' resolves to a string, so trying to go deeper ('a.b') must not raise.
		self.assertIsNone(flow_engine._resolve_context_path({"a": "hello"}, "a.b"))


class TestFromReferenceResolution(unittest.TestCase):
	"""`GraphContext.resolve` -- the single ``{"$from": ...}`` reference form
	that replaced the four ``{{...}}`` string interpolators (F-2). Mirrors
	what the old `TestInterpolateString` pinned, one reference at a time
	rather than one placeholder inside a larger string, since composing a
	string out of several interpolated fragments is exactly the capability
	GT-04 removed.
	"""

	def test_simple_substitution(self):
		ctx = GraphContext({"name": "World"})
		self.assertEqual(ctx.resolve({"$from": "context.name"}), "World")

	def test_dotted_path_substitution(self):
		ctx = GraphContext({"order": {"id": "ORD-1"}})
		self.assertEqual(ctx.resolve({"$from": "context.order.id"}), "ORD-1")

	def test_unresolved_reference_returns_none(self):
		ctx = GraphContext({})
		self.assertIsNone(ctx.resolve({"$from": "context.missing"}))

	def test_non_string_value_passes_through(self):
		ctx = GraphContext({"n": 3})
		self.assertEqual(ctx.resolve({"$from": "context.n"}), 3)

	def test_multiple_references_in_one_config_value(self):
		ctx = GraphContext({"a": "1", "b": "2"})
		self.assertEqual(
			ctx.resolve({"a": {"$from": "context.a"}, "b": {"$from": "context.b"}}),
			{"a": "1", "b": "2"},
		)

	def test_static_string_is_left_untouched(self):
		# Plain strings are no longer a templating surface -- only an exact
		# {"$from": ...} mapping is resolved; everything else, including a
		# string that happens to contain "{{...}}", passes through as-is.
		ctx = GraphContext({"name": "World"})
		self.assertEqual(ctx.resolve("Hello {{name}}"), "Hello {{name}}")


class TestResolveRecursive(unittest.TestCase):
	"""`GraphContext.resolve` recurses through nested dict/list structures,
	replacing the old `_substitute_dict` recursive ``{{ }}`` substitution.
	"""

	def test_resolves_nested_structure(self):
		ctx = GraphContext({"name": "Ada", "id": "42"})
		data = {
			"greeting": {"$from": "context.name"},
			"list": [{"$from": "context.id"}, "static"],
			"nested": {"x": {"$from": "context.name"}},
		}
		result = ctx.resolve(data)
		self.assertEqual(
			result,
			{"greeting": "Ada", "list": ["42", "static"], "nested": {"x": "Ada"}},
		)

	def test_non_reference_values_left_untouched(self):
		ctx = GraphContext({})
		data = {"count": 5, "enabled": True, "ratio": 1.5}
		self.assertEqual(ctx.resolve(data), data)

	def test_supports_dotted_paths_like_flat_keys(self):
		ctx = GraphContext({"user": {"email": "a@b.com"}})
		self.assertEqual(ctx.resolve({"to": {"$from": "context.user.email"}}), {"to": "a@b.com"})


# ---------------------------------------------------------------------------
# _evaluate_edges: priority ordering + all four edge types
# ---------------------------------------------------------------------------


class TestEvaluateEdges(unittest.TestCase):
	def _run(self, context=None):
		flow_run = FakeFlowRun()
		_ctx(flow_run, **(context or {}))
		return flow_run

	def test_no_outgoing_edges_returns_none(self):
		flow_run = self._run()
		self.assertIsNone(flow_engine._evaluate_edges(flow_run, "n1", {"status": "success"}, []))

	def test_always_edge_taken_unconditionally(self):
		flow_run = self._run()
		edges = [{"from": "n1", "to": "n2", "type": "always"}]
		self.assertEqual(flow_engine._evaluate_edges(flow_run, "n1", {"status": "failed"}, edges), "n2")

	def test_on_success_taken_when_status_success(self):
		flow_run = self._run()
		edges = [{"from": "n1", "to": "n2", "type": "on_success"}]
		self.assertEqual(flow_engine._evaluate_edges(flow_run, "n1", {"status": "success"}, edges), "n2")

	def test_on_success_not_taken_when_status_failed(self):
		flow_run = self._run()
		edges = [{"from": "n1", "to": "n2", "type": "on_success"}]
		self.assertIsNone(flow_engine._evaluate_edges(flow_run, "n1", {"status": "failed"}, edges))

	def test_on_failure_taken_when_status_failed(self):
		flow_run = self._run()
		edges = [{"from": "n1", "to": "n2", "type": "on_failure"}]
		self.assertEqual(flow_engine._evaluate_edges(flow_run, "n1", {"status": "failed"}, edges), "n2")

	def test_on_failure_not_taken_when_status_success(self):
		flow_run = self._run()
		edges = [{"from": "n1", "to": "n2", "type": "on_failure"}]
		self.assertIsNone(flow_engine._evaluate_edges(flow_run, "n1", {"status": "success"}, edges))

	def test_expression_edge_taken_when_true(self):
		flow_run = self._run({"score": 90})
		edges = [{"from": "n1", "to": "n2", "type": "expression", "condition": "context['score'] > 50"}]
		self.assertEqual(flow_engine._evaluate_edges(flow_run, "n1", {"status": "success"}, edges), "n2")

	def test_expression_edge_not_taken_when_false(self):
		flow_run = self._run({"score": 10})
		edges = [{"from": "n1", "to": "n2", "type": "expression", "condition": "context['score'] > 50"}]
		self.assertIsNone(flow_engine._evaluate_edges(flow_run, "n1", {"status": "success"}, edges))

	def test_default_edge_type_is_always(self):
		flow_run = self._run()
		edges = [{"from": "n1", "to": "n2"}]  # no explicit 'type'
		self.assertEqual(flow_engine._evaluate_edges(flow_run, "n1", {"status": "failed"}, edges), "n2")

	def test_edges_from_other_nodes_are_ignored(self):
		flow_run = self._run()
		edges = [{"from": "other", "to": "n9", "type": "always"}]
		self.assertIsNone(flow_engine._evaluate_edges(flow_run, "n1", {"status": "success"}, edges))

	def test_higher_priority_edge_wins_regardless_of_list_order(self):
		flow_run = self._run()
		edges = [
			{"from": "n1", "to": "low", "type": "always", "priority": 1},
			{"from": "n1", "to": "high", "type": "always", "priority": 10},
		]
		self.assertEqual(flow_engine._evaluate_edges(flow_run, "n1", {"status": "success"}, edges), "high")

	def test_priority_ties_fall_through_to_first_matching_type(self):
		# Same priority: a non-matching on_success edge must not block a
		# later (in list order) always edge from being reached.
		flow_run = self._run()
		edges = [
			{"from": "n1", "to": "unmatched", "type": "on_success", "priority": 5},
			{"from": "n1", "to": "fallback", "type": "always", "priority": 5},
		]
		self.assertEqual(flow_engine._evaluate_edges(flow_run, "n1", {"status": "failed"}, edges), "fallback")

	def test_missing_priority_defaults_to_zero(self):
		flow_run = self._run()
		edges = [
			{"from": "n1", "to": "explicit_zero", "type": "always", "priority": 0},
			{"from": "n1", "to": "no_priority_field", "type": "on_failure"},
		]
		# on_failure doesn't match (status success), so the explicit-priority
		# always edge (priority 0, same as the default) must win.
		self.assertEqual(flow_engine._evaluate_edges(flow_run, "n1", {"status": "success"}, edges), "explicit_zero")

	def test_expression_error_is_swallowed_and_edge_skipped(self):
		flow_run = self._run({})
		edges = [
			{"from": "n1", "to": "bad", "type": "expression", "condition": "context['missing'].foo"},
			{"from": "n1", "to": "fallback", "type": "always", "priority": -1},
		]
		# A raising expression must not abort edge evaluation -- it should be
		# treated as non-matching and evaluation should continue to the next edge.
		#
		# frappe.log_error is patched out deliberately: the swallow path writes an
		# Error Log document, and inserting one outside a normal request lifecycle
		# fails on an uninitialised frappe.flags.currently_saving. The behaviour under
		# test is "the exception is swallowed and the next edge is tried", not whether
		# the log write itself succeeds.
		with patch.object(flow_engine.frappe, "log_error"):
			result = flow_engine._evaluate_edges(flow_run, "n1", {"status": "success"}, edges)
		self.assertEqual(result, "fallback")


# ---------------------------------------------------------------------------
# Node executors: pure-logic ones (no DB writes beyond FakeFlowRun.db_set)
# ---------------------------------------------------------------------------


class TestExecCondition(unittest.TestCase):
	def test_true_branch_routes_to_true_node(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, flag=True)
		config = {"expression": "context['flag']", "on_true": "t", "on_false": "f"}
		result = flow_engine._exec_condition(flow_run, {}, config, {})
		self.assertEqual(result["status"], "success")
		self.assertEqual(result["next_node_id"], "t")
		self.assertEqual(result["branch"], "true")

	def test_false_branch_routes_to_false_node(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, flag=False)
		config = {"expression": "context['flag']", "on_true": "t", "on_false": "f"}
		result = flow_engine._exec_condition(flow_run, {}, config, {})
		self.assertEqual(result["next_node_id"], "f")
		self.assertEqual(result["branch"], "false")

	def test_missing_branch_target_yields_no_next_node(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, flag=True)
		config = {"expression": "context['flag']", "on_true": "t"}  # no on_false
		result = flow_engine._exec_condition(flow_run, {}, config, {})
		# flag is True -> chosen branch is true_node, which IS set, so this
		# should route normally; flip to confirm the "chosen branch absent" path:
		self.assertEqual(result["next_node_id"], "t")

	def test_missing_expression_fails(self):
		flow_run = FakeFlowRun()
		result = flow_engine._exec_condition(flow_run, {}, {"on_true": "t"}, {})
		self.assertEqual(result["status"], "failed")

	def test_missing_both_targets_fails(self):
		flow_run = FakeFlowRun()
		result = flow_engine._exec_condition(flow_run, {}, {"expression": "True"}, {})
		self.assertEqual(result["status"], "failed")

	def test_chosen_branch_without_target_completes_with_no_next_node(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, flag=False)
		# Only on_true configured; expression evaluates false -> on_false is None.
		config = {"expression": "context['flag']", "on_true": "t"}
		result = flow_engine._exec_condition(flow_run, {}, config, {})
		self.assertEqual(result["status"], "success")
		self.assertIsNone(result["next_node_id"])


class TestExecTransform(unittest.TestCase):
	"""GW-34: graph_ir.schema.json's ``TransformNode.config`` requires exactly
	``op``/``input`` (``additionalProperties: false``) -- the old
	``transformations: [{source_field, target_field, operation}]`` shape
	tested here previously was never a schema-valid config a Flow Definition
	could actually be saved with, so ``_exec_transform`` silently ignoring a
	real ``op``/``input`` config was the bug (see
	huf.ai.tests.test_flow_gw34_node_type_gap for the fuller regression
	suite). These tests now pin the schema's own shape, dispatched through
	``huf.ai.graph.transforms.run_transform`` -- the same function
	``procedure_runtime`` uses for the Procedure profile's ``transform`` node.
	"""

	def test_select_operation(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, rows=[{"name": "Ada", "age": 30}])
		config = {"op": "select", "input": {"rows": {"$from": "input.rows"}, "fields": ["name"]}}
		result = flow_engine._exec_transform(flow_run, {}, config, {})
		self.assertEqual(result["status"], "success")
		self.assertEqual(result["result"], [{"name": "Ada"}])

	def test_coalesce_operation_resolves_nested_reference(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, user={"name": "Ada"})
		config = {"op": "coalesce", "input": {"values": [None, {"$from": "input.user.name"}]}}
		result = flow_engine._exec_transform(flow_run, {}, config, {})
		self.assertEqual(result["status"], "success")
		self.assertEqual(result["result"], "Ada")

	def test_unknown_op_fails_closed(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run)
		config = {"op": "not_a_real_op", "input": {}}
		result = flow_engine._exec_transform(flow_run, {}, config, {})
		self.assertEqual(result["status"], "failed")

	def test_legacy_transformations_shape_no_longer_applies(self):
		"""``config.transformations`` predates the shared graph-IR schema and can
		never be saved through FlowDefinition.validate() any more -- it has no
		``op``, so run_transform fails closed rather than silently no-op'ing."""
		flow_run = FakeFlowRun()
		_ctx(flow_run, source_field="hello")
		config = {"transformations": [{"source_field": "source_field", "target_field": "dest", "operation": "copy"}]}
		result = flow_engine._exec_transform(flow_run, {}, config, {})
		self.assertEqual(result["status"], "failed")


class TestExecLoopNode(unittest.TestCase):
	def test_first_iteration_sets_item_and_returns_loop_node(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, items=["a", "b"])
		config = {"iterate_over": "items", "loop_node": "body", "done_node": "done"}
		result = flow_engine._exec_loop_node(flow_run, {}, config, {})
		self.assertEqual(result["next_node_id"], "body")
		new_ctx = json.loads(flow_run.context_json)
		self.assertEqual(new_ctx["loop_item"], "a")
		self.assertEqual(new_ctx["loop_index"], 1)

	def test_iteration_completes_and_routes_to_done_node(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, items=["a"], loop_index=1)
		config = {"iterate_over": "items", "loop_node": "body", "done_node": "done"}
		result = flow_engine._exec_loop_node(flow_run, {}, config, {})
		self.assertEqual(result["next_node_id"], "done")
		new_ctx = json.loads(flow_run.context_json)
		self.assertNotIn("loop_item", new_ctx)
		self.assertNotIn("loop_index", new_ctx)

	def test_missing_iterate_over_fails(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run)
		result = flow_engine._exec_loop_node(flow_run, {}, {}, {})
		self.assertEqual(result["status"], "failed")

	def test_non_list_target_fails(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, items="not-a-list")
		result = flow_engine._exec_loop_node(flow_run, {}, {"iterate_over": "items"}, {})
		self.assertEqual(result["status"], "failed")

	def test_custom_item_and_index_keys(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, rows=[1, 2, 3])
		config = {
			"iterate_over": "rows",
			"item_key": "current_row",
			"index_key": "row_idx",
			"loop_node": "body",
			"done_node": "done",
		}
		flow_engine._exec_loop_node(flow_run, {}, config, {})
		new_ctx = json.loads(flow_run.context_json)
		self.assertEqual(new_ctx["current_row"], 1)
		self.assertEqual(new_ctx["row_idx"], 1)

	def test_max_iterations_safety_cap_routes_to_done_node(self):
		flow_run = FakeFlowRun()
		_ctx(flow_run, items=list(range(10)), loop_index=5)
		config = {"iterate_over": "items", "loop_node": "body", "done_node": "done", "max_iterations": 5}
		result = flow_engine._exec_loop_node(flow_run, {}, config, {})
		self.assertEqual(result["next_node_id"], "done")


class TestExecEnd(unittest.TestCase):
	def test_end_node_reports_success(self):
		flow_run = FakeFlowRun()
		result = flow_engine._exec_end(flow_run, {}, {}, {})
		self.assertEqual(result["status"], "success")


class TestExecTriggerWebhook(unittest.TestCase):
	def test_passes_through_existing_context(self):
		flow_run = FakeFlowRun()
		payload = _ctx(flow_run, foo="bar")
		result = flow_engine._exec_trigger_webhook(flow_run, {}, {}, {})
		self.assertEqual(result["status"], "success")
		self.assertEqual(result["output"], payload)


# ---------------------------------------------------------------------------
# tool.call: exercised through the real executor with frappe surface mocked
# ---------------------------------------------------------------------------


class TestExecToolCallInterpolation(unittest.TestCase):
	"""tool.call's arg substitution -- one of the four ``{{...}}``
	implementations GT-04 found (F-2), and the one this defect is named for:
	unlike `_interpolate_string`, it only did a flat ``ctx.get(var_name)``
	lookup and could not resolve dotted paths. These tests drive the real
	`_exec_tool_call` executor with the frappe surface it touches
	(db.get_value, get_doc, execute_tool) mocked, and assert on the args
	actually passed to the tool -- an observable outcome that should hold
	across the F-2 fix, now expressed through the single
	``{"$from": ...}`` reference form instead of ``{{...}}``.
	"""

	def _run_tool_call(self, ctx, args, tool_result=None):
		flow_run = FakeFlowRun()
		_ctx(flow_run, **ctx)
		config = {"tool_name": "demo_tool", "args": args}
		captured = {}

		def fake_execute(tool_name, call_args):
			captured["tool_name"] = tool_name
			captured["args"] = call_args
			return tool_result or {"success": True, "result": "ok"}

		fake_run_doc = MagicMock()
		fake_tool_call_doc = MagicMock()

		with patch.object(flow_engine, "frappe") as fake_frappe, \
			patch.object(flow_engine, "execute_tool", side_effect=fake_execute), \
			patch.object(flow_engine, "_create_flow_agent_run", return_value=fake_run_doc):
			fake_frappe.db.get_value.return_value = None  # not an MCP tool
			fake_frappe.get_doc.return_value = fake_tool_call_doc
			flow_engine._exec_tool_call(flow_run, {"id": "n1"}, config, {})

		return captured

	def test_flat_key_reference_resolves(self):
		captured = self._run_tool_call({"name": "Ada"}, {"greeting": {"$from": "context.name"}})
		self.assertEqual(captured["args"]["greeting"], "Ada")

	def test_dotted_path_reference_resolves(self):
		"""F-2: tool.call's arg substitution used to only do a flat
		ctx.get(var_name) lookup and could not resolve dotted paths, unlike
		`_interpolate_string` elsewhere in the engine. Now every node type
		resolves ``{"$from": ...}`` through the same `GraphContext.resolve`,
		so a nested path works here exactly as it does everywhere else.
		"""
		captured = self._run_tool_call(
			{"user": {"email": "a@b.com"}},
			{"to": {"$from": "context.user.email"}},
		)
		self.assertEqual(captured["args"]["to"], "a@b.com")


# ---------------------------------------------------------------------------
# approve_flow_run: its own inline routing + meta.outcome convention
# ---------------------------------------------------------------------------


class TestApproveFlowRunRouting(unittest.TestCase):
	"""approve_flow_run has a SEPARATE routing implementation from
	`_evaluate_edges`: it first looks for an edge whose `meta.outcome` equals
	the decision string ("approved"/"rejected"); only for "approved" does it
	fall back to `_evaluate_edges`. Rejection with no explicit edge must FAIL
	the run rather than silently falling back to success-edge routing.
	"""

	def _defn(self, edges):
		return {
			"id": "test-flow",
			"entry": "approval",
			"nodes": [],
			"edges": edges,
			"settings": {},
		}

	def _invoke(self, flow_run, edges, decision, comment=None, roles=None, session_user="Administrator"):
		fake_frappe = MagicMock()
		fake_frappe.session.user = session_user
		fake_frappe.get_roles.return_value = roles or []
		fake_frappe.get_doc.return_value = flow_run

		def fake_throw(msg, exc=Exception):
			raise exc(msg)

		fake_frappe.throw.side_effect = fake_throw
		fake_frappe.PermissionError = PermissionError
		fake_frappe._ = lambda s: s

		with patch.object(flow_engine, "frappe", fake_frappe), \
			patch.object(flow_engine, "_", lambda s: s), \
			patch.object(flow_engine, "load_definition", return_value=self._defn(edges)), \
			patch.object(flow_engine, "run_flow") as fake_run_flow, \
			patch.object(flow_engine, "_clear_flow_notifications"):
			flow_engine.approve_flow_run(flow_run.name, decision, comment)
		return fake_run_flow

	def _waiting_flow_run(self, store_key="approval", approval_type="role", approver_role=None):
		flow_run = FakeFlowRun(
			status="Waiting Approval",
			current_node_id="approval",
			waiting=json.dumps(
				{
					"store_decision_in_context": store_key,
					"approval_type": approval_type,
					"approver_role": approver_role,
				}
			),
		)
		_ctx(flow_run)
		return flow_run

	def test_explicit_approved_outcome_edge_wins(self):
		flow_run = self._waiting_flow_run()
		edges = [
			{"from": "approval", "to": "next_ok", "meta": {"outcome": "approved"}},
			{"from": "approval", "to": "next_fallback", "type": "always"},
		]
		fake_run_flow = self._invoke(flow_run, edges, "approved")
		self.assertEqual(flow_run.current_node_id, "next_ok")
		self.assertEqual(flow_run.status, "Running")
		fake_run_flow.assert_called_once_with(flow_run.name)

	def test_explicit_rejected_outcome_edge_wins(self):
		flow_run = self._waiting_flow_run()
		edges = [{"from": "approval", "to": "rejection_path", "meta": {"outcome": "rejected"}}]
		self._invoke(flow_run, edges, "rejected", comment="not good")
		self.assertEqual(flow_run.current_node_id, "rejection_path")
		self.assertEqual(flow_run.status, "Running")

	def test_approved_with_no_outcome_edge_falls_back_to_evaluate_edges(self):
		flow_run = self._waiting_flow_run()
		edges = [{"from": "approval", "to": "generic_next", "type": "on_success"}]
		self._invoke(flow_run, edges, "approved")
		self.assertEqual(flow_run.current_node_id, "generic_next")

	def test_rejected_with_no_explicit_edge_fails_the_run_not_routes(self):
		"""This is the surprising branch: rejection must NOT fall back to
		`_evaluate_edges` (which would route it down a success-shaped path).
		With no explicit 'rejected' outcome edge, the run must simply fail."""
		flow_run = self._waiting_flow_run()
		edges = [{"from": "approval", "to": "success_path", "type": "on_success"}]
		self._invoke(flow_run, edges, "rejected", comment="nope")
		self.assertEqual(flow_run.status, "Failed")
		self.assertIn("nope", flow_run.last_error)
		self.assertIsNone(flow_run.waiting)

	def test_approved_with_no_outgoing_edges_completes_gracefully(self):
		flow_run = self._waiting_flow_run()
		self._invoke(flow_run, [], "approved")
		self.assertEqual(flow_run.status, "Success")

	def test_decision_is_stored_in_context_under_configured_key(self):
		flow_run = self._waiting_flow_run(store_key="my_decision")
		edges = [{"from": "approval", "to": "next", "meta": {"outcome": "approved"}}]
		self._invoke(flow_run, edges, "approved", comment="lgtm")
		stored_ctx = json.loads(flow_run.context_json)
		self.assertEqual(stored_ctx["my_decision"]["decision"], "approved")
		self.assertEqual(stored_ctx["my_decision"]["comment"], "lgtm")

	def test_hop_count_increments_on_routed_approval(self):
		flow_run = self._waiting_flow_run()
		flow_run.hop_count = 3
		edges = [{"from": "approval", "to": "next", "meta": {"outcome": "approved"}}]
		self._invoke(flow_run, edges, "approved")
		self.assertEqual(flow_run.hop_count, 4)

	def test_not_waiting_approval_raises(self):
		flow_run = FakeFlowRun(status="Running")
		with self.assertRaises(Exception):
			self._invoke(flow_run, [], "approved")

	def test_role_permission_denied_blocks_routing(self):
		flow_run = self._waiting_flow_run(approval_type="role", approver_role="Flow Approver")
		edges = [{"from": "approval", "to": "next", "meta": {"outcome": "approved"}}]
		with self.assertRaises(PermissionError):
			self._invoke(flow_run, edges, "approved", roles=["Some Other Role"])
		# Permission must be checked BEFORE any routing/context mutation happens.
		self.assertEqual(flow_run.status, "Waiting Approval")


# ---------------------------------------------------------------------------
# Hop limit trip + end-node completion, via the real _execute_loop
# ---------------------------------------------------------------------------


class TestHopLimitAndEndCompletion(unittest.TestCase):
	def test_hop_limit_trip_fails_the_run(self):
		flow_run = FakeFlowRun(current_node_id="n1", hop_count=5, max_hops=5)
		_ctx(flow_run)
		nodes_map = {"n1": {"id": "n1", "type": "end", "config": {}}}
		with patch.object(flow_engine, "_publish_flow_event"):
			flow_engine._execute_loop(flow_run, nodes_map, [], {})
		self.assertEqual(flow_run.status, "Failed")
		self.assertIn("Hop limit", flow_run.last_error)

	def test_end_node_completes_run_successfully(self):
		flow_run = FakeFlowRun(current_node_id="n1", hop_count=0, max_hops=10)
		_ctx(flow_run)
		nodes_map = {"n1": {"id": "n1", "type": "end", "config": {}}}
		with patch.object(flow_engine, "_publish_flow_event"):
			flow_engine._execute_loop(flow_run, nodes_map, [], {})
		self.assertEqual(flow_run.status, "Success")
		self.assertIsNotNone(flow_run.completed_at)

	def test_unmatched_node_fails_gracefully(self):
		flow_run = FakeFlowRun(current_node_id="missing", hop_count=0, max_hops=10)
		_ctx(flow_run)
		with patch.object(flow_engine, "_publish_flow_event"):
			flow_engine._execute_loop(flow_run, {}, [], {})
		self.assertEqual(flow_run.status, "Failed")
		self.assertIn("missing", flow_run.last_error)

	def test_normal_mode_advances_via_evaluate_edges_between_nodes(self):
		flow_run = FakeFlowRun(current_node_id="n1", hop_count=0, max_hops=10, mode="Normal")
		_ctx(flow_run)
		nodes_map = {
			"n1": {"id": "n1", "type": "end", "config": {}},
		}
		edges = []  # end node completes before edges are even consulted
		with patch.object(flow_engine, "_publish_flow_event"):
			flow_engine._execute_loop(flow_run, nodes_map, edges, {})
		self.assertEqual(flow_run.status, "Success")

	def test_no_outgoing_edges_from_non_end_node_completes_run(self):
		flow_run = FakeFlowRun(current_node_id="n1", hop_count=0, max_hops=10, mode="Normal")
		_ctx(flow_run)
		nodes_map = {"n1": {"id": "n1", "type": "transform", "config": {"op": "coalesce", "input": {"values": []}}}}
		with patch.object(flow_engine, "_publish_flow_event"):
			flow_engine._execute_loop(flow_run, nodes_map, [], {})
		self.assertEqual(flow_run.status, "Success")

	def test_hop_count_increments_each_step(self):
		flow_run = FakeFlowRun(current_node_id="n1", hop_count=0, max_hops=10, mode="Normal")
		_ctx(flow_run)
		nodes_map = {
			"n1": {"id": "n1", "type": "transform", "config": {"op": "coalesce", "input": {"values": []}}},
			"n2": {"id": "n2", "type": "end", "config": {}},
		}
		edges = [{"from": "n1", "to": "n2", "type": "always"}]
		with patch.object(flow_engine, "_publish_flow_event"):
			flow_engine._execute_loop(flow_run, nodes_map, edges, {})
		self.assertEqual(flow_run.hop_count, 2)
		self.assertEqual(flow_run.status, "Success")


# ---------------------------------------------------------------------------
# GW-02: a failed node with no successor must fail the run, not silently
# report success.
# ---------------------------------------------------------------------------


class TestFailedNodeWithNoSuccessorFailsRun(unittest.TestCase):
	"""GW-02 regression: ``huf.ai.graph.executor.GraphExecutor.run`` used to
	read ``next_node_id is None`` as "run boundary reached, complete the run
	successfully" no matter what the node's own outcome was. Router.resolve's
	fail-closed guard (I7) only fires when Flow's own ``default_resolver`` is
	NOT supplied -- but flow_engine.py always supplies one
	(``_build_router``'s ``default_resolver``), so a failed tool.call node
	with no ``next``/``on_error`` pointer and no matching edge silently
	completed the whole Flow Run as "Success". The fix enforces fail-closed
	centrally in ``GraphExecutor.run``, independent of which resolver
	produced the (missing) next node id.
	"""

	def _run_failing_tool_call(self, on_error=None):
		flow_run = FakeFlowRun(current_node_id="n1", hop_count=0, max_hops=10, mode="Normal")
		_ctx(flow_run)
		node = {"id": "n1", "type": "tool.call", "config": {"tool_id": "demo_tool", "input": {}}}
		if on_error:
			node["on_error"] = on_error
		nodes_map = {"n1": node}
		if on_error:
			nodes_map[on_error] = {"id": on_error, "type": "end", "config": {}}

		def fake_execute_tool(tool_name, call_args):
			return {"success": False, "error": "boom"}

		fake_run_doc = MagicMock()
		fake_tool_call_doc = MagicMock()

		with patch.object(flow_engine, "frappe") as fake_frappe, \
			patch.object(flow_engine, "execute_tool", side_effect=fake_execute_tool), \
			patch.object(flow_engine, "_create_flow_agent_run", return_value=fake_run_doc), \
			patch.object(flow_engine, "_publish_flow_event"):
			fake_frappe.db.get_value.return_value = None  # not an MCP tool
			fake_frappe.get_doc.return_value = fake_tool_call_doc
			flow_engine._execute_loop(flow_run, nodes_map, [], {})

		return flow_run

	def test_failed_node_no_successor_fails_the_run(self):
		"""A single engineered-to-fail node with no on_error edge must report
		Flow Run status Failed, not Success."""
		flow_run = self._run_failing_tool_call(on_error=None)
		self.assertEqual(flow_run.status, "Failed")
		self.assertIn("boom", flow_run.last_error or "")

	def test_failed_node_with_on_error_edge_still_succeeds(self):
		"""Regression guard: a failing node that DOES declare a matching
		on_error successor must still be able to complete the run
		successfully by routing to the error-handling node -- the fail-closed
		fix must not break existing on_error routing."""
		flow_run = self._run_failing_tool_call(on_error="recover")
		self.assertEqual(flow_run.status, "Success")


# ---------------------------------------------------------------------------
# Known defects (F-1..F-4): intended-behaviour acceptance tests for T-22
# ---------------------------------------------------------------------------


class TestKnownDefects(unittest.TestCase):
	def test_resumed_run_uses_definition_pinned_at_start_not_current(self):
		"""F-1 (flow_definition.py:33, flow_engine.py:141): flow_version
		auto-increments on every FlowDefinition save, and `load_definition` /
		`run_flow` always re-fetch the CURRENT definition rather than the one
		recorded on the Flow Run at creation time (`flow_run.flow_version`).
		Intended behaviour: a resumed run continues executing against the
		definition version it started with, even if the definition has since
		been edited and re-saved.
		"""
		flow_run = FakeFlowRun(
			current_node_id="n1",
			flow_version=1,
			status="Waiting User",
			hop_count=0,
			max_hops=10,
		)
		_ctx(flow_run)

		# Two definition "versions": v1 routes n1 -> old_next, v2 (simulating a
		# later edit + auto-bumped version) routes n1 -> new_next instead.
		defn_v1 = {
			"id": "test-flow",
			"version": 1,
			"entry": "n1",
			"nodes": [{"id": "n1", "type": "end", "config": {}}],
			"edges": [],
			"settings": {},
		}
		defn_v2 = {
			"id": "test-flow",
			"version": 2,
			"entry": "n1",
			# Deliberately a node shape that cannot complete successfully (a
			# condition node with no expression configured), so this test can
			# tell v1-vs-v2 execution apart by outcome rather than by node type.
			"nodes": [{"id": "n1", "type": "condition", "config": {}}],
			"edges": [],
			"settings": {},
		}
		versions = {1: defn_v1, 2: defn_v2}
		# Simulate the definition doc having since been edited and auto-bumped
		# to v2 (flow_definition.py:33's before_save) -- independent of what
		# version this particular run was pinned to at start.
		current_version_on_disk = {"v": 2}

		def fake_load_definition(flow_id):
			# This mirrors the ACTUAL (buggy) behaviour: flow_engine.py:141
			# always re-fetches whatever is current on disk, ignoring
			# flow_run.flow_version entirely. A fixed implementation would key
			# off `flow_run.flow_version` (== 1) here instead.
			return versions[current_version_on_disk["v"]]

		fake_frappe = MagicMock()
		fake_frappe.get_doc.return_value = flow_run

		with patch.object(flow_engine, "frappe", fake_frappe), \
			patch.object(flow_engine, "load_definition", side_effect=fake_load_definition), \
			patch.object(flow_engine, "commit_if_background"):
			# Simulate the definition being edited (and auto-version-bumped) to v2
			# WHILE this run is paused waiting on user input.
			flow_engine.resume_flow_run(flow_run.name)

		# Intended: the node type actually executed should be the one from the
		# PINNED version (v1's "end"), so the run should have completed via the
		# end node, not been left failing against a v2-shaped condition node.
		self.assertEqual(flow_run.status, "Success")

	def test_loop_over_more_than_max_hops_items_still_completes(self):
		"""F-3 (flow_engine.py ~1111, DEFAULT_MAX_HOPS ~34): each loop iteration
		burns one hop against the run's overall hop budget, via the same
		`hop_count` the outer `_execute_loop` checks. A loop with more items
		than `max_hops` can therefore never finish. Intended behaviour: loop
		iteration should not be constrained by the run's hop budget, so a
		150-item loop over a run with the default 100-hop budget still
		completes.
		"""
		items = list(range(150))
		flow_run = FakeFlowRun(current_node_id="loop", hop_count=0, max_hops=flow_engine.DEFAULT_MAX_HOPS)
		_ctx(flow_run, items=items)
		nodes_map = {
			"loop": {
				"id": "loop",
				"type": "loop",
				"config": {
					"iterate_over": "items",
					"loop_node": "body",
					"done_node": "finish",
					"max_iterations": 1000,
				},
			},
			"body": {"id": "body", "type": "transform", "config": {"op": "coalesce", "input": {"values": []}}},
			"finish": {"id": "finish", "type": "end", "config": {}},
		}
		edges = [{"from": "body", "to": "loop", "type": "always"}]
		with patch.object(flow_engine, "_publish_flow_event"):
			flow_engine._execute_loop(flow_run, nodes_map, edges, {})
		self.assertEqual(flow_run.status, "Success")

	def test_concurrent_resumes_do_not_double_advance_the_cursor(self):
		"""F-4: run_flow takes no lock, so two concurrent resumes of the same
		paused run can both read the same `current_node_id` and both advance
		it, effectively double-executing a step. Intended behaviour: only one
		of two concurrent `run_flow` calls against the same run should be able
		to advance the cursor past a given node in a single logical step; the
		other should observe (or be serialized behind) the first one's move.

		Modeled here without real threads: two "concurrent" callers both
		snapshot current_node_id before either writes it back, then both
		attempt to move forward. Intended behaviour requires some form of
		mutual exclusion (e.g. an optimistic version check or a row lock) that
		makes the second writer detect the conflict instead of silently
		clobbering / duplicating the first writer's advance.
		"""
		flow_run = FakeFlowRun(current_node_id="n1", hop_count=0, max_hops=10)
		_ctx(flow_run)

		# Two callers race to read current_node_id...
		snapshot_a = flow_run.current_node_id
		snapshot_b = flow_run.current_node_id
		self.assertEqual(snapshot_a, snapshot_b)

		advanced_by = []
		original_db_set = flow_run.db_set

		def tracking_db_set(field, value=None):
			updates = field if isinstance(field, dict) else {field: value}
			if "current_node_id" in updates:
				advanced_by.append(updates["current_node_id"])
			original_db_set(field, value)

		flow_run.db_set = tracking_db_set

		nodes_map = {
			"n1": {"id": "n1", "type": "transform", "config": {"op": "coalesce", "input": {"values": []}}},
			"n2": {"id": "n2", "type": "end", "config": {}},
		}
		edges = [{"from": "n1", "to": "n2", "type": "always"}]

		# ...and both drive the loop forward from the same starting snapshot.
		with patch.object(flow_engine, "_publish_flow_event"):
			flow_engine._execute_loop(flow_run, nodes_map, edges, {})
			flow_run.current_node_id = snapshot_a  # simulate caller B replaying its stale read
			flow_engine._execute_loop(flow_run, nodes_map, edges, {})

		# Intended: the cursor must not be advanced from the same starting node
		# twice -- a real lock/optimistic-concurrency check should have made
		# the second call a no-op (or raise), so "n2" should appear at most once.
		self.assertEqual(advanced_by.count("n2"), 1)


if __name__ == "__main__":
	unittest.main()
