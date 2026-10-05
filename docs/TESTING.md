# Testing

The tests run with no API keys and never call Claude, OpenAI or GitHub.
CI runs all of them on every pull request, and a pull request can merge
only when they pass. Run them before you push.

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
colour arithmetic, what changed between versions, view commands, the
workshop drawings and the sheet the 2D views are drawn on.
[The acceptance test](#the-acceptance-test-the-record-console) has the
console's numbers.

The finish tests hold every tinted Linolie colour to its photo on Douglas fir,
to within a shade the eye can barely tell. They check that no tint leans away
from its oil's own colour, and that a dark oil gains no colour on pale
timber that its photo lacks. Kyoto has to stay near-black on every timber,
and the Osmo oils stay as modelled. A test also fails when a stored tint or
pigment differs from what `scripts/fit-oil-colours.ts` would write.

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

Talking and editing while Claude works have tests of their own. A message
or an edit arrives while the scripted Claude is mid-step, and the tests
check where it lands in what Claude is sent next. They hold each edit to
an undo step of its own between Claude's, and the history to only
growing. A message Claude didn't read starts the next turn, and the busy
flag a restart waits on never drops between the two. The MCP tools run
against a live app on the same stand-ins, timed, with their background
block held to the agreed shape. The size tool is held to one undo step
mid-build, to refusing a name or formula that doesn't work, and to waiting
for a yes on a big change. Its reply has to name each new problem.

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

The toolbar tests hold its groups and menus to fixed slots, and check
that every view command from another chat lands on its control. An orbit
from another chat is held to the same turn at any frame rate, to easing
in and out, and to stopping for a camera view or the plan views. The
side panel's tests hold where each panel lives in the five tabs and on
the All designs and parts page, that picking a part opens Edit, and that
the status pill opens Check. A suggested change is held to the parts it
moves, the size of each move, and its Now and With the change sides. A
view command's drawer and highlight land on the model, the drawer and
Edit. Check's fixes name the problem, and Show me picks the parts a rule
reads. Each item in the design menu calls its own endpoint. The keyboard
shortcuts stay quiet in fields, and the model frames itself again only
when it should.

The follow tests hold where each of Claude's tools shows on screen, and
fail when one of Claude's tools has no place named. They hold that the
screen follows Claude tab by tab and gives each tab its time, and that
any touch stops it for the rest of the turn and keeps the tab you chose.
They also hold the order Show me how plays a turn in, and each step's
link to its control. The clock is passed in, so the tests run on a fake
one.

The phone layout's tests hold the bottom sheet's heights and where a drag
of its handle comes to rest. They check the 640 px breakpoint, and that
code opening a tab or the side panel opens the sheet at that tab. Box
select by touch is held to its two fingers and its taps. The stylesheet
is checked for controls under 44 px and fields under 16 px, and the page
for anything that blocks pinch zoom.

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
the edits made through apply_edits. Designs
are numbered, and it prints no names, chat text or design content. Turns
from older chats have no timing of their own. The script rebuilds their
rounds and tool calls from the saved conversation, and their seconds from
the chat's timestamps.

The live benchmark sends a few invented tasks to Claude for real, through
the same turn loop the app uses. It needs an Anthropic key and the
`--live` flag, costs money and never runs in the tests or CI. Each task
gets a throwaway data folder, and the script prints its cost estimate
before it starts.

```bash
npx tsx scripts/bench.ts --live [build|lp-fix|colour|height ...]
```

It reports each task's turns, requests, seconds, tool calls, edits, the
levels its requests ran at, tokens and rough cost. It also counts the
design's check errors before and after. Set `WOODCHUCK_MODEL` and
`WOODCHUCK_EFFORT` to compare models and effort, and
`WOODCHUCK_EFFORT_ROUTING=off` to hold every turn at that effort.

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
