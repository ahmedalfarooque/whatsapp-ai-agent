import { Link } from 'react-router-dom';
import { PageShell } from '../components/layout/PageShell';
import { Card } from '../components/ui/Card';
import { VisualConcept } from '../components/ui/VisualConcept';
import { categoryLabels, getProductsByCategory } from '../data/products';
import type { ProductCategory } from '../data/types';

const categories = Object.keys(categoryLabels) as ProductCategory[];

export function Products() {
  return (
    <PageShell
      eyebrow="Products"
      title="Product categories"
      description="Browse by category, or open a product directly for full details."
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {categories.map((category, i) => {
          const items = getProductsByCategory(category);
          return (
            <Link key={category} to={`/products/${category}`}>
              <Card className="overflow-hidden p-0">
                <div className="h-40 w-full">
                  <VisualConcept seed={i} />
                </div>
                <div className="p-6">
                  <h3 className="font-display text-xl font-semibold">{categoryLabels[category]}</h3>
                  <p className="mt-2 text-sm text-muted">{items.length} products</p>
                </div>
              </Card>
            </Link>
          );
        })}
      </div>
    </PageShell>
  );
}
