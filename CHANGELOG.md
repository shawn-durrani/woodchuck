# Changelog

House convention: one entry per user-visible change, newest first.

## Unreleased

New entries land as one file each in `changelog.d/`, and a release folds
them in here, newest first.

## v0.1.0 (2026-10-05)

First public release.

- A furniture planner you talk to. You describe a piece of wooden
  furniture, Claude builds it with a fixed set of woodworking tools, and
  you both edit the same 3D model. Claude drafts a piece straight away,
  pins its plan beside the model, and shows a change it suggests as a
  ghost on the model that you apply or turn down.
- Every size is worked out from the design and shows its working, and
  checks run after every change. A dado lengthens the shelf it holds, and
  the cut list says by how much.
- When the tools can't express something, Claude stops and writes up the
  tool it needs, which you can file as a GitHub issue for Claude Code.
- Joints come from a library of twelve, each with its proportions, its
  tools and when it suits, and a worked example on two sample boards.
- Workshop drawings print at true scale on A4 or A3, and every size on
  them matches the cut list to 0.1 mm. Cut layout places every part on the
  sheets and lengths you buy, and buys the least timber.
- The Finished look draws each part as its timber, with grain running the
  right way, under daylight, evening or workshop light. Finishes come from
  Linolie's Satin Wood Oil card and Osmo's Polyx-Oils, on a material, a
  part or a single face.
- Photo places the design in a photo of your room at its true size, and
  the optional AI blend relights the piece to match, labelled as not to
  scale.
- While Claude works, the screen follows it through the same tabs and
  controls you'd use, and you can keep talking to it and editing.
- Real parts such as drawer slides are researched on the web, approved by
  you and kept in a parts library, and can be shared as a pull request.
- Your workshop holds the tools you have, your usual finishes, the
  language Claude writes in and the country it searches for parts in.
- Every change is one undo and a version in a git history on your
  computer. Designs can be starred, copied, renamed, downloaded and opened
  again.
- Five themes and a phone layout. Woodchuck can go on your own tailnet
  behind an owner lock with a password and passkeys, and never through
  Funnel.
- Woodchuck is also an MCP server, so another chat app can work on the
  open design, watch a long build and change the open window's view.
