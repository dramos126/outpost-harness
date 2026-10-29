#!/usr/bin/env bash
# Set up a fresh Ubuntu host for Outpost: README steps 1–5 in one go. Idempotent; a step already
# done is skipped, so it is safe to run again after a failure.
#
# Run as the user Outpost serves for — never root; it asks for sudo where a step needs it.
# From a checkout it sets up that checkout; piped from curl it clones to $OUTPOST_DIR
# (default ~/outpost) first.
set -euo pipefail

repo_url="https://github.com/dramos126/outpost-harness.git"
yarn="node .yarn/releases/yarn-4.18.0.cjs"

if [ "$(id -u)" -eq 0 ]; then
  echo "setup-host.sh: run this as the Outpost user, not root" >&2
  exit 1
fi
if ! command -v apt-get >/dev/null; then
  echo "setup-host.sh: written for Ubuntu (apt); follow the README by hand elsewhere" >&2
  exit 1
fi

step() { printf '\n== %s\n' "$*"; }

step "packages"
sudo apt-get update
sudo apt-get install -y git python3 openssh-client rsync curl podman uidmap slirp4netns

# Node from nodesource, not Ubuntu's (too old) nor a version manager's (a unit cannot see it).
node_ok() {
  command -v node >/dev/null && node -e '
    const [a, b] = process.versions.node.split(".").map(Number)
    process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'
}
step "node 22.18+"
if node_ok; then
  echo "have $(node --version)"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  node_ok || { echo "setup-host.sh: node is still older than 22.18" >&2; exit 1; }
fi

# Left signed out on purpose: chats sign in from the page (README step 6).
step "claude CLI"
if [ ! -x "$HOME/.local/bin/claude" ]; then
  curl -fsSL https://claude.ai/install.sh | bash
fi
sudo ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude
echo "have $(/usr/local/bin/claude --version)"

step "linger"
sudo loginctl enable-linger "$(id -un)"

step "outpost"
here="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" && pwd)"
if [ -f "$here/install.sh" ] && [ -f "$here/../package.json" ]; then
  root="$(dirname "$here")"
else
  root="${OUTPOST_DIR:-$HOME/outpost}"
  [ -d "$root/.git" ] || git clone "$repo_url" "$root"
fi
cd "$root"
$yarn install --immutable
$yarn build
deploy/install.sh
node tools/install-hooks.mjs ~

# The setup link is printed once, at the first start with no password (docs/modules/auth.md).
if [ ! -f "$HOME/.outpost-auth.json" ]; then
  step "first password"
  link=""
  for _ in $(seq 1 15); do
    link="$(journalctl --user -u outpost -n 50 --no-pager 2>/dev/null | grep -o 'http[^ ]*setup=[^ ]*' | tail -1 || true)"
    [ -n "$link" ] && break
    sleep 1
  done
  if [ -n "$link" ]; then
    echo "open, once, to choose a username and password: $link"
  else
    echo "no link yet; find it with: journalctl --user -u outpost -n 20 | grep setup="
  fi
fi

cat <<'EOF'

Done. Next, in the page's Settings (README step 6): sign in to Claude, set the commit name and
email, add a GitHub token, add repos — or Import setup from your old machine.
Page won't load from another device? sudo ufw allow 5274/tcp
EOF
