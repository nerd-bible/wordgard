import {Node} from "@willows/doc"
import {Direction, BidiSpan, computeOrder} from "./bidi"

const cache: WeakMap<Node, TextblockMap> = new WeakMap

const enum Section {
  Text = 0,
  Atom = 1,
  BoundBefore = 2,
  BoundAfter = 3,
  Flag = 3,
  Shift = 2,
}

export class TextblockMap {
  constructor(
    readonly start: number,
    readonly node: Node,
    readonly text: string,
    readonly order: readonly BidiSpan[],
    // Describe the correspondence between the indices and document
    // positions. Each number starts with 2 bits holding a Section
    // flag, followed by the length of the section.
    readonly sections: number[]
  ) {}

  static get(start: number, node: Node) {
    let cached = cache.get(node)
    if (!cached) return TextblockMap.create(start, node)
    if (cached.start == start) return cached // FIXME check isolates
    return new TextblockMap(start, node, cached.text, cached.order, cached.sections)
  }

  static create(start: number, node: Node) {
    let text = "", sections: number[] = [], sectionPos = 0
    let flush = (upto: number) => {
      if (upto > sectionPos) sections.push((upto - sectionPos) << Section.Shift)
    }
    let scan = (node: Node, pos: number) => {
      for (let ch of node.children) {
        if (ch.isText()) {
          text += ch.text
        } else if (ch.isAtom()) {
          text += "\ufffc"
          if (ch.length > 1) {
            flush(pos)
            sections.push((ch.length << Section.Shift) | Section.Atom)
            sectionPos = pos + ch.length
          }
        } else if (ch.type.spec.cursorInsideBounds) {
          text += " " // FIXME smart unicode char?
          scan(node, pos + 1)
          text += " "
        } else {
          flush(pos)
          sections.push((1 << Section.Shift) | Section.BoundAfter)
          scan(node, pos + 1)
          flush(pos)
          sections.push((1 << Section.Shift) | Section.BoundBefore)
        }
        pos += ch.length
      }
    }
    scan(node, 0)
    flush(node.contentLength)
    return new TextblockMap(start, node, text, computeOrder(text, Direction.LTR /* FIXME */, []), sections)
  }

  toIndex(pos: number) {
    if (pos < this.start) return 0
    let off = pos - this.start, idx = 0
    for (let n of this.sections) {
      let len = n >> Section.Shift, flag = n & Section.Flag
      if (flag == Section.Text) {
        if (off <= len) return idx + off
        off -= len
        idx += len
      } else if (flag == Section.Atom) {
        off -= len
        if (off < 0) return idx
        idx++
      } else {
        off--
      }
    }
    return idx
  }

  fromIndex(index: number) {
    let off = this.start
    for (let n of this.sections) {
      let len = n >> Section.Shift, flag = n & Section.Flag
      if (flag == Section.Text) {
        if (len > index) return off + index
        index -= len
      } else if (flag == Section.Atom) {
        if (!index) return off
        index--
        off += len
      } else {
        if (!index) return off + (flag == Section.BoundBefore ? 0 : 1)
        off++
      }
    }
    return off
  }
}
