# Rowad Alfa Auto Care — Product Design Plan

## 0. Project Understanding

Greenfield folder (`Rowad Alfa_AI Agent`, nested inside the WhatsApp AI Agent repo at the user's explicit request — treated as a self-contained sub-project, not wired into the agent's Node/Express code). No existing framework, pages, components, design system, assets, dependencies, routing, backend, or scraping tooling exists yet. Everything below is being created from scratch.

**Stack decision:** Vite + React + TypeScript + Tailwind CSS + Framer Motion + React Router.
Reasons: matches the "premium, motion-rich, multi-page, fast" requirements; no server/backend is needed (this is a marketing/profile site, not a transactional app); static-data-driven (JSON/TS modules) so the "content engine" can later be swapped for a real CMS or the WhatsApp agent's own knowledge-file pattern without a rewrite.

## 1. Business Understanding (from research)

**Source:** public, logged-out view of `instagram.com/rowad_alfa_auto_care` (bio, profile header, and the visible post-grid thumbnails). Instagram began requiring login after a few page loads — browsing stopped there; no login was attempted (credential entry is out of scope for this agent).

**Observed (directly read from the profile/posts):**
- Name: رواد الفا للتجارة / "Rowad Alfa Trading Co." (Instagram handle bio: "🚗 شركة رواد الفا | Rawad Alfa")
- Tagline (Arabic, bio): "من أول تفصيل… لآخر لمسة، سيارتك بشكل أفخم وصوت أقوى" — "From the first detail to the last touch — your car looks more luxurious and sounds stronger."
- Bio categories: 🔊 صوتيات (audio systems) | 🛠️ إكسسوارات (accessories) | ✨ عناية (care) — bio text was truncated by Instagram's "more" toggle beyond this.
- Poster/post content visible in the grid: "Everything your car needs in one place!" / "زينة السيارات" (car accessories/decoration) / "Premium car accessories — Wholesale · Retail · Fitting" / a "50% OFF on installation & fitting charges" promotion / named audio brands **Pioneer** and **Kenwood** / "Android · New Model Screens" (aftermarket infotainment head units) / self-reported claims "100% Original Products" and "Warranty on all products & fittings".
- Location text on a poster: "Mohammed Saeed Naseef St, An Nuzhah, Jeddah" (Jeddah, Saudi Arabia).
- Phone numbers on posters: `05 31 842 393` and `055 819 0545`.
- Account is small/new: 5 followers, 8 following, roughly 10 visible posts dated Feb–May 2026.

