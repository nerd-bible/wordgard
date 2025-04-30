import ModuleServer from "esmoduleserve/moduleserver.js"
import serveStatic from "serve-static"
import send from "send"
import {gatherTests, testHTML} from "@marijn/testtool"
import {join, relative} from "node:path"
import {createServer} from "node:http"

let port = 8111
let base = join(import.meta.dirname, ".."), root = join(base, "demo")
let moduleserver = new ModuleServer({root, maxDepth: 2})
let staticserver = serveStatic(root)

createServer((req, resp) => {
  let m
  if (/^\/test\/?($|\?)/.test(req.url)) {
    let {browserTests} = gatherTests(["doc", "state", "view"].map(p => join(base, p)))
    resp.writeHead(200, {"content-type": "text/html"})
    resp.end(testHTML(browserTests.map(f => relative(root, f)), {
      html: `<title>Wordgard tests</title><h1>Wordgard tests</h1>`
    }))
  } else if (m = /^\/test\/mocha\.(css|js)($|\?)/.exec(req.url)) {
    send(req, join(base, "node_modules", "mocha", "mocha." + m[1])).pipe(resp)
  } else {
    moduleserver.handleRequest(req, resp) || staticserver(req, resp, _err => {
      resp.statusCode = 404
      resp.end('Not found')
    })
  }
}).listen(port, process.env.OPEN ? undefined : "127.0.0.1")
console.log(`Dev server listening on ${port}`)
