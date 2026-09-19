import argparse
import csv
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from contextlib import contextmanager

FIELDS = ["id", "created_at", "status", "updated_at", "owner", "notes", "report_path"]
ID = re.compile(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}")


@contextmanager
def queue_lock(directory):
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock = directory / ".queue.lock"
    for attempt in range(40):
        try:
            lock.mkdir(mode=0o700)
            break
        except FileExistsError:
            if attempt == 39:
                raise RuntimeError("QA queue is locked. Inspect the active writer before removing a stale .queue.lock.")
            time.sleep(0.05)
    try:
        yield
    finally:
        lock.rmdir()


def atomic_csv(directory, rows):
    descriptor, temporary = tempfile.mkstemp(prefix=".bugs-", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(descriptor, "w", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=FIELDS, lineterminator="\n")
            writer.writeheader()
            writer.writerows(rows)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, directory / "bugs.csv")
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_rows(directory):
    path = directory / "bugs.csv"
    rows = []
    if path.exists():
        with path.open(newline="", encoding="utf-8") as stream:
            reader = csv.DictReader(stream)
            if reader.fieldnames != FIELDS:
                raise RuntimeError("Unexpected CSV header; refusing to overwrite it")
            rows = list(reader)
    seen = set()
    for row in rows:
        if (None in row or any(value is None for value in row.values())
                or not ID.fullmatch(row["id"]) or row["id"] in seen
                or row["status"] not in ("open", "solving", "finished")
                or row["report_path"] != row["id"] + ".json"
                or not row["created_at"].isdigit()):
            raise RuntimeError("Invalid QA queue row; refusing to overwrite it")
        if not (directory / row["report_path"]).is_file():
            raise RuntimeError("Missing report for " + row["id"])
        seen.add(row["id"])
    recovered = False
    for path in sorted(directory.glob("*.json")):
        if not ID.fullmatch(path.stem) or path.stem in seen:
            continue
        report = json.loads(path.read_text(encoding="utf-8"))
        if report.get("id") != path.stem or report.get("schemaVersion") != 1 or not isinstance(report.get("createdAt"), int):
            raise RuntimeError("Invalid unindexed report: " + path.name)
        created = str(report["createdAt"])
        rows.append(dict(zip(FIELDS, [path.stem, created, "open", created, "", "Recovered unindexed report", path.name])))
        recovered = True
    rows.sort(key=lambda row: (int(row["created_at"]), row["id"]))
    if recovered:
        atomic_csv(directory, rows)
    return rows


def safe_cell(value):
    return "'" + value if value.lstrip().startswith(("=", "+", "-", "@")) or value.startswith(("\t", "\r", "\n")) else value


def operate(directory, command, bug_id=None, owner=None, status=None, notes=""):
    with queue_lock(directory):
        rows = load_rows(directory)
        if command == "list":
            return rows
        if command == "claim":
            active = next((row for row in rows if row["status"] == "solving"), None)
            if active:
                raise RuntimeError("Already solving " + active["id"] + "; resume it or explicitly reopen it before claiming another")
            row = next((row for row in rows if row["status"] == "open"), None)
            if not row:
                return None
            row.update(status="solving", owner=safe_cell(owner), notes="")
        else:
            row = next((row for row in rows if row["id"] == bug_id), None)
            if not row:
                raise RuntimeError("Unknown bug id")
            if row["status"] != "solving" or row["owner"] != safe_cell(owner):
                raise RuntimeError("Only the owner of a solving bug can finish or reopen it")
            if not notes.strip():
                raise RuntimeError("Provide verification evidence or the reason this bug remains open")
            row.update(status=status, notes=safe_cell(notes), owner="" if status == "open" else row["owner"])
        row["updated_at"] = str(time.time_ns() // 1_000_000)
        atomic_csv(directory, rows)
        return row


def main():
    parser = argparse.ArgumentParser(description="Safely manage Kan's local QA queue")
    parser.add_argument("--dir", type=Path, default=Path(os.environ.get("KAN_QA_DIR", Path(__file__).resolve().parents[1] / "qa_bugs")))
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list")
    claim = commands.add_parser("claim")
    claim.add_argument("--owner", required=True)
    update = commands.add_parser("update")
    update.add_argument("id")
    update.add_argument("status", choices=["open", "finished"])
    update.add_argument("--owner", required=True)
    update.add_argument("--notes", required=True)
    args = parser.parse_args()
    if hasattr(args, "owner") and (not args.owner.strip() or len(args.owner) > 200):
        parser.error("Owner must contain 1–200 characters")
    try:
        result = operate(args.dir.resolve(), args.command, getattr(args, "id", None), getattr(args, "owner", None), getattr(args, "status", None), getattr(args, "notes", ""))
        print(json.dumps(result, indent=2))
    except (OSError, ValueError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
