import type { CustomerRequestKind, CustomerRequestStatus } from '../memory/customerRequestRepo';

/**
 * The status rules of a request, in one place and free of I/O.
 *
 * Appointments keep the permissive behaviour they always had (staff can set any appointment status) except that the quotation-only
 * statuses do not apply to them. A quotation follows a real lifecycle:
 *
 *   pending → preparing → approved → sent → completed / closed / expired
 *                  └ rejected / cancelled at any point before it is sent (and cancelled/expired after)
 *
 * "approved" means staff decided to quote; it does NOT mean the customer has the quotation. "sent" is recorded only when the
 * quotation message actually left through WhatsApp (or, with a stated reason, staff sent it by other means). `confirmed` is the
 * status quotations used before this lifecycle existed; those rows stay valid and can move on, and older callers may still set it
 * (it is simply no longer offered: Approved replaces it).
 */

export const QUOTATION_ONLY_STATUSES: readonly CustomerRequestStatus[] = ['preparing', 'approved', 'sent', 'expired'];

const QUOTATION_FLOW: Record<CustomerRequestStatus, readonly CustomerRequestStatus[]> = {
  pending: ['preparing', 'contacted', 'approved', 'confirmed', 'rejected', 'cancelled', 'closed'],
  preparing: ['pending', 'contacted', 'approved', 'confirmed', 'rejected', 'cancelled', 'closed'],
  contacted: ['pending', 'preparing', 'approved', 'confirmed', 'rejected', 'cancelled', 'closed'],
  approved: ['preparing', 'sent', 'rejected', 'cancelled'],
  sent: ['preparing', 'completed', 'closed', 'expired', 'cancelled'],
  confirmed: ['preparing', 'approved', 'sent', 'completed', 'closed', 'cancelled', 'rejected'],
  completed: ['closed'],
  rejected: [],
  cancelled: [],
  expired: ['closed'],
  closed: [],
};

export class RequestTransitionError extends Error {
  status = 409;
}

export function statusAllowedForKind(kind: CustomerRequestKind, status: CustomerRequestStatus): boolean {
  return kind === 'quotation' || !QUOTATION_ONLY_STATUSES.includes(status);
}

export function canTransition(kind: CustomerRequestKind, from: CustomerRequestStatus, to: CustomerRequestStatus): boolean {
  if (from === to) return true;
  if (!statusAllowedForKind(kind, to)) return false;
  if (kind === 'appointment') return true;
  return QUOTATION_FLOW[from]?.includes(to) ?? false;
}

/** The statuses a request of this kind may move to from its current one (what the dashboard offers as buttons). */
export function nextStatuses(kind: CustomerRequestKind, from: CustomerRequestStatus): CustomerRequestStatus[] {
  const all = Object.keys(QUOTATION_FLOW) as CustomerRequestStatus[];
  // "confirmed" stays accepted for older callers but is not offered for a quotation: Approved is its replacement.
  return all.filter((s) => s !== from && canTransition(kind, from, s) && s !== 'sent' && !(kind === 'quotation' && s === 'confirmed'));
}
