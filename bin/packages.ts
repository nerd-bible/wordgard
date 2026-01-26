import * as fs from "node:fs"
import {join} from "node:path"

function tsFiles(dir: string) {
  return fs.readdirSync(dir).filter(f => /(?<!\.d)\.ts$/.test(f)).map(f => join(dir, f))
}

export class Package {
  // FIXME dynamically update somehow
  readonly sources: readonly string[]
  readonly name: string
  readonly dir: string
  constructor(dir: string, name: string) {
    this.dir = dir
    this.name = name
    this.sources = tsFiles(dir)
  }
}

function noExt(dir: string) {
  return fs.readdirSync(dir).filter(n => !/\./.test(n))
}

const src = join(import.meta.dirname, "..", "src")

function explore(dir: string, name: string): Package[] {
  let set: Package[] = []
  if (fs.existsSync(join(dir, "index.ts"))) set.push(new Package(dir, name))
  for (let inner of noExt(dir)) for (let pkg of explore(join(dir, inner), name + "/" + inner)) set.push(pkg)
  return set
}

export const packages = noExt(src).reduce((a, b) => a.concat(explore(join(src, b), b)), [] as Package[])
