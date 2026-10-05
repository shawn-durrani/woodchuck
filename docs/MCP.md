# The MCP server

Woodchuck is also an MCP server, so a chat app such as Crossband can work
on the open design. MCP is a standard way for an AI app to call another
program's tools, described at
[modelcontextprotocol.io](https://modelcontextprotocol.io). The server
talks to the chat app over stdio and to the running Woodchuck over HTTP,
so every change shows live in the Woodchuck window.

## Connect it

The chat app starts the server itself. Give it Node with the tsx loader
and the server's file:

```json
{
  "command": "/path/to/node",
  "args": [
    "--import", "file:///path/to/woodchuck/node_modules/tsx/dist/loader.mjs",
    "/path/to/woodchuck/packages/server/src/mcp.ts"
  ],
  "label": "Working on the furniture design"
}
```

The server finds the app at `WOODCHUCK_URL`, and its view notes name
`WOODCHUCK_CALLER`. [CONFIG.md](CONFIG.md) has both. Restart the chat app
after changing the server, since it reads the tools when it starts.

## The tools

| Tool | What it does |
|---|---|
| `woodchuck_ask` | Sends a message to Woodchuck's own Claude, which changes the design with its woodworking tools. A quick answer comes straight back, and a build hands over within a few seconds. Sent mid-build, the message reaches Claude after its current step and redirects the build. |
| `woodchuck_progress` | Says at once what Woodchuck's Claude is doing, its steps and time so far, whether it waits on the woodworker, and its reply once it's done. |
| `woodchuck_reply` | Waits a few seconds for the latest request to finish, then gives what Claude said and did, or how it's going. |
| `woodchuck_preview` | Applies the preview Woodchuck's Claude is showing, or says not now. |
| `woodchuck_finish` | Changes colours straight away, through the same operation as the Finish tab, mid-build too. Woodchuck's Claude is told after its current step. |
| `woodchuck_colours` | Lists the Linolie and Osmo colours by number and name. |
| `woodchuck_view` | Changes what the open window shows: the 3D or plan views, look, lighting, camera, an orbit, see-through, the room photo, highlights, the waiting preview on the model, a worked joint in the drawer, and a render to the downloads. A highlight opens the Edit tab. |
| `woodchuck_status` | Sums up the design: its problems, timber and finishes. |
| `woodchuck_picture` | Draws the design, or a waiting preview, in the Finished look, and returns a link to the picture. |

## Turning the model while you talk

`woodchuck_view` with `orbit` set to `"start"` keeps the camera turning
slowly around the model, once round in about half a minute. Add
`orbit_degrees_per_second` for another speed, from 1 to 60 either way,
where a positive speed turns it to the right. It eases in, keeps going
while the look, lighting, zoom or fit change, and eases out at `"stop"`.
It also stops when the woodworker takes the camera, picks a camera view or
opens the plan views. A room photo keeps the model still, and so does a
computer set to reduce motion. For a single turn, `turn_degrees` turns the
camera once and leaves it there.

## Timing

A chat app holds its turn while a tool runs, so no tool here waits long.
`woodchuck_ask` waits up to about six seconds for a quick answer. A longer
build carries on in the Woodchuck window, and the tool returns with how
it's going. Sent while Woodchuck's Claude is working, a message returns at
once. `woodchuck_progress` answers at once, and `woodchuck_reply` waits up
to about eight seconds. `woodchuck_finish` and `woodchuck_view` return
within a second, since no model is involved.

## Watching a build

`woodchuck_ask`, `woodchuck_progress` and `woodchuck_reply` each put a
`background` block in the result's `structuredContent`, beside the words.
A chat app reads it to watch a long build without holding its turn.

```json
{ "background": {
    "job": "u1a2b3",
    "state": "running",
    "title": "Woodchuck",
    "progress_tool": "woodchuck_progress",
    "stage": "Carcass done. Now the drawers.",
    "steps": 48,
    "elapsed_s": 312,
    "waiting_for": null,
    "ask": "",
    "reply": "",
    "outcome": null,
    "error": "",
    "parts": 18,
    "edits": 42
} }
```

- `job` names the message that started the request. A new one means a new
  turn, such as one a late message started.
- `state` is `running`, `waiting`, `done` or `idle`. A request that an
  error or Stop ended early is `done` here too, so a chat app that knows
  only these four still hears it's over.
- `outcome` says how a request that's over ended, as `finished`, `failed`
  or `stopped`. It's null while Claude works or waits. `error` holds the
  error that ended a failed request.
- `progress_tool` names the tool that gives a fresh block. It takes no
  arguments and answers within a second.
- `stage` is one plain line, from Claude's latest narration, the start of
  its thinking or its latest step.
- `waiting_for` and `ask` say what Claude waits on, with the question or
  the preview's title.
- `reply` holds what Claude said and did, once it's done or waiting. A
  failed or stopped request's reply opens with how it ended, and says the
  woodworker can ask Claude to carry on.
- `parts` counts the parts in the design, and `edits` counts Claude's edits
  in this request. Both grow during a build, and the Woodchuck window
  shows each part as it's added.

The app's own `GET /api/progress` gives the same facts, with the last
three steps and any messages Claude hasn't read yet. Its `state` names
`failed` and `stopped` as states of their own.

## Pictures

`woodchuck_picture` asks the server for a picture, which it draws by
opening its own page in a headless Chrome. The tool returns the picture
and a markdown line that shows it. A chat app that drops images from tools
can still show it, when its model puts that line in a reply. The link
points at this computer, so it loads only here.
