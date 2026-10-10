# Keeping Woodchuck running

Woodchuck is a server on your computer, on port 8905, and the page you open
in a browser talks to it. You can start it by hand whenever you want to use
it. If you'd like it always there, say for a phone on your tailnet, hand it
to a supervisor, which is a program that starts another program and keeps
it running. Here's how on macOS and Linux, how to restart it safely and how
to look after your designs.

## Run it by hand

```bash
./start.sh
```

`start.sh` installs packages when `package-lock.json` has changed and
rebuilds the web app when its source has. Then it runs the server and
prints its log in the terminal. Ctrl-C stops it.

## Keep it running on macOS

The supervisor built into macOS is
[launchd](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html),
and the repo ships a one-command installer that hands Woodchuck to it. Run
it from the checkout you want served.

```bash
service/install-service.sh
```

The script fills your computer's paths into a template,
`service/dev.woodchuck.server.plist.template`, and writes the result to
`~/Library/LaunchAgents/dev.woodchuck.server.plist`. That's the file that
tells launchd what to run. Then it stops any copy you started by hand,
gives the one real copy to launchd and waits for it to answer. The template
holds no personal path, so nothing about your computer is ever committed.

From then on launchd starts Woodchuck at login, starts it again if it
stops, and brings it back after a reboot. If it fails as it starts, launchd
waits ten seconds between tries, so a broken start shows up as a slow,
steady retry in the log. launchd calls a job like this an agent, and this
one is named `dev.woodchuck.server`. The `gui/$(id -u)` in each command
tells launchd to look in your own login session.

```bash
# restart it, after a git pull or to pick up .env changes
launchctl kickstart -k gui/$(id -u)/dev.woodchuck.server

# is it running, and as which process?
launchctl print gui/$(id -u)/dev.woodchuck.server | grep -iE 'state|pid'

# follow the log
tail -f data/service.log

# stop it, and stop launchd starting it again
launchctl bootout gui/$(id -u)/dev.woodchuck.server
```

While the agent runs, it holds port 8905, so a copy started with
`./start.sh` can't start. Use the restart command instead. Run the
installer again after you move the checkout or install Node somewhere new,
and it replaces the agent.

## Keep it running on Linux

On Linux the usual supervisor is
[systemd](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html).
The repo doesn't ship a unit file, but a user unit like this one runs
`start.sh` the same way the macOS agent does. Change the paths to your own
checkout.

