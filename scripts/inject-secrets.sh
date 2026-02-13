#!/bin/bash
# inject-secrets.sh - Inject secrets to file/env/systemd targets
# Usage: ./inject-secrets.sh <secrets.json>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SECRETS_FILE="${1:-}"
BACKUP_DIR="$HOME/.amcp/backups/$(date +%Y%m%d-%H%M%S)"
AGENT_NAME="${AGENT_NAME:-ClaudiusThePirateEmperor}"

if [ -z "$SECRETS_FILE" ] || [ ! -f "$SECRETS_FILE" ]; then
  echo "Usage: $0 <secrets.json>"
  exit 1
fi

# Validate JSON before processing
if ! python3 -c "import json; json.load(open('$SECRETS_FILE'))" 2>/dev/null; then
  echo "ERROR: $SECRETS_FILE is not valid JSON"
  exit 1
fi

mkdir -p "$BACKUP_DIR"

"$SCRIPT_DIR/notify.sh" "🔄 [$AGENT_NAME] Injecting secrets..."

echo "=== Inject Secrets ==="
echo "Source: $SECRETS_FILE"
echo "Backup: $BACKUP_DIR"

# Process secrets with Python
python3 << EOF
import json
import os
import shutil
from pathlib import Path

secrets = json.load(open("$SECRETS_FILE"))
backup_dir = "$BACKUP_DIR"
modified_files = set()
systemd_modified = False
env_lines = []

for secret in secrets:
    key = secret["key"]
    value = secret["value"]
    targets = secret.get("targets", [])
    
    for target in targets:
        kind = target["kind"]
        
        if kind == "file":
            path = os.path.expanduser(target["path"])
            json_path = target.get("jsonPath", "")
            
            if not os.path.exists(path):
                print(f"[SKIP] File not found: {path}")
                continue
            
            # Backup if not already backed up
            if path not in modified_files:
                backup_path = os.path.join(backup_dir, os.path.basename(path))
                shutil.copy2(path, backup_path)
                print(f"[BACKUP] {path} -> {backup_path}")
                modified_files.add(path)
            
            # Update JSON file
            with open(path) as f:
                data = json.load(f)
            
            # Navigate to jsonPath and set value
            parts = json_path.split(".")
            obj = data
            for part in parts[:-1]:
                if part not in obj:
                    obj[part] = {}
                obj = obj[part]
            obj[parts[-1]] = value
            
            with open(path, "w") as f:
                json.dump(data, f, indent=2)
            
            print(f"[FILE] {key} -> {path}:{json_path}")
        
        elif kind == "env":
            name = target.get("name", key)
            env_lines.append(f'export {name}="{value}"')
            print(f"[ENV] {name}")
        
        elif kind == "systemd":
            service = target.get("service", "openclaw-gateway")
            name = target.get("name", key)
            # Note: systemd env injection requires sudo, just log for now
            print(f"[SYSTEMD] {name} for {service} (manual injection needed)")
            systemd_modified = True

# Write env vars to bashrc if any
if env_lines:
    bashrc = os.path.expanduser("~/.bashrc")
    marker_start = "# AMCP-SECRETS-START"
    marker_end = "# AMCP-SECRETS-END"
    
    # Backup bashrc
    if bashrc not in modified_files:
        backup_path = os.path.join(backup_dir, ".bashrc")
        shutil.copy2(bashrc, backup_path)
        print(f"[BACKUP] {bashrc} -> {backup_path}")
    
    # Read current bashrc
    with open(bashrc) as f:
        content = f.read()
    
    # Remove old AMCP section if exists
    if marker_start in content:
        start = content.index(marker_start)
        end = content.index(marker_end) + len(marker_end)
        content = content[:start] + content[end:]
    
    # Add new AMCP section
    amcp_section = f"\n{marker_start}\n" + "\n".join(env_lines) + f"\n{marker_end}\n"
    content = content.rstrip() + amcp_section
    
    with open(bashrc, "w") as f:
        f.write(content)
    
    print(f"[ENV] Updated ~/.bashrc with {len(env_lines)} vars")

if systemd_modified:
    print("[NOTE] Systemd services may need: sudo systemctl daemon-reload && sudo systemctl restart <service>")

print(f"\nInjected {len(secrets)} secrets")
EOF

"$SCRIPT_DIR/notify.sh" "✅ [$AGENT_NAME] Secrets injected"

echo "=== Done ==="
