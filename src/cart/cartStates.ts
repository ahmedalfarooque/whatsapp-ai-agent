/** Menu states of the Inquiry Cart. Kept free of imports so the router can recognise them without loading the cart flow. */
export const CART_STATES = {
  MENU: 'CART_MENU',
  ADD: 'CART_ADD',
  QTY: 'CART_QTY',
  REMOVE: 'CART_REMOVE',
  REVIEW: 'CART_REVIEW',
  GENERAL: 'CART_GENERAL',
  STATUS: 'CART_STATUS',
} as const;

export function isCartState(state: string | null | undefined): boolean {
  return typeof state === 'string' && state.startsWith('CART_');
}

/** States where the next message is free text the cart consumes whole (an item, a quantity, a reference). */
export function cartConsumesFreeText(state: string | null | undefined): boolean {
  return state === CART_STATES.ADD || state === CART_STATES.QTY || state === CART_STATES.GENERAL || state === CART_STATES.STATUS;
}
