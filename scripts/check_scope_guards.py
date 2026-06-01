#!/usr/bin/env python3
"""Coarse scope guards for RevClaw roadmap drift.

These guards are intentionally small. They catch REN-795 growing into a pile of
dedicated files or migrations, while GUIDEPOST.md still owns the judgement call
for broader scope drift such as trust-root policy, social/profile surfaces, or a
detector-platform rewrite.
"""

from __future__ import annotations

import fnmatch
import os
import sys
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]

REN_795_IMPLEMENTATION_PATTERNS = [
    "api/src/**/*ring*.ts",
    "api/src/**/*dispatch*.ts",
    "api/src/**/*minhash*.ts",
    "api/src/**/*co-review*.ts",
    "api/src/**/*review-simhash*.ts",
]
REN_795_MIGRATION_PATTERNS = [
    "api/migrations/*ring*.sql",
    "api/migrations/*dispatch*.sql",
    "api/migrations/*co_review*.sql",
    "api/migrations/*review_simhash*.sql",
]

REN_795_MAX_IMPLEMENTATION_FILES = 5
REN_795_MAX_MIGRATIONS = 1


def _tracked_files() -> list[str]:
    files: list[str] = []
    for root, dirs, names in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", ".wrangler"}]
        for name in names:
            path = Path(root, name).relative_to(REPO).as_posix()
            files.append(path)
    return files


def _matches(files: list[str], patterns: list[str]) -> list[str]:
    return sorted({path for path in files for pattern in patterns if fnmatch.fnmatch(path, pattern)})


def main() -> int:
    files = _tracked_files()
    implementation = [path for path in _matches(files, REN_795_IMPLEMENTATION_PATTERNS) if not path.endswith(".test.ts")]
    migrations = _matches(files, REN_795_MIGRATION_PATTERNS)

    failures: list[str] = []
    if len(implementation) > REN_795_MAX_IMPLEMENTATION_FILES:
        failures.append(
            "REN-795 implementation file budget breached: "
            f"{len(implementation)} > {REN_795_MAX_IMPLEMENTATION_FILES}\n"
            + "\n".join(f"    {path}" for path in implementation)
        )
    if len(migrations) > REN_795_MAX_MIGRATIONS:
        failures.append(
            "REN-795 migration budget breached: "
            f"{len(migrations)} > {REN_795_MAX_MIGRATIONS}\n"
            + "\n".join(f"    {path}" for path in migrations)
        )

    if failures:
        print("SCOPE GUARD FAILED - halt and ask before expanding the slice.\n")
        for failure in failures:
            print(f"- {failure}")
        return 1

    print("scope guards OK.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
