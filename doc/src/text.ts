import {type Node} from "./node"

export class TextOutput {
  text = ""
  started = false

  constructor(readonly blockSep: string, readonly leafText?: (node: Node) => string) {}

  serialize(node: Node): boolean {
    let nodeText = node.isText ? node.text!
      : node.type.spec.toText ? node.type.spec.toText(node)
      : !node.isLeaf ? null
      : this.leafText ? this.leafText(node)
      : ""
    if (node.isBlock && (nodeText || node.isTextblock)) this.openBlock()
    if (nodeText != null) { this.text += nodeText; this.started = true }
    return nodeText != null
  }

  openBlock() {
    if (this.started) this.text += this.blockSep
    else this.started = true
  }
}
