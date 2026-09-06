"""Tests for RunBudget class creation and basic operations.

ST-09.1: Tests for RunBudget class initialization and methods.
"""

from frappe.tests import IntegrationTestCase
from datetime import datetime, timedelta
from unittest.mock import Mock, patch

import frappe
from huf.ai.run_budget import RunBudget, RunBudgetExceeded


class TestRunBudgetBasics(IntegrationTestCase):
    """Basic RunBudget initialization and field access."""

    def test_runbudget_init(self):
        """RunBudget initializes with all required fields."""
        deadline = datetime.now() + timedelta(seconds=900)
        budget = RunBudget(
            deadline_at=deadline,
            max_turns_ceiling=20,
            depth=0,
            ancestry=[],
            spend_cap_usd=100.0
        )

        assert budget.deadline_at == deadline
        assert budget.max_turns_ceiling == 20
        assert budget.current_depth == 0
        assert budget.ancestry == []
        assert budget.spend_cap_usd == 100.0
        assert budget.spend_so_far_usd == 0.0

    def test_runbudget_with_ancestry(self):
        """RunBudget preserves ancestry chain."""
        ancestors = ["run_1", "run_2"]
        budget = RunBudget(
            deadline_at=datetime.now() + timedelta(seconds=900),
            max_turns_ceiling=10,
            depth=2,
            ancestry=ancestors,
            spend_cap_usd=0
        )

        assert budget.current_depth == 2
        assert budget.ancestry == ancestors
        assert len(budget.ancestry) == 2


class TestRunBudgetDeadlineCheck(IntegrationTestCase):
    """Test deadline checking methods."""

    def test_check_deadline_valid(self):
        """check_deadline() with future deadline succeeds."""
        future_deadline = datetime.now() + timedelta(seconds=100)
        budget = RunBudget(
            deadline_at=future_deadline,
            max_turns_ceiling=10,
            depth=0,
            ancestry=[],
            spend_cap_usd=0
        )

        # Should not raise
        budget.check_deadline()

    def test_check_deadline_expired(self):
        """check_deadline() with expired deadline raises."""
        past_deadline = datetime.now() - timedelta(seconds=100)
        budget = RunBudget(
            deadline_at=past_deadline,
            max_turns_ceiling=10,
            depth=0,
            ancestry=[],
            spend_cap_usd=0
        )

        with self.assertRaises(frappe.ValidationError) as exc_info:
            budget.check_deadline()
        assert RunBudgetExceeded in type(exc_info.exception).__mro__


class TestRunBudgetDepthCheck(IntegrationTestCase):
    """Test depth checking methods."""

    def test_check_depth_valid(self):
        """check_depth() with depth below ceiling succeeds."""
        budget = RunBudget(
            deadline_at=datetime.now() + timedelta(seconds=900),
            max_turns_ceiling=10,
            depth=1,
            ancestry=["run_1"],
            spend_cap_usd=0
        )

        # Should not raise
        budget.check_depth(max_depth=3)

    def test_check_depth_at_ceiling(self):
        """check_depth() with depth equal to ceiling raises (fail closed: reaching
        the ceiling is treated the same as exceeding it, per check_depth's `>=`)."""
        budget = RunBudget(
            deadline_at=datetime.now() + timedelta(seconds=900),
            max_turns_ceiling=10,
            depth=3,
            ancestry=[],
            spend_cap_usd=0
        )

        with self.assertRaises(frappe.ValidationError) as exc_info:
            budget.check_depth(max_depth=3)
        assert "depth" in str(exc_info.exception).lower()

    def test_check_depth_exceeds(self):
        """check_depth() with depth >= ceiling raises."""
        budget = RunBudget(
            deadline_at=datetime.now() + timedelta(seconds=900),
            max_turns_ceiling=10,
            depth=4,
            ancestry=[],
            spend_cap_usd=0
        )

        with self.assertRaises(frappe.ValidationError) as exc_info:
            budget.check_depth(max_depth=3)
        assert "depth" in str(exc_info.exception).lower()


