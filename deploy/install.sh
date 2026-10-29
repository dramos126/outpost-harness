#!/usr/bin/env bash
# Install or refresh the Outpost user unit and (re)start it. Idempotent; safe to run every deploy.
#
# Run as the user Outpost serves for — never root. The unit is a *user* unit for reasons given
# at the top of deploy/outpost.service.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"                 # the checkout this is running from
unit_src="$here/outpost.service"
unit_dir="$HOME/.config/systemd/user"
unit_dst="$unit_dir/outpost.service"
data_dir="$HOME/.outpost/data"

if [ "$(id -u)" -eq 0 ]; then
  echo "install.sh: run this as the Outpost user, not root" >&2
  exit 1
fi

# A non-login session (Jenkins over SSH, a cron job) has no session bus without this.
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# No password yet is fine: the server starts in setup mode and prints a one-time link that
# sets the first one from the page (docs/modules/auth.md). Said here so a fresh box knows
# where to look for it.
if [ ! -f "$HOME/.outpost-auth.json" ]; then
  echo "install.sh: no ~/.outpost-auth.json yet — the server will print a setup link. Find it with:"
  echo "            journalctl --user -u outpost -n 20 | grep setup="
fi

if [ ! -d "$root/dist" ]; then
  echo "install.sh: no dist/ in $root — run: node .yarn/releases/yarn-4.18.0.cjs build" >&2
  exit 1
fi

# State moves out of the checkout once, so a later deploy from a different clone keeps it.
if [ ! -d "$data_dir" ]; then
  mkdir -p "$data_dir"
  [ -d "$root/data" ] && cp -n "$root/data"/*.json "$data_dir"/ 2>/dev/null || true
  echo "state dir created → $data_dir"
fi

mkdir -p "$unit_dir"
rendered="$(sed "s|__OUTPOST_DIR__|$root|" "$unit_src")"
if [ "$rendered" != "$(cat "$unit_dst" 2>/dev/null)" ]; then
  printf '%s\n' "$rendered" > "$unit_dst"
  echo "unit updated → $unit_dst  (serving $root)"
fi

systemctl --user daemon-reload
systemctl --user enable outpost >/dev/null 2>&1 || true
systemctl --user restart outpost

# Linger is what lets the unit come up on boot with nobody logged in. It needs root once;
# say so rather than fail, since everything above still worked for this session.
if ! loginctl show-user "$(id -un)" 2>/dev/null | grep -q '^Linger=yes'; then
  echo
  echo "note: linger is off, so this unit stops when your last session ends and will not"
  echo "      start at boot. Once, as root:  sudo loginctl enable-linger $(id -un)"
fi

echo "outpost: $(systemctl --user is-active outpost)"
