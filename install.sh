#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROVIDERS_DIR="$SCRIPT_DIR/providers"
TEMPLATES_DIR="$SCRIPT_DIR/templates/provider-template"
BACKUP_DIR="$SCRIPT_DIR/.backup-original"

find_node_bin() {
  if [[ -n "${NODE_BIN:-}" && -x "${NODE_BIN}" ]]; then
    echo "${NODE_BIN}"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  local candidates=(
    "$HOME/.nvm/versions/node"/*/bin/node
    "/usr/local/app/.nvm/versions/node"/*/bin/node
    "$HOME/.volta/bin/node"
    "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node
    "/opt/homebrew/bin/node"
    "/usr/local/bin/node"
  )
  local found=""
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      found="$candidate"
    fi
  done
  if [[ -n "$found" ]]; then
    echo "$found"
    return 0
  fi
  return 1
}

find_paseo_bin() {
  if [[ -n "${PASEO_BIN:-}" && -x "${PASEO_BIN}" ]]; then
    echo "${PASEO_BIN}"
    return 0
  fi
  if command -v paseo >/dev/null 2>&1; then
    command -v paseo
    return 0
  fi
  local node_dir
  node_dir="$(dirname "$1")"
  if [[ -x "$node_dir/paseo" ]]; then
    echo "$node_dir/paseo"
    return 0
  fi
  local candidates=(
    "$HOME/.nvm/versions/node"/*/bin/paseo
    "/usr/local/app/.nvm/versions/node"/*/bin/paseo
    "$HOME/.volta/bin/paseo"
    "/opt/homebrew/bin/paseo"
    "/usr/local/bin/paseo"
  )
  local found=""
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      found="$candidate"
    fi
  done
  if [[ -n "$found" ]]; then
    echo "$found"
    return 0
  fi
  return 1
}

