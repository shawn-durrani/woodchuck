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
| `woodchuck_set_param` | Sets parameters the design already has straight away, mid-build too, as one undo step. A change over 20%, or to zero or less, waits for the woodworker's yes. Woodchuck's Claude is told after its current step. |
| `woodchuck_colours` | Lists the Linolie and Osmo colours by number and name. |
| `woodchuck_view` | Changes what the open window shows: the 3D or plan views, look, lighting, camera, an orbit, see-through, the room photo, highlights, the waiting preview on the model, a worked joint in the drawer, and a render to the downloads. A highlight opens the Edit tab. |
| `woodchuck_status` | Sums up the design: its problems, timber and finishes. |
| `woodchuck_design` | Reads the design in short lines: its parameters, materials, parts with their sizes in mm and their shapes, overall size and problems. |
| `woodchuck_picture` | Draws the design, or a waiting preview, in the Finished look, and returns a link to the picture. |

## Changing a size straight away

`woodchuck_set_param` sets parameters the design already has, such as
`top_length`, through the same operation as the size sliders in the app.
Every size worked out from a parameter moves with it. Give each change as
`value_mm` for a size in millimetres, `value` for a count or another unit,
or `expression` for a formula of other parameters. Making a new parameter
is Claude's job, so the tool refuses a name the design doesn't have. It
also refuses a formula that doesn't read, names something the design
lacks, loops back on itself or doesn't work out to a number. A refused
call changes nothing, even when its other changes were fine.

A misheard number is the main risk in a voice chat, since "15" and "50"
sound alike. The tool's description asks the calling model to say each
change back and wait for a yes. A change of more than 20% of a parameter's
value, or one to zero or less, is refused until the call sets `confirmed`
to true. That refusal gives the old and new values and a question to put
to the woodworker.

The reply gives each old and new value and the sizes worked out from them
that moved. It counts the parts that moved and names each problem the
change fixed. It names each new error and warning too, up to 20, and
counts any past that. A parameter that was a formula gets a line naming
what the formula followed. A plain number in its place stops it following
them, and undo puts the formula back. The window brings the whole model
into view, with a note naming the change.

`woodchuck_design` reads the open design in short lines for another
model. It gives the parameters with their values and formulas, the
materials, each part's size and the overall size. It also lists the
problems and says whether Woodchuck's Claude is busy. Copies in an array
share one line, such as `false_front ×5`, and each list stops at a cap
with how many more there are.

A part with cuts has its shape on its line too. A slope gives its two ends
and its angle, such as `top sloped from 150 at the back to 80 at the
front, 10.4°`. Holes, notches and corners cut off are counted, such as
`2 holes, 1 notch`.

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
to about eight seconds. `woodchuck_finish`, `woodchuck_set_param`,
`woodchuck_design` and `woodchuck_view` return within a second, since no
model is involved.

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
    "edits": 42,
    "answered": ""
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
- `steps` counts Claude's tool calls in this request.
- `parts` counts the parts in the design, and `edits` counts Claude's edits
  in this request. Both grow during a build, and the Woodchuck window
  shows each part as it's added. One call can make a whole list of edits,
  so `edits` often grows faster than `steps`.
- `answered` is a line when a message sent while Claude worked was taken
  as the reply to its plan or question, which means Claude isn't waiting
  on it. It's empty otherwise.

The app's own `GET /api/progress` gives the same facts, with the last
three steps and any messages Claude hasn't read yet. Its `state` names
`failed` and `stopped` as states of their own.

## Pictures

`woodchuck_picture` asks the server for a picture, which it draws by
opening its own page in a headless Chrome. The tool returns the picture
and a markdown line that shows it. A chat app that drops images from tools
can still show it, when its model puts that line in a reply. The link
points at this computer, so it loads only here.
