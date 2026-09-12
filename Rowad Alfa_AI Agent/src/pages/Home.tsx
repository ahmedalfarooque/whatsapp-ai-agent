import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { SectionHeading } from '../components/ui/SectionHeading';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { EvidenceTag } from '../components/ui/EvidenceTag';
import { VisualConcept } from '../components/ui/VisualConcept';
import { ServiceCard } from '../components/service/ServiceCard';
import { ProductCard } from '../components/product/ProductCard';
import { businessProfile } from '../data/business';
import { services } from '../data/services';
import { products } from '../data/products';
import { offers } from '../data/offers';

const stats = [
  { label: 'Product categories', value: '2' },
  { label: 'Services offered', value: String(services.length) },
  { label: 'Audio brands carried', value: '2' },
];

export function Home() {
  const b = businessProfile;

  return (
    <main>
      {/* 01 — Hero */}
      <section id="overview" className="relative overflow-hidden border-b border-line">
        <div className="absolute inset-0 opacity-40">
          <VisualConcept seed={0} />
        </div>
        <div className="absolute inset-0 bg-gradient-to-r from-base via-base/90 to-base/50" />
        <div className="relative mx-auto max-w-6xl px-5 py-24 sm:py-32">
          <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
            <Badge tone="accent">{b.identity.category.value}</Badge>
            <h1 className="mt-6 max-w-3xl font-display text-4xl font-bold leading-tight text-white sm:text-6xl">
              {b.identity.tagline.value}
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted">
              {b.identity.name.value} — everything your car needs in one place: audio, accessories, and
              professional fitting in {b.location.city.value}.
            </p>
            <div className="mt-8 flex flex-wrap gap-4">
              <Button to="/products">Explore Products</Button>
              <Button to="/contact" variant="secondary">
                Get in Touch
              </Button>
            </div>
          </motion.div>
        </div>
      </section>

      {/* 02 — Business Overview */}
      <section className="mx-auto max-w-6xl px-5 py-20">
        <SectionHeading
          eyebrow="Business Overview"
          title="Audio, accessories & fitting, under one roof"
          description="Rowad Alfa brings together original audio equipment, accessory retail and wholesale, and same-visit professional fitting."
        />
        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          {stats.map((s) => (
            <Card key={s.label}>
              <p className="font-display text-3xl font-bold text-accent2">{s.value}</p>
              <p className="mt-2 text-sm text-muted">{s.label}</p>
            </Card>
          ))}
        </div>
        <div className="mt-8 flex flex-wrap gap-2">
          {b.contentThemes.map((theme) => (
            <span key={theme.value} className="rounded-full border border-line px-3 py-1.5 text-xs text-muted">
              {theme.value}
              <EvidenceTag evidence={theme.evidence} />
            </span>
          ))}
        </div>
      </section>

      {/* 03 — Services */}
      <section id="services" className="border-t border-line bg-panel/30 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <SectionHeading
            eyebrow="Services"
            title="What we do in-store"
            description="Every service is fitted on-site by the same team that sells the equipment."
          />
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {services.map((s) => (
              <ServiceCard key={s.slug} service={s} />
            ))}
          </div>
        </div>
      </section>

      {/* 04/05 — Products */}
      <section id="products" className="mx-auto max-w-6xl px-5 py-20">
        <SectionHeading
          eyebrow="Product Showcase"
          title="A closer look at what we fit"
          description="A sample of the audio systems, screens, and accessories customers come in for."
        />
        <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          {products.map((p, i) => (
            <ProductCard key={p.slug} product={p} seed={i} />
          ))}
        </div>
        <div className="mt-8">
          <Button to="/products" variant="secondary">
            Browse all products
          </Button>
        </div>
      </section>

      {/* 06 — Visual Showcase */}
      <section className="border-t border-line py-20">
        <div className="mx-auto max-w-6xl px-5">
          <SectionHeading
            eyebrow="Automotive Visual Showcase"
            title="Original concept imagery, not stock photos"
            description="Every visual on this site is generated fresh for Rowad Alfa — no Instagram images were reused."
          />
          <div className="mt-10 grid gap-4 sm:grid-cols-3">
            {[1, 2, 3].map((seed) => (
              <div key={seed} className="h-56 overflow-hidden rounded-2xl border border-line">
                <VisualConcept seed={seed} />
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 07 — Why Choose Us */}
      <section className="border-t border-line bg-panel/30 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <SectionHeading eyebrow="Why Choose Us" title="What the business says about itself" />
          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {b.claims.map((claim) => (
              <Card key={claim.value}>
                <p className="text-ink">{claim.value}</p>
                <div className="mt-3">
                  <EvidenceTag evidence={claim.evidence} />
                </div>
              </Card>
            ))}
          </div>
          <p className="mt-6 max-w-2xl text-xs text-muted/70">
            These are the business's own claims as posted publicly — presented here as claims, not independently
            verified facts. No customer counts, ratings, years-in-business, or certifications are shown because
            none were found in the accessible content.
          </p>
        </div>
      </section>

      {/* 08 — Offers */}
      <section id="offers" className="mx-auto max-w-6xl px-5 py-20">
        <SectionHeading eyebrow="Offers" title="Current promotions" />
        <div className="mt-10 grid gap-5 sm:grid-cols-2">
          {offers.map((o) => (
            <Card key={o.slug} className="flex items-start gap-4">
              <Badge tone="offer">{o.badge}</Badge>
              <div>
                <h3 className="font-display text-lg font-semibold">{o.title}</h3>
                <p className="mt-2 text-sm text-muted">{o.description}</p>
                <p className="mt-2 text-xs text-muted/70">{o.validity}</p>
              </div>
            </Card>
          ))}
        </div>
        <div className="mt-8">
          <Button to="/offers" variant="secondary">
            See all offers
          </Button>
        </div>
      </section>

      {/* 09 — Social Content Showcase */}
      <section id="social" className="border-t border-line bg-panel/30 py-20">
        <div className="mx-auto max-w-6xl px-5">
          <SectionHeading
            eyebrow="Social Content Showcase"
            title="How this brand shows up on social"
            description="A preview of the content library and weekly planner built from the business's real themes."
          />
          <div className="mt-8">
            <Button to="/social" variant="secondary">
              Open the content planner
            </Button>
          </div>
        </div>
      </section>

      {/* 10 — Contact / CTA */}
      <section id="contact" className="mx-auto max-w-6xl px-5 py-20">
        <Card className="flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-display text-2xl font-bold">Ready to upgrade your car?</h2>
            <p className="mt-2 text-muted">Visit us in {b.location.city.value} or reach out to plan your fitting.</p>
          </div>
          <Button to="/contact">Contact Us</Button>
        </Card>
        <p className="mt-6 text-sm text-muted">
          Prefer to browse first? See our <Link to="/services" className="text-accent2">services</Link> or{' '}
          <Link to="/products" className="text-accent2">products</Link>.
        </p>
      </section>
    </main>
  );
}
