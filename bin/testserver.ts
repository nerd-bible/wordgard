/// @ts-ignore
import ModuleServer from "esmoduleserve/moduleserver.js"
import {transformSync} from "@swc/wasm-typescript"
/// @ts-ignore
import serveStatic from "serve-static"
/// @ts-ignore
import send from "send"
import {join, resolve} from "node:path"
import {createServer} from "node:http"
import * as fs from "node:fs"

let port = 8111
let base = resolve(import.meta.dirname, ".."), root = join(base, "demo")
let moduleserver = new ModuleServer({
  root,
  maxDepth: 2,
  transform: (file: string, code: string) => /\.ts$/.test(file) ? transformSync(code).code : code
})
let staticserver = serveStatic(root)

function testHTML(files: readonly string[]) {
  return `<!doctype html><meta charset=utf8>
<link rel=stylesheet href="mocha.css">
<title>Wordgard Tests</title>
<h1>Wordgard Tests</h1>
<div id="workspace" style="opacity: 0; position: fixed; top: 0; left: 0; width: 20em;"></div>

<div id=mocha></div>
<script src="mocha.js"></script>
<script>
  mocha.setup({ui: "bdd"})
  onload = () => mocha.run()
</script>
${files.map(f => `<script type=module src="/_m/${f.replace(/\.\.\//g, "__/")}"></script>
`).join("")}`
}

createServer((req, resp) => {
  let m
  if (/^\/test\/?($|\?)/.test(req.url!)) {
    resp.writeHead(200, {"content-type": "text/html"})
    let testFiles = fs.readdirSync(join(base, "test")).filter(f => /^(web)?test-/.test(f)).map(f => join("..", "test", f))
    resp.end(testHTML(testFiles))
  } else if (m = /^\/test\/mocha\.(css|js)($|\?)/.exec(req.url!)) {
    send(req, join(base, "node_modules", "mocha", "mocha." + m[1])).pipe(resp)
  } else {
    moduleserver.handleRequest(req, resp) || staticserver(req, resp, () => {
      resp.statusCode = 404
      resp.end('Not found')
    })
  }
}).listen(port, process.env.OPEN ? undefined : "127.0.0.1")
console.log(`Dev server listening on ${port}`)
