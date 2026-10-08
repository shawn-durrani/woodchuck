# Architecture

Woodchuck is a furniture planner you talk to. You and Claude edit the same
design, and the app turns it into a 3D view, plan views, a cut list and
checks you can trust before you cut timber. Each heading here is a decision
that's settled, with the reason for it.

## The shape

```
packages/core     the model, in pure TypeScript: types, expressions,
                  sizes worked out, checks, cut list, joints, species,
                  finishes and plan views
packages/server   Node on 127.0.0.1:8905: the API and WebSocket, the
                  Claude turn loop and its tools, the store and version
                  history, pictures, the AI blend and the MCP server
packages/web      React and three.js: the 3D view, the chat and the panels
data/             designs, chats, pictures and history, and approved parts
                  waiting to merge, which git ignores
library/parts     real parts you've approved, shared in the repo once
                  their pull request merges
```

The web app and Claude change a design through the same operations in
core. The server keeps one design open at a time and sends every change to
each open window.

## Claude changes a design only through tools

Claude can't write code or pick from furniture templates. It edits with a
fixed set of woodworking tools, such as adding a panel, a joint or an
array, and each one checks its input and does its own arithmetic. One more
tool takes a list of those same edits and makes them in order. A piece
of furniture is anything those tools can express, so there's no catalogue
of shapes to outgrow.

When the tools can't express something, Claude stops and says so. It writes
up the tool it needs as a spec, and the woodworker sends that to Claude
Code as an issue. The spec's example comes from the design, so the issue
leaves it out unless the woodworker ticks a box for it. The app checks
those issues and tells the design once the tool is built.

## A part you approve works at once and shares itself

The app never writes into its own checkout, because a `git pull` can trip
over a file nobody committed. An approved part is kept in the data folder,
where every design can use it, and the app opens a pull request that adds
its file to `library/parts` with auto-merge on. Once that merges and
Woodchuck is updated, the copy in the data folder is dropped. If GitHub can't be reached, the part
still works and the pull request waits for a retry. A pull request closed
without merging leaves the part marked closed, with a button to open a new
one and another to remove the part. The repository comes from
`WOODCHUCK_REPO`, and the app refuses any value that isn't owner/name.
There's no default. With none named, GitHub stays off and the part stays in
the data folder, since an issue or a pull request on someone else's
repository would publish details of your design there.

## Your workshop is a setting, and the prompt caches around it

The tools you have, your usual finishes, the language Claude writes in and
the country it searches for parts in are app-wide settings. They're kept in
`workshop.json` in the data folder, never in a design, and Your workshop in
the design menu changes them. Claude reads them as the last block of its
standing instructions. The same settings always give the same text, so the
prompt cache holds until you change them. The country goes to the web
search, and `WOODCHUCK_SEARCH_COUNTRY` sets it over the workshop's own.

## A design stores intent, and every size is worked out

The design file holds parameters, materials, parts, joints, arrays,
hardware, rules, finishes and the plan. A part's position is an expression
or another part's face, such as a shelf that runs from one side's inner
face to the other's. Every number on the cut list comes from working those
out, so changing one size moves everything that depends on it.

Joints change cut sizes where they should. A dado lengthens the shelf it
holds, and the cut list says by how much and why. Every length is in
millimetres, and field names say so.

## An array repeats its parts, and a joint can pick one copy

An array repeats parts along an axis at a pitch, such as evenly spaced
shelves. The original is item one, and its copies are `shelf#2`, `shelf#3`
and so on. A joint on the original repeats on every copy, so every shelf gets
the dados the first one has.

A joint can also name one item as its host or guest, such as `shelf#2`, or
`shelf#1` for the original alone. It then joins those two parts once and
never repeats. A drawer divider housed into the underside of the second
shelf is a dado with host `shelf#2` and the divider as guest. The array's own
joints still repeat on that copy, so `shelf#2` keeps its dados into the
sides and gains the divider's. A joint on one item only ever adds to what
the array repeats. At the other end, an array's original means item one
alone too.

The joint follows the copy's number. A new pitch moves `shelf#2`, and the
divider's housing goes with it. A count that rises leaves the joint where
it was. A count that drops under its number, or a deleted array, leaves the
joint with nothing to join. The joint stays in the design, and the checks
name it as an error until it's deleted or added again on a copy that's
there. Deleting a part takes every joint on it or its copies with it.

