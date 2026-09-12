import { useParams } from 'react-router-dom';
import { PageShell } from '../components/layout/PageShell';
import { Card } from '../components/ui/Card';
import { VisualConcept } from '../components/ui/VisualConcept';
import { Button } from '../components/ui/Button';
import { ProductCard } from '../components/product/ProductCard';
import { getProductBySlug, getRelatedProducts } from '../data/products';
import { NotFound } from './NotFound';

export function ProductDetail() {
  const { slug } = useParams();
  const product = slug ? getProductBySlug(slug) : undefined;

  if (!product) return <NotFound />;

  const related = getRelatedProducts(product);

  return (
    <PageShell eyebrow="Product" title={product.name} description={product.description}>
      <div className="grid gap-8 lg:grid-cols-3">
        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-2">
          {[0, 1].map((seed) => (
            <div key={seed} className="h-52 overflow-hidden rounded-2xl border border-line">
              <VisualConcept seed={seed} />
            </div>
          ))}
          <Card className="sm:col-span-2">
            <h3 className="font-display text-lg font-semibold">Features</h3>
            <ul className="mt-3 grid gap-2 text-sm text-muted sm:grid-cols-2">
              {product.features.map((f) => (
                <li key={f} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent2" />
                  {f}
                </li>
              ))}
            </ul>
            <h3 className="mt-6 font-display text-lg font-semibold">Applications</h3>
            <ul className="mt-3 grid gap-2 text-sm text-muted sm:grid-cols-2">
              {product.applications.map((a) => (
                <li key={a} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  {a}
                </li>
              ))}
            </ul>
          </Card>
        </div>
        <Card>
          <h3 className="font-display text-lg font-semibold">Interested?</h3>
          <p className="mt-2 text-sm text-muted">
            Ask about pricing and fitting availability for {product.name.toLowerCase()}.
          </p>
          <div className="mt-5">
            <Button to="/contact">Contact Us</Button>
          </div>
        </Card>
      </div>

      {related.length > 0 && (
        <div className="mt-14">
          <h3 className="font-display text-xl font-semibold">Related products</h3>
          <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {related.map((r, i) => (
              <ProductCard key={r.slug} product={r} seed={i + 1} />
            ))}
          </div>
        </div>
      )}
    </PageShell>
  );
}
