import { Plot as Alias_Doc_Plot, Node, Pos } from 'wordgard/doc';
import { Correction } from 'wordgard/state';


// Reads `pos.node` with the type the published d.ts declares. At runtime the
// value is the document `Plot` (so `.isTextblock` works), but `tsc` rejects
// it: inside `namespace Pos` in dist/doc.d.ts, the declaration
// `class Plot extends Pos.Node { node: Plot }` self-references the
// namespace-local `Pos.Plot` instead of the document `Plot`, and `Pos.Plot`
// has no `isTextblock`.
export const correction1 = Correction.onContent(Node.Group.Textblock, (pos) => {
  const plot = pos.node

  /*

  Runtime log:
    plot.isTextblock is true

  TypeCheck:
    src/index.ts:24:28 - error TS2339: Property 'isTextblock' does not exist on type 'Plot'.
    24   const isTextblock = plot.isTextblock
                                ~~~~~~~~~~~
  */
  const isTextblock = plot.isTextblock
  console.log("plot.isTextblock is", isTextblock)

  /*

  Runtime log:
    plot1 is an instance of Alias_Doc_Plot: true

  TypeCheck:
    src/index.ts:38:9 - error TS2740: Type 'Plot' is missing the following properties from type 'Plot': tag, content, contentLength, name, and 21 more.

    38   const plot1: Alias_Doc_Plot = plot
              ~~~~~
  */
  const plot1: Alias_Doc_Plot = plot
  console.log("plot1 is an instance of Alias_Doc_Plot:", plot1 instanceof Alias_Doc_Plot)

  /*

  Runtime log:
    plot2 is an instance of Pos.Plot: false

  TypeCheck:
    No error
  */
  const plot2: Pos.Plot = plot
  console.log("plot2 is an instance of Pos.Plot:", plot2 instanceof Pos.Plot)

  return null
})
