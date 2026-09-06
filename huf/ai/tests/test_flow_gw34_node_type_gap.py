# Copyright (c) 2026, Tridz Technologies Pvt Ltd
# For license information, please see license.txt

"""GW-34: Flow's node type allow-list must match what flow_engine can execute.

``huf/ai/graph/validator.py``'s ``FLOW_NODE_TYPES`` (the schema-enforced allow-list
``FlowDefinition.validate()`` uses) is ``PROCEDURE_NODE_TYPES | FLOW_ONLY_NODE_TYPES`` --
by design (spec/graph-ir.md section 1: "the same seven [Procedure types], plus" the six
Flow-only types). ``PROCEDURE_NODE_TYPES`` includes ``foreach``, ``parallel``, ``validate``
and ``output`` -- so a schema-valid Flow Definition can save a node of any of these four
types. But ``huf.ai.flow_engine._NODE_EXECUTORS`` had no entry for any of them: at runtime
``GraphExecutor`` (via ``_execute_node``) raised "Unknown node type" the instant one ran,
even though ``huf/huf/doctype/flow_definition/test_flow_definition_schema.py``'s own
``_valid_flow_definition()`` fixture uses an ``output`` node as its valid example.

Separately, ``_exec_transform`` read ``config.get("transformations")`` (a
``[{source_field, target_field, operation}]`` list) that graph_ir.schema.json's
``TransformNode`` never defined -- the schema requires ``config.op``/``config.input``
(``additionalProperties: false`` rejects everything else), so a schema-valid ``transform``
node's actual config was silently ignored.

This module round-trips each of the four missing node types, plus the corrected
``transform``, through their executors directly (frappe-free, mirroring
test_flow_tool_call_gw01.py's Layer A) using exactly the schema's required config field
names -- proving the executor now consumes them instead of raising "Unknown node type" or
reading a field that is never there.

Run with:
    bench --site <site> run-tests --app huf --module huf.ai.tests.test_flow_gw34_node_type_gap
"""

import sys
import unittest
from unittest.mock import MagicMock

# Mirrors test_flow_tool_call_gw01.py's frappe-free stub setup -- huf.ai.flow_engine does
# `from frappe.<submodule> import X` at import time, which a bare top-level MagicMock
# cannot satisfy.
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
if isinstance(sys.modules.get("frappe"), MagicMock):
	sys.modules["frappe"].whitelist = lambda *a, **k: (lambda f: f)

from huf.ai import flow_engine  # noqa: E402
from huf.ai.graph.executor import GraphContext, PinnedVersion  # noqa: E402
from huf.ai.graph.validator import FLOW_NODE_TYPES, PROCEDURE_NODE_TYPES  # noqa: E402


class _FakeFlowRun:
	def __init__(self, **fields):
		defaults = dict(name="FR-TEST-GW34", flow_id="test-flow-gw34", conversation=None, context_json="{}")
		defaults.update(fields)
		for key, value in defaults.items():
			setattr(self, key, value)

	def db_set(self, key, value=None):
		if isinstance(key, dict):
			for k, v in key.items():
				setattr(self, k, v)
		else:
			setattr(self, key, value)


def _settings_for(nodes: list, data: dict | None = None) -> flow_engine.FlowRunContext:
	"""A minimal FlowRunContext whose ``.definition`` exposes ``nodes`` -- everything
	``_flow_nodes_by_id``/foreach/parallel need to look up a body/branch node, and
	everything ``_exec_output``/``_exec_foreach`` need for ``contract.limits``.
	"""
	graph = {
		"schema_version": "1.0.0",
		"profile": "flow",
		"entry": nodes[0]["id"] if nodes else None,
		"nodes": nodes,
		"contract": {"limits": {"max_rows": 1000, "max_output_bytes": 100_000, "max_foreach_iterations": 50}},
	}
	version = PinnedVersion.pin(graph)
	return flow_engine.FlowRunContext(context=GraphContext(data or {}), version=version)


class TestNodeTypeAllowListMatchesSchemaIntent(unittest.TestCase):
	"""spec/graph-ir.md section 1: FlowGraph is the Procedure profile's seven node types
	plus the six Flow-only ones -- output/foreach/parallel/validate are Procedure types,
	so they are (and must remain) Flow-usable too."""

	def test_output_foreach_parallel_validate_are_flow_usable(self):
		for node_type in ("output", "foreach", "parallel", "validate"):
			self.assertIn(node_type, PROCEDURE_NODE_TYPES)
			self.assertIn(node_type, FLOW_NODE_TYPES)

	def test_every_flow_node_type_has_an_executor(self):
		missing = sorted(FLOW_NODE_TYPES - set(flow_engine._NODE_EXECUTORS))
		self.assertEqual(missing, [], f"FLOW_NODE_TYPES has no flow_engine executor for: {missing}")


class TestExecOutput(unittest.TestCase):
	def test_resolves_value_and_is_terminal(self):
		node = {"id": "finish", "type": "output", "config": {"value": {"$from": "input.total"}}}
		settings = _settings_for([node], data={"total": 42})

		result = flow_engine._exec_output(_FakeFlowRun(), node, node["config"], settings)

		self.assertEqual(result["status"], "success")
		self.assertEqual(result["output"], 42)
		self.assertEqual(flow_engine.NODE_ROUTING["output"], flow_engine.RoutingMode.TERMINAL)

	def test_over_budget_list_fails_closed(self):
		node = {"id": "finish", "type": "output", "config": {"value": {"$from": "input.rows"}}}
		settings = _settings_for([node], data={"rows": list(range(5000))})
		# Force a tiny budget so the over-budget path is exercised deterministically.
		settings.version.graph["contract"]["limits"] = {"max_rows": 10, "max_output_bytes": 100_000}

		result = flow_engine._exec_output(_FakeFlowRun(), node, node["config"], settings)

		self.assertEqual(result["status"], "failed")
		self.assertIn("error", result)