resolve_paseo_server_dir() {
  if [[ -n "${PASEO_SERVER_DIR:-}" ]]; then
    if [[ -d "${PASEO_SERVER_DIR}/builtin-plugins" ]]; then
      echo "${PASEO_SERVER_DIR}"
      return 0
    fi
    echo "Error: PASEO_SERVER_DIR=${PASEO_SERVER_DIR} does not contain builtin-plugins/" >&2
    return 1
  fi

  local node_bin="$1"
  local paseo_bin="${2:-}"

  if [[ -n "$paseo_bin" ]]; then
    local resolved
    resolved="$("$node_bin" -e '
      import fs from "node:fs";
      import path from "node:path";
      const binPath = fs.realpathSync(process.argv[1]);
      let dir = path.dirname(binPath);
      for (let i = 0; i < 6; i++) {
        const candidates = [
          path.join(dir, "node_modules", "@getpaseo", "server", "dist", "server"),
          path.join(dir, "@getpaseo", "server", "dist", "server"),
          path.join(dir, "server", "dist", "server"),
        ];
        for (const c of candidates) {
          if (fs.existsSync(path.join(c, "builtin-plugins"))) {
            console.log(c);
            process.exit(0);
          }
        }
        dir = path.dirname(dir);
      }
      process.exit(1);
    ' "$paseo_bin" 2>/dev/null || true)"
    if [[ -n "$resolved" && -d "$resolved" ]]; then
      echo "$resolved"
      return 0
    fi
  fi

  local global_root
  global_root="$(dirname "$(dirname "$node_bin")")/lib/node_modules"
  local fallback="$global_root/@getpaseo/cli/node_modules/@getpaseo/server/dist/server"
  if [[ -d "$fallback/builtin-plugins" ]]; then
    echo "$fallback"
    return 0
  fi

  return 1
}

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [--all] [--restart]                  Install all providers in providers/*
  ./install.sh <provider-dir> [...] [--restart]     Install specific provider(s)
  ./install.sh --list                               List all providers in this repo & status
  ./install.sh --new <plugin-id> [provider-id] [cli] Scaffold a new provider under providers/<plugin-id>
  ./install.sh --uninstall [provider-dir]           Restore original Paseo files from .backup-original/

Examples:
  ./install.sh --all --restart
  ./install.sh antigravity-provider --restart
  ./install.sh --new deepseek-provider deepseek deepseek-cli
EOF
}

ACTION="install"
RESTART_DAEMON=false
SELECTED_PROVIDERS=()
NEW_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all)
      shift
      ;;
    --restart)
      RESTART_DAEMON=true
      shift
      ;;
    --list|-l)
      ACTION="list"
      shift
      ;;
    --uninstall|--restore)
      ACTION="uninstall"
      shift
      ;;
    --new)
      ACTION="new"
      shift
      while [[ $# -gt 0 ]]; do
        NEW_ARGS+=("$1")
        shift
      done
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      SELECTED_PROVIDERS+=("$1")
      shift
      ;;
  esac
done

if [[ "$ACTION" == "new" ]]; then
  PLUGIN_ID="${NEW_ARGS[0]:-}"
  if [[ -z "$PLUGIN_ID" ]]; then
    echo "Error: --new requires <plugin-id> (e.g. ./install.sh --new my-agent-provider my-agent my-cli)" >&2
    exit 1
  fi
  PROVIDER_ID="${NEW_ARGS[1]:-${PLUGIN_ID%-provider}}"
  CLI_CMD="${NEW_ARGS[2]:-$PROVIDER_ID}"
  PROVIDER_LABEL="$(tr '[:lower:]' '[:upper:]' <<< "${PROVIDER_ID:0:1}")${PROVIDER_ID:1}"
  DEST_DIR="$PROVIDERS_DIR/$PLUGIN_ID"
  if [[ -e "$DEST_DIR" ]]; then
    echo "Error: $DEST_DIR already exists." >&2
    exit 1
  fi
  mkdir -p "$DEST_DIR/server"
  cp "$TEMPLATES_DIR/icon.svg" "$DEST_DIR/icon.svg"
  sed \
    -e "s/__PLUGIN_ID__/$PLUGIN_ID/g" \
    -e "s/__PROVIDER_ID__/$PROVIDER_ID/g" \
    -e "s/__PROVIDER_LABEL__/$PROVIDER_LABEL/g" \
    -e "s/__CLI_CMD__/$CLI_CMD/g" \
    "$TEMPLATES_DIR/paseo-plugin.json" > "$DEST_DIR/paseo-plugin.json"
  sed \
    -e "s/__PLUGIN_ID__/$PLUGIN_ID/g" \
    -e "s/__PROVIDER_ID__/$PROVIDER_ID/g" \
    -e "s/__PROVIDER_LABEL__/$PROVIDER_LABEL/g" \
    -e "s/__CLI_CMD__/$CLI_CMD/g" \
    "$TEMPLATES_DIR/index.server.ts" > "$DEST_DIR/index.server.ts"
  sed \
    -e "s/__PLUGIN_ID__/$PLUGIN_ID/g" \
    -e "s/__PROVIDER_ID__/$PROVIDER_ID/g" \
    -e "s/__PROVIDER_LABEL__/$PROVIDER_LABEL/g" \
    -e "s/__CLI_CMD__/$CLI_CMD/g" \
    "$TEMPLATES_DIR/server/provider.ts" > "$DEST_DIR/server/provider.ts"
  sed \
    -e "s/__PLUGIN_ID__/$PLUGIN_ID/g" \
    -e "s/__PROVIDER_ID__/$PROVIDER_ID/g" \
    -e "s/__PROVIDER_LABEL__/$PROVIDER_LABEL/g" \
    -e "s/__CLI_CMD__/$CLI_CMD/g" \
    "$TEMPLATES_DIR/server/usage.ts" > "$DEST_DIR/server/usage.ts"
  echo "Created new provider scaffold at: $DEST_DIR"
  echo "Next steps:"
  echo "  1. Edit $DEST_DIR/server/provider.ts and $DEST_DIR/server/usage.ts"
  echo "  2. Run ./install.sh $PLUGIN_ID --restart"
  exit 0
fi

NODE_BIN="$(find_node_bin || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Error: Could not find 'node' executable. Set NODE_BIN=/path/to/node and retry." >&2
  exit 1
fi

PASEO_BIN="$(find_paseo_bin "$NODE_BIN" || true)"
PASEO_SERVER_DIR="$(resolve_paseo_server_dir "$NODE_BIN" "$PASEO_BIN" || true)"
if [[ -z "$PASEO_SERVER_DIR" ]]; then
  echo "Error: Could not auto-detect @getpaseo/server directory." >&2
  echo "Set PASEO_SERVER_DIR=/path/to/@getpaseo/server/dist/server and retry." >&2
  exit 1
fi

if [[ "$ACTION" == "list" ]]; then
  echo "Node binary:      $NODE_BIN"
  echo "Paseo Server dir: $PASEO_SERVER_DIR"
  echo ""
  printf "%-28s %-15s %s\n" "PROVIDER PLUGIN ID" "STATUS" "SOURCE PATH"
  printf "%-28s %-15s %s\n" "----------------------------" "---------------" "-----------"
  for dir in "$PROVIDERS_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    id="$(basename "$dir")"
    target="$PASEO_SERVER_DIR/builtin-plugins/$id"
    if [[ -d "$target" ]]; then
      status="installed"
    else
      status="not-installed"
    fi
    printf "%-28s %-15s %s\n" "$id" "$status" "providers/$id"
  done
  exit 0
fi

if [[ ${#SELECTED_PROVIDERS[@]} -eq 0 ]]; then
  for dir in "$PROVIDERS_DIR"/*/; do
    [[ -d "$dir" ]] || continue
    SELECTED_PROVIDERS+=("$(basename "$dir")")
  done
