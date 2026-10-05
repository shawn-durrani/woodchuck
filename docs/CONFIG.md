# Configuration

Woodchuck reads its settings from environment variables. Put them in `.env`
in the app's folder, which git ignores, and restart the app to pick them
up. Only `ANTHROPIC_API_KEY` is needed, and only for the chat. Every other
setting has a default that suits one person on one computer.

## Keys

| Setting | Default | What it does |
|---|---|---|
| `ANTHROPIC_API_KEY` | none | Your Anthropic API key, for the chat with Claude. Without a key, everything except the chat works. |
| `ANTHROPIC_AUTH_TOKEN` | none | An Anthropic token, used in place of the key when you have one. |
| `ANTHROPIC_PROFILE` | none | An Anthropic profile name, used in place of the key when you sign in that way. |
| `OPENAI_API_KEY` | none | Your OpenAI API key, for the AI blend in photo mode. Without it, the AI blend button says how to add one. |

## Claude and the AI blend

| Setting | Default | What it does |
|---|---|---|
| `WOODCHUCK_MODEL` | `claude-sonnet-5-5` | The Claude model a new design starts with. Each design can pick its own in the chat. |
| `WOODCHUCK_EFFORT` | `high` | How hard Claude thinks before it answers: `low`, `medium`, `high`, `xhigh` or `max`. Lower is quicker and cheaper. A turn that needs less thought can go lower, and none goes higher. |
| `WOODCHUCK_EFFORT_ROUTING` | `on` | Lets each turn pick how hard Claude thinks. A colour try or a question about the design runs at `low`, a small size change at `medium`, and anything else at `WOODCHUCK_EFFORT`. `off` runs every turn at `WOODCHUCK_EFFORT`. |
| `WOODCHUCK_COMPACT_AT` | `100000` | The chat size, in tokens, at which the API summarises the older turns so Claude stays quick. The whole chat stays saved, and Claude searches it when you refer back. The lowest is 50000, and `off` sends the whole chat every time. |
| `WOODCHUCK_CACHE_TTL` | `1h` | How long Claude's prompt cache lasts, `1h` or `5m`. An hour outlasts a pause in a voice chat or between edits. Writes to the cache cost twice the input price on `1h` and 1.25 times on `5m`, and reads cost the same. |
| `WOODCHUCK_COMPACT_IDLE_AT` | none | Turns on summaries between turns, at this chat size in tokens, such as `100000`. Once a turn ends past it, Claude summarises the chat in the background, and no turn waits. `WOODCHUCK_COMPACT_AT` then defaults to `150000`, for one long turn. |
| `WOODCHUCK_SEARCH_COUNTRY` | none | The country Claude's web searches favour, as a two-letter code. It wins over the country in Your workshop, which starts as `AU`. |
| `WOODCHUCK_IMAGE_MODEL` | `gpt-image-2.5-sunburst` | OpenAI's image model for the AI blend. `gpt-image-2.5-flare` is faster and cheaper. |
| `WOODCHUCK_SCRIPT` | none | A JSON file of replies the app plays back in place of Claude, for trying the chat with no key and no cost. |

## Where things live

| Setting | Default | What it does |
|---|---|---|
| `WOODCHUCK_PORT` | `8905` | The port the server listens on, at 127.0.0.1 only. |
| `WOODCHUCK_HOST` | `127.0.0.1` | The address the server listens on. It refuses to start on any other, so reach it from another device through your tailnet. |
| `WOODCHUCK_WEB_PORT` | `8906` | The port of the development web server that `npm run dev` starts. |
| `WOODCHUCK_DATA_DIR` | `data` | The folder for designs, chats, pictures, history and approved parts waiting to merge, relative to the app's folder. |
| `WOODCHUCK_LIBRARY_DIR` | `library/parts` | The folder of merged parts, shared through the repo. The app only reads it. |
| `WOODCHUCK_CHROME` | the usual install | The Chrome or Chromium the server draws pictures with for other apps. It looks in the usual places on macOS and at `/usr/bin/google-chrome` and `/usr/bin/chromium` on Linux. |

