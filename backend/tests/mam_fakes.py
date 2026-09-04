# Shared in-memory Firestore fake for MAM package tests. Not a test file
# itself (no test_ prefix) -- imported by test_mam_tools.py,
# test_mam_orchestrator.py, and test_mam_routes.py so all three exercise
# the exact same fake semantics rather than three slightly-different
# reimplementations. Deliberately minimal: only the operations
# app.mam.tools.Tools actually calls (.collection/.document/.where/
# .limit/.stream/.get/.set/.delete, plus one level of subcollection
# nesting for favorites/publicTransactionSummary) -- not a general
# Firestore emulator replacement.
from __future__ import annotations

from typing import Any


class FakeDocSnapshot:
    def __init__(self, doc_id: str, data: dict | None):
        self.id = doc_id
        self._data = data
        self.exists = data is not None

    def to_dict(self) -> dict | None:
        return dict(self._data) if self._data is not None else None


class FakeQuery:
    def __init__(self, items: list[tuple[str, dict]]):
        self._items = items

    def where(self, field: str, op: str, value: Any) -> FakeQuery:
        assert op == "==", f"FakeQuery only supports '==' (tools.py never uses another op), got {op!r}"

        def _matches(doc: dict) -> bool:
            return doc.get(field) == value

        return FakeQuery([(doc_id, doc) for doc_id, doc in self._items if _matches(doc)])

    def limit(self, n: int) -> FakeQuery:
        return FakeQuery(self._items[:n])

    def stream(self) -> list[FakeDocSnapshot]:
        return [FakeDocSnapshot(doc_id, doc) for doc_id, doc in self._items]


class FakeDocRef:
    def __init__(self, entry: dict):
        self._entry = entry
        self.id = entry["id"]

    def get(self) -> FakeDocSnapshot:
        return FakeDocSnapshot(self.id, self._entry["data"])

    def set(self, data: dict) -> None:
        self._entry["data"] = dict(data)

    def delete(self) -> None:
        self._entry["data"] = None

    def collection(self, name: str) -> FakeCollectionRef:
        return FakeCollectionRef(self._entry["subs"].setdefault(name, {}))


class FakeCollectionRef:
    def __init__(self, store: dict[str, dict]):
        self._store = store

    def document(self, doc_id: str) -> FakeDocRef:
        entry = self._store.setdefault(doc_id, {"id": doc_id, "data": None, "subs": {}})
        return FakeDocRef(entry)

    def _live_items(self) -> list[tuple[str, dict]]:
        return [(doc_id, e["data"]) for doc_id, e in self._store.items() if e["data"] is not None]

    def where(self, field: str, op: str, value: Any) -> FakeQuery:
        return FakeQuery(self._live_items()).where(field, op, value)

    def limit(self, n: int) -> FakeQuery:
        return FakeQuery(self._live_items()).limit(n)

    def stream(self) -> list[FakeDocSnapshot]:
        return FakeQuery(self._live_items()).stream()


class FakeFirestore:
    def __init__(self) -> None:
        self._collections: dict[str, dict[str, dict]] = {}

    def collection(self, name: str) -> FakeCollectionRef:
        return FakeCollectionRef(self._collections.setdefault(name, {}))
