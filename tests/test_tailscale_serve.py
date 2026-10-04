"""scripts/tailscale-serve.sh, the opt-in tailnet-only route.

Keyless and hermetic, like Membro's tests of its own copy. A fake
`tailscale` command is planted on a PATH built for each run, so the script's
own logic runs (find, check signed in, check Funnel, serve, check again,
report) and no real Tailscale is ever reached. Each run asserts first that
the only `tailscale` its PATH can find is the fake.

The property that matters most: the script never runs `tailscale funnel`,
and it never leaves a route in place on a device with Funnel on.
"""
import os
import shutil
import stat
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SCRIPT = REPO / "scripts" / "tailscale-serve.sh"
DNS = "my-mac.my-tailnet.ts.net"


def _tools(tmp: Path) -> Path:
    """A folder with node in it, so the script can read the JSON status,
    without the rest of the developer's PATH."""
    tools = tmp / "tools"
    tools.mkdir(exist_ok=True)
    node = shutil.which("node")
    if node and not (tools / "node").exists():
        (tools / "node").symlink_to(node)
    return tools


def fake_tailscale(bin_dir: Path, *, signed_in=True, serve_ok=True,
                   funnel_text=False, funnel_json=False, funnel_after_serve=False):
    """A fake `tailscale` that answers the calls the script makes and logs
    every call to calls.log beside it."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    log = bin_dir / "calls.log"
    served = bin_dir / "served"
    on_text = "Funnel on" if funnel_text else "tailnet only"
    allow = "true" if funnel_json else "false"
    after = f'[ -f "{served}" ] && FUNNEL=1' if funnel_after_serve else ""
    fake = bin_dir / "tailscale"
    fake.write_text(f"""#!/bin/bash
echo "$@" >> "{log}"
FUNNEL=0
{after}
case "$1" in
  status)
    if [ "$2" = "--json" ]; then
      printf '{{\\n  "Self": {{\\n    "DNSName": "{DNS}."\\n  }}\\n}}\\n'
      exit 0
    fi
    {"exit 0" if signed_in else "exit 1"}
    ;;
  serve)
    if [ "$2" = "status" ] && [ "$3" = "--json" ]; then
      A="{allow}"; [ "$FUNNEL" = 1 ] && A=true
      printf '{{\\n  "AllowFunnel": {{\\n    "{DNS}:8445": %s\\n  }}\\n}}\\n' "$A"
      exit 0
    fi
    if [ "$2" = "status" ]; then
      W="{on_text}"; [ "$FUNNEL" = 1 ] && W="Funnel on"
      echo "https://{DNS}:8445 ($W)"
      echo "|-- / proxy http://127.0.0.1:8905"
      exit 0
    fi
    touch "{served}"
    {"exit 0" if serve_ok else 'echo "unknown flag" >&2; exit 1'}
    ;;
  *) exit 0 ;;