class TestRunBudgetSpendCheck(IntegrationTestCase):
    """Test spend checking methods."""

    def test_check_spend_valid(self):
        """check_spend() within budget succeeds."""
        budget = RunBudget(
            deadline_at=datetime.now() + timedelta(seconds=900),
            max_turns_ceiling=10,
            depth=0,
            ancestry=[],
            spend_cap_usd=100.0
        )
        budget.spend_so_far_usd = 50.0

        # Should not raise
        budget.check_spend(49.0)

    def test_check_spend_exceeds(self):
        """check_spend() over budget raises."""
        budget = RunBudget(
            deadline_at=datetime.now() + timedelta(seconds=900),
            max_turns_ceiling=10,
            depth=0,
            ancestry=[],
            spend_cap_usd=100.0
        )
        budget.spend_so_far_usd = 90.0

        with self.assertRaises(frappe.ValidationError) as exc_info:
            budget.check_spend(20.0)  # Total would be 110.0 > 100.0
        assert "spend" in str(exc_info.exception).lower() or "budget" in str(exc_info.exception).lower()

    def test_check_spend_unlimited(self):
        """check_spend() with spend_cap=0 (unlimited) never raises."""
        budget = RunBudget(
            deadline_at=datetime.now() + timedelta(seconds=900),
            max_turns_ceiling=10,
            depth=0,
            ancestry=[],
            spend_cap_usd=0  # Unlimited
        )
        budget.spend_so_far_usd = 1000000.0

        # Should not raise
        budget.check_spend(999999.0)


class TestAgentSettingsSinglesStringCoercion(IntegrationTestCase):
    """Regression test for HK-01.

    frappe.db.get_single_value on a Singles doctype like ``Agent Settings``
    can return raw strings pulled straight from ``tabSingles`` (no type
    coercion happens there the way it does for a normal DocField on a
    regular table). Passing those uncoerced strings into ``min()``/``max()``
    alongside real ints, or into arithmetic with real floats, raises
    ``TypeError``. RunBudget must coerce every Agent Settings value it reads
    (via cint/flt) before using it.
    """

    @patch("frappe.db.get_single_value")
    def test_from_agent_survives_stringy_singles_values(self, mock_get_single_value):
        """RunBudget.from_agent must not raise TypeError when Agent Settings
        fields come back as strings (as they do from tabSingles)."""

        def get_single_value_side_effect(doctype, field):
            # Simulate the raw string values tabSingles can return.
            stringy_defaults = {
                "deadline_seconds": "900",
                "max_turns_ceiling": "20",
                "spend_cap_usd": "50.5",
                "max_depth": "3",
            }
            return stringy_defaults.get(field)

        mock_get_single_value.side_effect = get_single_value_side_effect

        agent_doc = Mock()
        agent_doc.name = "test_agent"
        agent_doc.max_turns = 15  # int, as it would come off a real DocField
        agent_doc.model = "gpt-4o"

        # Must not raise TypeError: '<' not supported between instances of
        # 'int' and 'str' (the min() call in from_agent).
        budget = RunBudget.from_agent(agent_doc)

        assert budget.max_turns_ceiling == 15  # min(15, 20)
        assert budget.spend_cap_usd == 50.5
        assert isinstance(budget.spend_cap_usd, float)

        # check_depth() must also coerce a stringy max_depth before the
        # `self.current_depth >= max_depth` comparison.
        budget.current_depth = 3
        with self.assertRaises(frappe.ValidationError):
            budget.check_depth()

    @patch("frappe.db.get_single_value")
    def test_from_run_doc_survives_stringy_spend_cap(self, mock_get_single_value):
        """RunBudget.from_run_doc must not raise TypeError when spend_cap_usd
        comes back as a string from tabSingles."""
        mock_get_single_value.return_value = "25.0"

        run_doc = {
            "budget_deadline_at": datetime.now() + timedelta(seconds=900),
            "budget_depth": 1,
            "budget_ancestry": "[]",
            "budget_spend_usd": 0.0,
        }

        budget = RunBudget.from_run_doc(run_doc)

        assert budget.spend_cap_usd == 25.0
        assert isinstance(budget.spend_cap_usd, float)

        # Should not raise TypeError comparing float spend to float cap.
        budget.check_spend(10.0)
