import { getCustomerFlowData, type Customer } from '../memory/customerRepo';
import { getCustomerRequestByReference, listCustomerRequestsFor, type CustomerRequest } from '../memory/customerRequestRepo';
import { requestTemplateVars, statusLabel } from '../requests/requestService';
import type { TemplateVars } from '../templates/templateRepo';
import { CART_STATES } from './cartStates';
import { sentQuotationSummary } from '../quotations/quotationService';
import {
  CartFullError,
  addCartItem,
  cartItems,
  cleanItemText,
  getOpenCart,
  getOrCreateOpenCart,
  parseQuantity,
  removeCartItem,
  renderCartLines,
  submitCart,
} from './cartRepo';

/**
 * The customer's side of the Inquiry Cart: one small state machine behind the main-menu option every business has. It decides which
 * reply templates to send and what the customer's menu state becomes; the router only recognises that a message belongs here, and the
 * pipeline sends the replies. All text lives in the editable reply templates (templates/cartDefaults.ts), so the cart speaks Arabic or
 * English like the rest of the menu and a business can reword it. Nothing here invents a product, a price or a promise.
 */

export { CART_STATES, isCartState, cartConsumesFreeText } from './cartStates';

export interface CartReply {
  key: string;
  vars?: TemplateVars;
}

export interface CartOutcome {
  replies: CartReply[];
  state: string;
  flowData: Record<string, string> | null;
  /** Set when this message submitted the cart: the pipeline alerts the business, exactly as for any new request. */
  request?: CustomerRequest;
}

const SKIP = new Set(['skip', 'no', 'none', 'n/a', '-', 'تخطي', 'تخطى', 'لا', 'بدون']);
const REFERENCE = /\b(?:APT|INQ)-\d{4}-\d{4}\b/i;
const STATUS_LIST_LIMIT = 5;

type Lang = 'ar' | 'en';

function lang(customer: Customer): Lang {
  return customer.language === 'ar' ? 'ar' : 'en';
}

function emptyCartText(language: Lang): string {
  return language === 'ar' ? 'السلة فارغة.' : 'Your cart is empty.';
}

function cartText(customer: Customer): string {
  const cart = getOpenCart(customer.id);
  const items = cart ? cartItems(cart.id) : [];
  return items.length ? renderCartLines(items, lang(customer)) : emptyCartText(lang(customer));
}

function menu(customer: Customer, ...before: CartReply[]): CartOutcome {
  return { replies: [...before, { key: 'cart_menu', vars: { details: cartText(customer) } }], state: CART_STATES.MENU, flowData: null };
}

function invalid(state: string, flowData: Record<string, string> | null = null): CartOutcome {
  return { replies: [{ key: 'cart_invalid_input' }], state, flowData };
}

/** Customer-safe one-line summary of a request: reference, type and status. No internal notes ever appear here. */
function requestLine(request: CustomerRequest, language: Lang): string {
  const kind = request.kind === 'quotation' ? (language === 'ar' ? 'عرض سعر' : 'Quotation') : language === 'ar' ? 'موعد' : 'Appointment';
  return `${request.reference} — ${kind} — ${statusLabel(request.status, language)}`;
}

function statusList(customer: Customer): CartOutcome {
  const language = lang(customer);
  const requests = listCustomerRequestsFor(customer.id, STATUS_LIST_LIMIT);
  if (requests.length === 0) return { replies: [{ key: 'cart_status_none' }], state: CART_STATES.MENU, flowData: null };
  return { replies: [{ key: 'cart_status_list', vars: { details: requests.map((r) => requestLine(r, language)).join('\n') } }], state: CART_STATES.STATUS, flowData: null };
}

/** The customer's OWN request by reference. Another customer's reference, another business's reference and a made-up one all answer the same. */
function statusDetail(customer: Customer, text: string): CartOutcome {
  const reference = REFERENCE.exec(text)?.[0];
  const request = reference ? getCustomerRequestByReference(reference) : undefined;
  if (!request || request.customer_id !== customer.id) return { replies: [{ key: 'cart_status_not_found' }], state: CART_STATES.STATUS, flowData: null };
  const language = lang(customer);
  const vars = requestTemplateVars(request, customer, language);
  // The quotation the customer was actually sent (only once delivered); never a draft, never an internal note.
  const quote = request.kind === 'quotation' ? sentQuotationSummary(request.id, language) : '';
  if (quote) vars.details = `\n\n`;
  return { replies: [{ key: 'cart_status_detail', vars }], state: CART_STATES.STATUS, flowData: null };
}