## Backups

Woodchuck backs up its data folder by itself, into `data/backups`.
[OPERATIONS.md](OPERATIONS.md#backups) says what a snapshot holds and how
to restore one.

| Setting | Default | What it does |
|---|---|---|
| `WOODCHUCK_BACKUP_INTERVAL_HOURS` | `6` | Hours between snapshots by the clock, so time the computer spends asleep counts. There's one more at every start, before anything touches the data. `0` turns the timer off. |
| `WOODCHUCK_BACKUP_KEEP` | `14` | Snapshots kept in `data/backups`. The oldest go first. |
| `WOODCHUCK_BACKUP_MIRROR_DIR` | none | A second folder, such as one in iCloud Drive, that gets a copy of each finished snapshot. It never gets the live files, which a sync service can trip over. A relative path starts at the app's folder. |
| `WOODCHUCK_BACKUP_MIRROR_KEEP` | `7` | Snapshots kept in the mirror folder. |

## GitHub

Woodchuck can file a missing tool's spec as a GitHub issue, and open a
pull request that shares a part you approve. It stays off until you name a
repository in `WOODCHUCK_REPO`, and missing tools and approved parts stay
in the app until then. The issues and pull requests it creates are public
whenever the repository is. It acts through the
[GitHub CLI](https://cli.github.com), `gh`, which has to be installed and
signed in with an account that can write to the repository.

| Setting | Default | What it does |
|---|---|---|
| `WOODCHUCK_REPO` | none | The GitHub repository, written owner/name. Missing-tool issues are filed in it, and pull requests for approved parts open against its `main` branch. Without it, the app never calls GitHub. |

## Your tailnet and the owner lock

These put Woodchuck on your own tailnet, behind the owner lock.
[REMOTE_ACCESS.md](REMOTE_ACCESS.md) has the steps, and with none of them
set, Woodchuck answers on this computer only.

| Setting | Default | What it does |
|---|---|---|
| `WOODCHUCK_TRUSTED_HOSTS` | none | The tailnet names Woodchuck answers on besides this computer, separated by commas, such as `my-mac.my-tailnet.ts.net`. Anyone reaching one meets the lock screen. |
| `WOODCHUCK_TAILSCALE_SERVE` | `0` | `1` makes `start.sh` run `scripts/tailscale-serve.sh` on every start. A failure there never stops the app. |
| `WOODCHUCK_TAILSCALE_PORT` | `8445` | Woodchuck's own HTTPS port on the tailnet name. The serve script uses it, and so does the address Woodchuck gives other apps. |
| `WOODCHUCK_TAILSCALE_BIN` | none | The `tailscale` command, when it isn't on your `PATH`. On a Mac it's `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, and the Funnel check looks there by itself. |
| `WOODCHUCK_TAILSCALE_IDENTITY_REQUIRED` | `1` | Refuses a request on a tailnet name that lacks the identity header Tailscale adds for your own devices. Funnel never adds it. `0` turns the check off. |
| `WOODCHUCK_FUNNEL_CHECK_S` | `180` | How often, in seconds, Woodchuck asks Tailscale whether Funnel is on for its port. While it is, Woodchuck serves nothing. `0` turns the check off. |
| `WOODCHUCK_BROWSER_ORIGIN` | worked out | Where a browser opens Woodchuck, for links from your other apps. Without it, it's https at the first trusted name and the tailnet port, or `http://127.0.0.1:8905` with none. |
| `WOODCHUCK_RECOVERY_SECRET` | random | The secret that sets or resets the owner password. Without it, Woodchuck makes a new one each start and prints it in the log while no password is set. |

## The MCP server

The MCP server runs as its own process, started by the chat app that uses
it. [MCP.md](MCP.md) says how to connect it.

| Setting | Default | What it does |
|---|---|---|
| `WOODCHUCK_URL` | `http://127.0.0.1:8905` | Where the MCP server finds the running app. |
| `WOODCHUCK_CALLER` | `another app` | The name the app's window shows when the MCP server changes its view or colours, such as the chat app that runs it. |