The machining lands on that copy alone, in the checks, the see-through view
and every picture. Copies that come out the same share a cut list row. A
copy a joint sets apart gets a row of its own, named for it, such as
"Shelf (shelf#2)", and its own sheet in the workshop drawings. Its notes
keep the copy's number, so a tenon into `shelf#2` says so.

Joints aren't edited by hand yet, so Claude makes a joint on one copy. Pick
the copy, and the Edit tab lists its joints with the rest of its machining.

## A drawer goes together the way a woodworker builds one

A housing lengthens its guest into one host, so a panel held on several
sides gets a joint for each part round it. A drawer bottom in grooves in
its sides and front grows by the groove's depth into all three. Its back
can stop on top of it instead. The bottom then slides in from behind,
along grooves that run out of the sides' back ends.

A groove is as wide as its panel plus any fit, or as wide as the cutter
you name. A panel thicker than the cutter's groove is an error, since it
won't go in, and one more than 1 mm thinner is a warning, since it
rattles. A groove can go half the host's thickness deep. A strip under
6 mm beside it is a warning, and a groove run out of the host's edge has
no strip, since it's cut the way a rabbet is.

A rabbet is open on one side, and it can go two thirds of the host's
thickness deep. One with wood on both sides is a warning, since it's a
dado or a groove. A dado and rabbet puts a tongue on the guest's end that
hooks into a dado near the host's end, so a drawer front holds when it's
pulled. The tongue sits on the face away from that end, which leaves the
most short grain beyond the dado, and under 6 mm of it is a warning.

## A part is the blank you cut, and cuts shape it

Every part is a box, and the box is the blank you cut it from. Cuts then
shape the blank on its broad face. An edge cut takes wood off one edge
along a straight line, which makes a slope, a taper or a corner cut off. A
cutout takes a rectangle, a rounded rectangle or a circle right through the
part. Inside the outline it's a hole, and where it reaches the outline it's
a notch, such as a toe kick.

Positions, stock checks and the cutting layout all keep using the box. A
face such as `side.top` is the blank's face, which on a sloped top is its
highest point. A cut's points are bounds like a part's own, so a slope can
run from the back's top to the front's and follow both when they move. A
cut may use its own part's faces too.

The shape is worked out once every part's place and size is known, and
nothing that sets a size or a position reads it back. That keeps a cut from starting a loop.
Joints, the checks and a design's rules read it. A part with no cuts gets
no shape worked out, and a test holds every example to the same output
byte for byte.

Edge cuts go first, then cutouts. An array copy shares its original's
shape. A housing joint goes into its host only along the stretches of the
end that no cut has touched. A cut that misses the wood is a warning, and
one that splits a part in two is an error.

You make and change cuts by hand in the Shape section of a panel's Edit
tab. Each Add button starts a cut the part can take, such as a slope down
to two thirds of its height, so there's something to see at once. A cut's
fields read like a part's own sizes, as a number, a sum or a face. While
you type, the window works the change out and draws it on the model as a
ghost, with the cut's new words or the reason it's refused. Leaving the
field makes it through the same operations as Claude's, as one undo step.

A circle becomes a polygon with its corners on the true curve, never more
than 0.005 mm inside it. That leaves a shade more wood than the real part
has, so a check errs towards finding an overlap. Straight edges are exact.
The cut list gives a hole the size you set, and it groups parts only when
their shapes match to 0.1 mm. A mirror image keeps a row of its own.

Every picture draws the shape. The 3D view, the plan views and the
server's pictures carry the outline through the part's thickness and leave
its holes open. Each wall of that solid counts as the face its edge counts
as, so a sloped top takes the top's finish and a click on it picks the top.
A hole's walls count as the faces they look towards. A part with no cuts is
still drawn as its box, and a test holds every example's views, drawings and
PDF to the same bytes.

The workshop drawings draw the shape you cut, tongues and all, with its
holes. A part's sheet sizes each slope's angle and the wood left at each
end, and places and sizes each hole. Its notes give a slope's two ends and a
hole's centre or corner in the sheet's own along and up. A part turned over
for its machining turns its shape over too. The cutting layout still places
the blanks, and draws each part's outline inside its own.

## Claude cuts a part with its own tools

Claude slopes, tapers or chamfers an edge with `set_edge_cut`. It cuts a
hole, a slot or a notch with `set_cutout`, and takes a cut off with
`delete_cut`. Each one checks its input through the same operations as
any other edit, so a list of edits or a suggested change can carry cuts
too. Claude's instructions say that a face still means the blank, that
joints sit on uncut wood, and that a slope is a cut. Stepped boxes and
stand-ins never make one.

