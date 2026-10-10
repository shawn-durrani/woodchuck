# Testing

The tests run with no API keys and never call Claude, OpenAI or GitHub.
CI runs all of them on every pull request, and a pull request can merge
only when they pass. Run them before you push. Each test has 30 seconds,
since a test that writes a design's history to git can take several on a
busy computer.

```bash
npm run typecheck
npm test
npm run build
```

The Python tests check the docs and the scripts. They need Python 3.12 or
newer with [pytest](https://docs.pytest.org) installed.

```bash
python -m pytest tests/ -q
```

## What the TypeScript tests hold

### The core

The core tests in `packages/core/test` pin the woodworking to numbers.
Each joint in the library is built on sample boards and checked for its cut
sizes, its machining and its warnings, and every worked example has to
build with no errors. The record console example in the app is the
acceptance test, with its drawer width pinned to the millimetre. Other
tests cover expressions, the checks, cutting layouts, finishes and their
colour arithmetic, what changed between versions, view commands and the
tabs they open, the workshop drawings and the sheet the 2D views are drawn
on.
[The acceptance test](#the-acceptance-test-the-record-console) has the
console's numbers.

Cuts have tests of their own. The flat geometry is held to exact numbers
on small invented shapes, such as a notch flush with an edge, a circle that
touches one and a slot that splits a part. An invented drawer whose sides
slope from a tall back to a low front checks a slope that follows its
neighbours, its words on the cut list and its area for the finish. The cut
operations are held to what they refuse and to a panel keeping its cuts
through any other change. Every example with no cuts has to derive and
check to a fixed digest, so cuts can't change a design that has none. The
digests for the checks cover each joint example with its joint taken out
too, so the overlap and contact checks get something to say.

The checks on cut parts run on an invented shelf unit and on the joint
library's worked examples. A board clear of a slope is held to no overlap,
and one that runs into it to the deepest overlap along each axis. A block
resting where a notch took the wood is held to floating. Each new problem
has a pass and a fail with its words pinned: wood left too thin, a joint
with no wood where its parts meet, a housing that runs out into a cutout,
and a cut into a mortise, a half lap or a slot. Screws are held to spreading
over the wood a cut leaves. `gap_x`, `gap_y` and `gap_z` are held to exact
numbers on a slope, on boxes and on parts at right angles. An invented
drawer checks a rule that reads the blank's top and fails, where the gap
to the slope passes.

The pictures of a cut part have tests of their own, on an invented tray
with sloped sides and a panel with a round hole, a slot and a notch. The
plan views are held to the side's true outline from each side, to holes
drawn open by the even-odd rule, and to walls hidden behind wood left out.
The workshop drawings are held to the slope's angle, the height at each
end, each hole's place and size, and a part turned over for its machining.
The record console's two sides have their grooves at the back. One is
turned over, so the tests hold each sheet to naming its views and the edge
it measures up from.

### Details and centres on a part's sheet

An invented record rack's rail, 1500 long and 45 wide with three pairs of
fins housed 4 mm apart, holds the details of spots too small to read. Its
sheet is held to the detail's chains and scale, to the three pairs sharing
one detail, and to the main view keeping where each pair starts. The
record console's drawer side holds a narrow gap's number written past the
end of its row. An invented hall frame holds Domino mortises set out by
their centres. Its rails are held to each centre on the chains and in the
notes, and to the middle they're set out from. The Domino tests hold a
joint's tight and loose mortises to sharing their centres. The rule for a
part's face side and face edge is held on invented boxes, and the hall
frame's two rails are held to giving the same brace mortise the same
place from their face edge.
Every example's part sheets are held to no text printed over other text,
and to no two narrow gaps side by side in a row, except at either end.
The views, the drawings and their PDF of every example with no cuts have to
match fixed digests.

### Stopped housings

A dado that stops short of an edge is tested on an invented wall shelf,
with two sides and one shelf housed in both. The stop as an edit is held to
the edges it takes, its expressions and each refusal's words. A stop at the
front, at the back and at both is held to where the housing runs, to the
notch at each of the shelf's corners and to its words on the cut list. A
shelf set back past its stop needs no notch, and a stop of 0 derives as no
stop. Each check has its words pinned, for a stop that leaves no housing,
less than half of it, under 6 mm before the edge, or sits on the wrong
edge. A shelf with a cut is held to its tongue's outline with the notch
left out. The see-through plan has to draw the housing 10 mm short of the
front, and the plain views can't change. The drawings are held to the stop
in the side's chain and the notch in the shelf's. The stopped worked
example of a dado, a groove, a rabbet and a dado and rabbet has to build
with no errors. A stopped dado and rabbet notches only the tongue.

A scripted Claude builds an invented wall shelf with its dados stopped at
the front and shows a stopped dado, and the chat's card says it's stopped.
`add_joint` is held to its stop's fields, and the refusals for a stop on
screws or of the wrong shape have their words pinned. `list_joints` has to
offer a stop on a dado, groove, rabbet or dado and rabbet only, and so
does `show_joint`.

### Finishes

The finish tests hold every tinted Linolie colour to its photo on Douglas fir,
to within a shade the eye can barely tell. They check that no tint leans away
from its oil's own colour, and that a dark oil gains no colour on pale
timber that its photo lacks. Kyoto has to stay near-black on every timber,
and the Osmo oils stay as modelled. A test also fails when a stored tint or
pigment differs from what `scripts/fit-oil-colours.ts` would write.

The finished look of the views is tested on an invented bedside cabinet.
Each face has to take the colour its finish gives on its timber, by the
colour cards' own arithmetic. That finish comes from the face, its part or
its material, and a face with none shows bare timber. An array's copies
take their original's finish, and a stand-in stays hatched. A shaped panel
keeps its holes open in its finish, and a slope takes its top's. The plain
look has to stay the same whatever the finishes.

### The server

The server tests in `packages/server/test` drive the whole app through its
HTTP API with stand-ins for every outside service. A scripted Claude plays
back fixed replies, so the turn loop, previews, questions and tool requests
run for real without a key. One scripted reply can carry many tool calls.
The tests hold those calls to running in order, each with its result, and
to one undo step for all of them. A failed call leaves the rest running, and
only one question, plan, part or preview can wait at a time. One call can
carry a list of edits too, and every edit in it is checked before any
runs. The tests hold the list to the same order and one undo step. They
check that a refused edit stops it with the edits before it kept, and that
the problems come back once for the whole list. Every request
asks the API to drop earlier thinking that a changed prompt, tool list or
workshop doesn't match. A table of invented messages pins the level each
turn thinks at. The turn tests hold an effort message to going in only when
the level changes, and the request's own settings to staying the same all
chat long. A tool that needs judgement raises the level for the rest of the
turn, and with routing off no effort message goes in. Stand-ins also
take the place of OpenAI, GitHub, Tailscale and the picture camera, which
is why a test can't send anything anywhere. A software passkey signs the
passkey tests, so the whole sign-in runs without a browser. Any test that
needs a repository names one from the roster, such as `globex/woodchuck`.
With none named, the tests check that the app never calls GitHub, and that
a missing tool's issue quotes the design only when asked.

The workshop tests hold Claude's standing instructions to two blocks, with
your workshop last and the cache breakpoint on it. The same settings give
the same bytes, and a change touches the workshop block alone. They also
check what the workshop's route saves and what it refuses, and that
`WOODCHUCK_SEARCH_COUNTRY` wins over the workshop's country.

The cache tests hold both of the request's cache breakpoints to an hour,
with no beta for it. With `WOODCHUCK_CACHE_TTL=5m` both go back to the
API's default, with no lifetime named. A value the app can't read means
an hour, with one warning. Every request in a turn has to match the first
byte for byte, apart from the chat, and so does the next turn's. A change
to the setting mid-turn waits for the next turn.

Talking and editing while Claude works have tests of their own. A message
or an edit arrives while the scripted Claude is mid-step, and the tests
check where it lands in what Claude is sent next. They hold each edit to
an undo step of its own between Claude's, and the history to only
growing. A message Claude didn't read starts the next turn, and the busy
flag a restart waits on never drops between the two. The MCP tools run
against a live app on the same stand-ins, timed, with their background
block held to the agreed shape. The size tool is held to one undo step
mid-build, to refusing a name or formula that doesn't work, and to waiting
for a yes on a big change. A test reads the MCP server's own imports, and
fails if it runs any of Woodchuck's woodworking code beyond its tools'
fixed inputs. Its reply has to name each new problem. The
view tool is held to opening a tab and telling the calling model to open
Make for the cut list. Every tool's description has to fit in the 900
characters Crossband reads.

### Claude's cut tools

Claude's cut tools are tested on an invented drawer whose sides slope from
a tall back to a low front. Each tool is held to the shape it leaves, to
the words of each refusal and to undoing with the turn. A list of edits
builds a sloped side and a holed back, and a refused cut stops it with the
edits before it kept. A suggested slope waits for Apply, and an edit's
result names a part whose shape alone changed. A pin on the slope or on a
hole's wall names its cut, and another chat reads each part's shape. A
scripted Claude slopes the sides and measures the room under a rail with
`gap_y`, and the checks find nothing wrong.

### Drawer joints

The core tests build an invented drawer box in 12 mm ply with a 6 mm ply
bottom. Its bottom sits in grooves in the sides and front and slides in
under a back that stops on top of it, and its corners are rabbeted. Every cut size
and every line of machining is pinned, and so is a bottom that grows on
all four edges when the back has a groove too. The workshop drawings are
held to each groove and rabbet in their chains and notes, and the finish
areas to what the parts give with no joints at all.

Each check has a pass and a fail with its words pinned. A groove can be
too deep, too near the edge, too narrow for its panel or loose on it. A
rabbet can leave no lip or have wood on both sides. The dado and rabbet's
worked example pins its tongue to the face away from the side's end, and a
thick tongue leaves too little short grain.

A scripted Claude reads the joint library, opens the dado and rabbet's
worked example and builds the same box in two lists of edits. The library
is held to saying where a drawer bottom and a drawer's corners go, and the
joints to leaving no problem at all. A groove narrower than the bottom
comes back with its error, and a groove given both a width and a fit is
refused.

### A plan's key sizes

The plan tests run a scripted Claude on an invented bookcase, with a shelf
repeated up its sides. A plan whose key sizes match the model pins and
waits, and the plan on its card carries the model's number for each size.
A plan that gives the shelf pitch as the clear gap between shelves is
refused, and nothing is pinned. The refusal is held to its words, which
name the size, its expression, what Claude expected and what the model
gives. A plan with an expression that names a missing part, or that gives
true or false, is refused the same way. The core tests hold each key size
to the number it works out to, or the reason it can't. The web tests hold
a plan's card to the model's number for each size.

### A joint on one copy

The core tests hold a joint on one copy to an invented bookcase, with
three shelves housed into its sides. A drawer divider's top is housed into
`shelf#2` alone, and its foot is pocket screwed into `shelf#1`, the
original alone. The dado lands on `shelf#2` and nowhere else, while the
shelves' own dados repeat on all three. The checks find nothing wrong, and
the see-through view shows the housing in `shelf#2` alone. The cut list
gives `shelf#2` a row of its own, named for it, and the drawings give it a
sheet. A copy named as the guest is lengthened into its host, and gets a
row of its own too.

A count that rises keeps the joint on `shelf#2`, and a new pitch moves it
with the shelf. A count of one, or a deleted array, leaves the joint as an
error with its words pinned, and turning the count back up derives the
design as it was. The refusals of a copy past the count, a copy of a part
in no array and a copy number that can't be read are pinned too. Deleting
a part takes the joints on its copies with it. Every example keeps its
fixed digest, since none has a joint on a copy.

The server tests run a scripted Claude that builds the bookcase and houses
the divider into `shelf#2`. The edit's result gives the divider's new
length and no new problem, and a copy past the count is refused in words
that name the copies there are. A `set_array` that leaves one shelf comes
back naming the joint's problem. The tool descriptions are held to the
divider example, and to the warning that a joint follows its copy's
number. The web tests hold a joint on one copy to picking that copy on
screen.

### Requirements and the whole piece

The core tests hold `overall.width`, `overall.height` and `overall.depth`
to an invented hall cabinet on plinth runners. Its back is fixed on behind
its sides, and its top overhangs them. The box takes in the back, the
runners, the top and a stand-in, and leaves out a prop and a handle. A rule
on the overall depth fails while the back sits behind 300 mm sides, and its
working names the back and a side. It passes once the sides give up the
back's thickness. A parameter or a part's place that reads the whole piece
is refused, and so is a part called `overall`.

The server tests pin the words in Claude's instructions and in `set_rule`
that ask for a rule in each direction a requirement limits. They also pin
the words that hold an overall size to the whole piece. Every rule those
words quote has to work out on the record console. A scripted Claude builds
an invented bookshelf 300 deep with its back behind the sides.
`check_design` shows it the failing rule, and Claude takes the back's
thickness off the sides until the checks pass. The benchmark's depth check
reads the same 300 mm.

### Drawers on wooden runners

The core tests hold an invented bedside cabinet, too shallow for 450 mm
slides, with two drawers on oak runners. Each runner is a row of timber on
the cut list with its size, the hardware list is empty, and the cut list
says to wax the runners. A drawer that touches the carcass side is an
error, one with 0.3 mm of room is a warning, and 0.5 mm passes. A drawer
that touches the next drawer's runners over it is an error, and so is one
screwed to its runner. A runner held in a groove needs a fit of 0.5 mm. A
drawer on a shelf counts the shelf as its runner, and a partition fixed on
the same shelf is left alone. `set_hardware` refuses wax glides with
nothing to buy, in pinned words, and a design that already holds them gets
a warning.

The server tests pin the words in Claude's instructions and tools that
send it to runners. A scripted Claude reads an AcmeCo slide too long for
the cabinet, builds the carcass and tries wax glides. The refusal sends it
to runners, the checks pass, and the cut list has the runners and nothing
to buy.

### Dominos

The core tests join an invented bedside carcass in 18 mm ply with Dominos,
and a face frame's rail to its stile. The size, count, depths and play the
joint picks for itself are pinned, and so is every mortise's place in both
parts. Each pair is held to lining up, with 6 mm of play in every one of
the host's mortises and none in the guest's. No part changes size, and the
carcass has no problem. The cut list places every mortise, and the hardware
list buys each size as its library part, counted from the joints and from
an array's copies.

A single Domino gets its 6 mm of play in the host too. The tests move the
play to the guest with `loose`, cut both pieces tight with a fit of 0, and
take the widest setting with 10. The tenons to buy stay the same, and the
checks measure the guest's longer mortises against its edges and each
other. The edit refuses `loose` on any other joint, or as anything but host
or guest, and a changed `loose` takes adding the joint again.

Each check has its words pinned. A mortise can leave too little wood behind
it or come out the far side, sit too near an edge or too near the next, or
break out of the part. Thin stock leaves thin walls, and a Domino over half
the stock is too thick. A depth the DF 500 has no stop for, a guest mortise
it can't reach, a size or a fit from a parameter that it can't cut, a cut
into a mortise and a mortise into a dado each have theirs too. The edit
refuses a size Festool doesn't make and a fit that isn't a joiner setting.
The worked example builds with no problem, and its drawings are held to
each mortise in their chains and notes.

The server tests pin `add_joint`'s words about when to use a Domino and
which piece takes its play. A scripted Claude reads the joint library,
opens the Domino's worked example and builds the carcass in two lists of
edits with no problem and one undo. Its cut list has the tenons to buy, and
a Domino Festool doesn't make is refused. Another puts the play in the
carcass sides with `loose`, and hears why `loose` on a dowel joint, a
part's id given as its value and a changed joint sent again are each
refused. A test holds the library's Domino files to the joint's sizes and
their sources to Festool's own sites.

### The exploded view

The core tests pull every worked joint apart and check that its guest
comes off its host along the joint and stands clear of it. An invented
table of four legs, four rails and a top comes apart in order. The base
drops off the top as one frame, and each end frame slides off the long
rails before its leg comes off its rail. The record console's drawers
slide out the front. The tests step through the slider two thousand times
and check that no two parts ever overlap more than they do together. Two
parts whose joints hold each other every way come apart through each
other, rest clear, and the plan names them. Every joint of the table and
the console, pulled apart on its own, rests clear of every part. A table
rail held at both ends stays, and its leg slides off it instead. The
table's last stage fans it out, with the top going up, the rails up and
out, and each leg out past its own corner. Stepped through the slider,
the table and the console never go under the floor, and the table rises
as its base drops off its top.

The core tests cut through every worked joint and check that both views
carry sizes and stay on the paper. A tenon's chain gives its cheeks, its
thickness and its shoulders, and a dado's gives its depth and the wood it
leaves. A half lap splits into equal halves, a box joint into equal
fingers, and a dowel crossing the cut is drawn solid. A joint's sizes
mark the library's usual settings, and its cuts read as the cut list
words them.

The server tests stand in a window that answers a screenshot. The
picture comes back to the MCP client as an image, the same each time, and
the window hears whether the room photo was asked for. With no window
open, the tool says so. The web tests hold the line of words with a
screenshot.

The server tests send `woodchuck_undo`, `woodchuck_redo` and each of
`woodchuck_designs`' actions twice. The second send changes nothing and
says so. Only the latest change undoes, a delete waits for `confirmed`,
and a design of the same name is refused. The window's own Undo names its
change the same way. A restore, a photo's removal and a blend wait for
`confirmed`, a second restore finds the design already as that version,
and the photo's lens and shadow reach the window the same each time.

The read tool is held to the record console's right side, word for word,
with its views and the sides it's measured from. It's held to narrowing by
a part's id, a copy, a row number and a name, and to naming the parts when
one isn't found. Each list it reads has a line pinned, the file reads back
as the design, and two sends read the same and change nothing.

The web tests hold Explode to its place in the toolbar, its key and the
reasons it greys out, and a command from outside to the state it leaves.
A joint's section shares the drawer's joint slot, beside a preview.
The server tests hold `show_joint` with a joint's id, the card it leaves
in the chat and the refusal of a joint the design doesn't have.

### Your own stock and the cutting plan

The core tests build an invented hall stand of pine stiles and rails with
a ply back. One board you own takes all six parts, ripped two side by
side, and nothing is bought. A shorter board leaves the rails to buy at
their own width, and boards you don't need are listed as left over. A
board too narrow for any part is left alone. Your own sheet goes first,
with no trim. Every part stays inside its board and a kerf from the next,
and the plan is the same every time. With the widths a yard sells, each
part takes the narrowest that holds it. The tests also hold the letters,
the cut list's Board column, the plan in words, and `set_stock` merging
sizes and clearing with null.

The printed plan fits one page for the stand, says what's yours and what
to buy, and labels each ripped part with its rip. Thirty long slats go on
to a second page. The server tests hold the plan's PDF route, Claude's
`set_stock` tool and the plan `get_cut_list` reads back. They send
`woodchuck_stock` the same list twice, and the second send changes
nothing.

### Edits Claude nearly got right

The core tests hold an invented plant stand to how an edit reads what it's
sent. Wherever an expression goes, a number can come as a JSON number or
in one pair of matching quotes. Mismatched quotes, a quoted name or sum,
and a value that's neither text nor a number are all refused. The same add
sent again hands back the design untouched, for every kind of add. A
different part, joint or stand-in under a taken id is refused, and the
refusal shows the one that's there. A thickness axis given a start and an
end is held to words that name the material's thickness and the span to
send, in the edit's own values. Each field that takes a list or an object
has a case of the wrong shape, and its refusal has to end on an example of
the right one.

The server tests send a list of edits that's refused partway, then send it
whole again. The second list runs to the end, names the edits that were
already there, and leaves one undo step. A different joint under a taken
id stops the list, and a single edit that's already there says it changed
nothing.

### Claude's pictures

`render_views` is held to the plain look unless Claude asks for the
finished one, and to refusing a look it doesn't have. Its words say when
the colours are estimates. The plain look's sheet has to match the core
sheet byte for byte. The record console takes two invented finishes, and
the finished sheet has to show each one. A scripted Claude sets those
finishes and asks for the finished look, and gets a picture of it back.

### Summaries of a long chat

The summary tests use a scripted Claude that answers requests for a
summary apart from turns, with token counts the test sets. With the
setting unset, they hold every request to the API's own summary at
100,000 tokens, with no summary between turns and no summaries file. With
it set, a summary starts only once a turn ends past the threshold, and
never while Claude waits on an answer or a message waits to be read. It covers
the turn's last request, sent with that request's model, instructions,
tools and thinking. The next request sends it first, as the API returned
it, and the saved chat only grows. A turn that starts while it's written
never waits, and gets it at its next step. A summary that fails, comes
back empty or lands after the chat moved on is dropped. After one fails,
the next try waits for 20,000 more tokens or an hour. A single long turn
on a chat that already holds a summary gets one between two steps. The
summary's instructions are held to keeping the woodworker's answers and
the sizes they asked for.
The restart gate names a summary being written, and closing the app
abandons it.

The signature tests run the real SDK client on a fake API, through a fake
`fetch`. A summary block keeps its signature whichever event carries it:
the block's start, its compaction delta or a signature delta. It's saved
with the signature and sent back as stored. A chat whose older summary has
no signature is summarised from the whole saved chat, unless that's too
long for one request. A request the API refuses over a stored summary goes
again once with the chat in full, and so does every later one in that chat.

The size tests hold the whole chat to a fake token count. It's asked with
the summary request's model, instructions, tools, thinking and betas, minus
the web tools the count refuses. A chat is counted once for each length,
and one over the model's limit isn't counted again. When the count fails,
the rough count stands in. It counts a picture as 5,000 tokens and a
document as 30,000, wherever they sit, and never reads a signature or
encoded data as words.

### Warming the cache

The warm-up tests use a scripted Claude that also answers a request sent
whole, and a clock the test moves. A warm-up goes when a design is opened,
a window comes into view or an MCP tool is called, once the design's last
request is older than the cache lasts. The tests hold it to none within
that time, on either lifetime. They also allow none for an empty chat, none
while Claude works or a summary is written, and none with
`WOODCHUCK_CACHE_PREWARM=off`. A failed one waits a cache lifetime too. A
turn that starts stops one on its way, and so does closing the app. The
restart gate never waits on one.

The warm-up has to match the next turn's first request byte for byte, in
everything but its size and where its cache point sits. That's checked on
a plain chat, on one with effort messages and a stored summary, and on one
waiting on Claude's question. A chat at the size where the API summarises
it isn't warmed. Each warm-up's tokens go in `warmups.json`, the chat stays
as it was, and turn-stats counts them apart from the turns. In the web
tests, a window asks for one as it opens in view and each time it comes
back, and never while it's out of view.

### Timing, dropped connections and backups

Each turn's usage line is held to its timing on a fake clock. That covers
every request to Claude, the level it ran at, the wait for its first
streamed words, its tokens and tool calls, any retries, and the time the
tools took. An apply_edits call counts as one call, with its edits counted
beside it. The turn stats script runs on a data folder the test invents,
and has to print numbers and nothing from a chat or a design.

A stand-in that drops the connection mid-reply checks that Claude's
request is sent again, and that the cut-off words leave the chat. A turn
that an error or Stop ends has to say so to other apps and to the next
turn, and never leave the typing cursor behind. A message sent during a
reply that's cut off mid-tool call goes in after its not-run results, and
answers no plan or question.

The backup tests run on a clock they're handed. They hold the app to a
snapshot at every start, taken before the store touches the data, and to
the interval by the wall clock across a computer's sleep. They check the
counts kept in `data/backups` and the mirror, that every snapshot and its
folder are private, and that a failing mirror or backup never stops the
app. A snapshot unpacked with `tar` has to open every design as it was.

### The web app

The web tests in `packages/web/test` cover the logic kept out of the
components, such as box select, face picking, the AI blend's sizing and
its not-to-scale label, how Claude's replies are drawn and which face the
lock screen shows. They also hold the theme choice, the script that sets it
before the first paint, and the themes' colours, which must read on every
surface and stay out of the stylesheet. Others hold the buttons each of
Claude's waiting moments offers, how a turn's steps fold into one line,
and the timing line at each turn's foot.

A table in a reply is held to its header, its rows and each column's
alignment, with bold and code inside its cells. A short row is padded and
a long one widens the table. Pipes that don't make a table stay as text,
and nothing in a cell becomes markup.

The floor grid is held to a sheet just wide enough for its fade, kept
under the camera, that never reads or writes depth. In three.js's own
draw order it has to come before every part, ghost and mark, wherever the
camera is.

A cut part's mesh is held to a closed solid with every triangle facing
out, to the volume its shape holds, and to the face each triangle counts
as. A click on its slope has to pick the top, and a click through a hole
has to miss it. A change to a part's shape alone has to show in a suggested
change's ghost and in Claude's glow. The cutting layout has to shade the
wood a part's cuts take from its blank.

### Controls, following and the phone

The toolbar tests hold its groups and menus to fixed slots, and check
that every view command from another chat lands on its control. An orbit
from another chat is held to the same turn at any frame rate, to easing
in and out, and to stopping for a camera view or the plan views. A frame
asked for as the window opens is held through the view's first fits,
until Fit, a camera view or another design. The
side panel's tests hold where each panel lives in the five tabs and on
the All designs and parts page, that picking a part opens Edit, and that
the status pill opens Check. A suggested change is held to the parts it
moves, the size of each move, and its Now and With the change sides. A
view command's drawer and highlight land on the model, the drawer and
Edit, and a tab opens with the side panel. Check's fixes name the problem, and Show me picks the parts a rule
reads. Each item in the design menu calls its own endpoint. The keyboard
shortcuts stay quiet in fields, and the model frames itself again only
when it should.

The follow tests hold where each of Claude's tools shows on screen, and
fail when one of Claude's tools has no place named. A cut opens Edit on
the part it shapes, and the camera frames a part whose shape alone
changed, with its array's copies. They hold that the
screen follows Claude tab by tab and gives each tab its time, and that
any touch stops it for the rest of the turn and keeps the tab you chose.
They also hold the order Show me how plays a turn in, and each step's
link to its control. The clock is passed in, so the tests run on a fake
one. Claude's instructions are held to naming the five tabs and what each
holds, and each tool they say opens a tab has to open it.

The phone layout's tests hold the bottom sheet's heights and where a drag
of its handle comes to rest. They check the 640 px breakpoint, and that
code opening a tab or the side panel opens the sheet at that tab. Box
select by touch is held to its two fingers and its taps. The stylesheet
is checked for controls under 44 px and fields under 16 px, and the page
for anything that blocks pinch zoom.

### Cuts made by hand

The Shape section's tests run on an invented hall cabinet. Each Add button
is held to the cut it starts with, such as a slope down to two thirds of a
side's height, a 35 mm hole in the middle of a back, or a toe kick notch at
a side's bottom front. The operation a cut's fields make is held to its
numbers, sums and faces, and the fields a cut shows have to make the same
cut again. While you type, the section has to show the design's own words
for the cut, the reason it refuses a change, or the cut's problems. The
change's ghost has to fall on the part it shapes. The editor's drawing of
the face is held to the edge it lights and the wood left at each end of a
slope, and the cut list to each shaped row's notes.

## The acceptance test: the record console

The record console is a long, low cabinet for vinyl records, and every
change has to keep its test passing. It opens from the design menu as an
example, and `packages/core/test/console.test.ts` builds it with the same
operations Claude uses. Its inputs are a 2040 × 520 × 30 mm top, 30 mm
carcass panels, and one row of five drawers for 12 inch LPs. An LP sleeve
is about 315 mm, so the design has a rule that each drawer is at least
320 mm wide inside.

- The carcass is flush with the top, with two sides and four partitions at
  30 mm. That leaves five openings of 372 mm each.
- Side-mount slides take 12.7 mm a side and the drawer sides are 15 mm, so
  each drawer is 316.6 mm inside. The LP check fails, and its trace shows
  every number it used.
- Undermount slides take 5 mm a side. With those, each drawer is 332 mm
  inside and the check passes. Only the drawer bottom, front and back rows
  of the cut list change.
- A new top length moves every opening, drawer part and cut-list row that
  depends on it, and nothing else.
- Housed parts are cut longer than they show, and the cut list says by how
  much. Identical parts group into one row, and mirror images stay apart.

The test's plan also calls for a load check, about 75 LPs a drawer against
the slide's rating, and a check that a solid top is held with fixings that let
it move. Neither is built yet.

## What the Python tests hold

- `tests/test_doc_style.py` holds every markdown file to the writing rules
  in [CONTRIBUTING.md](../CONTRIBUTING.md). It also checks that the docs
  index links every doc and that [CONFIG.md](CONFIG.md) names every
  setting the code reads.
- `tests/test_changelog_fragments.py` checks that every `changelog.d`
  fragment can fold into the changelog at release.
- `tests/test_secret_scan.py` checks that the tree scans clean, and that
  the leak scanner matches Crossband's copy, which Woodchuck shares.
- `tests/test_tailscale_serve.py` runs the tailnet serve script against a
  fake `tailscale` command. It checks that the script never runs Funnel,
  refuses while Funnel is on and skips cleanly without Tailscale.

## Timing Claude's turns

Each turn's usage line keeps how long it took. It holds the model, the
rule that picked the turn's level, the whole turn's time, the time the
tools took, and a record for each request to Claude. A record has the
level the request ran at, its time, the wait for its first thinking or
words, its tokens and its tool calls. An apply_edits call counts once,
and the record keeps the number of edits it listed apart. The chat shows
the time and the number of requests at each turn's foot.

The stats script sums them up across every design in a data folder, and
changes nothing. It names the folder you give it, or reads
`WOODCHUCK_DATA_DIR`.

```bash
npx tsx scripts/turn-stats.ts [data-folder]
```

It prints a line per turn, then the median and 90th percentile of rounds,
seconds and tokens. It also gives the share of requests that carried more
than one tool call, and how often a turn started on a cold cache. It
tallies the level of every request and the rule behind each turn, and
the edits made through apply_edits. Warm-ups of the cache aren't turns,
and it sums up their tokens, times and what set them off on a line of
their own. Designs
are numbered, and it prints no names, chat text or design content. Turns
from older chats have no timing of their own. The script rebuilds their
rounds and tool calls from the saved conversation, and their seconds from
the chat's timestamps.

## The quality benchmark

The quality benchmark sends invented tasks to Claude for real, through the
same turn loop the app uses, and checks what comes back. A faster setting,
such as less thinking on a turn, has to keep every check passing. A lost
requirement or a wrong size costs timber, and can make a piece unsafe.

It needs an Anthropic key and the `--live` flag, costs money and never
runs in the tests or CI. Each run gets a throwaway data folder, so your own
designs are never touched.

```bash
npx tsx scripts/bench.ts --live [--tasks height,lp-fix] [--repeat 2] [--configs routing,no-routing,medium]
```

`--tasks` picks some of the tasks, and all of them run when you name none.
`--repeat` runs each task that many times, two by default, so you see how
much a result varies. `--configs` compares settings side by side in one
run. Each config runs in a process of its own, since the app reads the
model and effort once at start.

- `current` keeps your environment as it is, and runs when you name no
  config.
- `routing` lets each turn pick its level, up to `WOODCHUCK_EFFORT`.
- `no-routing` holds every turn at `WOODCHUCK_EFFORT`.
- An effort's name, such as `medium`, holds every turn at that level.
- `routing-xhigh` and the like let turns pick up to that level.

`WOODCHUCK_MODEL` picks the model for every config, and
[CONFIG.md](CONFIG.md) says what the effort settings do.

### What it costs

The script prints its estimate and waits five seconds before it sends
anything, so Ctrl-C can stop it. The estimate adds up each task's own range
for the model you picked. On Sonnet 5.5, one pass of every task costs
roughly US$1.80 to US$5.80. Three configs with two repeats cost six times
that, about US$11 to US$35. Opus 5.5 costs about twice as much. The build
and the bookshelf cost the most, and the two questions the least.

Ctrl-C during a run stops it, and the runs that finished are still summed
up and saved.

`--dry-run` plays a stand-in for Claude that answers every message with
one fixed line and changes nothing. It needs no key and costs nothing, so
it tries the script itself. Every check that needs a change fails on a dry
run.

### What it prints

The script prints a line for each run as it finishes, with the reason for
each check that failed. A table follows, with a row for each config and
task. It shows how many runs passed, which checks failed and how often,
and the median seconds, requests and cost of a run. Each config then gets
a verdict, such as "all quality checks passed in 14/14 runs".

Every run's checks, timings, levels and tokens go into a JSON file in the
system's temp folder, so you can compare runs later. The script prints its
path. It never prints Claude's words, and a reason holds only numbers and
ids from the design.

### What each task checks

Every task also checks that each turn finished without an error. Expected
values come from the starting design wherever they can, so a change to the
record console example moves them with it. When Claude stops to ask, plan
or suggest, the script says to go ahead, up to three times a message. It
applies a waiting preview and approves a waiting plan first, as the app's
buttons do. A task can answer a question it expects instead. The bookshelf
task answers "in total" when Claude asks whether two more shelves means two
in total or two in each section.

| Task | What it sends |
| --- | --- |
| `height` | "Make the carcass 50 mm taller." on the record console. |
| `colour` | "Oil the whole console in a dark walnut colour." on the record console. |
| `lp-fix` | "The LP check fails. Change the drawers so 12-inch LPs fit, and tell me what you changed." on the record console. |
| `build` | The record console's spec, on an empty design: a 2040 × 520 × 30 mm top, 30 mm carcass panels, about 400 mm tall, and one row of five drawers that hold 12 inch LPs. |
| `question-bay` | "How wide is each drawer opening?" on the record console. |
| `question-height` | "How tall is the whole console?" on the record console. |
| `requirement-kept` | A bookshelf 900 mm wide and 1800 mm tall in 18 mm birch ply, whose shelves take 30 kg without visible sag. Then two more shelves, 300 mm deep, and a light oil, a message each. |

| Task | Check | Passes when |
| --- | --- | --- |
| `height` | `sides-50-taller` | Each carcass side is 50 mm taller. |
| | `overall-50-taller` | The whole piece is 50 mm taller. |
| | `height-param-moved` | The parameter that sets the sides went up 50 mm, so its slider still drives them. |
| | `footprint-kept` | The width and depth are as they were. |
| | `drawers-kept` | There are as many drawers as before. |
| | `other-sizes-kept` | Every other slider keeps its value. |
| | `no-new-errors` | The checks find no error the start didn't have. |
| `colour` | `every-face-finished` | Every face of every part has a finish, set on its material, its part or the face. |
| | `one-finish` | Every face has the same finish, from the colour cards. |
| | `dark` | The finish has a lightness of 45 or less on each part's own timber. |
| | `walnut-brown` | Its hue on each timber runs from red to orange, and it isn't grey. |
| | `geometry-kept` | No part moved, changed size, appeared or went, and no parameter, joint, array, hardware or rule changed. |
| | `timber-kept` | No material changed thickness or the timber it shows as, so walnut can't come from swapping the timber. |
| | `no-new-errors` | As for `height`. |
| `lp-fix` | `not-weakened` | The `lp_fit` rule keeps its expression and stays an error, and no parameter it requires, such as `lp_clear`, went down. Otherwise it fails as "weakened the requirement". |
| | `lp-fit-passes` | `lp_fit` passes on the first drawer and on each array copy. |
| | `lps-fit-width` | Each drawer is at least 315 mm wide between its sides, the width of an LP sleeve. |
| | `lps-fit-height` | Each drawer has at least 315 mm from its bottom to the carcass over it, so LPs stand up. |
| | `drawers-kept` | There are still five drawers. |
| | `width-kept` | The width is as it was, unless the reply gives the new width. |
| | `says-what-changed` | The reply names a parameter that changed, by name or new value, or a part that moved. |
| | `no-new-errors` | As for `height`. |
| `build` | `top-size` | A part measures 2040 × 520 × 30 mm. |
| | `carcass-30` | At least three carcass panels, such as sides, a bottom and partitions, and every one of them 30 mm thick. |
| | `height-in-range` | The whole piece is 380 to 440 mm tall. |
| | `five-drawers` | There are five drawer fronts. |
| | `one-row` | The fronts all start at the same height. |
| | `lp-rule` | A rule names LPs, records, vinyl or sleeves, so the requirement is kept as a rule. |
| | `lp-rule-passes` | That rule passes on every drawer. |
| | `lps-fit-width`, `lps-fit-height` | As for `lp-fix`. |
| | `no-errors` | The checks find no errors. |
| `question-bay` | `answer-gives-bay` | The reply gives the `bay` parameter's value, 372 mm on the example. |
| | `design-unchanged` | Nothing in the design changed. |
| `question-height` | `answer-gives-height` | The reply gives the overall height, 430 mm on the example. |
| | `design-unchanged` | As for `question-bay`. |
| `requirement-kept` | `width-900`, `height-1800`, `depth-300` | The finished bookshelf has that size, to within 0.5 mm. |
| | `birch-ply-18` | At least three sides, shelves, tops or bottoms, every one 18 mm birch ply. A back or a lip can be anything. |
| | `load-rule` | A rule about load, sag, weight or span exists at the end. |
| | `load-rule-every-turn` | One existed after every message, so no follow-up dropped it. |
| | `load-rule-passes` | It passes. A warning that fails passes only when a reply mentions sag. |
| | `two-more-shelves` | The second message added two shelves, and later ones kept them. |
| | `every-face-finished`, `one-finish` | As for `colour`. |
| | `light` | The finish has a lightness of 65 or more on each part's timber. |
| | `no-errors` | As for `build`. |

### How the checks read a design

A drawer is counted by its front. That's a panel named or tagged drawer
that faces forward, with no bigger drawer panel in front of it, so a
handle or the box behind a false front doesn't count. The room inside a
drawer is measured between its two side panels, and from its bottom up to
the lowest carcass part over it.

Lightness runs from 0 for black to 100 for white, as the eye sees it. It's
worked out from the colour the app draws for that finish on that timber,
so the same oil can pass on pale birch and fail on walnut. Shelves are
counted twice, as parts named shelf and as every flat panel, and either
count will do.

A number in a reply counts when it's within 1 mm of the one expected. It
can be written as `372 mm`, `372mm`, `372.0` or `37.2 cm`. Numbers inside
ids, such as `ply15`, don't count.

`packages/server/test/quality.test.ts` holds every check to a pass and a
fail on designs it makes. It also runs a task through the turn loop with a
scripted Claude, and the script itself on a dry run.

The live summary check tries a summary between turns on the real API,
under the same rules as the benchmark. It needs a key and `--live`, warns
of the cost and waits five seconds before it starts. Its invented chat
lives in a throwaway data folder.

```bash
npx tsx scripts/summary-check.ts --live
```

The chat states that every drawer must hold 12-inch LPs and answers a
question Claude asks. It grows until the API summarises it inside a
request, then asks for a summary between turns and runs one more turn.
That turn sets `prefix_mismatch_behavior` to `"error"`, so kept thinking
that fails the API's check fails the request. The script prints `PASS`,
`FAIL` or `SKIP` for each check, `INFO` for what the API does that isn't a
fault, and the summary's length but never its text.

- The API's own summary is stored with its signature. The line names the
  stream event that carried it. The API doesn't sign a summary it writes
  inside a request, so that's an `INFO` line. It fails only when the
  stream carried a signature the app didn't keep.
- The summary request comes back with `stop_reason` `"compaction"` and
  `usage.iterations`.
- It reads from the prompt cache.
- The API accepts it on a chat that holds an older summary. It's sent from
  that summary when it's signed, and as the whole chat without it when not.
  The line gives the whole chat's size and what measured it.
- The summary keeps the early requirement and the answer.
- The next request carries the summary as stored, with no 400.
- The kept turns' thinking passes the check, with no input
  transformations.
- No request was refused over a stored summary.

## Trying the chat without a key

Point `WOODCHUCK_SCRIPT` at a JSON file of replies, and Woodchuck plays
them back in place of Claude. Each entry is one reply's content blocks, the
same shape the API returns. Use a throwaway `WOODCHUCK_DATA_DIR` at the same
time, so the trial never touches your designs.

A block like `{"type": "delay", "ms": 2500}` holds its reply back that
long and never reaches the chat. Put one in each reply to try a long
build, then send messages and edits while it runs. Tests hold a reply
with a gate block instead, which waits until the test opens it, so the
tests of a build in progress pass however busy the machine is.
