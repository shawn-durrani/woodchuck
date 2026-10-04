// A stand-in for Chrome, with just enough of the DevTools protocol for
// picture.ts. It says which port it's on, opens one page and hands back a
// screenshot. FAKE_CHROME_STUBBORN=1 makes it ignore being told to close,
// and FAKE_CHROME_PID names a file to write its process id in.

import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { WebSocketServer } from "ws";

const profile = process.argv.find((a) => a.startsWith("--user-data-dir="))?.slice("--user-data-dir=".length);
if (!profile) throw new Error("No --user-data-dir");
if (process.env.FAKE_CHROME_PID) writeFileSync(process.env.FAKE_CHROME_PID, String(process.pid));
if (process.env.FAKE_CHROME_STUBBORN) process.on("SIGTERM", () => {});

const server = createServer((_req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify([{ type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/page` }]));
});
new WebSocketServer({ server }).on("connection", (ws) => {
  ws.on("message", (data) => {
    const { id, method } = JSON.parse(String(data));
    const result =
      method === "Runtime.evaluate"
        ? { result: { value: true } }
        : method === "Page.captureScreenshot"
          ? { data: Buffer.from("a picture").toString("base64") }
          : {};
    ws.send(JSON.stringify({ id, result }));
  });
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(path.join(profile, "DevToolsActivePort"), `${server.address().port}\n/devtools/browser/fake\n`);
});
