import {SpanSet, Span, SpanLabel, SpanComparator, FragmentIterator} from "@willows/state"
import {ChangeSet, basicBuilders} from "@willows/doc"
import ist from "ist"

const {doc, p} = basicBuilders

class Label extends SpanLabel {
  _startSide: number
  _endSide: number
  _point: boolean
  name: string | null
  pos: number | null
  constructor(readonly spec: any = {}, empty: boolean) {
    super()
    this._startSide = spec.startSide || 1
    this._endSide = spec.endSide || (empty ? 1 : -1)
    this._point = empty || !!spec.point
    this.name = spec.name || null
    this.pos = spec.pos == null ? null : spec.pos
  }

  get startSide() { return this._startSide }
  get endSide() { return this._endSide }
  get point() { return this._point }
  get rank() { return this.name ? this.name.charCodeAt(0) : 0 }

  eq(other: SpanLabel): boolean {
    return other instanceof Label && other.spec == this.spec
  }
  static names(v: readonly Label[]): string {
    let result = []
    for (let val of v) if (val.name || val.point) result.push(val.name || "POINT")
    return result.join("/")
  }
}

function cmp(a: Span<Label>, b: Span<Label>) { return a.from - b.from }

function mk(from: number, to?: any, spec?: any): Span<Label> {
  if (typeof to != "number") { spec = to; to = from }
  if (typeof spec == "string") spec = {name: spec}
  return new Label(spec, from == to).span(from, to)
}
function mkSet(spans: Span<Label>[]) { return SpanSet.of<Label>(spans) }

const dummyDoc = doc(p("-".repeat(5000)))

function changeSet(changes: [number, number, number][]) {
  let collect: any[] = []
  for (let [from, to, len] of changes) {
    if (len) collect.push({insert: "x".repeat(len), from, to})
    if (from < to) collect.push({from, to})
  }
  return ChangeSet.create(dummyDoc, collect)
}

let smallSpans: Span<Label>[] = []
for (let i = 0; i < 5000; i++)
  smallSpans.push(mk(i, i + 1 + (i % 4), {pos: i}))
let _set0: SpanSet<Label> | null = null
function set0() { return _set0 || (_set0 = mkSet(smallSpans)) }

function checkSet(set: SpanSet<Label>) {
  let count = 0
  set.between(0, set.length, (from, _, value) => {
    count++
    if (value.pos != null) ist(from, value.pos)
  })
  ist(count, set.size)
}

