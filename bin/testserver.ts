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

function testHTML(files: readonly string[]) {
  return `<!doctype html><meta charset=utf8>
<link rel=stylesheet href="mocha.css">
<title>Wordgard Tests</title>
<h1>Wordgard Tests</h1>
<div id="workspace" style="opacity: 0; position: fixed; top: 0; left: 0; width: 20em;"></div>

<div id=mocha></div>
<script src="mocha.js"></script>
<script src="run-tests.js"></script>
${files.map(f => `<script type=module src="/_m/${f.replace(/\.\.\//g, "__/")}"></script>
`).join("")}`
}

let base = resolve(import.meta.dirname, ".."), root = join(base, "demo")

const resp404 = (resp: any) => () => {
  resp.statusCode = 404
  resp.end('Not found')
}

export function testServer(port: number, open = false) {
  let moduleserver = new ModuleServer({
    root,
    maxDepth: 2,
    transform: (file: string, code: string) => /\.ts$/.test(file) ? transformSync(code).code : code
  })
  let staticserver = serveStatic(root)
  let websiteRoot = join(base, "website", "output")
  let websiteServer = fs.existsSync(websiteRoot) && serveStatic(websiteRoot, {
    setHeaders(res: any, path: string) {
      if (/modules\/|\/sandbox.js$/.test(path))
        res.setHeader("Access-Control-Allow-Origin", "*")
    }
  })

  let server = createServer((req, resp) => {
    let m, url = req.url || "/"
    if (/^\/test\/($|\?)/.test(url)) {
      resp.writeHead(200, {"content-type": "text/html"})
      let testFiles = fs.readdirSync(join(base, "test")).filter(f => /^(web)?test-/.test(f)).map(f => join("..", "test", f))
      resp.end(testHTML(testFiles))
    } else if (/^\/test$/.test(url)) {
      resp.writeHead(301, {"location": "/test/"})
      resp.end()
    } else if (m = /^\/test\/mocha\.(css|js)($|\?)/.exec(url)) {
      send(req, join(base, "node_modules", "mocha", "mocha." + m[1])).pipe(resp)
    } else if (m = /^\/test\/run-tests.js($|\?)/.exec(url)) {
      send(req, join(base, "bin", "run-tests.js")).pipe(resp)
    } else if (websiteServer && (m = /^\/website(\/.*)$/.exec(url))) {
      req.url = m[1]
      websiteServer(req, resp, resp404(resp))
    } else {
      moduleserver.handleRequest(req, resp) || staticserver(req, resp, resp404(resp))
    }
  })
  server.listen(port, open ? undefined : "127.0.0.1")
  return server
}
