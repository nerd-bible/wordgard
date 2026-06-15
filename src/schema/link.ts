import {Menu} from "wordgard/command"
import {ChangeSet} from "wordgard/doc"
import {GardState, Transaction} from "wordgard/state"
import {Link} from "wordgard/schema-def"
import {phrases} from "wordgard/phrases"
import {Wordgard, Dialog, KeyBinding, Tooltip} from "wordgard/editor"

function toggleLink(wg: Wordgard) {
  let {selection, doc} = wg.state
  if (selection.empty) return false
  let remove: ChangeSet.Spec[] = []
  for (let {from, to} of selection.ranges) doc.iterate(from, to, (node, pos) => {
    let has = Link.isInSet(node.marks)
    if (has) remove.push({from: pos, to: pos + node.length, remove: has})
  })
  if (remove.length) {
    wg.dispatch({changes: remove, userEvent: "mark.remove"})
  } else {
    Dialog.show(wg, {
      label: phrases.get(wg.state, "link_target"),
      input: {type: "text", name: "url"},
      submitLabel: phrases.get(wg.state, "create_link"),
      focus: true
    }).result.then(form => {
      wg.focus()
      let url = form && (form.elements.namedItem("url") as HTMLInputElement)?.value
      if (url) wg.dispatch({
        changes: selection.ranges.map(r => ({from: r.from, to: r.to, add: Link.of(url)})),
        userEvent: "mark.add"
      })
    })
  }
  return true
}

function computeLinkTooltip(state: GardState): Tooltip | null {
  if (!state.selection.isCursor) return null
  let {head} = state.sel, before = head.nodeBefore, link = before && Link.isInSet(before.marks)
  if (!link) return null
  let start = head.pos - before!.length, end = head.pos, siblings = head.parent.node.content
  for (let index = head.index - 1; index > 0 && link.isInSet(siblings[index - 1].marks);)
    start -= siblings[--index].length
  for (let index = head.index; index < siblings.length && link.isInSet(siblings[index].marks);)
    end += siblings[index++].length
  return {
    pos: start,
    end,
    above: false,
    create: () => renderLinkTooltip(link.value)
  }
}

const closeLinkTooltip = Transaction.Effect.define<null>()
  
const linkTooltipField = GardState.Field.define<Tooltip | null>({
  create: computeLinkTooltip,
  update(value, tr) {
    if (tr.effects.some(e => e.is(closeLinkTooltip))) return null
    let sel = tr.selection
    if (!tr.docChanged && (!sel || value && sel.isCursor && sel.head >= value.pos && sel.head <= value.end!)) return value
    return computeLinkTooltip(tr.state)
  },
  provide: f => Tooltip.show.from(f)
})

function renderLinkTooltip(target: string) {
  let dom = document.createElement("wg-link-tooltip")
  let link = dom.appendChild(document.createElement("a"))
  link.href = target
  link.textContent = target
  return {dom}
}

const linkTooltipTheme = Wordgard.baseTheme({
  "wg-link-tooltip": {
    maxWidth: "30em",
    fontSize: "90%",
    textOverflow: "ellipsis",
    whiteSpace: "pre",
    overflow: "hidden",
    borderRadius: "3px",
    padding: "2px 5px",
    marginTop: "1px",
    "& a": {
      textDecoration: "none",
      color: "inherit"
    }
  }
})

/// Extensions for a link mark—the {@link Link schema element}, a
/// {@link link.keyBinding key binding}, a {@link link.button menu
/// button}, and the {@link link.tooltip link tooltip}.
export function link(): GardState.Extension {
  return [GardState.schemaElement.of(Link), link.button, link.keyBinding, link.tooltip]
}

export namespace link {
  /// Binds `Mod-k` to toggle the link mark.
  export const keyBinding = KeyBinding.define({
    key: "Mod-k",
    run: toggleLink,
  })

  /// Menu button that will remove the link mark from the selection if
  /// present, or prompt for a target and make the current selection a
  /// link.
  export const button = Menu.Button.define({
    run: toggleLink,
    active(state) {
      let {selection, doc} = state, found = false
      if (!selection.empty) for (let {from, to} of selection.ranges) doc.iterate(from, to, node => {
        if (found) return false
        if (Link.isInSet(node.marks)) found = true
      })
      return found
    },
    enable(state) {
      return !state.selection.empty
    },
    label: {
      icon: "M29 41 21 49a19 19 0 1 0 27 27l11-11A19 19 0 0 0 54 34L50 38a6 6 0 0 0-1 1 13 13 0 0 1 5 22L43 72a12 12 0 1 1-18-18l5-5a25 25 0 0 1-1-8zM41 29A19 19 0 0 0 46 59l5-5a13 13 0 0 1-6-21L57 22a12 12 0 1 1 18 18l-5 5c1 3 1 5 1 8l9-9a19 19 0 1 0-27-27z"
    },
    description: phrases.ref("create_link"),
    parent: Menu.Group.inline,
    rank: 50,
  })

  /// Extension that displays a tooltip with the link target below the
  /// cursor when that is in a link.
  export const tooltip: GardState.Extension = [
    linkTooltipField,
    GardState.prec.low(KeyBinding.define({
      key: "Escape",
      run: wg => {
        if (!wg.state.field(linkTooltipField)) return false
        wg.dispatch({effects: closeLinkTooltip.of(null)})
        return true
      }
    })),
    linkTooltipTheme
  ]
}
