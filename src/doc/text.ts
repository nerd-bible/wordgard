import {type Part, type Leaf} from "./node"

export class TextOutput {
  text = ""
  started = false

  constructor(readonly blockSep: string, readonly leafText?: (node: Leaf.Any) => string) {}

  serialize(part: Part): boolean {
    let nodeText = !part.isLeaf ? null
      : part.isText ? part.param as string
      : part.type.spec.toText ? part.type.spec.toText(part)
      : this.leafText ? this.leafText(part)
      : ""
    if (part.isLeaf ? part.isBlock : part.isTextblock) this.openBlock()
    if (nodeText != null) { this.text += nodeText; this.started = true }
    return nodeText != null
  }

  openBlock() {
    if (this.started) this.text += this.blockSep
    else this.started = true
  }
}
