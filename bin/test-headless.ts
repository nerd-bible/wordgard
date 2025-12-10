import {execFile} from "node:child_process"
import {testServer} from "./testserver.ts"

function run(cmd: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {shell: false, encoding: "utf8"},
             (err, result) => { if (err) reject(err); else resolve(result) })
  })
}

let chromium: string | undefined
for (let i = 2; i < process.argv.length;) {
  let arg = process.argv[i++]
  if (arg == "--binary") chromium = process.argv[i++]
}

for (let name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "google-chrome-canary"]) {
  if (chromium) break
  try { chromium = (await run("which", [name])).trim() }
  catch (e: any) { if (e.stdout == null) throw e }
}

if (!chromium) {
  console.log("No Chrome browser found")
  process.exit(1)
}

let port = 8924, server = testServer(port), result
try {
  result = await run(chromium, ["--headless", "--virtual-time-budget=15000", "--dump-dom", `http://localhost:${port}/test/?headless`])
} catch (e: any) {
  if (e.stdout == null) throw e
  console.log("Couldn't start Chrome: " + (e.stderr || e.stdout))
  process.exit(1)
}
server.close()

function unesc(html: string) {
  return html.replace(/&(lt|gt|amp|quot);/g, (_, ch) => ch == "lt" ? "<" : ch == "gt" ? ">" : ch == "amp" ? "&" : '"')
}

let json = /<pre>([^]*?)<\/pre>/.exec(result), parsed
try { parsed = json && JSON.parse(unesc(json[1])) } catch {}
if (!parsed) {
  console.log("Failed to get a proper result from the browser")
  process.exit(1)
}

let failed = 0, ran = 0, scope = []
for (let record of parsed as {name: string, scope: string[], fail?: string}[]) {
  for (let i = 0; i < record.scope.length; i++) {
    if (scope[i] != record.scope[i]) {
      scope.length = i
      scope.push(record.scope[i])
      console.log("  ".repeat(i) + scope[i] + ":")
    }
  }
  console.log("  ".repeat(scope.length) + (record.fail ? "❌" : "✔️") + " " + record.name)
  ran++
  if (record.fail) failed++
}

console.log(`\nRan ${ran} tests. ${failed} failed, ${ran - failed} passed.`)
process.exit(failed ? 1 : 0)
