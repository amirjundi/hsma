#!/usr/bin/env bash
#
# HSMA -- Hate Speech Monitoring Agent. Install on Linux or macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/amirjundi/hsma/main/install.sh | bash
#
# HSMA is an agent, not a plugin: this builds and installs it directly. There is no
# separate host to install first and nothing to register afterwards -- the judgement
# lives in extensions/hsma-domain inside this repository, and the monitoring persona
# is the bundled workspace template, so a fresh workspace comes up as a monitor.

set -euo pipefail

# Phosphor green, matching the Control UI theme and packages/terminal-core palette.
# Truecolor when the terminal advertises it, 8-colour otherwise: a terminal that does
# not understand 38;2 prints the escape as literal text across every line.
if [ -n "${NO_COLOR:-}" ] || [ ! -t 1 ]; then
  B=''; D=''; G=''; Y=''; R=''; C=''; N=''
elif [ "${COLORTERM:-}" = "truecolor" ] || [ "${COLORTERM:-}" = "24bit" ]; then
  B=$'\033[1m'; D=$'\033[38;2;111;130;121m'; G=$'\033[38;2;47;224;122m'
  Y=$'\033[38;2;255;176;32m'; R=$'\033[38;2;226;61;45m'; C=$'\033[38;2;124;255;175m'
  N=$'\033[0m'
else
  B=$'\033[1m'; D=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; C=$'\033[92m'; N=$'\033[0m'
