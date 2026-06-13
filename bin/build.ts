import ts from "typescript"
import {join, dirname, resolve} from "node:path"
import * as fs from "fs"
import {rollup, type RollupBuild, type Plugin} from "rollup"
import dts from "rollup-plugin-dts"
import {parse, type AnyNode} from "acorn"
import {recursive} from "acorn-walk"
import {Package, packages} from "./packages.ts"

/// Options passed to `build` or `watch`.
export interface BuildOptions {
  /// Fail the build on type errors. defaults to false
  typeCheck?: boolean
  /// Additional compiler options to pass to TypeScript.
  tsOptions?: any
  /// When given, this is used to convert anchor links in the `///`
  /// comments to full URLs.
  expandLink?: (anchor: string) => string | null
  /// When given, prefix this to links in the comments that start with
  /// a `/`.
  expandRootLink?: string
  /// Adds a Rollup output plugin to use.
  outputPlugin?: (dir: string) => Plugin | Promise<Plugin>
  /// Adds an output plugin to use only for CommonJS bundles.
  cjsOutputPlugin?: (root: string) => Plugin
}

const tsDefaultOptions = {
  lib: ["es2021", "dom"],
  types: [],
  stripInternal: true,
  noUnusedLocals: true,
  strict: true,
  target: "es2021",
  module: "es2020",
  newLine: "lf",
  declaration: true,
  moduleResolution: "bundler",
  paths: {
    "wordgard/*": ["./src/*"],
  }
}

function configFor(pkgs: readonly Package[], options: BuildOptions) {
  return {
    compilerOptions: {...tsDefaultOptions, ...options.tsOptions},
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

function readAndMangleComments(dirs: readonly string[], options: BuildOptions) {
  return (name: string) => {
    let file = ts.sys.readFile(name)
    if (file && dirs.includes(dirname(name)))
      file = file.replace(/(?<=^|\n)(?:([ \t]*)\/\/\/.*\n)+/g, (comment, space) => {
        if (options.expandLink)
          comment = comment.replace(/\]\(#((?:[^()]|\([^()]*\))+)\)/g, (m, anchor) => {
            let result = options.expandLink!(anchor)
            return result ? `](${result})` : m
          })
        if (options.expandRootLink)
          comment = comment.replace(/\]\(\/((?:[^()]|\([^()]*\))+)\)/g, (_m, link) => {
            return `](${options.expandRootLink}${link})`
          })
        return `${space}/**\n${space}${comment.slice(space.length).replace(/\/\/\/ ?/g, "")}${space}*/\n`
      })
    return file
  }
}

function runTS(dirs: readonly string[], tsconfig: any, options: BuildOptions) {
  let config = ts.parseJsonConfigFileContent(tsconfig, ts.sys, dirname(dirs[0]))
  let host = ts.createCompilerHost(config.options)
  host.readFile = readAndMangleComments(dirs, options)
  let program = ts.createProgram({rootNames: config.fileNames, options: config.options, host})

  if (options.typeCheck) {
    let diagnostics = ts.getPreEmitDiagnostics(program)
    if (diagnostics.length > 0) {
      console.error("Type checking failed:")
      diagnostics.forEach(diag => console.error(ts.formatDiagnostic(diag, tsFormatHost)))
      return null
    }
  }

  let out = new Output, result = program.emit(undefined, out.write)
  return result.emitSkipped ? null : out
}

const tsFormatHost = {
  getCanonicalFileName: (path: string) => path,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => "\n"
}

function watchTS(dirs: readonly string[], tsconfig: any, options: BuildOptions) {
  let out = new Output, mangle = readAndMangleComments(dirs, options)
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

function processOutput(code: string) {
  let patches: {from: number, to?: number, insert: string}[] = []
  function walkCall(node: any, c: (node: AnyNode, state?: any) => void) {
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

  let tree = parse(code, {ecmaVersion: "latest", sourceType: "module", onComment: delComment})
  recursive(tree, null, {
    CallExpression(node: any, _s, c) {
      walkCall(node, c)
      let m
      let iife = node.callee.type == "FunctionExpression"
      let tsVarKludge = iife && node.callee.params.length == 1 &&
        (m = /\bvar (\w+);\s*$/.exec(code.slice(node.start - 100, node.start))) &&
        m[1] == node.callee.params[0].name && node.arguments.length == 1 &&
        node.arguments[0].type == "LogicalExpression" && node.arguments[0].operator == "||"
      if (!iife || tsVarKludge) addPure(node.start)
      // TS-style enum
      if (tsVarKludge) {
        patches.push({from: m!.index + 4 + m![1].length + (node.start - 100), to: node.start, insert: " = "})
        patches.push({from: node.callee.body.end - 1, insert: "return " + m![1]})
      }
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

const dist = join(import.meta.dirname, "..", "dist")

async function bundle(pkg: Package, compiled: Output, options: BuildOptions) {
  let base = await Promise.resolve(options.outputPlugin && options.outputPlugin(pkg.dir) || {name: "dummy"})
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
export async function build(pkgs: readonly Package[], options: BuildOptions = {}): Promise<boolean> {
  let compiled = runTS(pkgs.map(p => p.dir), configFor(pkgs, options), options)
  if (!compiled) return false
  for (let pkg of pkgs) await bundle(pkg, compiled, options)
  return true
}

/// Build the given packages and keep rebuilding them every time an
/// input file changes.
export function watch(pkgs: readonly Package[], options: BuildOptions = {}): void {
  let out = watchTS(pkgs.map(p => p.dir), configFor(pkgs, options), options)
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
      try { await bundle(pkg, out, options) }
      catch(e) { console.error(`Failed to bundle ${pkg.name}:\n${e}`) }
    }
    console.log("Bundling done.")
  }
}

let options = {}

if (process.argv.includes("--watch")) watch(packages, options)
else build(packages, options)