class TestExecValidate(unittest.TestCase):
	def test_all_assertions_pass(self):
		config = {"assertions": [{"expression": 'input["total"] > 0', "code": "positive", "message": "must be positive"}]}
		node = {"id": "check", "type": "validate", "config": config}
		settings = _settings_for([node], data={"total": 5})

		result = flow_engine._exec_validate(_FakeFlowRun(), node, config, settings)

		self.assertEqual(result["status"], "success")
		self.assertEqual(result["result"]["assertions_passed"], 1)

	def test_failed_assertion_fails_closed(self):
		config = {"assertions": [{"expression": 'input["total"] > 0', "code": "positive", "message": "must be positive"}]}
		node = {"id": "check", "type": "validate", "config": config}
		settings = _settings_for([node], data={"total": -1})

		result = flow_engine._exec_validate(_FakeFlowRun(), node, config, settings)

		self.assertEqual(result["status"], "failed")
		self.assertIn("positive", result["error"])


class TestExecTransform(unittest.TestCase):
	def test_reads_schema_op_and_input_not_legacy_transformations(self):
		"""The schema's TransformNode requires config.op/config.input
		(additionalProperties: false) -- config.transformations was never a valid shape."""
		config = {"op": "coalesce", "input": {"values": [{"$from": "input.missing"}, {"$from": "input.total"}]}}
		node = {"id": "t1", "type": "transform", "config": config}
		settings = _settings_for([node], data={"total": 7})

		result = flow_engine._exec_transform(_FakeFlowRun(), node, config, settings)

		self.assertEqual(result["status"], "success")
		self.assertEqual(result["result"], 7)

	def test_legacy_transformations_field_is_ignored_not_crashed_on(self):
		"""A schema-invalid config (impossible to save any more, but defence in depth)
		must not raise -- run_transform fails closed on a missing/invalid op instead."""
		config = {"transformations": [{"source_field": "total", "target_field": "out", "operation": "copy"}]}
		node = {"id": "t1", "type": "transform", "config": config}
		settings = _settings_for([node], data={"total": 7})

		result = flow_engine._exec_transform(_FakeFlowRun(), node, config, settings)

		self.assertEqual(result["status"], "failed")


class TestExecForeach(unittest.TestCase):
	def test_iterates_body_and_collects_output(self):
		body_node = {
			"id": "double",
			"type": "transform",
			"config": {"op": "coalesce", "input": {"values": [{"$from": "foreach.item"}]}},
		}
		foreach_node = {
			"id": "each",
			"type": "foreach",
			"config": {
				"items": {"$from": "input.numbers"},
				"body": ["double"],
				"max_iterations": 10,
				"on_item_error": "fail",
				"collect": {"$from": "double"},
			},
		}
		settings = _settings_for([foreach_node, body_node], data={"numbers": [1, 2, 3]})

		result = flow_engine._exec_foreach(_FakeFlowRun(), foreach_node, foreach_node["config"], settings)

		self.assertEqual(result["status"], "success")
		self.assertEqual(result["result"], [1, 2, 3])

	def test_exceeding_max_iterations_fails_closed(self):
		foreach_node = {
			"id": "each",
			"type": "foreach",
			"config": {
				"items": {"$from": "input.numbers"},
				"body": ["noop"],
				"max_iterations": 2,
				"on_item_error": "fail",
				"collect": None,
			},
		}
		noop_node = {"id": "noop", "type": "transform", "config": {"op": "coalesce", "input": {"values": []}}}
		settings = _settings_for([foreach_node, noop_node], data={"numbers": [1, 2, 3]})

		result = flow_engine._exec_foreach(_FakeFlowRun(), foreach_node, foreach_node["config"], settings)

		self.assertEqual(result["status"], "failed")
		self.assertIn("max_iterations", result["error"])


class TestExecParallel(unittest.TestCase):
	def test_runs_every_branch_to_completion(self):
		branch_a = {
			"id": "a1",
			"type": "transform",
			"config": {"op": "coalesce", "input": {"values": [{"$from": "input.x"}]}},
		}
		branch_b = {
			"id": "b1",
			"type": "transform",
			"config": {"op": "coalesce", "input": {"values": [{"$from": "input.y"}]}},
		}
		parallel_node = {
			"id": "fan_out",
			"type": "parallel",
			"config": {"branches": [["a1"], ["b1"]], "join": "all"},
		}
		settings = _settings_for([parallel_node, branch_a, branch_b], data={"x": 1, "y": 2})

		result = flow_engine._exec_parallel(_FakeFlowRun(), parallel_node, parallel_node["config"], settings)

		self.assertEqual(result["status"], "success")
		self.assertEqual(result["result"]["branches_completed"], 2)

	def test_one_failing_branch_fails_the_node(self):
		branch_a = {"id": "a1", "type": "transform", "config": {"op": "coalesce", "input": {"values": []}}}
		branch_b = {"id": "b1", "type": "transform", "config": {"op": "not_a_real_op", "input": {}}}
		parallel_node = {
			"id": "fan_out",
			"type": "parallel",
			"config": {"branches": [["a1"], ["b1"]], "join": "all"},
		}
		settings = _settings_for([parallel_node, branch_a, branch_b], data={})

		result = flow_engine._exec_parallel(_FakeFlowRun(), parallel_node, parallel_node["config"], settings)

		self.assertEqual(result["status"], "failed")


if __name__ == "__main__":
	unittest.main()