An edit's result gives each shaped part's cuts in workshop words, such as
a slope's two ends and its angle. A pin the woodworker puts on a cut edge
or a hole's wall names that cut. An arched edge or a pocket cut into a
face, such as a recessed pull, still needs a tool Claude asks for.

## The checks see the wood a cut leaves

A part with cuts is checked as its true solid, which is its outline and
holes carried through its thickness, with each housing's tongue on it.
Overlaps, hardware and what holds a part up all use that solid. An overlap
there gives the deepest the two run into each other along each axis. Every
other part is still its box, and a test holds the checks on a design with
no cuts to the same report byte for byte.

A joint is found where two blanks meet, then placed on the wood the cuts
leave. A joint with no wood left where its parts meet is refused, and the
error names the cut. Screws, dowels and pocket screws spread over the wood
that's left. A housing runs out through an edge cut the way it runs out of
the blank's own edge. A cutout across a housing is a warning, since the
guest's end shows there. Some joints need all their wood, so a cut there is
an error. That's a cut into a mortise or under its tenon, inside a half lap
or box joint, or where a part passes through a slot. A slot's walls are
measured to the outline.

Wood a cut leaves narrower than 6 mm is a warning, or under half the part's
thickness when that's more. It covers a strip between an edge cut and the
far edge, and the wood between a cutout and the outline or another cutout.
A slope run out to a point is its shape, so it isn't counted.

## A housing can stop short of an edge

A dado, groove or rabbet runs along the whole of the guest's end, and so
does the dado of a dado and rabbet. Where the guest is flush with an edge
of the host, the housing shows on that edge. A stop says how far short of an edge the housing ends, such as
`{"front": "10"}`, so its end doesn't show there. It can stop at one or
both of the two edges it runs between. Each stop is an expression, like
any size.

The guest keeps its place and its size, and its corner is notched where
the housing stops. A dado and rabbet notches only its tongue. That's the usual way to make a stopped dado, and it
keeps a shelf's front flush with the side's. The notch runs the stop's
length along the end and the housing's depth into it. A guest set back
past the stop needs no notch, and the housing ends where the guest does.

The housing's machining runs only to the stop. The cut list says how far
short of each edge it ends, such as "stopped 10 mm from the front". Each
notch is machining on the guest, sized and placed like a cut's notch. The
see-through view and the workshop drawings draw both, and the host's sheet
sizes the stop in its chain. A guest with cuts leaves its notches out of
its tongue as well. A stop of 0 is no stop, and a design with no stops
derives, checks and draws to the same bytes.

A stop that leaves no housing is an error, and the housing runs whole
until it's fixed. A stop that leaves less than half the housing is a
warning, since the guest has little holding it. One that leaves under 6 mm
of wood before the edge is a warning too, since that wood can break out
when you square the end. Only the two edges the housing runs between can
take a stop, and a stop on any other edge is an error.

Claude adds a stop with `add_joint`. Its instructions say to use one when
the woodworker asks for a stopped housing or says that edge will be seen.
A joint's card in the Edit tab shows its stop, and the worked example of
each joint that can stop has a Stopped switch.

## A rule can measure to the shape

A face such as `side.top` reads the blank, so a rule that reads a face a
cut has taken wood from gets a warning. `gap_x(a, b)`, `gap_y(a, b)` and
`gap_z(a, b)` measure to the shape you see. Each looks along its axis
wherever the two parts line up across it, and gives the smallest clear
space between them. Where they overlap it's minus the deepest overlap. For
two boxes it's the larger start less the smaller end, so it works on parts
with no cuts too. A tongue hidden in a housing doesn't count.

Two parts that don't line up across the axis have no gap to measure, and
the rule can't be worked out. Only a rule can use these, since every shape
is worked out after every size. A drawer side that slopes down under a rail
shows why. `rail.bottom - side.top` reads the side's tallest point and
fails, while `gap_y(rail, side)` reads the slope under the rail and passes.

## A requirement is a rule in every direction it limits

Claude's instructions ask for a rule for each requirement you state, and
one for each direction it limits. A 12-inch LP needs room across a drawer
and room to stand up in it, so an LP drawer gets two rules. A shelf's load
limits both its span and its thickness.

An overall size means the whole piece, with the back, feet, top and any
overhang in it. `overall.width`, `overall.height` and `overall.depth` read
the box around every part, and `overall.top` and the other faces read its
edges. Stand-in boxes count, and props and hardware don't. Claude holds a
size you give with a rule such as `overall.depth == 300`, then fits the
parts inside it. A back put on behind 300 mm sides fails that rule. Its
working names the part at each end, such as the back and a side, so the
part that sticks out is plain to see.

