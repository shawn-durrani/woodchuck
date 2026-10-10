// What woodchuck_read can read. It imports nothing, so the MCP server can
// declare the tool without loading the app's code.

/** What woodchuck_read can read, each as the app shows it. */
export const READ_PARTS = ["parts", "joints", "cut_list", "cutting_plan", "drilling", "hardware", "checks", "file"] as const;
export type ReadPart = (typeof READ_PARTS)[number];
