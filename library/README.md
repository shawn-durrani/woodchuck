# Parts library

Each file in `parts/` is one real part you've approved, such as a drawer
slide or a hinge. Claude researches a part from a link, a spec sheet or
the maker's site, and proposes it in the chat.

## Approving a part

Approving a part lets every design use it at once. The app keeps the
approved part in `library-pending/` in its data folder, and it never writes
into this folder.

The app also opens a pull request that adds the part's file to this
folder, with auto-merge on. The branch is `part/<id>`, and the one file is
`library/parts/<id>.json`. The repository comes from `WOODCHUCK_REPO`, and
the pull request goes to its `main` branch. It's public whenever that
repository is, and it holds only the part's specs, sources and shape. Once
it's merged and Woodchuck is updated, the file is here and the copy in the
data folder is dropped.

With no repository in `WOODCHUCK_REPO`, GitHub is off. The part stays in
the data folder, where every design can use it, and its card says how to
turn sharing on. [docs/CONFIG.md](../docs/CONFIG.md) has the setting.

If GitHub can't be reached, the part still works. The part's card in the
chat and the parts library say the pull request is waiting, and a Retry
button tries again.

## Browsing

The parts library lists every part, merged or waiting. It's on the All
designs and parts page, from the design menu. Search it by name,
kind or maker. Open a part to see its specs, its sources as links and the
designs that use it.

## Checking

A test checks every file in CI, so a broken one fails the build. Each part
lists the sources its numbers came from. Check them against the hardware
in your hand before you cut.
