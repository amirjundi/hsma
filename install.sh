#!/usr/bin/env bash
#
# AnkEdo -- install on Linux or macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/amirjundi/ankedo-agent/master/install.sh | bash
#
# AnkEdo is an agent, not a plugin: this builds and installs it directly. There is no
# separate host to install first and nothing to register afterwards -- the domain code
# lives in extensions/ankedo-domain inside this repository, and the monitoring persona
# is the bundled workspace template, so a fresh workspace comes up as a monitor rather
# than a personal assistant.

set -euo pipefail

BOLD=$'\033[1m'; DIM=$'\033[2m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; NC=$'\033[0m'
step() { printf '\n%s> %s%s\n' "$BOLD" "$1" "$NC"; }
ok()   { printf '  %s+%s %s\n' "$GREEN" "$NC" "$1"; }
warn() { printf '  %s!%s %s\n' "$YELLOW" "$NC" "$1"; }
die()  { printf '  %sx%s %s\n' "$RED" "$NC" "$1"; exit 1; }

REPO="https://github.com/amirjundi/ankedo-agent.git"
DIR="${ANKEDO_DIR:-$HOME/ankedo}"

printf '\n%s  AnkEdo -- hate-speech monitoring agent%s\n' "$BOLD" "$NC"

# -- Node --------------------------------------------------------------------
step "Checking Node"
command -v node >/dev/null 2>&1 || die "Node is not installed. AnkEdo needs >=22.22.3 <23, >=24.15 <25, or >=25.9."

NODE_VERSION="$(node --version | sed 's/^v//')"
# The supported range is a disjunction, not a floor: 23.x and 25.0-25.8 are excluded
# even though they are numerically higher than 22.22.3. Comparing against the lowest
# supported version would wave through 24.11, which fails later during the build.
node -e '
const [maj, min, pat] = process.versions.node.split(".").map(Number);
const ge = (a, b, c) => maj > a || (maj === a && (min > b || (min === b && pat >= c)));
const ok = (maj === 22 && ge(22, 22, 3)) || (maj === 24 && ge(24, 15, 0)) || ge(25, 9, 0);
process.exit(ok ? 0 : 1);
' || die "Node $NODE_VERSION is not supported. Need >=22.22.3 <23, >=24.15 <25, or >=25.9.
      nvm:  nvm install 24 && nvm use 24
      apt:  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs"
ok "Node $NODE_VERSION"

# -- pnpm --------------------------------------------------------------------
# The repository is a pnpm workspace. Plain `npm install` at the root is not supported
# and fails in ways that look like a broken repository rather than a missing tool.
step "Checking pnpm"
if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version)"
elif command -v corepack >/dev/null 2>&1 && corepack enable pnpm >/dev/null 2>&1; then
  ok "pnpm enabled via corepack"
else
  npm install -g pnpm >/dev/null 2>&1 || die "could not install pnpm. Install it, then rerun:
      npm install -g pnpm"
  ok "pnpm installed"
fi

# -- Source ------------------------------------------------------------------
step "Fetching AnkEdo"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only 2>&1 | tail -1
  ok "updated $DIR"
else
  git clone --depth 1 "$REPO" "$DIR" 2>&1 | tail -1
  ok "cloned to $DIR"
fi
cd "$DIR"

# -- Build -------------------------------------------------------------------
# This takes a while. It builds the agent and the domain extension together, because
# extensions/* is part of the workspace.
step "Building (this takes several minutes)"
pnpm install 2>&1 | tail -3 || die "pnpm install failed in $DIR"
pnpm build 2>&1 | tail -5 || die "build failed"
ok "built"

# -- Install the command -----------------------------------------------------
step "Installing the ankedo command"
# sudo -n, never plain sudo: run as `curl ... | bash` this script is stdin, so a
# password prompt has no terminal to read from and would hang at the last step of an
# otherwise finished install.
if npm install -g . >/dev/null 2>&1; then
  ok "$(command -v ankedo || echo ankedo)"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null && sudo -n npm install -g . >/dev/null 2>&1; then
  ok "$(command -v ankedo || echo ankedo)"
else
  warn "could not install globally without a password. Run one of these yourself:"
  printf '  %s  sudo npm install -g %s%s\n' "$DIM" "$DIR" "$NC"
  printf '  %s  npm config set prefix ~/.npm-global && npm install -g %s%s\n' "$DIM" "$DIR" "$NC"
fi

# -- Browser, optional -------------------------------------------------------
step "Checking the browser"
if node -e "require.resolve('camoufox')" >/dev/null 2>&1; then
  ok "Camoufox present"
else
  warn "Camoufox not installed -- classification works, collection does not."
  printf '  %sTo enable collection:%s\n' "$DIM" "$NC"
  printf '  %s  cd %s/extensions/ankedo-domain && npm install camoufox && npx camoufox fetch%s\n' "$DIM" "$DIR" "$NC"
  printf '  %s  ankedo config set plugins.entries.browser.enabled false%s\n' "$DIM" "$NC"
  printf '  %s(The bundled browser drives Chromium over CDP with no anti-detection,%s\n' "$DIM" "$NC"
  printf '  %s which is what gets worker accounts banned. Camoufox replaces it.)%s\n' "$DIM" "$NC"
fi

# -- Done --------------------------------------------------------------------
cat <<EOF

$BOLD  Installed.$NC

  ${DIM}ankedo onboard$NC   configure a model provider and seed the workspace

  Then point it at the platform:

    ${DIM}ankedo config set plugins.entries.ankedo.config.platformUrl https://ettok.net/api/hermes/
    ankedo config set plugins.entries.ankedo.config.agentKey <key with the hate_speech_scan scope>
    ankedo config set plugins.entries.ankedo.config.agentId ankedo-\$(hostname)
    ankedo config set plugins.entries.ankedo.config.databasePath \$HOME/.ankedo/evidence.db$NC

  ${DIM}agentId is not optional in practice: the platform scopes idempotency on
  (agent_id, key), so two machines omitting it share a namespace and one
  silently replays the other's response.$NC

  Then:

    ${DIM}ankedo gateway run      start the agent and its dashboard
    ankedo plugins list     confirm the ankedo tools are enabled$NC

  State lives in ~/.ankedo.

EOF
