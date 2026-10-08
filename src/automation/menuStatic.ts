/**
 * The built-in guided-menu structure of the ORIGINAL business (Rowad Alfa
 * Auto Care: car audio, accessories, care, tinting, prices…). It is kept
 * exactly as it was, and is used only for the original business (account 1).
 * Every other business gets a menu compiled from its own configuration
 * (menuConfig.ts) — see getMenuTables().
 */

export const MENU_STATES = {
  AWAITING_LANGUAGE: 'AWAITING_LANGUAGE',
  AWAITING_LANGUAGE_SWITCH: 'AWAITING_LANGUAGE_SWITCH',
  MAIN_MENU: 'MAIN_MENU',
  SUBMENU_AUDIO: 'SUBMENU_AUDIO',
  SUBMENU_ACCESSORIES: 'SUBMENU_ACCESSORIES',
  SUBMENU_CARE: 'SUBMENU_CARE',
  SUBMENU_TINT: 'SUBMENU_TINT',
  SUBMENU_PRICES: 'SUBMENU_PRICES',
  /** The customer is looking at a numbered list of catalogues (businesses with the catalogue library only). */
  CATALOGUE_SELECT: 'CATALOGUE_SELECT',
} as const;

export interface MenuOption {
  /** Template sent when this number is chosen (undefined for flows/handoff). */
  template?: string;
  /** State to move into (undefined = unchanged). */
  state?: string;
  /** Starts a multi-step flow instead of sending a single template. */
  flow?: 'appointment' | 'quotation';
  /** Pauses automation and hands the customer to staff. */
  handoff?: boolean;
  /** Shows the business's catalogue list (only ever set by a non-original business's own menu). */
  catalogues?: boolean;
}

export interface SubmenuDef {
  menuTemplate: string;
  options: Record<string, MenuOption>;
}

export interface FlowDef {
  statePrefix: string;
  intro: string;
  confirm: string;
  fields: readonly string[];
  stepTemplate: (step: number) => string;
}

export type FlowSet = Record<'appointment' | 'quotation', FlowDef>;

/** Main menu: the option number → what happens. Text for the numbers lives in the main_menu template. */
export const MAIN_MENU_OPTIONS: Record<string, MenuOption> = {
  '1': { template: 'car_audio', state: MENU_STATES.SUBMENU_AUDIO },
  '2': { template: 'car_accessories', state: MENU_STATES.SUBMENU_ACCESSORIES },
  '3': { template: 'car_care', state: MENU_STATES.SUBMENU_CARE },
  '4': { template: 'tinting_protection', state: MENU_STATES.SUBMENU_TINT },
  '5': { template: 'prices_enquiries', state: MENU_STATES.SUBMENU_PRICES },
  '6': { template: 'location_hours' },
  '7': { flow: 'appointment' },
  '8': { handoff: true },
  '9': { template: 'about' },
};

/** Sub-menus: state → (menu template, option number → action). */
export const SUBMENUS: Record<string, SubmenuDef> = {
  [MENU_STATES.SUBMENU_AUDIO]: {
    menuTemplate: 'car_audio',
    options: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), { template: `car_audio_${n}` }])),
  },
  [MENU_STATES.SUBMENU_ACCESSORIES]: {
    menuTemplate: 'car_accessories',
    options: Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [String(n), { template: `car_accessories_${n}` }])),
  },
  [MENU_STATES.SUBMENU_CARE]: {
    menuTemplate: 'car_care',
    options: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((n) => [String(n), { template: `car_care_${n}` }])),
  },
  [MENU_STATES.SUBMENU_TINT]: {
    menuTemplate: 'tinting_protection',
    options: Object.fromEntries([1, 2, 3, 4, 5].map((n) => [String(n), { template: `tinting_protection_${n}` }])),
  },
  [MENU_STATES.SUBMENU_PRICES]: {
    menuTemplate: 'prices_enquiries',
    options: {
      '1': { template: 'prices_products' },
      '2': { template: 'prices_services' },
      '3': { template: 'prices_offers_list' },
      '4': { flow: 'quotation' },
      '5': { template: 'prices_inquiry_cart' },
    },
  },
};

/** Multi-step flows of the original business: the answer stored at each step and the prompt for the next one. */
export const FLOWS = {
  appointment: {
    statePrefix: 'APPOINTMENT_STEP_',
    intro: 'appointment_intro',
    confirm: 'appointment_confirm',
    fields: ['name', 'make', 'model', 'year', 'service', 'date', 'time', 'notes'],
    stepTemplate: (step: number) => `appointment_step_${step}`,
  },
  quotation: {
    statePrefix: 'QUOTATION_STEP_',
    intro: 'quotation_intro',
    confirm: 'quotation_confirm',
    fields: ['name', 'vehicle', 'service', 'notes'],
    stepTemplate: (step: number) => `quotation_step_${step}`,
  },
} as const satisfies FlowSet;
