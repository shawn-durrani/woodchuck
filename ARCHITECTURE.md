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

## Checks run after every change

Overlaps, parts nothing holds up, joints out of proportion, parts too big
for your stock and your own rules are all checked each time the design
changes. A design is ready to cut only when nothing is in error and no
stand-in part is left. Claude runs the same checks before it says it's
done.

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
a set size, the API summarises the older turns itself, and from then on
only the summary and the newer turns are sent. The summary keeps what you
want and what was decided. The design holds every size, so the summary
leaves those out. The whole chat stays saved on disk, and Claude searches
it with a recall tool when you refer back to something. The app never
trims the chat itself, since that would break Claude's earlier reasoning.

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

An image model can quietly change drawer counts and proportions, so a blend
is labelled as not to scale, on screen and in the corner of the saved
picture. The page draws the label as it makes the copy to save, since the
page is the one place that holds the finished blend. The true-scale picture
never gets a label.

## Other chats use the same tools

Woodchuck is also an MCP server, so a chat app such as Crossband can work
on the open design. A message goes to Woodchuck's own Claude, which uses
the same tools. A colour change can skip that and apply directly, through
the same operation as the Finish tab, and Woodchuck's Claude is told after
its current step. A request to change the view moves the open window and
never touches the design.

A chat app holds its turn while a tool runs, so no tool waits long. A
request hands over within a few seconds, and a progress tool answers at
once. Their results carry a background block, which lets the chat app
watch a long build without waiting on it.