**Reasonable inference (labeled as such everywhere it's used — not presented as fact):**
- Likely a small/independent car-audio-and-accessories retailer & installer (not a franchise/dealer), serving walk-in retail and fitting customers in Jeddah.
- "Care" (✨ عناية) most likely refers to car detailing/cosmetic care add-ons sold alongside accessories, since no dedicated detailing imagery was visible in the sampled posts.
- The "50% off installation" line is a time-bound promotion, not a permanent price — treated as an example **Offer**, not a permanent claim.
- Trust badges ("100% Original", "Warranty") are the business's own marketing claims, carried through as *quoted business claims*, never restated as independently-verified facts.

**Explicitly not fabricated:** customer counts, years in business, certifications, star ratings, branch counts — none of these appeared anywhere in the accessible content, so none appear in the build.

## 2. Instagram Research Strategy

Logged-out browser fetch of the profile URL only (`get_page_text`, accessibility tree read, and screenshots of the visible grid). No scraping API/automation beyond the already-available browser tool; no attempt to bypass Instagram's login wall; no image downloads (Instagram media is not ours to redistribute — see Phase 15/Originality rule and the Copyright policy). All imagery in the built site is original (CSS/SVG/gradient compositions), never a copy of an Instagram photo.

## 3. Information Architecture

```
/                    Home — long-form scrolling profile (Hero, Overview, Services,
                     Products, Showcase, Why Choose Us, Offers, Social, Contact)
/services            Services index
/services/:slug      Service detail
/products             Product category index
/products/:category   Category listing
/products/:category/:slug   Product detail (gallery, features, related products)
/offers               Offers / promotions index
/gallery              Visual showcase (original concept imagery, categorized)
/social               Social content showcase + content library + weekly planner
/contact              Contact / CTA
```

Sticky, scroll-spy section tabs (Overview/Services/Products/Gallery/Offers/Social/About/Contact) live on `/` and smooth-scroll to in-page sections; the same labels in the top nav route to the dedicated pages for deep content.

## 4. Component Architecture

`components/layout` (SiteHeader w/ scroll-spy tabs, SiteFooter, PageShell)
`components/ui` (Button, Badge, Card, SectionHeading, StatTile, Tag)
`components/sections` (Hero, Overview, ServicesGrid, ProductShowcase, VisualShowcase, WhyChooseUs, OffersGrid, SocialShowcase, ContactCta)
`components/product` (ProductCard, ProductGallery, RelatedProducts)
`components/content` (ContentPlannerBoard, ContentLibraryCard, PostTemplatePreview)
`data/` — typed TS modules: `business.ts`, `services.ts`, `products.ts`, `offers.ts`, `contentLibrary.ts`, `weeklyPlan.ts` (see §11).

## 5. Design System

- **Palette:** near-black automotive base (`#0B0D12`), carbon panel (`#14171F`), electric-blue accent (`#3B82F6`→`#22D3EE` gradient, echoing the audio-brand LED aesthetic seen in the posts), warning/offer red (`#EF4444`) for promo badges, warm off-white text (`#F4F6FB`).
- **Type:** display face **Sora** (geometric, confident) for headings; body face **Inter** for readability; **JetBrains Mono** for spec/price/tag micro-copy. Loaded from Google Fonts (allowed CDN).
- **Surface language:** dark carbon cards with a single soft cyan glow accent per section — glassmorphism used sparingly (only on the sticky nav and hero overlay), not on every card, per the "don't overuse glass" instruction.
- **Motion:** Framer Motion `whileInView` reveals (fade+rise, one direction, consistent easing), a scroll-progress bar in the header, subtle hover-scale on product/service cards, animated tab underline. All animations respect `prefers-reduced-motion`.

## 6. Data / Content Model

TypeScript interfaces in `src/data/types.ts`: `Service`, `Product` (with `category`, `features`, `applications`, `relatedSlugs`), `Offer`, `ContentLibraryItem` (matches the Phase 17 JSON shape), `PlannerEntry` (matches the Phase 9 fields: date, platform, contentType, product/service ref, captionIdea, imageConcept, status, scheduledTime, creativeDirection).

## 7. Instagram Intelligence Model

`data/business.ts` exports a single `businessProfile` object shaped like the Phase 2 tree (Identity, Brand, Services, Products/Categories, ContentThemes, Offers, Location, Contact) — this is the one place the "observed vs inferred" research above is encoded, with an `evidence: 'observed' | 'inferred'` tag per field so downstream pages/content-generation can distinguish them.

## 8. Product-Generation Strategy

Products are modeled per the two observed categories (Audio Systems, Accessories/Screens) with 3–4 representative items each, written as originally-authored product concepts consistent with what was observed (brand-agnostic where a specific SKU wasn't confirmed) rather than invented specs presented as fact.

## 9. Social-Media Content-Generation Strategy

`contentLibrary.ts` holds reusable creative concepts (Phase 7/17 shape); `weeklyPlan.ts` holds a starter 7-day plan derived from the business's actual themes (audio installs, accessory spotlights, offers, care/detailing tips) rather than a generic template. The `/social` page renders both as an editable-looking (client-side only) planner board and library grid — a foundation, not a live scheduler/CMS.

## 10. Asset-Generation Strategy

No Instagram images are copied. All visual "photography" in the build is CSS/SVG-composited (gradients, radial glows, abstract car/audio silhouettes) under `src/assets/generated/` — clearly original, license-free, and reusable. `public/` is reserved for any future real product photography the business supplies.

## 11. Implementation Phases (this session)

1. Scaffold Vite+React+TS+Tailwind, fonts, design tokens.
2. Build data layer (`data/*.ts`) from the research above.
3. Build layout + design system primitives.
4. Build the Home scrolling profile (Hero → Contact) with scroll-spy tabs.
5. Build Services, Products (+ category + detail), Offers, Gallery, Social, Contact routes.
6. Build the content-library + weekly-planner UI on `/social`.
7. Motion pass (reveals, scroll-spy, reduced-motion guard).
8. Responsive pass (mobile nav, horizontal scroll tabs, card reflow).
9. `npm run build` + lint/typecheck; fix all errors.
10. Manual browser QA pass (desktop + mobile viewport) of every route.

## 12. Testing Strategy

No backend, so no integration test suite is introduced. Verification = `tsc --noEmit` (typecheck), ESLint, `vite build` (production build must succeed), and a real browser click-through of every route at desktop and mobile widths, checking console errors and broken links.

## 13. Acceptance Criteria

- Every route in §3 renders with real content (no lorem ipsum, no "Cannot GET").
- No Instagram images reused; all imagery original.
- No fabricated trust statistics (years/customers/certifications/ratings).
- Business claims sourced from the profile are visibly attributable as the business's own claims, not independently verified.
- Build, typecheck, and lint pass clean.
- Mobile nav/tabs/cards verified in a real (non-squeezed-desktop) mobile viewport.
- Reduced-motion respected.
