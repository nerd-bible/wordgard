import {Node} from "@willows/doc"
import {Direction, BidiSpan, computeOrder} from "./bidi"
import {findClusterBreak} from "@marijn/find-cluster-break"

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
    readonly dir: Direction,
    readonly text: string,
    // FIXME compute lazily?
    readonly order: readonly BidiSpan[],
    // Describe the correspondence between the indices and document
    // positions. Each number starts with 2 bits holding a Section
    // flag, followed by the length of the section.
    readonly sections: number[]
  ) {}

  // FIXME handle isolates
  static get(start: number, node: Node, dir: Direction) {
    let cached = cache.get(node)
    if (cached && cached.start == start && cached.dir == dir) return cached
    let result = cached && cached.dir == dir
      ? new TextblockMap(start, node, dir, cached.text, cached.order, cached.sections)
      : TextblockMap.create(start, node, dir)
    cache.set(node, result)
    return result
  }

  static create(start: number, node: Node, dir: Direction) {
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
          scan(ch, pos + 1)
          text += " "
        } else {
          flush(pos)
          sections.push((1 << Section.Shift) | Section.BoundAfter)
          scan(ch, sectionPos = pos + 1)
          flush(pos + ch.length - 1)
          sections.push((1 << Section.Shift) | Section.BoundBefore)
          sectionPos = pos + ch.length
        }
        pos += ch.length
      }
    }
    scan(node, 0)
    flush(node.contentLength)
    return new TextblockMap(start, node, dir, text, computeOrder(text, dir, []), sections)
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
      } else {
        if (!index) return off + (flag == Section.BoundBefore ? 1 : 0)
      }
      off += len
    }
    return off
  }

  // This implementation moves strictly visually, without concern for a
  // traversal visiting every logical position in the string. It will
  // still do so for simple input, but situations like multiple isolates
  // with the same level next to each other, or text going against the
  // main dir at the end of the line, will make some positions
  // unreachable with this motion. Each visible cursor position will
  // correspond to the lower-level bidi span that touches it.
  //
  // The alternative would be to solve an order globally for a given
  // line, making sure that it includes every position, but that would
  // require associating non-canonical (higher bidi span level)
  // positions with a given visual position, which is likely to confuse
  // people. (And would generally be a lot more complicated.)
  moveVisually(start: number, assoc: number, forward: boolean): {pos: number, assoc: -1 | 1} | null {
    let startIndex = this.toIndex(start), {order, dir} = this
    let spanI = BidiSpan.find(order, startIndex, assoc)
    let span = order[spanI], spanEnd = span.side(forward, dir)
    // End of span
    if (startIndex == spanEnd) {
      let nextI = spanI += forward ? 1 : -1
      if (nextI < 0 || nextI >= order.length) return null
      span = order[spanI = nextI]
      startIndex = span.side(!forward, dir)
      spanEnd = span.side(forward, dir)
    }
    let nextIndex = findClusterBreak(this.text, startIndex, span.forward(forward, dir))
    if (nextIndex == startIndex) return null
    if (nextIndex < span.from || nextIndex > span.to) nextIndex = spanEnd

    let nextSpan = spanI == (forward ? order.length - 1 : 0) ? null : order[spanI + (forward ? 1 : -1)]
    if (nextSpan && nextIndex == spanEnd && nextSpan.level + (forward ? 0 : 1) < span.level)
      return {pos: this.fromIndex(nextSpan.side(!forward, dir)), assoc: nextSpan.forward(forward, dir) ? 1 : -1}
    return {pos: this.fromIndex(nextIndex), assoc: span.forward(forward, dir) ? -1 : 1}
  }

  visualTextblockSide(start: boolean): {pos: number, assoc: -1 | 1} {
    let pos, assoc: -1 | 1
    if (start) {
      let span = this.order[0]
      ;[pos, assoc] = span.dir == this.dir ? [span.from, 1] : [span.to, -1]
    } else {
      let span = this.order[this.order.length - 1]
      ;[pos, assoc] = span.dir == this.dir ? [span.to, -1] : [span.from, 1]
    }
    return {pos: this.fromIndex(pos), assoc}
  }

  moveLogically(start: number, forward: boolean): {pos: number, assoc: -1 | 1} | null {
    let index = this.toIndex(start)
    let next = findClusterBreak(this.text, index, forward)
    return next == index ? null : {pos: this.fromIndex(next), assoc: forward ? -1 : 1}
  }
}