describe("SpanSet", () => {
  it("divides a set into chunks and layers", () => {
    let set = mkSet(smallSpans.concat([mk(1000, 4000, {pos: 1000}), mk(2000, 3000, {pos: 2000})]).sort(cmp))
    ist(set.size, 5002)
    ist(set.chunk.length, 1, ">")
    ist(set.nextLayer.size)
    checkSet(set)
  })

  it("complains about misordered spans", () => {
    ist.throws(() => mkSet([mk(8, 9), mk(7, 10)]), /sorted/)
    ist.throws(() => mkSet([mk(1, 1, {startSide: 1}), mk(1, 1, {startSide: -1})]), /sorted/)
  })

  describe("update", () => {
    it("can add spans", () => {
      let set = set0().update({add: [mk(4000, {pos: 4000})]})
      ist(set.size, 5001)
      ist(set.chunk[0], set0().chunk[0])
    })

    it("can add a large amount of spans", () => {
      let spans = []
      for (let i = 0; i < 4000; i += 2) spans.push(mk(i))
      let set = set0().update({add: spans})
      ist(set.size, 2000 + set0().size)
      checkSet(set)
    })

    it("can filter spans", () => {
      let set = set0().update({filter: from => from >= 2500})
      ist(set.size, 2500)
      ist(set.chunk.length, set0().chunk.length, "<")
      checkSet(set)
    })

    it("can filter all over", () => {
      let set = set0().update({filter: from => (from % 200) >= 100})
      ist(set.size, 2500)
      checkSet(set)
    })

    it("collapses the chunks when removing almost all spans", () => {
      let set = set0().update({filter: from => from == 500 || from == 501})
      ist(set.size, 2)
      ist(set.chunk.length, 1)
    })

    it("calls filter on precisely those spans touching the filter span", () => {
      let spans = []
      for (let i = 0; i < 1000; i++) spans.push(mk(i, i + 1, {pos: i}))
      let set = mkSet(spans)
      let called: [number, number][] = []
      set.update({filter: (from, to) => (called.push([from, to]), true), filterRange: {from: 400, to: 600}})
      ist(called.length, 202)
      for (let i = 399, j = 0; i <= 600; i++, j++)
        ist(called[j].join(), `${i},${i+1}`)
    })

    it("returns the empty set when filter removes everything", () => {
      ist(set0().update({filter: () => false}), SpanSet.empty)
    })
  })

  describe("map", () => {
    function test(positions: Span<Label>[], changes: [number, number, number][],
                  newPositions: (number | [number, number])[]) {
      let set = mkSet(positions)
      let mapped = set.map(changeSet(changes))
      let out: string[] = []
      for (let iter = mapped.iter(); iter.label; iter.next()) out.push(iter.from + "-" + iter.to)
      ist(JSON.stringify(out), JSON.stringify(newPositions.map(p => Array.isArray(p) ? p[0] + "-" + p[1] : p + "-" + p)))
    }

    it("can map through changes", () =>
       test([mk(1), mk(4), mk(10)], [[0, 0, 1], [2, 3, 0], [8, 8, 20]], [2, 4, 30]))

    it("takes inclusivity into account", () =>
       test([mk(1, 2, {startSide: -1, endSide: 1})], [[1, 1, 2], [2, 2, 2]], [[1, 6]]))

    it("uses side to determine mapping of points", () =>
       test([mk(1, 1, {startSide: -1, endSide: -1}), mk(1, 1, {startSide: 1, endSide: 1})], [[1, 1, 2]], [1, 3]))

    it("defaults to exclusive on both sides", () =>
       test([mk(1, 2)], [[1, 1, 2], [4, 4, 2]], [[3, 4]]))

    it("drops point spans", () =>
       test([mk(1, 2)], [[1, 2, 0], [1, 1, 1]], []))

    it("drops spans in deleted regions", () =>
       test([mk(1, 2), mk(3)], [[0, 4, 0]], []))

    it("shrinks spans", () =>
       test([mk(2, 4), mk(2, 8), mk(6, 8)], [[3, 7, 0]], [[2, 3], [2, 4], [3, 4]]))

    it("leaves point spans on change boundaries", () =>
       test([mk(2), mk(4)], [[2, 4, 6]], [2, 8]))

    it("can collapse chunks", () => {
      let smaller = set0().map(changeSet([[30, 4500, 0]]))
      ist(smaller.chunk.length, set0().chunk.length, "<")
      let empty = smaller.map(changeSet([[0, 1000, 0]]))
      ist(empty, SpanSet.empty)
    })
  })

  class Comparator implements SpanComparator<Label> {
    spans: number[] = []
    addSpan(from: number, to: number) {
      if (this.spans.length && this.spans[this.spans.length - 1] == from) this.spans[this.spans.length - 1] = to
      else this.spans.push(from, to)
    }
    compareSpan(from: number, to: number) { this.addSpan(from, to) }
    comparePoint(from: number, to: number) { this.addSpan(from, to) }
  }

  describe("compare", () => {
    function test(spans: SpanSet<Label> | Span<Label>[], update: any, changes: number[]) {
      let set = Array.isArray(spans) ? mkSet(spans) : spans
      let newSet = set, docChanges = changeSet(update.changes || [])
      if (update.changes) newSet = newSet.map(docChanges)
      if (update.filter || update.add) newSet = newSet.update(update)
      if (update.prepare) update.prepare(newSet)
      let comp = new Comparator
      SpanSet.compare([set], [newSet], docChanges, comp)
      ist(JSON.stringify(comp.spans), JSON.stringify(changes))
    }

    it("notices added spans", () =>
       test([mk(2, 4, "a"), mk(8, 11, "a")], {
         add: [mk(3, 9, "b"), mk(106, 107, "b")]
       }, [3, 9, 106, 107]))

    it("notices deleted spans", () =>
       test([mk(4, 6, "a"), mk(5, 7, "b"), mk(6, 8, "c"), mk(20, 30, "d")], {
         filter: (from: number) => from != 5 && from != 20
       }, [5, 7, 20, 30]))

    it("recognizes identical spans", () => {
      let label = new Label({name: "a"}, false)
      test([label.span(0, 50)], {
        add: [label.span(10, 40)],
        filter: () => false
      }, [0, 10, 40, 50])
    })

    it("skips changes", () =>
       test([mk(0, 20, "a")], {
         changes: [[5, 15, 20]],
         filter: () => false
       }, [0, 5, 25, 30]))

    it("ignores identical sub-nodes", () => {
      let spans = []
      for (let i = 0; i < 1000; i++) spans.push(mk(i, i + 1, "a"))
      test(spans, {
        changes: [[900, 1000, 0]],
        add: [mk(850, 860, "b")],
        prepare: (set: SpanSet<Label>) => Object.defineProperty(set.chunk[0], "value", {get() { throw new Error("NO TOUCH") }})
      }, [850, 860])
    })

    it("ignores changes in points", () => {
      let spans = [mk(3, 997, {point: true})]
      for (let i = 0; i < 1000; i += 2) spans.push(mk(i, i + 1, "a"))
      let set = mkSet(spans.sort(cmp))
      test(set, {
        changes: [[300, 500, 100]]
      }, [])
    })

    it("notices adding a point", () => {
      test([mk(3, 50, {point: true})], {
        add: [mk(40, 80, {point: true})]
      }, [50, 80])
    })

    it("notices removing a point", () => {
      test([mk(3, 50, {point: true})], {
        filter: () => false
      }, [3, 50])
    })

    it("can handle multiple changes", () => {
      let spans = []
      for (let i = 0; i < 200; i += 2) {
        let end = i + 1 + Math.ceil(i / 50)
        spans.push(mk(i, end, `${i}-${end}`))
      }
      test(spans, {
        changes: [[0, 0, 50], [50, 100, 0], [150, 200, 0]],
        filter: (from: number) => from % 50 > 0
      }, [50, 51, 100, 103, 148, 153])
    })

    it("reports point decorations with different cover", () => {
      test([
        mk(0, 4, {startSide: 1, endSide: -1}),
        mk(1, 3, {point: true, startSide: -1, endSide: 1})
      ], {
        changes: [[2, 4, 0]]
      }, [1, 2])
    })
  })

  describe("fragments", () => {
    class Builder implements FragmentIterator<Label> {
      spans: string[] = []
      fragment(from: number, to: number, active: readonly Label[]) {
        let name = Label.names(active)
        this.spans.push((to - from) + (name ? "=" + name : ""))
      }
      point(from: number, to: number, value: Label) {
        this.spans.push((to > from ? (to - from) + "=" : "") + (value.name ? "[" + value.name + "]" : "ø"))
      }
    }
    function test(set: SpanSet<Label> | SpanSet<Label>[], start: number, end: number, expected: string) {
      let builder = new Builder
      SpanSet.fragments(Array.isArray(set) ? set : [set], start, end, builder)
      ist(builder.spans.join(" "), expected)
    }

    it("separates the span in covering spans", () => {
      test(mkSet([mk(3, 8, "one"), mk(5, 8, "two"), mk(10, 12, "three")]), 0, 15,
           "3 2=one 3=one/two 2 2=three 3")
    })

    it("can retrieve a limited span", () => {
      let decos = [mk(0, 200, "wide")]
      for (let i = 0; i < 100; i++) decos.push(mk(i * 2, i * 2 + 2, "span" + i))
      let set = mkSet(decos), start = 20, end = start + 6
      let expected = ""
      for (let pos = start; pos < end; pos += (pos % 2 ? 1 : 2))
        expected += (expected ? " " : "") + (Math.min(end, pos + (pos % 2 ? 1 : 2)) - pos) + "=span" + Math.floor(pos / 2) + "/wide"
      test(set, start, end, expected)
    })

    it("reads from multiple sets at once", () => {
      let one = mkSet([mk(2, 3, "x"), mk(5, 10, "y"), mk(10, 12, "z")])
      let two = mkSet([mk(0, 6, "a"), mk(10, 12, "b")])
      test([one, two], 0, 12, "2=a 1=a/x 2=a 1=a/y 4=y 2=b/z")
    })

    it("orders active spans by rank", () => {
      let one = mkSet([mk(2, 10, "a"), mk(8, 12, "b"), mk(20, 30, "a")])
      let two = mkSet([mk(3, 4, "b"), mk(18, 22, "b")])
      let three = mkSet([mk(0, 25, "c")])
      test([one, two, three], 0, 25, "2=c 1=a/c 1=a/b/c 4=a/c 2=a/b/c 2=b/c 6=c 2=b/c 2=a/b/c 3=a/c")
    })

    it("doesn't get confused by same-place points", () => {
      test(mkSet([mk(1, "a"), mk(1, "b"), mk(1, "c")]), 0, 2,
           "1 [a] [b] [c] 1")
    })

    it("properly resyncs active spans after points", () => {
      test(mkSet([mk(0, 20, "r1"), mk(1, 10, "r2"), mk(3, 12, {name: "p", point: true}), mk(4, 8, "r3"), mk(5, 20, "r4")]), 0, 20,
           "1=r1 2=r2/r1 9=[p] 8=r4/r1")
    })

    it("omits points that are covered by the previous point", () => {
      let points = 0
      SpanSet.fragments([mkSet([mk(0, 4, {point: true}), mk(1, 5, {name: "a"}), mk(2, 4, {point: true})])], 0, 10, {
        fragment() {},
        point() { points++ }
      })
      ist(points, 1)
    })

    it("puts smaller spans inside bigger ones with the same rank", () => {
      test(mkSet([mk(0, 3, {name: "a_big"}), mk(0, 1, {name: "a_1"}), mk(1, 2, {name: "a_2"}), mk(2, 3, {name: "a_3"})]), 0, 3,
           "1=a_1/a_big 1=a_2/a_big 1=a_3/a_big")
    })

    it("reports span start positions", () => {
      SpanSet.fragments([mkSet([mk(0, 10, "a"), mk(1, 11, "b")])], 5, 6, {
        point() {},
        fragment(from, to, active, start) {
          ist(from, 5)
          ist(to, 6)
          ist(active.map(l => l.name).join(), "a,b")
          ist(start.join(), "0,1")
        }
      })
    })
  })

  describe("iter", () => {
    it("iterates over spans", () => {
      const set = mkSet(smallSpans.concat([mk(1000, 4000, {pos: 1000}), mk(2000, 3000, {pos: 2000})]).sort(cmp))
      let count = 0
      for(let iter = set.iter(); iter.label; iter.next(), count++) {
        ist(iter.from, count > 2001 ? count - 2 : (count > 1000 ? count - 1 : count))
      }
      ist(count, 5002)
    })

    it("can iterate over a subset", () => {
      let count = 0
      for (let iter = set0().iter(1000); iter.label; iter.next(), count++) {
        if (iter.from > 2000) break
        ist(iter.to, iter.from + 1 + (iter.from % 4))
      }
      ist(count, 1003)
    })
  })

  describe("between", () => {
    it("iterates over spans", () => {
      let found = 0
      set0().between(100, 200, (from, to) => {
        ist(to, from + 1 + (from % 4))
        ist(to, 100, ">=")
        ist(from, 200, "<=")
        found++
      })
      ist(found, 103)
    })

    it("returns spans in a zero-length set", () => {
      let set = SpanSet.of([mk(0, 0)]), found: number[] = []
      set.between(0, 0, (from, to) => { found.push(from, to) })
      ist(found.toString(), "0,0")
    })
  })
})
