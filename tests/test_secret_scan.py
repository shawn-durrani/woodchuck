"""The committed tree must scan clean, and the scanner must stay a
byte-for-byte copy of crossband's canonical. The tree test runs without
the personal deny-list so it behaves the same locally and in CI. The
drift test reads a local crossband checkout when there is one and
otherwise downloads the canonical, skipping visibly when it can't."""
import hashlib
import os
import subprocess
import urllib.request
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
SCAN = REPO / "scripts" / "secret-scan.sh"


def test_committed_tree_scans_clean():
    env = dict(os.environ, SECRET_SCAN_LOCAL="/nonexistent")
    p = subprocess.run(["bash", str(SCAN), "--tree"], cwd=REPO,
                       capture_output=True, text=True, env=env)
    assert p.returncode == 0, p.stdout + p.stderr


CANONICAL_URL = ("https://raw.githubusercontent.com/shawn-durrani/crossband/"
                 "main/scripts/secret-scan.sh")
SYNC_HINT = (
    "scripts/secret-scan.sh is a byte-for-byte copy of crossband's canonical "
    "scanner. Pattern fixes land in crossband first; do not patch this copy. "
    "Sync it with:\n"
    f"  curl -fsSL {CANONICAL_URL} -o scripts/secret-scan.sh\n"
    "or copy the file from a local crossband checkout, then commit."
)


def _canonical_scanner():
    explicit = os.environ.get("SECRET_SCAN_CANONICAL")
    if explicit:
        p = Path(explicit)
        assert p.is_file(), f"SECRET_SCAN_CANONICAL={explicit} is not a file"
        return p.read_bytes(), f"SECRET_SCAN_CANONICAL={explicit}"
    for p in (REPO.parent / "crossband" / "scripts" / "secret-scan.sh",):
        if p.is_file():
            return p.read_bytes(), str(p)
    try:
        with urllib.request.urlopen(CANONICAL_URL, timeout=10) as resp:
            return resp.read(), CANONICAL_URL
    except Exception as exc:  # offline, a proxy, a GitHub hiccup
        return None, f"{CANONICAL_URL} ({exc.__class__.__name__}: {exc})"


def test_scanner_matches_canonical():
    canonical, source = _canonical_scanner()
    if canonical is None:
        pytest.skip(f"the canonical scanner is not reachable: {source}. "
                    "CI has network and checks this; offline it cannot.")
    mine = hashlib.sha256(SCAN.read_bytes()).hexdigest()
    theirs = hashlib.sha256(canonical).hexdigest()
    assert mine == theirs, (
        f"scripts/secret-scan.sh has drifted from the canonical at {source}\n"
        f"  local     sha256 {mine}\n  canonical sha256 {theirs}\n{SYNC_HINT}")
