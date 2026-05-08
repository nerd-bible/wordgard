import {Command, toggleList, listIsActive} from "wordgard/command"
import {BulletList, OrderedList, ListItem, InlineListItem} from "wordgard/schema"
import {MenuButton, BlockMenu, icon} from "wordgard/menu"
import {phrases} from "wordgard/phrases"
import {InputRule} from "wordgard/inputrule"

export const menu = {
  toggleBulletList: new MenuButton({
    run: Command.bind(toggleList, BulletList),
    active: listIsActive(BulletList),
    label: icon.BulletList,
    description: phrases.ref("toggle_bullet_list"),
    parent: BlockMenu,
    rank: 20
  }),

  toggleOrderedList: new MenuButton({
    run: Command.bind(toggleList, OrderedList.default!),
    active: listIsActive(OrderedList.default!),
    label: icon.OrderedList,
    description: phrases.ref("toggle_ordered_list"),
    parent: BlockMenu,
    rank: 30
  })
}

export const listOnDash = InputRule.wrapping(/^ ?- $/, BulletList)

export const listOnNumber = InputRule.wrapping(/^ ?(\d+)\. $/, match => OrderedList.of(+match[1]!.text))

// FIXME support inline list items?

export function bulletList(config: {blockItems?: boolean} = {}) {
  return [BulletList, config.blockItems == false ? InlineListItem : ListItem, menu.toggleBulletList, listOnDash]
}

export function orderedList(config: {blockItems?: boolean} = {}) {
  return [OrderedList, config.blockItems == false ? InlineListItem : ListItem, menu.toggleOrderedList, listOnNumber]
}
