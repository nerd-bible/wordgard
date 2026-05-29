import {GardState} from "wordgard/state"

export function eqArray<T extends {eq(b: T): boolean}>(a?: readonly T[] | null, b?: readonly T[] | null) {
  if (!a || !b) return a == b
  if (a == b) return true
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].eq(b[i])) return false
  return true
}

export const exceptionSink = GardState.Facet.define<(exception: any) => void>()

/// Log or report an unhandled exception in client code. Should
/// probably only be used by extension code that allows client code to
/// provide functions, and calls those functions in a context where an
/// exception can't be propagated to calling code in a reasonable way
/// (for example when in an event handler).
///
/// Either calls a handler registered with {@link
/// Wordgard.exceptionSink}, `window.onerror`, if defined, or
/// `console.error` (in which case it'll pass `context`, when given,
/// as first argument).
export function logException(state: GardState, exception: any, context?: string) {
  let handler = state.facet(exceptionSink)
  if (handler.length) handler[0](exception)
  else if (window.onerror) window.onerror(String(exception), context, undefined, undefined, exception)
  else if (context) console.error(context + ":", exception)
  else console.error(exception)
}