function submit(customer: Customer, waId: string): CartOutcome {
  const language = lang(customer);
  const result = submitCart(customer.id, waId, customer.display_name ?? '', language);
  if (!result) return { replies: [{ key: 'cart_general_prompt' }], state: CART_STATES.GENERAL, flowData: null }; // nothing to send: never create an empty request
  return {
    replies: [{ key: 'cart_submitted', vars: { reference: result.request.reference, details: result.request.payload.details ?? '' } }],
    state: 'MAIN_MENU',
    flowData: null,
    request: result.request,
  };
}

/**
 * One cart interaction. `input` is null when the customer has just chosen the Inquiry Cart in the main menu; otherwise it is the
 * message they sent while in a cart state. Writes only this customer's cart in this business.
 */
export function runCart(customer: Customer, waId: string, input: string | null): CartOutcome {
  if (input === null) return menu(customer);

  const state = customer.menu_state;
  const text = input.trim();
  const choice = /^\d{1,2}$/.test(text) ? Number(text) : null;

  switch (state) {
    case CART_STATES.MENU: {
      if (choice === 1) return { replies: [{ key: 'cart_add_prompt' }], state: CART_STATES.ADD, flowData: null };
      if (choice === 2) {
        const cart = getOpenCart(customer.id);
        const items = cart ? cartItems(cart.id) : [];
        if (items.length === 0) return menu(customer);
        return { replies: [{ key: 'cart_remove_prompt', vars: { details: renderCartLines(items, lang(customer)) } }], state: CART_STATES.REMOVE, flowData: null };
      }
      if (choice === 3) {
        const cart = getOpenCart(customer.id);
        const items = cart ? cartItems(cart.id) : [];
        // An empty cart still allows a general inquiry: one message from the customer becomes the request.
        if (items.length === 0) return { replies: [{ key: 'cart_general_prompt' }], state: CART_STATES.GENERAL, flowData: null };
        return { replies: [{ key: 'cart_review', vars: { details: renderCartLines(items, lang(customer)) } }], state: CART_STATES.REVIEW, flowData: null };
      }
      if (choice === 4) return statusList(customer);
      return invalid(CART_STATES.MENU);
    }

    case CART_STATES.ADD: {
      const description = cleanItemText(text);
      if (!description) return invalid(CART_STATES.ADD);
      return { replies: [{ key: 'cart_qty_prompt' }], state: CART_STATES.QTY, flowData: { pending: description } };
    }

    case CART_STATES.QTY: {
      const pending = getCustomerFlowData(customer).pending;
      if (!pending) return menu(customer);
      const quantity = SKIP.has(text.toLowerCase()) ? null : parseQuantity(text);
      if (quantity === null && !SKIP.has(text.toLowerCase())) return invalid(CART_STATES.QTY, { pending });
      try {
        addCartItem(getOrCreateOpenCart(customer.id).id, { description: pending, quantity });
      } catch (error) {
        if (error instanceof CartFullError) return menu(customer, { key: 'cart_full' });
        throw error;
      }
      return menu(customer, { key: 'cart_item_added' });
    }

    case CART_STATES.REMOVE: {
      const cart = getOpenCart(customer.id);
      if (choice === null || !cart || !removeCartItem(cart.id, choice)) return invalid(CART_STATES.REMOVE);
      return menu(customer, { key: 'cart_item_removed' });
    }

    case CART_STATES.REVIEW: {
      if (choice === 1) return submit(customer, waId);
      if (choice === 2) return menu(customer);
      return invalid(CART_STATES.REVIEW);
    }

    case CART_STATES.GENERAL: {
      const description = cleanItemText(text);
      if (!description) return invalid(CART_STATES.GENERAL);
      addCartItem(getOrCreateOpenCart(customer.id).id, { description, source: 'general' });
      return submit(customer, waId);
    }

    case CART_STATES.STATUS:
      return statusDetail(customer, text);

    default:
      return menu(customer);
  }
}
