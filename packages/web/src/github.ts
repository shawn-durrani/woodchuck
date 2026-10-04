// What the window says about GitHub. It only acts in the repository named in
// WOODCHUCK_REPO, and with none named it's off: missing tools and approved
// parts stay in the app, and the window says how to turn it on. Kept free of
// React so the tests can hold it.

/** How to turn GitHub on, in plain words. */
export const TURN_ON_GITHUB = "To turn it on, add WOODCHUCK_REPO=owner/name to the .env file in the Woodchuck folder, then restart Woodchuck.";

/** What a missing tool's card says while GitHub is off. */
export const TOOL_KEPT = `Filing on GitHub is off, so this request stays here in the app. ${TURN_ON_GITHUB} Meanwhile you can copy the spec into Claude Code yourself.`;

/** What an approved part says while GitHub is off. */
export const PART_KEPT = `Kept on this computer, where it works in your designs. Sharing it as a pull request is off. ${TURN_ON_GITHUB}`;

/** The box to tick before the issue quotes your design. It starts unticked. */
export const exampleConsent = (repo: string) => `Include where it came up. It quotes your design, and anyone who can see ${repo} can read the issue.`;
