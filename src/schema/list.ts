import {GardState} from "wordgard/state"
import {Command, Menu, toggleList, listIsActive} from "wordgard/command"
import {BulletList, OrderedList, ListItem, InlineListItem} from "wordgard/schema-def"
import {phrases} from "wordgard/phrases"
import {InputRule} from "wordgard/editor"

export function bulletList(config: {blockItems?: boolean} = {}) {
  return [GardState.schemaElement.of(BulletList),
          GardState.schemaElement.of(config.blockItems == false ? InlineListItem : ListItem),
          bulletList.toggleButton, bulletList.createOnDash]
}

export namespace bulletList {
  export const createOnDash = InputRule.wrapping(/^ ?- $/, BulletList)

  export const toggleButton = Menu.Button.define({
    run: Command.bind(toggleList, BulletList),
    active: listIsActive(BulletList),
    label: {
      icon: "M34 75a3 3 0 0 1 0-6h56a3 3 0 0 1 0 6h-56m0-25a3 3 0 0 1 0-6h56a3 3 0 0 1 0 6h-56m0-25a3 3 0 0 1 0-6h56a3 3 0 0 1 0 6h-56m-22 3a6 6 0 1 0 0-12 6 6 0 0 0 0 12m0 25a6 6 0 1 0 0-12 6 6 0 0 0 0 12m0 25a6 6 0 1 0 0-12 6 6 0 0 0 0 12",
      directional: true
    },
    description: phrases.ref("toggle_bullet_list"),
    parent: Menu.Group.blockMenu,
    rank: 20
  })
}

export function orderedList(config: {blockItems?: boolean} = {}) {
  return [GardState.schemaElement.of(OrderedList),
          GardState.schemaElement.of(config.blockItems == false ? InlineListItem : ListItem),
          orderedList.toggleButton, orderedList.createOnNumber]
}

export namespace orderedList {
  export const createOnNumber = InputRule.wrapping(/^ ?(\d+)\. $/, match => OrderedList.of(+match[1]!.text))

  export const toggleButton = Menu.Button.define({
    run: Command.bind(toggleList, OrderedList.default!),
    active: listIsActive(OrderedList.default!),
    label: {
      icon: "M34 75a3 3 0 0 1 0-6h56a3 3 0 0 1 0 6h-56m0-25a3 3 0 0 1 0-6h56a3 3 0 0 1 0 6h-56m0-25a3 3 0 0 1 0-6h56a3 3 0 0 1 0 6h-56M11 74v-3H13c1 0 2-1 2-2 0-1-1-2-2-2-1 0-2 1-2 2h-4c0-3 2-5 6-5 4 0 6 2 6 4a4 4 0 0 1-3 4v0a4 4 0 0 1 4 4c0 3-3 5-7 5-4 0-6-2-6-5h4c0 1 1 2 3 2 2 0 3-1 3-2 0-1-1-2-3-2h-2zm0-29h-4v0c0-3 2-5 6-5 4 0 6 2 6 5 0 2-2 4-3 5l-3 4h7V57H7v-3l6-6c1-1 2-2 2-3 0-1-1-2-2-2a2 2 0 0 0-2 2zM16 31h-4V18h0l-4 3v-4l4-3h4z",
      directional: true
    },
    description: phrases.ref("toggle_ordered_list"),
    parent: Menu.Group.blockMenu,
    rank: 30
  })
}
