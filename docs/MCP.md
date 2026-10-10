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

Crossband reads the first 900 characters of a tool's description and
drops the rest. Each description keeps within that, and a test holds it
there. The finer points of a tool go in the descriptions of its inputs.

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
| `woodchuck_view` | Changes what the open window shows: the 3D or plan views, look, lighting, camera, an orbit, see-through, the piece or one joint pulled apart, the room photo, highlights, the waiting preview, a worked joint, a side panel tab and a render to the downloads. |
| `woodchuck_status` | Sums up the design: its problems, timber, finishes, joint ids and latest changes by number. |
| `woodchuck_undo` | Undoes the latest change, named by its number. |
| `woodchuck_redo` | Puts back the change undone last, named by its number. |
| `woodchuck_designs` | Lists, opens, starts, copies, renames, stars and deletes designs, as the design menu does, and links to the open one's file. |
| `woodchuck_history` | Lists the design's saved versions by id, or restores one after the woodworker's yes. |
| `woodchuck_drawings` | Links to the workshop drawings as a PDF, on A4 or A3, to the cutting plan on its own, and to the cut list as a spreadsheet file. |
| `woodchuck_stock` | Reads the cutting plan board by board, or sets the boards and sheets the woodworker already has, the widths and lengths the yard sells and the saw kerf, as one undo step. |
| `woodchuck_photo` | Works the room photo bar: shows the design in its photo and sets the lens and shadow. The AI blend and removing the photo wait for the woodworker's yes. |
| `woodchuck_design` | Reads the design in short lines: its parameters, materials, parts with their sizes in mm and their shapes, overall size and problems. |
| `woodchuck_read` | Reads any part of the design as the app shows it: each part's sheet from the workshop drawings, the joints, the cut list, the cutting plan, the drilling and hardware lists, every check, or the design's file. |
| `woodchuck_picture` | Draws the design, or a waiting preview, in the Finished look, and returns the picture to look at with a link to it. |
| `woodchuck_screenshot` | Returns what the open window shows right now, as pictures to look at, with a line saying what they show. |

## Sending a call twice

A chat app may send a call again when the first seems lost, so every tool
is safe to repeat. A tool that sets something, such as a size, a colour or
the view, ends in the same place however often it's sent. The tools that
take a step name the step instead. `woodchuck_undo` and `woodchuck_redo`
take a change's number from `woodchuck_status`, and a change already undone
or back in the design is left there. `woodchuck_designs` names a design by
its id, and new and copy count as done once a design of that name is
open. Starring sets starred to true or false. `woodchuck_stock` replaces a
material's whole list of the wood the woodworker has, so the same list
sent again changes nothing.

Some steps can't be taken back, or cost money. Deleting a design, removing
the room photo, restoring a version and an AI blend each wait for the
woodworker's yes, given as `confirmed`. A second delete or removal finds
it gone, and a second restore finds the design already as that version.
A blend is a new one each time it's sent, so it's an exception. An
undo or a redo only moves the latest change, so going back further is one
call a change, latest first. The window's own Undo and Redo name their
change the same way, so a second click can't take another step.

`turn_degrees`, `zoom` and `render` are exceptions too. They turn, zoom or
save a picture each time they're sent.

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

## Reading the whole design

`woodchuck_read` gives another chat anything the app shows about the
design, as text. Its `what` picks which part to read.

- `parts` gives each part's sheet from the workshop drawings. That's its
  cut size, the side of the piece each view shows and every numbered
  note. Each note says where its cut starts and ends, and the sheet says
  which end, edge and face those are measured from.
- `joints` lists each joint by id, with the two parts it joins and its
  settings, and says which came from the joint library.
- `cut_list`, `cutting_plan`, `drilling` and `hardware` give those lists.
- `checks` gives every problem in full, where `woodchuck_design` stops at
  a cap.
- `file` gives the design's own JSON.

`part` narrows the parts, joints, cut list and drilling list to one part.
It takes a part's id, an array copy such as `shelf#2`, a row number from
the cut list or a row's name. A chat asked where a cut is, or which face
it's in, reads the answer here instead of guessing.

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

## Pulling it apart

`woodchuck_view` with `explode` pulls the piece apart the way it goes
together. A value of 1 is fully apart, 0 is back together, and a number
between leaves it partly apart. `focus_joint` pulls one joint apart on its
own and fades the rest, and opens the joint's section and sizes beside the
model. It takes a joint's id, which `woodchuck_status` lists.
`close_drawer` puts the section away. An empty `focus_joint` goes back to the whole piece, put together.
The plan views and the room photo show the piece together, so the tool
refuses either with `explode` or `focus_joint`. A joint the design doesn't
have is refused with a list of the ones it has.

## Opening a tab

`woodchuck_view` with `tab` opens that tab of the side panel, by its name
on screen. Make holds the workshop drawings, the cut list and the cutting
layout. Check holds the problems, Finish the timber and colours, Edit the
picked part and the sizes, and History every change and version. The
tool's description tells the calling model to open Make for "show me the
cut list", so it needn't ask Woodchuck's Claude.

A tab brings the side panel back, whether it was folded or hidden by
filling the window. It can't go with `fill_window` set to true. The 3D view
or the plan views stay as they were. A highlight opens Edit by itself, and
a tab named with it wins.

## Timing

A chat app holds its turn while a tool runs, so no tool here waits long.
`woodchuck_ask` waits up to about six seconds for a quick answer. A longer
build carries on in the Woodchuck window, and the tool returns with how
it's going. Sent while Woodchuck's Claude is working, a message returns at
once. `woodchuck_progress` answers at once, and `woodchuck_reply` waits up
to about eight seconds. `woodchuck_finish`, `woodchuck_set_param`,
`woodchuck_design` and `woodchuck_view` return within a second, since no
model is involved.

Every tool but `woodchuck_ask` and `woodchuck_preview` also asks Woodchuck
to warm its Claude's prompt cache, without waiting, at most once a minute.
Woodchuck sends a warm-up only once the cache has gone cold, so a message
after a long pause starts sooner. Those two send Claude a message, which
writes the cache itself.

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

`woodchuck_screenshot` shows the calling model what the woodworker sees.
The server asks the open window over its socket, and the window answers
within a few seconds. It sends the 3D view from the woodworker's own
camera, with the piece or a joint pulled apart and the parts picked, or
the plan view's drawing. A joint's section, when it's open, comes as a
second picture. A line of words says what they show. The room photo stays
out unless `with_photo` is true. With no window open, the tool says so,
and `woodchuck_picture` draws the design instead. A chat app passes these
pictures to its model only if it keeps images from a tool's result.
