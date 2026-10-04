# Security

Woodchuck runs on your own computer and keeps your designs there. It sends
things out only when you use a feature that needs another service, such as
the chat with Claude. Here's who can reach it, where its keys live, what
leaves the computer and what the controls don't cover.

## Reporting

Report a suspected vulnerability privately, through GitHub's private
vulnerability reporting. On the repository, open the Security tab and
choose "Report a vulnerability". Please don't open a public issue for it.
One person maintains Woodchuck, and you'll hear back within a few days.

## Who can reach it

The server listens on 127.0.0.1, port 8905, so only programs on the same
computer can connect. It refuses to start on any other address. Every
request and every WebSocket connection is checked as it arrives. The host
it names has to be this computer, or a tailnet name you listed, and so does
the web page it came from, when it says. That stops a website open in your
browser from using the app, including through a trick called DNS
rebinding, where a site's address is quietly switched to your own computer.

On this computer there's no sign-in. Anything already running on your
computer can use the app, the same as you can. The MCP server and your own
scripts rely on that, and anything running as you can read `data/`
anyway.

## Tailnet only, if you widen it

You can put Woodchuck on your own tailnet, Tailscale's private network
between your devices. [docs/REMOTE_ACCESS.md](docs/REMOTE_ACCESS.md) has
the steps. `tailscale serve` passes requests from your tailnet to the app at
127.0.0.1, under a name listed in `WOODCHUCK_TRUSTED_HOSTS`. The tailnet is
the outer fence, and the owner lock stands inside it.

- Never use Tailscale Funnel, which puts the app on the public internet.
  The app asks Tailscale every few minutes whether Funnel is on for its
  port, and serves nothing while it is. The serve script never runs it,
  and refuses to set anything up while it's on.
- A request on a tailnet name needs the identity header Tailscale adds for
  your own signed-in devices. Funnel adds none, so a request through it is
  refused before the lock screen, even between checks. A request that
  carries the header came through Tailscale, so it meets the lock even
  when it names this computer.
- A request to `/api/` that the browser marks `cross-site` is refused, on
  every address.
- The page that sent a request has to be at the same name it was sent to.
  The live-updates connection checks the host, the identity header, that
  page and the session, the same as a request.
- A caller with no Origin, such as a script, passes the page check, the
  same as on this computer. For those the tailnet is the whole fence, so
  keep your tailnet to your own devices.

## The owner lock

An anonymous caller on a tailnet name gets the lock screen and nothing
else. The page itself loads, and every `/api/` route outside signing in
answers 401.

- Setting the password needs the recovery secret. That's
  `WOODCHUCK_RECOVERY_SECRET`, or a random one made each start and printed
  in the log while no password is set. Once a password is set, setting it
  again is refused. A reset with the secret replaces it and signs every
  browser out.
- The password is kept as a salted scrypt hash, and each passkey as its
  public key. Both live in `data/lock.json`, readable by you alone.
- A sign-in is a cookie that lasts 24 hours. It's httpOnly and
  SameSite=Strict, and Secure on a tailnet name. Only a SHA-256 hash of it
  is stored, so a copy of `data/` can't sign anyone in. Signing out ends
  it on the server, and removing a passkey ends every other one.
- A passkey works at a trusted tailnet name over HTTPS, or at `localhost`,
  and never at an IP address. Adding one needs a signed-in browser at that
  same address. The lock screen offers only Woodchuck's own passkeys.
- Browsers send cookies to every port of a name. Your other apps served on
  the same tailnet name receive this cookie too, so keep to apps you trust
  there.

## Keys

Keys live in `.env` in the app's folder, which git ignores. The server
reads them when it starts, and they never reach the browser.

- `ANTHROPIC_API_KEY` is for the chat with Claude. Without it, everything
  except the chat still works.
- `OPENAI_API_KEY` is for the AI blend, and it's optional.

Keep `.env` readable by you alone, with `chmod 600 .env`.
[docs/CONFIG.md](docs/CONFIG.md) lists every setting.

## What leaves the computer

Nothing goes out until you use a feature that needs it.

- **The chat** sends your messages, the design, your workshop settings and
  anything you attach to Anthropic. When you point at the model, it also sends a picture of your
  view. Claude can search the web and read pages, and Anthropic does that
  fetching on its side.
- **The AI blend** sends your room photo, with the model drawn in, to
  OpenAI. It asks first, every time.
- **GitHub** is off until you name a repository in `WOODCHUCK_REPO`. With
  none named, the app never calls GitHub, and missing tools and approved
  parts stay in the app. Once it's on, it acts only in that repository,
  using the GitHub command line tool and your login. It refuses a
  repository that isn't written owner/name. What it creates there is public
  whenever the repository is.
- **A missing tool** goes to GitHub as an issue when you click to file it.
  Where it came up quotes your design, so it goes into the issue only when
  you tick the box for it. The app checks filed issues every few minutes.
- **An approved part** goes to GitHub as a pull request. The app opens it
  by itself when you approve the part, and turns on auto-merge. It holds one
  file with the part's specs, sources and model.

Woodchuck never fetches its own updates. You choose when to pull new code.

## Web pages are data

When Claude reads a web page to research a part, its instructions say the
page is data and never a command. A part it researches goes into the parts
library only when you approve it. A part's file holds numbers, sources and
boxes, never code, and a test checks it before the pull request can merge.
Text from the page goes into the pull request inside code spans, so it
can't mention anyone or link anywhere unasked.

## Your data folder

Designs, chats, pictures, the version history and your workshop settings
live in `data/`, which git ignores. The server starts with `umask 077` and writes each file
readable by you alone. Deleting a design removes its folder for good.

## What these controls don't do

- They don't stop anything already running as you on this computer, which
  can read `data/` and use the app.
- They don't keep a device on your tailnet from the lock screen. Anyone you
  let on your tailnet can try your password, and nothing limits how often,
  so choose a long one.
- They don't hide your tailnet names from your tailnet. The lock screen
  tells a caller who hasn't signed in which of them hold a passkey, so it
  can send you to the right one.
- They don't make the chat private from Anthropic, or the AI blend private
  from OpenAI. What you send them is covered by their own policies.
- They don't check that a colour or a size is right. The checks catch
  mistakes in the design, and the colours are estimates.