fi
step()  { printf '\n%s%s%s\n' "$B" "$1" "$N"; }
ok()    { printf '  %s+%s %s\n' "$G" "$N" "$1"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
info()  { printf '  %s%s%s\n' "$D" "$1" "$N"; }
die()   { printf '  %sx%s %s\n' "$R" "$N" "$1"; exit 1; }

REPO="https://github.com/amirjundi/hsma.git"
DIR="${HSMA_DIR:-$HOME/hsma}"

printf '\n'
printf '%s  HSMA%s  Hate Speech Monitoring Agent\n' "$B$C" "$N"
printf '%s  Arabic and Kurdish social media, Iraqi minorities.%s\n' "$D" "$N"

# -- Node --------------------------------------------------------------------
step "1/5  Runtime"
command -v node >/dev/null 2>&1 || die "Node is not installed. HSMA needs >=22.22.3 <23, >=24.15 <25, or >=25.9."

NODE_VERSION="$(node --version | sed 's/^v//')"
# The supported range is a disjunction, not a floor: 23.x and 25.0-25.8 are excluded
# even though they are numerically higher than 22.22.3. Comparing against the lowest
# supported version would wave through 24.11, which then fails during the build.
node -e '
const [maj, min, pat] = process.versions.node.split(".").map(Number);
const ge = (a, b, c) => maj > a || (maj === a && (min > b || (min === b && pat >= c)));
const ok = (maj === 22 && ge(22, 22, 3)) || (maj === 24 && ge(24, 15, 0)) || ge(25, 9, 0);
process.exit(ok ? 0 : 1);
' || die "Node $NODE_VERSION is not supported. Need >=22.22.3 <23, >=24.15 <25, or >=25.9.
      This is a disjunction, not a minimum: 23.x and 24.11 are excluded even
      though they look newer than 22.22.3.

      nvm:  nvm install 24 && nvm use 24
      apt:  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt install -y nodejs"
ok "Node $NODE_VERSION"

if command -v pnpm >/dev/null 2>&1; then
  ok "pnpm $(pnpm --version)"
elif command -v corepack >/dev/null 2>&1 && corepack enable pnpm >/dev/null 2>&1; then
  ok "pnpm (enabled via corepack)"
else
  # The repository is a pnpm workspace. Plain `npm install` at the root is unsupported
  # and fails in ways that look like a corrupt checkout rather than a missing tool.
  npm install -g pnpm >/dev/null 2>&1 || die "pnpm is required and could not be installed. Install it, then rerun:
      npm install -g pnpm"
  ok "pnpm installed"
fi

# -- Source ------------------------------------------------------------------
step "2/5  Source"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only >/dev/null 2>&1 && ok "updated $DIR" || warn "could not fast-forward $DIR; using what is there"
else
  git clone --depth 1 "$REPO" "$DIR" >/dev/null 2>&1 || die "could not clone $REPO"
  ok "cloned to $DIR"
fi
cd "$DIR"

# -- Build -------------------------------------------------------------------
step "3/5  Build"
info "This takes several minutes. It compiles the agent and the judgement together."
pnpm install >/dev/null 2>&1 || die "pnpm install failed in $DIR"
ok "dependencies resolved"
pnpm build 2>&1 | tail -3 || die "build failed"
ok "built"

# -- Install -----------------------------------------------------------------
step "4/5  Install"
# --allow-scripts is needed for the bundled-plugin postinstall step on npm 11.16+ and
# npm 12. Older npm rejects the flag outright, so fall back to a plain install.
#
# sudo -n, never plain sudo: run as `curl ... | bash` this script is stdin, so a
# password prompt has no terminal to read from and would hang at the final step of an
# otherwise finished install.
if npm install -g . --allow-scripts=openclaw >/dev/null 2>&1 || npm install -g . >/dev/null 2>&1; then
  ok "hsma -> $(command -v hsma 2>/dev/null || echo 'on PATH')"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null && sudo -n npm install -g . --allow-scripts=openclaw >/dev/null 2>&1; then
  ok "hsma -> $(command -v hsma 2>/dev/null || echo 'on PATH')"
else
  warn "could not install globally without a password. Run one of these yourself:"
  info "  sudo npm install -g --allow-scripts=openclaw $DIR"
  info "  npm config set prefix ~/.npm-global && npm install -g $DIR"
fi

# -- Collection --------------------------------------------------------------
step "5/5  Collection"
if node -e "require.resolve('camoufox')" >/dev/null 2>&1; then
  ok "Camoufox present -- collection available"
else
  warn "Camoufox not installed. Classification works; collection does not."
  info "The bundled browser drives Chromium over CDP with no anti-detection, which is"
  info "what gets worker accounts banned. Camoufox is a hardened Firefox that replaces it:"
  info "  cd $DIR/extensions/hsma-domain && npm install camoufox && npx camoufox fetch"
  info "  hsma config set plugins.entries.browser.enabled false"
fi

# -- Done --------------------------------------------------------------------
printf '\n%s  Installed.%s  State lives in ~/.hsma\n\n' "$B$G" "$N"
printf '%s  Next%s\n' "$B" "$N"
printf '    %shsma onboard%s              pick a model provider, seed the workspace\n' "$C" "$N"
printf '    %shsma gateway run%s          start the agent and its dashboard\n' "$C" "$N"
printf '    %shsma plugins list%s         confirm the hsma tools are enabled\n\n' "$C" "$N"
printf '%s  Connect it to the platform%s\n' "$B" "$N"
printf '    %shsma config set plugins.entries.hsma.config.platformUrl  <base url>%s\n' "$D" "$N"
printf '    %shsma config set plugins.entries.hsma.config.agentKey     <hate_speech_scan key>%s\n' "$D" "$N"
printf '    %shsma config set plugins.entries.hsma.config.agentId      hsma-$(hostname)%s\n' "$D" "$N"
printf '    %shsma config set plugins.entries.hsma.config.databasePath $HOME/.hsma/evidence.db%s\n\n' "$D" "$N"
printf '%s  agentId is not optional in practice: the platform scopes idempotency on%s\n' "$D" "$N"
printf '%s  (agent_id, key), so two machines omitting it share a namespace and one%s\n' "$D" "$N"
printf '%s  silently replays the other'"'"'s response.%s\n\n' "$D" "$N"
