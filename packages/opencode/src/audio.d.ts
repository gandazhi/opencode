declare module "*.wav" {
  const file: string
  export default file
}

declare module "*.mp3" {
  const file: string
  export default file
}

declare module "*.wasm" {
  const file: string
  export default file
}

// quickjs-emscripten wasmfile variants expose the .wasm asset via a `./wasm`
// subpath export. Imported with `{ type: "file" }` so Bun embeds the bytes in
// the compiled binary (see workflow/sandbox.ts).
declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
  const file: string
  export default file
}
