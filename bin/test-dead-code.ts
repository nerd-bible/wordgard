import {rollup, type Plugin} from "rollup"
import {packages} from "./packages.ts"
import {join} from "node:path"

async function testDeadCodeElimination() {
  let plugin: Plugin = {
    name: "test-dead-code",
    resolveId(source: string, base: string | undefined, options: any) {
      if (source == "input.js") return "input.js"
      let local = /^wordgard\/(.*)/.exec(source)
      if (local) {
        let pkg = packages.find(p => p.name == local[1])
        if (pkg) return join(import.meta.dirname, "..", "dist", pkg.name + ".js")
      }
      return undefined
    },
    load(file: string) {
      if (file == "input.js") return {code: packages.map(p => `import "wordgard/${p.name}"`).join("\n")}
      return undefined
    }
  }
  let bundle = await rollup({
    input: "input.js",
    external(id: string) {
      return id != "tslib" && !/^(\.?\/|\w:|wordgard\/)/.test(id)
    },
    plugins: [plugin],
    treeshake: {
      moduleSideEffects: id => id[0] == "/"
    },
    onwarn(warning, deflt) {
      if (!/empty chunk/.test(warning.message)) deflt(warning)
    }
  })
  let result = await bundle.generate({
    format: "esm",
    file: "out.js",
    externalLiveBindings: false,
  })
  return result.output.reduce((s, f) => s + (f as any).code.length, 0)
}

let size = await testDeadCodeElimination()
if (size < 100) process.exit(0)
console.log(`Failed to eliminate part of the library: ${size} bytes left`)
process.exit(1)
