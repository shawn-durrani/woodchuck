# Acknowledgements

Woodchuck is built on other people's work. The software listed here comes
through npm and isn't copied into the repo, apart from the few lines of the
noise hash credited at the end of the list. Every licence was checked for
compatibility.

## Software

- [React](https://react.dev) and React DOM, MIT
- [three.js](https://threejs.org), MIT
- [React Three Fiber](https://github.com/pmndrs/react-three-fiber) and
  [drei](https://github.com/pmndrs/drei), MIT
- [Vite](https://vite.dev), MIT
- [ws](https://github.com/websockets/ws), MIT
- [SimpleWebAuthn](https://simplewebauthn.dev), server and browser, MIT,
  for passkeys. What it uses in turn, PeculiarVentures' ASN.1 and X.509
  libraries, asn1js, tsyringe, reflect-metadata and tslib, is under the
  MIT, BSD-3-Clause, Apache-2.0 and 0BSD licences.
- [resvg-js](https://github.com/yisibl/resvg-js), MPL-2.0, for drawing the
  plan views as pictures
- [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript), MIT
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk), MIT
- [Zod](https://zod.dev), MIT
- [tsx](https://tsx.is), MIT
- [Vitest](https://vitest.dev), MIT
- [TypeScript](https://www.typescriptlang.org), Apache-2.0, and
  [concurrently](https://github.com/open-cli-tools/concurrently) and
  [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react), MIT,
  as development tools
- The value-noise hash behind the timber grain, in
  `packages/web/src/wood.ts`, follows Inigo Quilez's
  [Value Noise 3D](https://www.shadertoy.com/view/4sfGzS) shader, MIT,
  copyright 2017 Inigo Quilez

## Services (bring your own keys)

- [Anthropic](https://www.anthropic.com), for the chat with Claude
- [OpenAI](https://openai.com), for the optional AI blend
- [Tailscale](https://tailscale.com), optional, for reaching Woodchuck
  from your other devices over your own tailnet

## Finish colours

- The Satin Wood Oil colours were sampled from the product photos on
  [Linolie & Pigment](https://linolie.dk/en/products/satin-wood-oil.lin10.020/)'s
  site. Satin Wood Oil is their product and name.
- The Osmo Polyx-Oil finishes are modelled from
  [Osmo](https://osmouk.com/faq/wood/polyx-oil-raw-3044-vs-tints-white-3040/)'s
  own descriptions. Polyx-Oil is their product and name.
- Woodchuck isn't affiliated with Linolie & Pigment, Osmo or Blum, or
  endorsed by them. Their names, and the names of their products, are their
  trademarks.

## Projects studied

Woodchuck studied these projects while it was planned. No code from any of
them is in the repo. Each is listed with its licence and what Woodchuck
took from it.

| Project | Licence | What Woodchuck took |
|---|---|---|
| [Prompt2CAD](https://prompt2cad.com) | a hosted product | What a furniture planner you talk to should and shouldn't do |
| [FreeCAD Woodworking](https://github.com/dprojects/Woodworking) | MIT | Drawer clearances and dowel defaults, as numbers |
| [OpenCutList](https://github.com/lairdubois/lairdubois-opencutlist-sketchup-extension) | GPL-3.0 | Ideas only, such as cut-size rules, grouping and grain locks, written fresh |
| [packingsolver](https://github.com/fontanf/packingsolver) | MIT | Nothing yet. It's the library to try if Woodchuck's own cutting layouts waste too much |
| zinin's sketchup-mcp2, Supex and NeoNexAI's SketchUp tools | MIT | Ideas, such as an undo per operation, measured results, screenshot presets and a pinned tool list |
| SidhNor's sketchup-mcp-server | unclear, it names two | Ideas only, from its guidelines for writing tools |
| mhyrr's sketchup-mcp | no licence file | Nothing |
