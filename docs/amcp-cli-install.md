# Installing the AMCP CLI on Child VMs

The `amcp` CLI provides cryptographic identity management and checkpoint operations for the AMCP protocol. It is installed from the GitHub repository (not the npm registry).

## Prerequisites

- Node.js >= 20 (recommend 22 LTS)
- npm (comes with Node.js)
- git

## Install

```bash
npm install -g github:fcavalcantirj/amcp-protocol
```

This installs the `amcp` binary globally. Verify with:

```bash
amcp --help
```

## What it does

npm clones the repo, runs `npm install` (which fetches `tsx` and `@noble/ed25519`), and symlinks `scripts/amcp` into your global bin directory. The wrapper script resolves paths relative to the installed package, so it works regardless of where npm places global packages (`/usr/local/bin/`, `/usr/bin/`, etc.).

## Core commands

```bash
# Create a new KERI identity
amcp identity create --out ~/.amcp/identity.json

# Create with a deterministic seed (for fleet deployments)
amcp identity create --seed "$(openssl rand -hex 32)" --out ~/.amcp/identity.json

# Validate an existing identity
amcp identity validate --path ~/.amcp/identity.json

# Show identity details
amcp identity show --identity ~/.amcp/identity.json

# Create an encrypted checkpoint
amcp checkpoint create \
  --content ~/.openclaw/workspace \
  --secrets ~/.amcp/secrets.json \
  --out ~/.amcp/checkpoints/

# Verify a checkpoint
amcp verify --checkpoint ~/.amcp/checkpoints/<cid>.json

# Restore from a checkpoint
amcp resuscitate \
  --checkpoint ~/.amcp/checkpoints/<cid>.json \
  --identity ~/.amcp/identity.json \
  --out-content ~/.openclaw/workspace \
  --out-secrets ~/.amcp/secrets-restored.json
```

## How proactive-amcp finds it

All proactive-amcp scripts locate the `amcp` binary using:

```bash
AMCP_CLI="${AMCP_CLI:-$(command -v amcp 2>/dev/null || echo "$HOME/bin/amcp")}"
```

Resolution order:
1. `$AMCP_CLI` environment variable (explicit override)
2. `amcp` on `$PATH` (npm global install)
3. `$HOME/bin/amcp` (manual/legacy installs)

## Upgrading

```bash
npm install -g github:fcavalcantirj/amcp-protocol
```

Same command as install -- npm replaces the existing version.

## Uninstalling

```bash
npm uninstall -g amcp-protocol
```

## Troubleshooting

**`amcp: command not found` after install**

npm's global bin directory may not be on your PATH. Check with:
```bash
npm config get prefix
# Add <prefix>/bin to PATH if missing
```

**`tsx: not found` errors**

The `tsx` runtime should be installed as a dependency of the package. Reinstall:
```bash
npm install -g github:fcavalcantirj/amcp-protocol
```

**Permission errors on global install**

If running as non-root, either use `sudo` or configure npm to use a user-local prefix:
```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
```