esac
""")
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    return fake


def run(tmp: Path, fake_dir: Path | None, *args, env_extra=None):
    """Runs a copy of the script with PATH = the fake (if any), node,
    /usr/bin and /bin. The copy sits in a folder of its own, so it can never
    read a real .env beside the app."""
    app = tmp / "app"
    (app / "scripts").mkdir(parents=True, exist_ok=True)
    copy = app / "scripts" / "tailscale-serve.sh"
    shutil.copy(SCRIPT, copy)
    dirs = ([str(fake_dir)] if fake_dir else []) + [str(_tools(tmp)), "/usr/bin", "/bin"]
    path = os.pathsep.join(dirs)
    found = shutil.which("tailscale", path=path)
    assert found is None or Path(found).parent == fake_dir, (
        f"refusing to run: a real tailscale is on the test PATH at {found}")
    env = {"PATH": path, "HOME": str(tmp), **(env_extra or {})}
    named = env.get("WOODCHUCK_TAILSCALE_BIN")
    assert not named or str(tmp) in named, "WOODCHUCK_TAILSCALE_BIN must name a fake"
    p = subprocess.run(["/bin/bash", str(copy), *args], cwd=tmp, env=env,
                       capture_output=True, text=True, timeout=30)
    return p.returncode, p.stdout, p.stderr


def calls(fake_dir: Path) -> list[str]:
    log = fake_dir / "calls.log"
    return log.read_text().splitlines() if log.exists() else []


def assert_never_funnel(fake_dir: Path):
    ran = calls(fake_dir)
    assert not [c for c in ran if c.split()[:1] == ["funnel"]], ran


def test_script_exists_and_runs():
    """start.sh and docs/REMOTE_ACCESS.md both point at it."""
    assert SCRIPT.exists()
    assert os.access(SCRIPT, os.X_OK)


def test_no_tailscale_command_skips_cleanly(tmp_path):
    """No Tailscale here: a clear skip and exit 0, never an error."""
    rc, out, err = run(tmp_path, None)
    assert rc == 0, err
    assert "SKIPPED" in err
    assert "127.0.0.1:8905" in err
    assert "WOODCHUCK_TAILSCALE_BIN" in err


def test_signed_out_skips_and_says_how(tmp_path):
    fake = tmp_path / "bin"
    fake_tailscale(fake, signed_in=False)
    rc, out, err = run(tmp_path, fake)
    assert rc == 0
    assert "SKIPPED" in err and "tailscale up" in err
    assert not [c for c in calls(fake) if "--bg" in c]


def test_serves_its_own_https_port_and_says_where(tmp_path):
    """The route is 8445 on the tailnet to 127.0.0.1:8905, and the script
    names the address and the setting it needs."""
    fake = tmp_path / "bin"
    fake_tailscale(fake)
    rc, out, err = run(tmp_path, fake)
    assert rc == 0, err
    assert "serve --bg --https=8445 http://127.0.0.1:8905" in calls(fake)
    assert f"https://{DNS}:8445/" in out
    assert f"WOODCHUCK_TRUSTED_HOSTS={DNS}" in out
    assert_never_funnel(fake)


def test_funnel_on_is_refused_before_anything_is_served(tmp_path):
    """The safety property: Funnel on means exit 1, a loud refusal,
    no success line, and no route set up at all."""
    fake = tmp_path / "bin"
    fake_tailscale(fake, funnel_text=True)
    rc, out, err = run(tmp_path, fake)
    assert rc == 1
    assert "REFUSING" in err and "funnel reset" in err
    assert "Woodchuck is on your tailnet" not in out
    assert not [c for c in calls(fake) if "--bg" in c]
    assert_never_funnel(fake)


def test_funnel_in_the_json_config_alone_is_refused_too(tmp_path):
    """Tailscale prints its config across lines. The check reads it whole."""
    fake = tmp_path / "bin"
    fake_tailscale(fake, funnel_json=True)
    rc, out, err = run(tmp_path, fake)
    assert rc == 1 and "REFUSING" in err
    assert not [c for c in calls(fake) if "--bg" in c]


def test_funnel_seen_after_serving_is_refused(tmp_path):
    """The route is read back after it's set, and Funnel then is refused."""
    fake = tmp_path / "bin"
    fake_tailscale(fake, funnel_after_serve=True)
    rc, out, err = run(tmp_path, fake)
    assert rc == 1 and "REFUSING" in err
    assert "Woodchuck is on your tailnet" not in out
    assert_never_funnel(fake)


def test_a_failed_serve_degrades_cleanly(tmp_path):
    fake = tmp_path / "bin"
    fake_tailscale(fake, serve_ok=False)
    rc, out, err = run(tmp_path, fake)
    assert rc == 0
    assert "failed" in err.lower() and "unknown flag" in err
    assert "127.0.0.1:8905" in err


def test_status_changes_nothing(tmp_path):
    """--status reads the route and sets nothing up."""
    fake = tmp_path / "bin"
    fake_tailscale(fake)
    rc, out, err = run(tmp_path, fake, "--status")
    assert rc == 0, err
    assert "tailnet only" in out
    assert not [c for c in calls(fake) if "--bg" in c]
    assert_never_funnel(fake)


