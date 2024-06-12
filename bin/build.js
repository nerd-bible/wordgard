import {build, watch} from "@marijn/buildtool"
import {resolve, join} from "node:path"
import {packages} from "./packages.js"

let root = resolve(import.meta.dirname, "..")
let mains = packages.map(p => join(root, p, "src", "index.ts"))
let options = {
  pureTopCalls: true
}

if (process.argv.includes("--watch")) {
  watch(mains, [], options)
} else {
  build(mains, options)
}
