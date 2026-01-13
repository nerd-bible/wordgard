import * as fs from "node:fs"
import {join} from "node:path"

export const packages = fs.readdirSync(join(import.meta.dirname, "..", "src")).filter(n => !/\./.test(n))