def test_ports_come_from_the_settings(tmp_path):
    fake = tmp_path / "bin"
    fake_tailscale(fake)
    rc, out, err = run(tmp_path, fake, env_extra={
        "WOODCHUCK_PORT": "8970", "WOODCHUCK_TAILSCALE_PORT": "9445"})
    assert rc == 0, err
    assert "serve --bg --https=9445 http://127.0.0.1:8970" in calls(fake)
    assert f"https://{DNS}:9445/" in out


def test_a_named_command_is_used_when_path_has_none(tmp_path):
    """The Mac case: the command is inside the app, named in .env."""
    elsewhere = tmp_path / "elsewhere"
    fake_tailscale(elsewhere)
    rc, out, err = run(tmp_path, None,
                       env_extra={"WOODCHUCK_TAILSCALE_BIN": str(elsewhere / "tailscale")})
    assert rc == 0, err
    assert "serve --bg --https=8445 http://127.0.0.1:8905" in calls(elsewhere)
    assert_never_funnel(elsewhere)


def test_settings_come_from_env_beside_the_app_when_unset(tmp_path):
    """Run by hand, it reads its settings from .env, as Woodchuck does."""
    elsewhere = tmp_path / "elsewhere"
    fake_tailscale(elsewhere)
    (tmp_path / "app").mkdir(exist_ok=True)
    (tmp_path / "app" / ".env").write_text(
        f'WOODCHUCK_TAILSCALE_BIN="{elsewhere / "tailscale"}"\nWOODCHUCK_TAILSCALE_PORT=9445\n')
    rc, out, err = run(tmp_path, None)
    assert rc == 0, err
    assert "serve --bg --https=9445 http://127.0.0.1:8905" in calls(elsewhere)


def test_a_named_command_that_cannot_run_is_ignored(tmp_path):
    dud = tmp_path / "dud"
    dud.write_text("#!/bin/sh\nexit 0\n")
    rc, out, err = run(tmp_path, None, env_extra={"WOODCHUCK_TAILSCALE_BIN": str(dud)})
    assert rc == 0 and "SKIPPED" in err


def test_the_script_never_runs_funnel():
    """Read statically too: "funnel" shows up only in comments, in
    warnings and in the check that reads the status, never as a command."""
    for i, line in enumerate(SCRIPT.read_text().splitlines(), 1):
        if "funnel" not in line.lower():
            continue
        s = line.strip()
        allowed = s.startswith("#") or s.startswith("warn ") or "grep" in s
        assert allowed, f"line {i} mentions funnel outside a comment, warning or check:\n{line}"
    assert '"$TS_BIN" funnel' not in SCRIPT.read_text()


def test_the_command_is_never_guessed():
    """PATH or WOODCHUCK_TAILSCALE_BIN only. The Mac app's path appears in
    a warning, never as a value the script runs."""
    for i, line in enumerate(SCRIPT.read_text().splitlines(), 1):
        if "/Applications/" in line:
            s = line.strip()
            assert s.startswith("#") or s.startswith("warn "), f"line {i}: {line}"
    assert 'TS_BIN="/Applications' not in SCRIPT.read_text()


def test_start_runs_it_only_when_asked_and_never_stops_on_it():
    """start.sh calls it behind WOODCHUCK_TAILSCALE_SERVE=1, and a failure
    there never stops Woodchuck starting."""
    start = (REPO / "start.sh").read_text()
    idx = start.index("scripts/tailscale-serve.sh")
    guard = start.rfind("if ", 0, idx)
    assert 'setting WOODCHUCK_TAILSCALE_SERVE)" = "1"' in start[guard:idx]
    line = start[start.rfind("\n", 0, idx):start.find("\n", idx)]
    assert "|| true" in line
    assert line.startswith("\n    ") or line.startswith("\n  ")
    assert start.index("tailscale-serve.sh") < start.index("exec ")
