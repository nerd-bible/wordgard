import ts from "typescript"
import {join, dirname, resolve} from "node:path"
import * as fs from "fs"
import {rollup, type RollupBuild, type Plugin} from "rollup"
import dts from "rollup-plugin-dts"
import * as acorn from "acorn"
import {recursive} from "acorn-walk"
import {Package, packages} from "./packages.ts"

const root = join(import.meta.dirname, "..")
const dist = join(root, "dist")

function configFor(pkgs: readonly Package[]) {
  let file = join(root, "tsconfig.json")
  let conf = ts.parseConfigFileTextToJson(file, fs.readFileSync(file, "utf8"))
  return {
    compilerOptions: {
      ...conf.config.compilerOptions,
      declaration: true,
      allowImportingTsExtensions: false
    },
    include: pkgs.map(p => p.dir).map(normalize)
  }
}

function normalize(path: string) {
  return path.replace(/\\/g, "/")
}

class Output {
  files: {[name: string]: string} = Object.create(null)
  changed = new Set<string>()
  watchers: ((changed: Set<string>) => void)[] = []
  watchTimeout: any = null

  constructor() { this.write = this.write.bind(this) }

  write(path: string, content: string) {
    let norm = normalize(path)
    if (this.files[norm] == content) return
    this.files[norm] = content
    if (!this.changed.has(path)) this.changed.add(path)
    if (this.watchTimeout) clearTimeout(this.watchTimeout)
    if (this.watchers.length) this.watchTimeout = setTimeout(() => {
      this.watchers.forEach(w => w(this.changed))
      this.changed.clear()
    }, 100)
  }

  get(path: string) {
    return this.files[normalize(path)]
  }
}

function readAndMangleComments(dirs: readonly string[]) {
  return (name: string) => {
    let file = ts.sys.readFile(name)
    if (file && dirs.includes(dirname(name)))
      file = file.replace(/(?<=^|\n)(?:([ \t]*)\/\/\/.*\n)+/g, (comment, space) => {
        return `${space}/**\n${space}${comment.slice(space.length).replace(/\/\/\/ ?/g, "")}${space}*/\n`
      })
    return file
  }
}

function runTS(dirs: readonly string[], tsconfig: any) {
  let config = ts.parseJsonConfigFileContent(tsconfig, ts.sys, join(dirs[0], "..", ".."))
  let host = ts.createCompilerHost(config.options)
  host.readFile = readAndMangleComments(dirs)
  let program = ts.createProgram({rootNames: config.fileNames, options: config.options, host})

  let diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length > 0) {
    console.error("Type checking failed:")
    diagnostics.forEach(diag => console.error(ts.formatDiagnostic(diag, tsFormatHost)))
    return null
  }

  let out = new Output, result = program.emit(undefined, out.write)
  if (result.emitSkipped) {
    console.error("TypeScript failed to emit code")
    return null
  }
  return out
}

const tsFormatHost = {
  getCanonicalFileName: (path: string) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n"
}

function watchTS(dirs: readonly string[], tsconfig: any) {
  let out = new Output, mangle = readAndMangleComments(dirs)
  let dummyConf = join(dirname(dirname(dirs[0])), "TSCONFIG.json")
  ts.createWatchProgram(ts.createWatchCompilerHost(
    dummyConf,
    undefined,
    Object.assign({}, ts.sys, {
      writeFile: out.write,
      readFile: (name: string) => {
        return name == dummyConf ? JSON.stringify(tsconfig) : mangle(name)
      }
    }),
    ts.createEmitAndSemanticDiagnosticsBuilderProgram,
    diag => console.error(ts.formatDiagnostic(diag, tsFormatHost)),
    diag => console.info(ts.flattenDiagnosticMessageText(diag.messageText, "\n"))
  ))
  return out
}

function outputPlugin(output: Output, ext: string, base: Plugin) {
  let {resolveId, load} = base
  return {
    ...base,
    resolveId(source: string, base: string | undefined, options: any) {
      let full = base && source[0] == "." ? resolve(dirname(base), source) : source
      if (!/\.\w+$/.test(full)) full += ext
      if (output.get(full)) return full
      return resolveId instanceof Function ? resolveId.call(this, source, base, options) : undefined
    },
    load(file: string) {
      let code = output.get(file)
      return code ? {code} : (load instanceof Function ? load.call(this, file) : undefined)
    }
  } as Plugin
}

const pure = "/*@__PURE__*/"

function isNamespace(node: acorn.AnyNode): node is acorn.CallExpression {
  if (node.type != "CallExpression" || node.callee.type != "FunctionExpression" || node.arguments.length != 1)
    return false
  let arg = node.arguments[0]
  return node.callee.params.length == 1 &&
    arg.type == "LogicalExpression" && arg.operator == "||" && arg.left.type == "Identifier" &&
    arg.right.type == "AssignmentExpression" && arg.right.right.type == "ObjectExpression" &&
    arg.left.name == (node.callee.params[0] as acorn.Identifier).name
}

type Patch = {from: number, to?: number, insert: string}