The whole piece is worked out after every size, the same as a shape. Only
a rule or a plan's key size can read it, and no part can be called
`overall`. Its height runs from its lowest part to its highest. Hardware
isn't in the box, so a piece on bought legs has its height from the floor
in `overall.top`.

## Hardware is what you buy, and a runner is timber

The hardware list is a shopping list. Each item on it names a part from the
library or carries the maker's figures, such as a slide's length.
`set_hardware` refuses anything with neither, so a placeholder such as wax
glides can't reach the list. A design that already holds one gets a
warning that says what to do.

A drawer with no slides runs on wooden runners. A runner is an ordinary
part tagged `runner`, such as a strip fixed to the carcass side or a shelf.
It's on the cut list with its size like any part, and the cut list says to
wax it. A drawer rides a runner when it rests on the runner's top with no
joint, or when a groove in the drawer holds the runner. The parts its
joints hold together make up the drawer.

A drawer slides front to back, so the checks hold it to running clearance
across that. Every part beside it, over it or under it needs 0.5 mm of
clear space from it, apart from the runners it rides. Touching is an error,
and less than 0.5 mm is a warning, since timber swells. A groove needs a
fit of 0.5 mm or more. A drawer joined to its runner can't open, so that's
an error too. With no part tagged `runner`, none of these checks run.

## A Domino is a joint, and its tenons are bought

