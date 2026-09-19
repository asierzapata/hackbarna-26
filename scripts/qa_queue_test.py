import csv
import json
from pathlib import Path
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from qa_queue import FIELDS, operate


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        for index, created in [(1, 20), (2, 10)]:
            bug_id = f"12345678-1234-1234-1234-{index:012d}"
            (self.directory / (bug_id + ".json")).write_text(json.dumps({"id": bug_id, "createdAt": created, "schemaVersion": 1}))

    def test_fifo_recovery_ownership_and_csv_round_trip(self):
        rows = operate(self.directory, "list")
        self.assertEqual([row["created_at"] for row in rows], ["10", "20"])
        first = operate(self.directory, "claim", owner="session-a")
        self.assertEqual(first["id"], rows[0]["id"])
        with self.assertRaises(RuntimeError):
            operate(self.directory, "claim", owner="session-b")
        with self.assertRaises(RuntimeError):
            operate(self.directory, "update", first["id"], "wrong-owner", "finished", "passed")
        with self.assertRaises(RuntimeError):
            operate(self.directory, "update", first["id"], "session-a", "finished", "")
        notes = 'Verified "quotes", commas\nand newline'
        operate(self.directory, "update", first["id"], "session-a", "finished", notes)
        self.assertEqual(operate(self.directory, "list")[0]["notes"], notes)
        second = operate(self.directory, "claim", owner="session-b")
        self.assertEqual(second["id"], rows[1]["id"])
        operate(self.directory, "update", second["id"], "session-b", "open", "Blocked on credentials")
        self.assertEqual(operate(self.directory, "list")[1]["status"], "open")
        self.assertEqual(operate(self.directory, "list")[1]["owner"], "")

    def test_concurrent_claims_have_one_owner(self):
        def claim(owner):
            try:
                return operate(self.directory, "claim", owner=owner)
            except RuntimeError:
                return None
        with ThreadPoolExecutor() as pool:
            results = list(pool.map(claim, ["a", "b", "c"]))
        self.assertEqual(sum(result is not None for result in results), 1)

    def test_formula_safe_and_header_compatible_with_rust(self):
        first = operate(self.directory, "claim", owner="=formula")
        operate(self.directory, "update", first["id"], "=formula", "finished", "=HYPERLINK(\"x\")")
        text = (self.directory / "bugs.csv").read_text()
        self.assertTrue(text.startswith(",".join(FIELDS) + "\n"))
        rows = list(csv.DictReader(text.splitlines()))
        self.assertEqual(rows[0]["owner"], "'=formula")
        self.assertTrue(rows[0]["notes"].startswith("'="))

    def test_repairs_joined_rows_without_losing_ownership_or_notes(self):
        first = operate(self.directory, "claim", owner="session-a")
        operate(self.directory, "update", first["id"], "session-a", "finished", 'Verified "quotes", commas\nand newline')
        expected = operate(self.directory, "list")
        path = self.directory / "bugs.csv"
        original = path.read_text().replace(expected[0]["report_path"] + "\n", expected[0]["report_path"])
        path.write_text(original)
        with self.assertRaises(RuntimeError):
            operate(self.directory, "list")
        self.assertEqual(operate(self.directory, "repair"), expected)
        backups = list(self.directory.glob(".bugs-backup-*.csv"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text(), original)
        self.assertEqual(operate(self.directory, "repair"), expected)
        self.assertEqual(len(list(self.directory.glob(".bugs-backup-*.csv"))), 1)

    def test_repair_refuses_unrecognized_corruption(self):
        rows = operate(self.directory, "list")
        path = self.directory / "bugs.csv"
        original = path.read_text().replace(rows[0]["report_path"], "unexpected.json")
        path.write_text(original)
        with self.assertRaises(RuntimeError):
            operate(self.directory, "repair")
        self.assertEqual(path.read_text(), original)
        self.assertEqual(list(self.directory.glob(".bugs-backup-*.csv")), [])

    def test_truncated_row_is_not_overwritten(self):
        text = ",".join(FIELDS) + "\n12345678-1234-1234-1234-000000000001\n"
        (self.directory / "bugs.csv").write_text(text)
        with self.assertRaises(RuntimeError):
            operate(self.directory, "claim", owner="a")
        self.assertEqual((self.directory / "bugs.csv").read_text(), text)

    def test_corrupt_queue_is_not_overwritten(self):
        (self.directory / "bugs.csv").write_text("bad header\n")
        with self.assertRaises(RuntimeError):
            operate(self.directory, "claim", owner="a")
        self.assertEqual((self.directory / "bugs.csv").read_text(), "bad header\n")
        self.assertFalse((self.directory / ".queue.lock").exists())


if __name__ == "__main__":
    unittest.main()