function processOutput(code: string) {
  let patches: Patch[] = []
  function walkCall(node: any, c: (node: acorn.AnyNode, state?: any) => void) {
    node.arguments.forEach((n: any) => c(n))
    c(node.callee)
  }
  function addPure(pos: number) {
    let last = patches.length ? patches[patches.length - 1] : null
    if (!last || last.from != pos || last.insert != pure)
      patches.push({from: pos, insert: pure})
  }
  function delComment(isBlock: boolean, _text: string, from: number, to: number) {
    if (!isBlock || code[to] == "\n") to++
    while (from) {
      let prev = code[from - 1]
      if (prev != " " && prev != "\t") break
      from--
    }
    patches.push({from, to, insert: ""})
  }
  function patchNamespace(node: acorn.CallExpression) {
    let func = node.callee as acorn.FunctionExpression
    let name = ((node.arguments[0] as acorn.BinaryExpression).left as acorn.Identifier).name
    let sliceFrom = Math.max(0, node.start - 100)
    let varDef = /\bvar (\w+);\s*$/.exec(code.slice(sliceFrom, node.start))
    if (varDef && varDef[1] != name) varDef = null
    patches.push({from: func.body.end - 1, insert: ";return " + name})
    patches.push({from: node.arguments[0].start, to: node.arguments[0].end, insert: varDef ? "{}" : name})
    if (varDef)
      patches.push({from: varDef.index + sliceFrom + 4 + varDef[1].length, to: node.start, insert: ` = ${pure}`})
    else
      patches.push({from: node.start, insert: `;${name} = ${pure}`})
  }

  let tree = acorn.parse(code, {ecmaVersion: "latest", sourceType: "module", onComment: delComment})
  recursive(tree, null, {
    CallExpression(node: any, _s, c) {
      walkCall(node, c)
      let iife = node.callee.type == "FunctionExpression"
      if (iife && isNamespace(node)) patchNamespace(node)
      else if (!iife) addPure(node.start)
    },
    NewExpression(node, _s, c) {
      walkCall(node, c)
      addPure(node.start)
    },
    Function() {},
    Class() {}
  })
  patches.sort((a, b) => a.from - b.from)
  for (let pos = 0, i = 0, result = "";; i++) {
    let next = i == patches.length ? null : patches[i]
    let nextPos = next ? next.from : code.length
    result += code.slice(pos, nextPos)
    if (!next) return result
    result += next.insert
    pos = next.to ?? nextPos
  }
}

async function emit(bundle: RollupBuild, conf: any, dts = false) {
  let result = await bundle.generate(conf)
  let dir = dirname(conf.file)
  await fs.promises.mkdir(dir, {recursive: true}).catch(() => null)
  for (let file of result.output) {
    let content = (file as any).code || (file as any).source
    if (!dts) content = processOutput(content)
    await fs.promises.writeFile(join(dir, file.fileName), content)
  }
}

function external(id: string) {
  return id != "tslib" && !/^(\.?\/|\w:)/.test(id)
}

async function bundle(pkg: Package, compiled: Output) {
  let base = {name: "dummy"}
  let input = pkg.sources.find(s => /\bindex\.ts$/.test(s))
  if (!input) throw new Error("Could not determine entry point for package " + pkg.name)
  let bundle = await rollup({
    input: input.replace(/\.ts$/, ".js"),
    external,
    plugins: [outputPlugin(compiled, ".js", base)]
  })
  await emit(bundle, {
    format: "esm",
    file: join(dist, pkg.name + ".js"),
    externalLiveBindings: false,
  })

  let tscBundle = await rollup({
    input: input.replace(/\.ts$/, ".d.ts"),
    external,
    plugins: [outputPlugin(compiled, ".d.ts", {name: "dummy"}), dts()],
    onwarn(warning, warn) {
      if (warning.code != "CIRCULAR_DEPENDENCY" && warning.code != "UNUSED_EXTERNAL_IMPORT")
        warn(warning)
    }
  })
  await emit(tscBundle, {
    format: "esm",
    file: join(dist, pkg.name + ".d.ts")
  }, true)
}

/// Build the package with main entry point `main`, or the set of
/// packages with the given entry point files. Output files will be
/// written to the `dist` directory one level up from the entry file.
/// Any TypeScript files in a `test` directory one level up from main
/// files will be built in-place.
export async function build(pkgs: readonly Package[]): Promise<boolean> {
  let compiled = runTS(pkgs.map(p => p.dir), configFor(pkgs))
  if (!compiled) return false
  for (let pkg of pkgs) await bundle(pkg, compiled)
  return true
}

/// Build the given packages and keep rebuilding them every time an
/// input file changes.
export function watch(pkgs: readonly Package[]): void {
  let out = watchTS(pkgs.map(p => p.dir), configFor(pkgs))
  out.watchers.push(writeFor)
  writeFor(new Set(Object.keys(out.files)))

  async function writeFor(files: Set<string>) {
    let changedPkgs: Package[] = []
    for (let file of files) {
      let dir = dirname(file), pkg = pkgs.find(p => normalize(p.dir) == dir)
      if (!pkg) throw new Error("No package found for " + file)
      if (!changedPkgs.includes(pkg)) changedPkgs.push(pkg)
    }
    console.log("Rebuilding " + changedPkgs.map(p => p.name).join(", "))
    for (let pkg of changedPkgs) {
      try { await bundle(pkg, out) }
      catch(e) { console.error(`Failed to bundle ${pkg.name}:\n${e}`) }
    }
    console.log("Bundling done.")
  }
}

if (process.argv.includes("--watch")) watch(packages)
else build(packages)
