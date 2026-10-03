import {Plot, Node} from "wordgard/doc"
import {GardState, Transaction} from "wordgard/state"
import {RangeSet, PointSet} from "wordgard/set"
import {Decoration} from "./decoration"

function offset<T>(
  add: (value: T, from: number, to?: number) => void,
  offset: number
): (value: T, from: number, to?: number) => void {
  return (v, from, to) => add(v, from + offset, to == null ? undefined : to + offset)
}

type Replacement<D> = {
  from: number
  to: number
  add?: (src: Source<D>) => void
}

type Set<D extends Decoration.Point | Decoration.Range> =
  D extends Decoration.Range ? RangeSet<D> :
  D extends Decoration.Point ? PointSet<D> : never

type Source<D> = (value: D, from: number, to?: number) => void

function init<D extends Decoration.Point | Decoration.Range>(
  type: Node.Query,
  create: (source: (add: Source<D>) => void) => Set<D>,
  addFor: (plot: Plot, offset: number, add: Source<D>) => void,
  doc: Plot.Doc
): Set<D> {
  return create(add => {
    doc.iterate((node, pos) => {
      if (node.isPlot && doc.schema.matchNode(node.type, type)) addFor(node as Plot, pos + 1, add)
    })
  })
}

function refreshByPred<D extends Decoration.Range | Decoration.Point>(
  type: Node.Query,
  addFor: (plot: Plot, offset: number, add: Source<D>) => void,
  doc: Plot.Doc,
  deco: Set<D>,
  pred: (plot: Plot) => boolean
): Set<D> {
  let recreate: Replacement<D>[] = []
  doc.iterate((node, pos) => {
    if (doc.schema.matchNode(node.type, type) && pred(node as Plot)) recreate.push({
      from: pos, to: pos + node.length,
      add: add => addFor(node as Plot, pos + 1, add)
    })
  })
  return recreate.length ? deco.modify({replace: recreate as any}) as Set<D> : deco
}

function update<D extends Decoration.Range | Decoration.Point>(
  config: Config,
  create: (source: (add: Source<D>) => void) => Set<D>,
  addFor: (plot: Plot, offset: number, add: Source<D>) => void,
  deco: Set<D>,
  tr: Transaction
): Set<D> {
  let doc = tr.newDoc
  let refresh = config.refresh && config.refresh(tr)
  if (refresh === true) return init(config.type, create, addFor, doc)
  if (refresh) deco = refreshByPred(config.type, addFor, tr.startState.doc, deco, refresh)
  if (!tr.docChanged && !refresh) return deco
  let recreate: Replacement<D>[] = []
  let clear: {from: number, to: number}[] = []
  tr.changes.iterChangedRanges((fromA, toA, fromB, toB) => {
    let covered = false
    doc.iterate(fromB, toB, (node, pos) => {
      if (doc.schema.matchNode(node.type, config.type)) {
        recreate.push({
          from: pos, to: pos + node.length,
          add: add => addFor(node as Plot, pos + 1, add)
        })
        if (pos < toB && pos + node.length > toB) covered = true
        return false
      }
    })
    if (!covered) {
      let end = tr.startState.doc.resolve(toA)
      let open = end.matchingParent(p => doc.schema.matchNode(p.type, config.type))
      if (open && open.before >= fromA) clear.push({from: open.before, to: open.after})
    }
  })
  if (clear.length) deco = deco.modify({replace: clear}) as Set<D>
  deco = deco.map(tr.changes, recreate as any) as Set<D>
  return deco
}

type Config = {
  /// The type of plot to decorate.
  type: Node.Query,
  /// A function that produces range decorations for a plot. `from`
  /// and `to` should be relative to the start of the plot's content,
  /// and be fall entirely within the plot.
  ranges?: (node: Plot, range: (deco: Decoration.Range, from: number, to: number) => void) => void
  /// A function that produces point decorations for a plot. `pos`
  /// should be relative to the start of the plot's content.
  points?: (node: Plot, point: (deco: Decoration.Point, pos: number) => void) => void
  /// An optional function that causes the decorations to be recreated
  /// on matching transaction, either for the entire document (`true`)
  /// or for any plot where the returned predicate returns `true`.
  refresh?: (tr: Transaction) => boolean | ((plot: Plot) => boolean)
}

/// Create an extension that adds decorations to plots matching the
/// given type.
export function decoratePlots(config: Config): GardState.Extension {
  let result: GardState.Extension[] = []
  let {type, points, ranges} = config
  if (points) {
    let addFor = (plot: Plot, start: number, add: Source<Decoration.Point>) => points(plot, offset(add, start))
    let field = GardState.Field.define<Decoration.Point.Set>({
      create(state) { return init<Decoration.Point>(type, PointSet.create, addFor, state.doc) },
      update(value, tr) { return update(config, PointSet.create, addFor, value, tr) }
    })
    result.push(field, Decoration.Point.source.of(s => s.field(field)))
  }
  if (ranges) {
    let addFor = (plot: Plot, start: number, add: Source<Decoration.Range>) => ranges(plot, offset(add, start))
    let field = GardState.Field.define<Decoration.Range.Set>({
      create(state) { return init(type, RangeSet.create, addFor, state.doc) },
      update(value, tr) { return update(config, RangeSet.create, addFor, value, tr) }
    })
    result.push(field, Decoration.Range.source.of(s => s.field(field)))
  }
  return result
}
