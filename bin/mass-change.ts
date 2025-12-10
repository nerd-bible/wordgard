import {packages} from "./packages.ts"
import {join, resolve} from "node:path"
import * as fs from "fs"

let pattern = process.argv[2], replacement = process.argv[3] || ""
if (!pattern) {
  console.log("Usage: mass-change 'pattern(.*)' 'replacement&1'")
  process.exit(1)
}

let re = new RegExp(pattern, "g")
let root = resolve(import.meta.dirname, "..")
for (let pkg of packages) {
  let src = join(root, "src", pkg)
  for (let file of fs.readdirSync(src)) if (/\.ts$/.test(file)) {
    let path = join(src, file)
    let content = fs.readFileSync(path, "utf8"), changed = content.replace(re, replacement)
    if (changed != content) {
      console.log("Updated " + path)
      fs.writeFileSync(path, changed)
    }
  }
}
