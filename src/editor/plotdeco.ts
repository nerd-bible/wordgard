import {Plot} from "wordgard/doc"
import {GardState, Transaction} from "wordgard/state"
import {RangeSet} from "wordgard/set"
import {Decoration} from "./decoration"

function offsetRanges(source: RangeSet.Source<Decoration.Range>, offset: number) {
  return (add: (from: number, to: number, value: Decoration.Range) => void) => {
    if (typeof source == "function")
      source((from, to, v) => add(from + offset, to + offset, v))
    else
      for (let [from, to, v] of source) add(from + offset, to + offset, v)
  }
}

class PlotDeco {
  constructor(
    public deco: Decoration.Range.Set
  ) {}

  static init(config: Config, doc: Plot.Doc) {
    return new PlotDeco(Decoration.Range.set(add => {
      doc.iterate((node, pos) => {
        if (node.type == config.type)
          offsetRanges(config.decorations(node as Plot), pos + 1)(add)
      })
    }))
  }

  update(config: Config, tr: Transaction) {
    if (!tr.docChanged) return this
    let recreate: RangeSet.Replacement<Decoration.Range>[] = []
    let clear: RangeSet.Replacement<Decoration.Range>[] = []
    tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
      let covered = false
      tr.newDoc.iterate(fromB, toB, (node, pos) => {
        if (node.type == config.type) {
          recreate.push({
            from: pos, to: pos + node.length,
            add: offsetRanges(config.decorations(node as Plot), pos + 1)
          })
          if (pos < toB && pos + node.length > toB) covered = true
          return false
        }
      })
      if (!covered) {
        let end = tr.startState.doc.resolve(toA)
        let open = end.matchingParent(p => p.type == config.type)
        if (open && open.before >= fromA) clear.push({from: open.before, to: open.after})
      }
    })
    let deco = this.deco
    if (clear.length) deco = deco.modify({replace: clear})
    deco = deco.map(tr.changes, recreate)
    return new PlotDeco(deco)
  }
}

type Config = {
  type: Plot.Type<any>
  decorations: (node: Plot) => RangeSet.Source<Decoration.Range>
}

export function decorateByPlot(spec: Config): GardState.Extension {
  let field = GardState.Field.define<PlotDeco>({
    create(state) {
      return PlotDeco.init(spec, state.doc)
    },
    update(value, tr) {
      return value.update(spec, tr)
    }
  })
  return [
    field,
    Decoration.Range.source.of(s => s.field(field).deco)
  ]
}