fi

if [[ "$ACTION" == "uninstall" ]]; then
  if [[ ! -d "$BACKUP_DIR" ]]; then
    echo "Error: No backup directory found at $BACKUP_DIR" >&2
    exit 1
  fi
  for id in "${SELECTED_PROVIDERS[@]}"; do
    target="$PASEO_SERVER_DIR/builtin-plugins/$id"
    if [[ -d "$BACKUP_DIR/builtin-plugins/$id" ]]; then
      rm -rf "$target"
      cp -r "$BACKUP_DIR/builtin-plugins/$id" "$target"
      echo "  ✓ Restored original builtin-plugins/$id"
    elif [[ -f "$BACKUP_DIR/created-$id" ]]; then
      rm -rf "$target"
      echo "  ✓ Removed custom builtin-plugins/$id"
    fi
  done
  if [[ -f "$BACKUP_DIR/plugin-provider.js" ]]; then
    cp "$BACKUP_DIR/plugin-provider.js" "$PASEO_SERVER_DIR/server/agent/plugin-provider.js"
    echo "  ✓ Restored server/agent/plugin-provider.js"
  fi
  if [[ -f "$BACKUP_DIR/builtin-index.js" ]]; then
    cp "$BACKUP_DIR/builtin-index.js" "$PASEO_SERVER_DIR/server/plugins/builtin/index.js"
    echo "  ✓ Restored server/plugins/builtin/index.js"
  fi
  echo "Restore complete. Run 'paseo restart' to reload."
  exit 0
fi

echo "Using Node:         $NODE_BIN"
echo "Using Paseo Server: $PASEO_SERVER_DIR"

mkdir -p "$BACKUP_DIR/builtin-plugins"
if [[ ! -f "$BACKUP_DIR/plugin-provider.js" && -f "$PASEO_SERVER_DIR/server/agent/plugin-provider.js" ]]; then
  cp "$PASEO_SERVER_DIR/server/agent/plugin-provider.js" "$BACKUP_DIR/plugin-provider.js"
fi
if [[ ! -f "$BACKUP_DIR/builtin-index.js" && -f "$PASEO_SERVER_DIR/server/plugins/builtin/index.js" ]]; then
  cp "$PASEO_SERVER_DIR/server/plugins/builtin/index.js" "$BACKUP_DIR/builtin-index.js"
fi

echo "[1/3] Installing provider plugins (${SELECTED_PROVIDERS[*]}) ..."
for id in "${SELECTED_PROVIDERS[@]}"; do
  src_dir="$PROVIDERS_DIR/$id"
  if [[ ! -d "$src_dir" ]]; then
    echo "Error: Provider directory not found: $src_dir" >&2
    exit 1
  fi
  target_dir="$PASEO_SERVER_DIR/builtin-plugins/$id"
  if [[ -d "$target_dir" && ! -d "$BACKUP_DIR/builtin-plugins/$id" && ! -f "$BACKUP_DIR/created-$id" ]]; then
    cp -r "$target_dir" "$BACKUP_DIR/builtin-plugins/$id"
  elif [[ ! -d "$target_dir" && ! -d "$BACKUP_DIR/builtin-plugins/$id" ]]; then
    touch "$BACKUP_DIR/created-$id"
  fi
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  cp -r "$src_dir"/. "$target_dir"/
  echo "  + Deployed providers/$id -> builtin-plugins/$id"
done

echo "[2/3] Applying core patches & verifying plugin compilation ..."
"$NODE_BIN" "$SCRIPT_DIR/patches/apply-core-patches.mjs" "$PASEO_SERVER_DIR" "${SELECTED_PROVIDERS[@]}"

if [[ "$RESTART_DAEMON" == "true" && -n "$PASEO_BIN" ]]; then
  echo "[3/3] Restarting Paseo daemon via $PASEO_BIN restart ..."
  PATH="$(dirname "$NODE_BIN"):$PATH" "$PASEO_BIN" restart
else
  echo "[3/3] Done! Run 'paseo restart' (or './install.sh --restart') to reload the Paseo daemon."
fi
