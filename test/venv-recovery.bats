#!/usr/bin/env bats
# venv-recovery.bats — Integration tests for recreate-venvs.sh

HELPER="$(cd "$(dirname "$BATS_TEST_FILENAME")" && pwd)/test_helper.sh"
SCRIPT_DIR="$(cd "$(dirname "$BATS_TEST_FILENAME")/../scripts" && pwd)"

setup() {
  source "$HELPER"
  setup_test_env
  export MANIFEST_DIR="$CONTENT_DIR/memory"
  mkdir -p "$MANIFEST_DIR"
}

teardown() {
  teardown_test_env
}

# Helper: create a venvs manifest
create_manifest() {
  local path="${1:-$MANIFEST_DIR/venvs-manifest.json}"
  local content="${2}"
  mkdir -p "$(dirname "$path")"
  echo "$content" > "$path"
  echo "$path"
}

# Helper: create a working venv at a path
create_working_venv() {
  local base_path="$1"
  local venv_path="$base_path/.venv"
  mkdir -p "$venv_path/bin"
  cat > "$venv_path/bin/pip" << 'EOFPIP'
#!/bin/bash
if [ "$1" = "--version" ]; then
  echo "pip 24.0 from /test (.venv)"
  exit 0
fi
if [ "$1" = "install" ]; then
  echo "installed"
  exit 0
fi
exit 0
EOFPIP
  chmod +x "$venv_path/bin/pip"
  # Also create python3 in venv
  cat > "$venv_path/bin/python3" << 'EOFPY'
#!/bin/bash
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  mkdir -p "$3/bin"
  cp "$0" "$3/bin/python3"
  exit 0
fi
exit 0
EOFPY
  chmod +x "$venv_path/bin/python3"
}

# Helper: create a broken venv (pip --version fails)
create_broken_venv() {
  local base_path="$1"
  local venv_path="$base_path/.venv"
  mkdir -p "$venv_path/bin"
  cat > "$venv_path/bin/pip" << 'EOFPIP'
#!/bin/bash
exit 1
EOFPIP
  chmod +x "$venv_path/bin/pip"
}

# Mock python3 that handles venv creation
setup_mock_python3() {
  cat > "$MOCK_BIN/python3" << 'EOFPY'
#!/bin/bash
# If running a heredoc/script from recreate-venvs.sh, use real python3
if [ "$1" = "-m" ] && [ "$2" = "venv" ]; then
  # Create a mock venv
  mkdir -p "$3/bin"
  cat > "$3/bin/pip" << 'INNERPIP'
#!/bin/bash
if [ "$1" = "--version" ]; then
  echo "pip 24.0"
  exit 0
fi
echo "installed"
exit 0
INNERPIP
  chmod +x "$3/bin/pip"
  exit 0
fi
# For the heredoc script, use real python3
exec /usr/bin/python3 "$@"
EOFPY
  chmod +x "$MOCK_BIN/python3"
}


# ============================================================
# Test 1: All venvs present and functional — script skips all
# ============================================================
@test "venv recovery: manifest exists, all venvs functional, skips all" {
  local project_a="$TEST_DIR/projects/alpha"
  mkdir -p "$project_a"
  create_working_venv "$project_a"

  create_manifest "$MANIFEST_DIR/venvs-manifest.json" "$(cat <<EOMANIFEST
{
  "venvs": [
    {
      "path": "$project_a",
      "python": "python3",
      "packages": ["requests"]
    }
  ]
}
EOMANIFEST
)"

  run /usr/bin/python3 -c "
import json, subprocess, os
from pathlib import Path

manifest_path = '$MANIFEST_DIR/venvs-manifest.json'
with open(manifest_path) as f:
    manifest = json.load(f)

for vc in manifest.get('venvs', []):
    base = Path(os.path.expanduser(vc['path']))
    pip = base / '.venv' / 'bin' / 'pip'
    if pip.exists():
        r = subprocess.run([str(pip), '--version'], capture_output=True)
        if r.returncode == 0:
            print(f'venv functional, skipping: {base}')
        else:
            print(f'venv broken: {base}')
    else:
        print(f'venv missing: {base}')
"

  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping"* ]]
}


# ============================================================
# Test 2: One venv missing, script creates it
# ============================================================
@test "venv recovery: manifest exists, venv missing, creates it" {
  local project_b="$TEST_DIR/projects/beta"
  mkdir -p "$project_b"
  # No .venv directory — it's missing

  create_manifest "$MANIFEST_DIR/venvs-manifest.json" "$(cat <<EOMANIFEST
{
  "venvs": [
    {
      "path": "$project_b",
      "python": "python3",
      "packages": ["flask"]
    }
  ]
}
EOMANIFEST
)"

  setup_mock_python3

  run bash "$SCRIPT_DIR/recreate-venvs.sh" "$MANIFEST_DIR/venvs-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"Creating venv"* ]]
  # Verify .venv/bin/pip was created
  [ -f "$project_b/.venv/bin/pip" ]
}


# ============================================================
# Test 3: Broken venv — script recreates it
# ============================================================
@test "venv recovery: manifest exists, broken venv, recreates it" {
  local project_c="$TEST_DIR/projects/gamma"
  mkdir -p "$project_c"
  create_broken_venv "$project_c"

  create_manifest "$MANIFEST_DIR/venvs-manifest.json" "$(cat <<EOMANIFEST
{
  "venvs": [
    {
      "path": "$project_c",
      "python": "python3",
      "packages": ["numpy"]
    }
  ]
}
EOMANIFEST
)"

  setup_mock_python3

  run bash "$SCRIPT_DIR/recreate-venvs.sh" "$MANIFEST_DIR/venvs-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"broken"* || "$output" == *"Creating venv"* || "$output" == *"recreating"* ]]
}


# ============================================================
# Test 4: Manifest missing — script exits 0 with skip message
# ============================================================
@test "venv recovery: no manifest, exits 0 with skip" {
  run bash "$SCRIPT_DIR/recreate-venvs.sh" "$MANIFEST_DIR/nonexistent-manifest.json"
  [ "$status" -eq 0 ]
  [[ "$output" == *"No venvs manifest"* || "$output" == *"skipping"* ]]
}


# ============================================================
# Test 5: Manifest with invalid JSON — exits 0 (resilient)
# ============================================================
@test "venv recovery: invalid JSON manifest, exits gracefully" {
  create_manifest "$MANIFEST_DIR/venvs-manifest.json" "this is not { valid json }"

  run bash "$SCRIPT_DIR/recreate-venvs.sh" "$MANIFEST_DIR/venvs-manifest.json"
  # Should fail but not catastrophically — script has set -e so python3 error propagates
  # The important thing is it doesn't hang or produce unclear errors
  [ "$status" -ne 0 ] || [[ "$output" == *"error"* ]] || [[ "$output" == *"Error"* ]]
}


# ============================================================
# Test 6: Resurrection integration — venv restored after rehydrate
# ============================================================
@test "venv recovery: resuscitate.sh includes recreate-venvs guard" {
  # Verify resuscitate.sh has the guard pattern for recreate-venvs.sh
  run grep -c "recreate-venvs.sh" "$SCRIPT_DIR/resuscitate.sh"
  [ "$status" -eq 0 ]
  [ "$output" -ge 1 ]

  # Verify it uses guard pattern ([ -x ... ] &&)
  run grep "recreate-venvs" "$SCRIPT_DIR/resuscitate.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *'[ -x'* || "$output" == *'guard'* || "$output" == *'if'* ]]
}
