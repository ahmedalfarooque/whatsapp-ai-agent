import { Link } from 'react-router-dom';
import { Card } from '../ui/Card';
import { VisualConcept } from '../ui/VisualConcept';
import type { Product } from '../../data/types';

export function ProductCard({ product, seed = 0 }: { product: Product; seed?: number }) {
  return (
    <Card className="flex flex-col overflow-hidden p-0">
      <div className="h-40 w-full">
        <VisualConcept seed={seed} />
      </div>
      <div className="flex flex-1 flex-col p-6">
        <h3 className="font-display text-lg font-semibold text-ink">{product.name}</h3>
        <p className="mt-2 text-sm text-muted">{product.shortDescription}</p>
        <Link
          to={`/products/${product.category}/${product.slug}`}
          className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent2 hover:text-accent"
        >
          View product →
        </Link>
      </div>
    </Card>
  );
}