```ini
[Unit]
Description=Woodchuck

[Service]
WorkingDirectory=/home/you/woodchuck
ExecStart=/bin/bash /home/you/woodchuck/start.sh
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

Save it as `~/.config/systemd/user/woodchuck.service`, then turn it on.

```bash
systemctl --user daemon-reload
systemctl --user enable --now woodchuck
```

systemd gives the service a short `PATH`. If `node` lives somewhere else,
such as a version manager's folder, add an `Environment=PATH=` line to the
`[Service]` section that names its folder first. Restart it with
`systemctl --user restart woodchuck`, and follow its log with
`journalctl --user -u woodchuck -f`. A user service stops when you log out,
unless you run `loginctl enable-linger` once.

## Before you restart

A restart in the middle of Claude's turn cuts that turn off. Ask Woodchuck
first. The busy route answers from this computer with no sign-in.

```bash
curl -s http://127.0.0.1:8905/api/busy
```

It answers `{"busy":true,"reasons":["claude_turn"]}` while Claude is
working, and `{"busy":false,"reasons":[]}` once it's free. The reason
`backup` shows for the few seconds a snapshot takes to write. The reason
`chat_summary` shows while Claude summarises a long chat after a turn,
when that's turned on, and it can take a minute. A restart then drops the summary, and the next
turn asks for it again. A warm-up of Claude's prompt cache never counts as
busy. A restart cuts it short, and the next reply writes the cache itself. The health
route, `/api/health`, answers `{"ok":true,...}` as soon as the server is
up. Both still answer from this computer while Funnel is on and Woodchuck
serves nothing else.

An open window reloads itself onto the new version once nothing would be
lost, such as a message you're still typing. A window in view then asks
for a warm-up of Claude's cache, which goes once for each design after a
restart, and [CONFIG.md](CONFIG.md) says what it costs.

## Writing your own update script

Woodchuck never updates itself. If you'd like a script to do it, have it
follow these steps.

1. Fetch the new code, and check it in a separate checkout with `npm ci`,
   `npm run typecheck`, `npm test` and `npm run build`. If any of them
   fail, keep the old version running.
2. Ask `/api/busy` until it says `"busy":false`. Claude's turns can run
   for minutes, so give it a generous wait. The busy flag stays up from
   one of Claude's turns to the next, so a script that waits on it never
   lands between them.
3. Move the served checkout to the new code with `git pull`, then restart
   through your supervisor. `start.sh` reinstalls packages and rebuilds the
   web app as it starts.
4. Ask `/api/health` every few seconds until it answers. If it doesn't
   within a few minutes, look at the log.

A chat app that runs Woodchuck's MCP server, such as Crossband, needs no
restart for an update. The server passes every call to the app, so the
new version answers as soon as it's running. Restart the chat app only
when a tool's name, description or inputs have changed, since it reads
them when it starts. [MCP.md](MCP.md) has more.

Keep a script like this outside Woodchuck, as a program of its own that
you choose to run.

## Logs

With the macOS agent, the server's output goes to `data/service.log`. Run
by hand it goes to the terminal, and under systemd it goes to the journal.
While tailnet access is on and no owner password is set, the log holds the
recovery secret, so keep it to yourself.
[REMOTE_ACCESS.md](REMOTE_ACCESS.md) says what the secret is for.

## Your designs

Each design is a folder under `data/projects`, with its design, chat,
pictures and settings. Every change set is also a commit in a git
repository at `data/projects/.git`, which the History tab reads. Woodchuck
backs all of it up by itself, as [Backups](#backups) explains. To share one
design, pick Download in the design menu, on the design's name.

## Backups

Woodchuck takes a snapshot of the data folder each time it starts, before
it touches anything. After that it takes one every six hours by the clock.
Time the computer spends asleep counts. The timer checks every five
minutes, so a snapshot that fell due during sleep lands soon after it
wakes. [CONFIG.md](CONFIG.md#backups) has the settings for how often, how
many to keep and a mirror folder.

Each snapshot is one compressed file in `data/backups`, such as
`woodchuck-20261005-031500-3f9a1c2b7d4e.tar.gz`. The time in its name is
UTC, and the letters after it are a fingerprint of what's inside. A
snapshot the same as the newest one isn't kept, so a run of quick
restarts never pushes the older ones out. The newest 14 stay, and the
oldest go first. The health route, `/api/health`, reports when the newest
was taken as `last_backup_at`.

A snapshot holds everything Woodchuck needs to start again. That's every
design with its chat, pictures and version history, your workshop, tool
requests, approved parts waiting to merge and the owner lock's password
and passkeys. It leaves out the backups themselves, the service log and
any half-written temporary file. The log can hold the recovery secret.
Sign-ins are left out too, so after a restore every browser on your
tailnet signs in again. A sign-in you ended after the snapshot never comes
back that way.

Snapshots and their folder are private to your account, the same as the
data folder. A failed snapshot is logged, and Woodchuck carries on.

### A mirror folder

A snapshot in `data/backups` is lost along with the computer. Set
`WOODCHUCK_BACKUP_MIRROR_DIR` to a folder that a sync service copies
elsewhere, such as one in iCloud Drive, and each finished snapshot is
copied there too. Give it a folder of its own. Woodchuck makes it private
to your account and keeps the newest 7 there.

Only finished snapshots reach the mirror. A sync service that watches
files while they're being written can trip over them, so the live data
folder never goes there. If the mirror can't be reached, the snapshot in
`data/backups` stands and the log says why. The next snapshot tries the
mirror again.

### Restoring a backup

Pick the snapshot to go back to from `data/backups`, or from the mirror,
then follow these steps from the app's folder.

1. Stop Woodchuck. Press Ctrl-C if you started it by hand. With the macOS
   agent, run `launchctl bootout gui/$(id -u)/dev.woodchuck.server`.
2. Move the data folder aside, so nothing is lost if you change your mind.

   ```bash
   mv data data-before-restore
   ```

3. Make an empty data folder, private to you, and unpack the snapshot
   into it.

   ```bash
   mkdir -m 700 data
   tar -xzf data-before-restore/backups/woodchuck-20261005-031500-3f9a1c2b7d4e.tar.gz -C data
   ```

4. Move the backups back, so the older snapshots stay with the app.

   ```bash
   mv data-before-restore/backups data/
   ```

5. Start Woodchuck again with `./start.sh`, or with
   `service/install-service.sh` for the macOS agent.

Unpacking over the data folder you have works too. It keeps anything made
since the snapshot, such as a newer design, beside what it brings back.
Once you're happy with the restore, delete `data-before-restore`.

## Approved parts

An approved part is kept in `data/library-pending` until its pull request
merges and Woodchuck is updated. Then the file is in `library/parts`, and
the copy in `data/` is dropped when the app next starts or lists its parts.
With no repository named in `WOODCHUCK_REPO`, the part stays in
`data/library-pending`, where every design can use it.

If GitHub couldn't be reached, the parts library says the pull request is
waiting and offers a Retry button. It's on the All designs and parts page,
in the design menu.

The app asks GitHub about each open pull request when it starts and every
five minutes after. If you close one without merging it, the part is marked
"pull request closed". It still works in your designs, and the parts library
and the chat card offer two buttons. "Open a new pull request" tries again
and opens a fresh one. "Remove from library" deletes the part's file from
`data/library-pending` and nothing else. A design that used the part keeps
its own copy of the specs and the model.
