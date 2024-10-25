import {Node} from "@willows/doc"
import {Direction, BidiSpan, computeOrder} from "./bidi"

const cache: WeakMap<Node, TextblockMap> = new WeakMap

export class TextblockMap {
  constructor(
    readonly start: number,
    readonly node: Node,
    readonly text: string,
    readonly order: readonly BidiSpan[],
    readonly gaps: number[]
  ) {}

  static get(start: number, node: Node) {
    let cached = cache.get(node)
    if (!cached) return TextblockMap.create(start, node)
    if (cached.start == start) return cached // FIXME check isolates
    return new TextblockMap(start, node, cached.text, cached.order, cached.gaps)
  }

  static create(start: number, node: Node) {
    let text = "", gaps: number[] = [], gapPos = 0
    let scan = (node: Node, pos: number) => {
      for (let ch of node.children) {
        if (ch.isText()) {
          text += ch.text
        } else if (ch.isAtom() || !ch.inlineContent()) {
          text += "\ufffc"
          if (ch.length > 1) {
            if (pos > gapPos) gaps.push(pos - gapPos)
            gaps.push(-ch.length)
            gapPos = pos + ch.length
          }
        } else {
          text += " "
          scan(node, pos + 1)
          text += " "
        }
        pos += ch.length
      }
    }
    scan(node, 0)
    if (gapPos < node.contentLength) gaps.push(node.contentLength - gapPos)
    return new TextblockMap(start, node, text, computeOrder(text, Direction.LTR /* FIXME */, []), gaps)
  }

  toIndex(pos: number) {
    if (pos < this.start) return 0
    let off = pos - this.start, idx = 0
    for (let n of this.gaps) {
      if (n < 0) {
        off += n
        if (off < 0) return idx
        idx++
      } else {
        if (off <= n) return idx + off
        off -= n
      }
    }
    return idx
  }

  fromIndex(index: number) {
    let off = this.start
    for (let n of this.gaps) {
      if (n < 0) { off += -n; index-- }
      else if (n < index) index -= off
      else return index + off
    }
    return this.text.length
  }
}
