# Outpost — your Claude Code sessions, as chats

Run Claude Code chats on a machine of yours and drive them from a browser — desktop or phone,
over the LAN. Each chat gets its own checkout of your repos and its own container. Read it as
a conversation, type back, answer its questions, schedule one, land its work.

It uses your own Claude subscription or API key. There is no Outpost account and nothing is
uploaded.

## Set up a machine

Outpost is hosted on one Linux machine that stays on, and used from any other device.

**The host needs:** Linux with systemd (written against Ubuntu 24.04), an ordinary user
account, Node 22.18+, the `claude` CLI, rootless Podman, and git, python3, ssh and rsync.
macOS and Windows cannot host.

**In one go** on Ubuntu, steps 1–5 are a script. Run it as your ordinary user; it asks for
sudo where needed, clones to `~/outpost` (or `$OUTPOST_DIR`) and prints the setup link:

```bash
curl -fsSL https://raw.githubusercontent.com/dramos126/outpost-harness/main/deploy/setup-host.sh | bash
```

From a checkout, `deploy/setup-host.sh` sets up that one. Then go to step 6.

### 1. Packages

```bash
sudo apt update
sudo apt install -y git python3 openssh-client rsync curl podman uidmap slirp4netns
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

Node has to come from a system package: Ubuntu's own is too old, and a version manager's is
invisible to a systemd unit.

### 2. The Claude CLI

```bash
curl -fsSL https://claude.ai/install.sh | bash
sudo ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude
```

Outpost looks for it at `/usr/local/bin/claude`. Do not log it in — chats sign in from the
page (step 6).

### 3. Linger

```bash
sudo loginctl enable-linger "$USER"
```

Without it, Outpost and every chat stop when you log out.

### 4. Outpost

```bash
git clone https://github.com/dramos126/outpost-harness.git ~/outpost
cd ~/outpost
node .yarn/releases/yarn-4.18.0.cjs install --immutable
node .yarn/releases/yarn-4.18.0.cjs build
deploy/install.sh
node tools/install-hooks.mjs ~
```

`deploy/install.sh` installs and starts a systemd user unit serving port 5274 on the LAN.
The last line installs the hooks chats report their status through.

### 5. First password

```bash
journalctl --user -u outpost -n 20 | grep setup=
```

Open the link it prints and choose a username and password. The link works once. After that
the page is `http://<the machine>:5274`.

Page won't load from another device? Open the port: `sudo ufw allow 5274/tcp`.

### 6. Finish in Settings

1. **Integrations › Claude › Sign in with Claude** — or paste an API key. Required.
2. **General › Account** — the name and email chats commit as.
3. **Integrations › GitHub** — a fine-grained token, used to clone and push.
4. **Repos** — add your repos.
5. **General › About this machine** — lists anything still missing and where to enter it.

Then **New chat**. The first one takes a minute longer while the container image builds.

## Move to another machine

1. Set up the new machine through step 5.
2. Old machine: **Settings › General › Export setup**.
3. New machine: **Import setup**, then enter the secrets it lists.

The export holds repos, settings and schedules — never secrets. Chats do not move, so push
what matters first.

## Update

```bash
cd ~/outpost
git pull
node .yarn/releases/yarn-4.18.0.cjs install --immutable
node .yarn/releases/yarn-4.18.0.cjs build
deploy/install.sh
```

Running chats are not interrupted.

## Develop

```bash
node .yarn/releases/yarn-4.18.0.cjs dev
```

One process, on `127.0.0.1`, no password.

## How it works

- **A chat** is a `claude` process in a rootless Podman container, under its own systemd user
  unit. It sees its own checkouts and nothing else of the machine, and it survives a restart
  of Outpost.
- **Status** — working, waiting on you, finished, errored, stalled — comes from Claude Code
  hooks posting to `127.0.0.1:5274`. That address is fixed.
- **Credentials** live in Outpost's secret store and never reach a chat: it gets GitHub,
  Jenkins and your other hosts as tools Outpost runs for it.
- **Only chats Outpost started are listed.** Sessions from VS Code or a terminal are
  searchable but are not rows.

## Security

Outpost can start processes and type into your sessions, so:

- Off loopback it requires a password or `OUTPOST_TOKEN`; with neither it answers nothing but
  the one-time setup link.
- On loopback it checks `Host` and `Origin`, against DNS rebinding and cross-site requests.
- The credential is a bearer header, never a cookie.
- It speaks plain http. Keep it on a LAN or VPN you trust, not the open internet.

## Where things are

```
server/    the API and everything that touches the machine
src/       the page
deploy/    the systemd unit, its installer, and the new-host setup script
tools/     commands you run: install hooks, set a password, read the retry log
scripts/   checks CI runs
```

Outpost keeps everything under `~/.outpost/`, plus the login in `~/.outpost-auth.json`. To
remove it, stop the unit and delete those.

## Contributing

Pull requests are welcome; replies may be slow.

- Run `node .yarn/releases/yarn-4.18.0.cjs check` first: typecheck, tests and the build.
- One thing per pull request, and say what you checked and how.
- Match the code around you, and ask before adding a dependency.
- You keep the copyright in what you contribute, and give Danny Ramos the right to use, change
  and license it as part of Outpost, under its licence or any other.

Found a security hole? Report it privately through GitHub's **Security › Report a
vulnerability**, not in an issue or pull request.

## Licence

[PolyForm Noncommercial 1.0.0](LICENSE): run it, change it and share it for any noncommercial
purpose. Selling it or using it in a business needs permission.

Required Notice: Copyright (c) 2026 Danny Ramos (https://github.com/dramos126/outpost-harness)

Third-party notices are in `THIRD-PARTY-NOTICES.md`.
