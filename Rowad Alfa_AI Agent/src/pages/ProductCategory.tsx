import { useParams } from 'react-router-dom';
import { PageShell } from '../components/layout/PageShell';
import { ProductCard } from '../components/product/ProductCard';
import { categoryLabels, getProductsByCategory } from '../data/products';
import type { ProductCategory as CategoryType } from '../data/types';
import { NotFound } from './NotFound';

export function ProductCategoryPage() {
  const { category } = useParams();
  const isValid = category === 'audio-systems' || category === 'accessories-screens';

  if (!isValid) return <NotFound />;

  const typedCategory = category as CategoryType;
  const items = getProductsByCategory(typedCategory);

  return (
    <PageShell
      eyebrow="Product Category"
      title={categoryLabels[typedCategory]}
      description={`${items.length} product${items.length === 1 ? '' : 's'} in this category.`}
    >
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((p, i) => (
          <ProductCard key={p.slug} product={p} seed={i} />
        ))}
      </div>
    </PageShell>
  );
}