A Festool Domino is a joiner that cuts an oblong mortise, and a bought
beech tenon is glued into a matching mortise in each part. Festool's
[Domino manual](https://www.festool.com/-/media/tts/fcp/festool/knowledge/downloads-page/download-brochures/manual_domino/versions/festool-domino-manual-april-2016-au-imp-en.pdf)
gives its sizes and settings. In Woodchuck it's the joint type `domino`, a
fastener like dowels, since it changes no part's size. Claude adds one with
`add_joint`. Its instructions say to use it only when your workshop lists a
Domino joiner, and dowels when it doesn't.

The joint takes the DF 500's tenons, which are 4 × 20, 5 × 30, 6 × 40,
8 × 40, 8 × 50 and 10 × 50 mm, thickness by length. Each size is a part in
the library, with Festool's pages as its sources, and a test holds the
joint's sizes to those files. Left out, the size is the thickest up to a
third of the stock that leaves 5 mm of wood round each mortise. One Domino
goes in for about every 100 mm of the joint, spread the way dowels are and
centred on the guest's thickness.

The host's mortise goes half the tenon's length deep, or less to leave 5 mm
of the host behind it. The guest's takes the rest of the tenon, at the next
depth the DF 500 stops at. Those are 12, 15, 20, 25 and 28 mm, and only the
first three with the 5 mm cutter. The 4 mm cutter cuts 10 mm. The guest's
mortises are as wide as the tenon, and so is the host's nearest the front,
top or right, which lines the parts up. The fit makes the host's others 6
or 10 mm wider for play, the way Festool lines up a long joint. Three or
more Dominos get 6 mm unless the joint gives a fit.

Each mortise is machining of its own, so the cut list places every one and
the workshop drawings dimension it. The see-through view draws each mortise
in red and each tenon as a block. The tenons go on the hardware list as
their library parts, counted from the joints, so an array's copies add
theirs. They never go in the design's own hardware, which keeps the count
right when a joint changes.

The checks hold a Domino to what the DF 500 can cut and to the wood round
it. A size Festool doesn't make is an error, and so is a fit that isn't one
of the machine's settings or a guest mortise deeper than it reaches. A
mortise that comes out of a part is an error too. The same goes for one
that runs into the next, into another joint's machining or into a cut.
Under 5 mm of wood behind a mortise, beside it or between two is a warning,
and so is a depth the machine has no stop for. A Domino more than half the
stock's thickness is a warning as well, since about a third is usual.

## Your own wood is cut first

A design can list the boards and sheets the woodworker already has, by
material, with each size's length, width and count. The cutting layout
places parts on those first and buys only the rest, so the buy list is
the shortfall. A piece of your own is used as it is, with no trim, since
you cut its edges yourself.

A part narrower than a board is ripped from it. Your own boards, and solid
timber bought at the widths a material says the yard sells, pack the way
a sheet does: crosscut to length, then ripped, so two narrow parts can
share one board. A material that names no widths buys each part at its
own width, as before.

Every board and sheet gets a letter, your own first. The cut list names
each row's boards by letter, and the cutting plan draws them on one page
when they fit. It shrinks the drawings until they do, and only a big
piece goes on to a second page. Claude, the window and another chat over
MCP all set the stock through one operation, `set_stock`, which replaces
the whole list for a material, so the same list sent twice changes
nothing.

## Checks run after every change

Overlaps, parts nothing holds up, joints out of proportion, parts too big
for your stock and your own rules are all checked each time the design
changes. A design is ready to cut only when nothing is in error and no
stand-in part is left. Claude runs the same checks before it says it's
done.

## A plan's sizes come from the model

For a new piece, Claude builds a draft first and then pins a plan beside
it for you to approve. The plan lists the parts, the joints, the
assumptions and a few key sizes. Each key size is an expression on the
model, such as the clear gap between two shelves, with the size Claude
means. The app works out every one before it pins the plan.

A size more than 0.5 mm from what the model gives refuses the whole plan,
and so does one that can't be worked out. Claude can set a wider tolerance
for a size. The refusal lists each size with its expression, what Claude
expected and what the model gives. Claude then fixes the number, its label
or the model, and submits the plan again. The card gives each size as the
model has it.

## Every change undoes in one step

A change set is one undo, whether you made it with a slider or Claude made
it with forty tool calls. An edit you make while Claude works is a change
set of its own. Claude's work before it and after it are two more, so Undo
takes them back one at a time. Each change set is also a commit in a git
history of the designs on this computer, so the History tab can show what changed
and restore any version. The chat's history only grows, which keeps
Claude's earlier reasoning valid. A new version of Claude's instructions
or tools, or a change to your workshop, still leaves an open chat working.
The API drops the earlier reasoning that doesn't match, and Claude
carries on without it.

## You can talk and edit while Claude works

A build can take minutes, so the chat box and the edit controls stay open
while Claude works. A step is one reply from Claude. Claude makes a whole
stage of a build, such as every carcass panel, as one list of edits in one
step. The list runs in order and stops at the first edit that's refused.
The edits before it stay made, and Claude hears which one failed and why.
Each edit's result already lists the problems it made, so Claude runs the
full checks and draws the model once a stage is done. A message you send
waits for Claude's current step to end. It then
goes in beside that step's tool results, in the same message, and Claude
carries on with it in mind. Your edits reach Claude the same way. Nothing
earlier in the chat changes to fit them in, which keeps Claude's earlier
reasoning valid.

A message that arrives after Claude's last step starts a new turn as soon
as the old one ends, and so does one waiting when you press Stop. The app
stays busy across that hand-off, so a restart that waits for it to be free
can't land in the gap. When the old turn ended on a plan or a question,
that message is taken as the reply. The card says so, and Claude is told
it may not answer what was asked. Undo, redo and switching designs wait
until Claude is done, since they'd move the design out from under it.

## A dropped connection is tried again

A build sends Claude dozens of requests, and a connection can drop in the
middle of one. The app sends that request again after a second, and again
after four more, before it gives up. It does the same when the API is
overloaded or has a server error. The chat says it's trying again, and the
words the cut-off reply had streamed leave the chat. A bad key, a rate
limit or a refusal ends the turn straight away.

A turn that an error or Stop ends says so to other apps watching it. The
next turn is told how far the last one got, so it can finish what was left.

## A long chat is summarised, and the whole of it stays searchable

Rereading a long chat on every step slows Claude down. Once a chat passes
a set size, the API summarises the older turns inside a request, and from
then on only the summary and the newer turns are sent. That step pauses
while the summary is written.

The summary keeps what you want and what was decided, with your answers
to Claude's questions and plans and every size you asked for. The design
holds the rest of its numbers, so the summary leaves those out.

Summaries between turns are a setting, and they're off until you turn
them on. Once a turn ends with the chat past a set size, Woodchuck asks
the API to summarise it in the background. The summary stands in for the
messages Claude's last request carried. The next turn sends it in their
place, then Claude's reply and anything said since. No turn waits for it.
A turn that starts while it's being written runs on the whole chat, and
the summary goes in at that turn's next step. None starts while Claude
waits on your answer or a message waits to be read. A summary that fails
is logged and skipped. The next try waits until the chat has grown or an
hour has passed.

With them on, the API's own summary is a fallback for a single long turn,
at a higher size. Once the chat holds a summary from between turns, the
API can't summarise it inside a request. Woodchuck then asks for one in
the background the same way, between two steps, and that stays true for
that chat if you turn the setting off.

Each summary is kept as the API sent it, with its signature. A request for
a summary between turns refuses an older summary that has no signature.
When the chat starts from one, Woodchuck sends the whole saved chat in its
place, with the old summary taken out. It measures the whole chat first
with the API's
[token count](https://platform.claude.com/docs/en/build-with-claude/token-counting),
which is free, and a rough count stands in if that fails. A chat too long
for the model keeps the API's own summaries, and the log says so. If the
API refuses a request over a stored summary, Woodchuck sends it again with
the chat in full. Every later request in that chat goes the same way.

The whole chat stays saved on disk, and Claude searches it with a recall
tool when you refer back to something. Each summary from between turns is
saved beside the chat with the number of messages it stands in for, so
the saved chat only grows. The app never trims the chat itself, since that would break
Claude's earlier reasoning. The API accepts the reasoning in the turns
after a summary it wrote, so those turns keep theirs.

## The prompt cache outlasts a pause

Every request sends Claude its tools, its instructions and the chat. The
API's [prompt cache](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
keeps what it read last time, so it needn't read it all again. A cold
cache makes the next request write the whole chat to it before Claude can
start. Woodchuck is often used by voice, and a pause to measure a board or
to think runs well past the API's usual five minutes. The cache lasts an
hour from the last request that used it, so the request after a pause like
that still reads the chat from the cache. Writing to an hour's cache costs
more, and [CONFIG.md](docs/CONFIG.md) says how much and how to go back to
five minutes.

The request has two cache points, one after the instructions and one at
the end of the chat. Both get the same lifetime, since the API wants a
longer lifetime to come before a shorter one. The app reads the setting
once a turn, like your workshop, so every request in a turn matches the
one before it apart from the chat.

## A cold cache is warmed before you speak

A cold cache makes the next reply write the whole chat before Claude can
start, which takes many seconds on a long chat. The cache goes cold once
its lifetime has passed since the last request, and a restart can bring
new instructions or tools that the old cache doesn't match. Woodchuck warms it in the background
while you're still looking. Opening a design, a window coming into view
and another app calling a Woodchuck tool each ask for a warm-up. The tools
that send Claude a message don't ask, since that message writes the cache
itself.

A warm-up goes only when the open design's chat isn't empty, Claude isn't
working or summarising, and the design's last request is older than the
cache lasts. A restart forgets when that was, so the first ask after one
warms the design whatever the gap. A design gets one at most once a cache
lifetime, even when it fails. It waits two seconds first, so clicking
through designs warms only the one you stop on. A turn that starts
meanwhile stops it, and the restart gate doesn't wait on one, since the
next reply writes the cache itself if a restart cuts one short.

The warm-up is a copy of the next request that asks for no reply. With
`max_tokens` at 0 the API writes the cache, answers nothing and bills no
output, as the
[prompt caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
describe. It isn't streamed, since the API refuses that with a zero size.
The same code builds it as every request in a turn, so the two match in
everything the cache reads: the model, instructions, tools, thinking,
effort and betas, and the chat with its summary and effort messages. Only
its cache point differs. It sits on the last block of the chat as it
stands, with the same lifetime, and a placeholder message follows it where
your next message will go. A cache point isn't part of what the cache
matches, so the next turn reads that entry. A chat at the size where the
API summarises inside a request isn't warmed, since the summary starts a
new cache. Each warm-up's tokens and time go in a file beside the chat,
where turn-stats counts them, and the chat never shows them.
[CONFIG.md](docs/CONFIG.md) says what one costs and how to turn them off.

## Each turn thinks as hard as it needs

Thinking is most of the wait on a turn, and a colour try needs far less of
it than a new build. Each turn picks a level from plain rules about the
message, with no model call. A colour try, a question about the design or
"looks right" to a plan runs at low. A small size change runs at medium. A
new build, a photo, joints, strength and anything the rules don't know get
the configured level. Once Claude reaches for a joint, a plan or a question,
the turn goes back to the configured level until it ends.

The request's own level never changes, since a change there would restart
the cache. A turn sets its level with a message in the chat that carries
only the level, and it adds one only when the level changes. The chat
stays append-only, so Claude's earlier reasoning stays valid.

## It runs on this computer, and your tailnet if you ask

The server listens on 127.0.0.1 and checks the host and origin of every
request, so other websites can't reach it. Other machines reach it only
through your own tailnet, when you list its name. On macOS an optional
launchd agent keeps it running, and elsewhere your own service manager can
run `start.sh`. Woodchuck never updates itself. An open window reloads
itself onto a new version when nothing would be lost.

## Your tailnet meets a lock, and this computer doesn't

Tailscale serve passes requests from your own devices to 127.0.0.1, under
a tailnet name you list. A request there needs Tailscale's identity header
and a signed-in session, and the app serves nothing while Funnel is on.
This computer stays open with no sign-in. The MCP server and your own
scripts have no way to sign in, and anything running here can read the data
folder anyway. The lock follows Crossband and Membro, with a password,
passkeys and a recovery secret.

## The data folder backs itself up

Woodchuck snapshots the whole data folder at every start and then by the
wall clock, the way Crossband and Membro back up theirs. The server's
writes are all synchronous, so a snapshot read in one pass between them
never holds a save half done. Each snapshot is one plain `.tar.gz` that any
`tar` unpacks, written with Node's own compression and no extra package.
Sign-ins stay out of it, so a restore never brings back a session you
ended. [docs/OPERATIONS.md](docs/OPERATIONS.md#backups) has the details.

## Colours are measured or modelled, never guessed

The Linolie Satin Wood Oil colours come from Linolie's photos of each oil
on Douglas fir. Each one splits into a tint that lets the grain through and
a pigment that covers it, and on Douglas fir the two add back up to the
photo. Osmo publishes no photos to sample, so its oils are modelled from
how much white each one has. On any other timber the colour is an estimate,
and a line over the swatches says which half of each chip is the estimate
and which is the photo.

A tint is clear, or leans toward the oil's own colour as its photo shows
it. A tint that leant the other way would cancel the fir's orange in the
photo, then cast blue onto any paler timber. The pigment keeps at least 30%
of the photo's red, green and blue. Within those limits the timber shows
through as far as the photo allows, so the grain does too. A script in
`scripts/` writes each tint and pigment from its photo, and a test fails
when the two disagree. A dark oil on walnut or jarrah can take a faint cool
tint from its pigment. Those timbers are much darker than fir, so less of
their own colour comes through to balance it.

The finished view draws grain from each species' own figures, such as ring
spacing and ply thickness. Nothing is a photo of wood, so there's nothing
to license.

## One screen, and Claude drives it

The window is one screen, whoever is driving. The chat sits on the left,
the model in the middle, and a side panel on the right with five tabs:
Edit, Finish, Make, Check and History. Your designs, the parts library and
missing tools share one page, opened from the design menu.

Claude works the same controls you would. While it works, the side panel
opens the tab it's in, the control it used lights up, and the camera
frames the parts it changed. Each of Claude's tools names its place on
screen in `packages/web/src/follow.ts`, and a test fails if a tool has
none. Touching anything stops the following for the rest of the turn. A
turn's "show me how" replays its steps slowly without changing the design.
Claude's instructions name the five tabs and what each holds, so it can
tell you where to look.

One layout means one thing to learn, and watching Claude teaches it.
Hands-on editing will add grips to the same model, and Claude will drive
those too.

Only Claude's changes glow, in the theme's glow colour. A change Claude
suggests is drawn on the model itself as a see-through ghost, with each
move dimensioned, until you apply it or turn it down. Everything Claude
waits on sits in one bar over the chat box.

## A phone gets the same screen, rearranged

On a screen narrower than 640 px the same pieces rearrange. The model
fills the screen under a slim header, and the chat and the five tabs share
one sheet that slides up from the bottom. The sheet follows the same tab
and panel state as a wider window. Anything that opens a tab, Claude
included, opens the sheet there.

Between 640 and 1000 px the window keeps the desktop layout, with the
toolbar folded and the chat starting folded. Tests hold every control on a
phone to at least 44 px and every field to at least 16 px, and nothing
blocks pinch zoom.

## Every colour of the window comes from the theme

The window offers five themes, the same as Crossband's and Membro's, and
System, which follows the device's light or dark setting. Each theme is a set of variables in `packages/web/src/themes.css`,
chosen by `data-theme` on the page, and the stylesheet writes no colour of
its own. A test fails if it does. The 3D view and the 2D views read the same
variables, so one choice sets the whole window.

A small script in `index.html` sets the theme before the first paint, so
nothing flashes. The page the server photographs is always Light, since
those pictures are for Claude and shouldn't depend on your taste.

Some colours stay true in every theme. These are the Finished look's timber
and light, your room photo, the AI blend and the workshop drawings.

## Pictures come from the same model

The 3D view, the plan views and the pictures the server draws for other
apps all come from the same design. The server draws a picture by opening
its own page in a headless Chrome and taking a screenshot. A photo of your
room sits behind the model at its true size. The optional AI blend may
relight only the piece and its shadow, through a mask, and the rest of the
photo stays as taken.

Another chat can also see what the open window shows. The server asks the
window over its socket, and the window sends its own view back as
pictures, with a line saying what they show. That covers the camera you
left it at, the piece pulled apart and a joint's section. The room photo
goes only when it's asked for.

The pictures Claude looks at are plan views drawn on the server, with no
browser, so they're quick and need no key to test. They come in the plain
look or the finished one. The finished look gives each face the average
colour of its timber with its finish on it. That's the same arithmetic as
the 3D view's Finished look, without the grain or the lighting, so Claude
can check the colours before it says they're on.

An image model can quietly change drawer counts and proportions, so a blend
is labelled as not to scale, on screen and in the corner of the saved
picture. The page draws the label as it makes the copy to save, since the
page is the one place that holds the finished blend. The true-scale picture
never gets a label.

## A piece comes apart the way it goes together

Explode pulls the piece apart in the 3D view, and a slider puts it back.
Solid wood can't rest inside solid wood, so no part ever stops inside
another. Each joint says which way its parts slide apart. A
tenon or a tongue comes straight out of its housing, and a screwed part
comes straight off the face it meets. A half lap lifts off, a part through
a slot slides out either end, and a box joint opens either way its fingers
are open. A drawer slide lets a drawer run out the front and no other way.
A part with no joint can go any way with nothing in its path.

`packages/core/src/explode.ts` plans it in stages, outside in, and the
largest part stays put. A stage takes every part that can slide free of
everything left, and no two moves in a stage could cross. A part that
can't come off alone takes what holds it, such as a table's end frame, and
that group comes apart in later stages. On the way, the piece never
overlaps more than it does together. Parts whose joints hold each other
every way are the one exception. The part held least passes through what
holds it, and the bar over the model names them. Each move goes far
enough to rest clear of what's around it, now and in every later stage.

Once every part is off its joints, a last stage fans them all out from
the middle of the piece. A part goes further the nearer an edge it sits,
up and down as well as out, so a long low piece still spreads in three
dimensions. The fan-out is checked along its whole path, and it shortens
until no two parts meet on the way. Nothing comes apart through the floor.
Wherever a part would dip under it, the whole piece rises together by as
much, so nothing new meets. A joint pulled apart on its own lifts its
upper part off instead of dropping the lower one.

The slider's stages take turns, the last part on coming off first. Dragging
it back shows the piece going together in order. The view moves each part
every frame without drawing the page again, and a pin, a click or a box
select reads the part where it sits now.

A joint can come apart on its own too. Its card in the Edit tab does it,
and so do Claude's `show_joint` with the joint's id and another chat's
`focus_joint`. Its two parts come apart and the rest fades. The part that
moves is the one that comes to rest clear of every part soonest, faded
ones too. On the way it may pass through a faded part that holds it too,
and the bar names that part. The plan views, the room photo and a
suggested change show the piece together, so Explode waits for them.

A joint on its own also opens its section and sizes beside the model,
and the 3D view moves over to make room. `jointSection` in
`packages/core/src/drawings.ts` cuts through the joint twice, the way the
workshop drawings draw a part. A tongue joint is cut through its
thickness and through its width, a half lap along each part, and a box
joint through its fingers and across its corner. Each part's cut face is
hatched its own way, wood cut away stays white, and a fixing crossing the
cut is solid grey. Every real face gets a size, and each view takes the
largest standard scale that fits. Under the drawing are the joint's
settings and each part's cuts, in the cut list's own words.

## Other chats use the same tools

Woodchuck is also an MCP server, so a chat app such as Crossband can work
on the open design. A message goes to Woodchuck's own Claude, which uses
the same tools. A colour change, or a new value for a parameter the design
already has, can skip that and apply directly. It goes through the same
operation as the Finish tab or a size slider, and Woodchuck's Claude is
told after its current step. A big change to a size waits for the
woodworker's yes, since a misheard number wastes timber. A request to
change the view moves the open window and never touches the design. One
that arrives as the window opens waits until the design is in, and the
parts it frames stay framed while the view gets ready.

A chat app may send a call twice, so each tool is safe to repeat. One that
sets something ends in the same place, and one that takes a step, such as
an undo or a new design, names the change or the design it means. A
second send then finds it done.

A chat app holds its turn while a tool runs, so no tool waits long. A
request hands over within a few seconds, and a progress tool answers at
once. Their results carry a background block, which lets the chat app
watch a long build without waiting on it.
