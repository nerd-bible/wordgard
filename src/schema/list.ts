import {Command, Menu, toggleList, listIsActive} from "wordgard/command"
import {BulletList, OrderedList, ListItem, InlineListItem} from "wordgard/schema-def"
import {icon} from "wordgard/menu"
import {phrases} from "wordgard/phrases"
import {InputRule} from "wordgard/inputrule"

export function bulletList(config: {blockItems?: boolean} = {}) {
  return [BulletList, config.blockItems == false ? InlineListItem : ListItem, bulletList.toggleButton, bulletList.createOnDash]
}

export namespace bulletList {
  export const createOnDash = InputRule.wrapping(/^ ?- $/, BulletList)

  export const toggleButton = Menu.Button.define({
    run: Command.bind(toggleList, BulletList),
    active: listIsActive(BulletList),
    label: icon.BulletList,
    description: phrases.ref("toggle_bullet_list"),
    parent: Menu.BlockMenu,
    rank: 20
  })
}

export function orderedList(config: {blockItems?: boolean} = {}) {
  return [OrderedList, config.blockItems == false ? InlineListItem : ListItem, orderedList.toggleButton, orderedList.createOnNumber]
}

export namespace orderedList {
  export const createOnNumber = InputRule.wrapping(/^ ?(\d+)\. $/, match => OrderedList.of(+match[1]!.text))

  export const toggleButton = Menu.Button.define({
    run: Command.bind(toggleList, OrderedList.default!),
    active: listIsActive(OrderedList.default!),
    label: icon.OrderedList,
    description: phrases.ref("toggle_ordered_list"),
    parent: Menu.BlockMenu,
    rank: 30
  })
}
