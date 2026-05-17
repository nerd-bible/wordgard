import {Plot, Leaf, Node} from "wordgard/doc"
import {BidiSpan, computeOrder} from "./bidi"
import {findClusterBreak} from "@marijn/find-cluster-break"

const cache: WeakMap<Plot, TextblockMap> = new WeakMap

const enum Section {
  Text = 0,
  Atom = 1,
  BoundBefore = 2,
  BoundAfter = 3,
  Flag = 3,
  Shift = 2,
}

// FIXME export?
export class TextblockMap {
  private constructor(
    readonly start: number,
    readonly node: Plot,
    readonly ltr: boolean,
    readonly text: string,
    private _order: readonly BidiSpan[] | null,
    // Describe the correspondence between the indices and document
    // positions. Each number starts with 2 bits holding a Section
    // flag, followed by the length of the section.
    readonly sections: number[]
  ) {}

  get order() {
    return this._order || (this._order = computeOrder(this.text, this.ltr, []))
  }

  // FIXME handle isolates
  static get(start: number, node: Plot, ltr: boolean) {
    let cached = cache.get(node)
    if (cached && cached.start == start && cached.ltr == ltr) return cached
    let result = cached && cached.ltr == ltr
      ? new TextblockMap(start, node, ltr, cached.text, cached._order, cached.sections)
      : TextblockMap.create(start, node, ltr)
    cache.set(node, result)
    return result
  }

  static create(start: number, node: Plot, ltr: boolean) {
    let text = "", sections: number[] = [], sectionPos = 0
    let flush = (upto: number) => {
      if (upto > sectionPos) sections.push((upto - sectionPos) << Section.Shift)
    }
    let scan = (node: Node, pos: number) => {
      if (!node.isLeaf) for (let ch of node.content) {
        if (ch.is(Leaf.Text)) {
          text += ch.param
        } else if (ch.type.isLeaf) {
          text += "\ufffc"
          if (ch.length > 1) {
            flush(pos)
            sections.push((ch.length << Section.Shift) | Section.Atom)
            sectionPos = pos + ch.length
          }
        } else if (ch.type.spec.cursorInsideBounds) {
          text += " "
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
    return new TextblockMap(start, node, ltr, text, null, sections)
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
  moveVisually(start: number, side: number, forward: boolean, skipped?: string[]): {pos: number, side: -1 | 1} | null {
    let startIndex = this.toIndex(start), {order, ltr} = this
    let spanI = BidiSpan.find(order, startIndex, side)
    let span = order[spanI], spanEnd = span.side(forward, ltr)
    // End of span
    if (startIndex == spanEnd) {
      let nextI = spanI += forward ? 1 : -1
      if (nextI < 0 || nextI >= order.length) return null
      span = order[spanI = nextI]
      startIndex = span.side(!forward, ltr)
      spanEnd = span.side(forward, ltr)
    }
    let nextIndex = findClusterBreak(this.text, startIndex, span.forward(forward, ltr))
    if (nextIndex == startIndex) return null
    if (nextIndex < span.from || nextIndex > span.to) nextIndex = spanEnd
    if (skipped) skipped[0] = this.text.slice(Math.min(startIndex, nextIndex), Math.max(startIndex, nextIndex))

    let nextSpan = spanI == (forward ? order.length - 1 : 0) ? null : order[spanI + (forward ? 1 : -1)]
    if (nextSpan && nextIndex == spanEnd && nextSpan.level + (forward ? 0 : 1) < span.level)
      return {pos: this.fromIndex(nextSpan.side(!forward, ltr)), side: nextSpan.forward(forward, ltr) ? 1 : -1}
    return {pos: this.fromIndex(nextIndex), side: span.forward(forward, ltr) ? -1 : 1}
  }

  skipWord(start: number, side: number, forward: boolean, visually: boolean): {pos: number, side: -1 | 1} | null {
    let word = "", skipped = [""], cur: {pos: number, side: -1 | 1} | null = null
    let history = new Map<number, {pos: number, side: -1 | 1}>()
    for (;;) {
      let next, char, from = cur ? cur.pos : start
      if (visually) {
        next = this.moveVisually(from, cur ? cur.side : side, forward, skipped)
        char = skipped[0]
      } else {
        next = this.moveLogically(from, forward)
        char = next ? this.text.slice(Math.min(next.pos, from), Math.max(next.pos, from)) : ""
      }
      if (!next) break
      if (/\p{L}|\p{N}/u.test(char)) {
        if (forward) word += char
        else word = skipped[0] + word
        history.set(word.length, next)
      } else if (word) {
        break
      }
      cur = next
    }
    if (!word) return null
    if (!(Intl as any).Segmenter) return cur // FIXME see when TS gets decls for this
    let segments = [...new (Intl as any).Segmenter(undefined, {granularity: "word"}).segment(word)]
    return history.get(segments[forward ? 0 : segments.length - 1].segment.length) || cur
  }

  visualTextblockSide(start: boolean): {pos: number, side: -1 | 1} {
    let pos, side: -1 | 1
    if (start) {
      let span = this.order[0]
      ;[pos, side] = span.ltr == this.ltr ? [span.from, 1] : [span.to, -1]
    } else {
      let span = this.order[this.order.length - 1]
      ;[pos, side] = span.ltr == this.ltr ? [span.to, -1] : [span.from, 1]
    }
    return {pos: this.fromIndex(pos), side}
  }

  moveLogically(start: number, forward: boolean): {pos: number, side: -1 | 1} | null {
    let index = this.toIndex(start)
    let next = findClusterBreak(this.text, index, forward)
    return next == index ? null : {pos: this.fromIndex(next), side: forward ? -1 : 1}
  }
}
