import { PageShell } from '../components/layout/PageShell';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { offers } from '../data/offers';

export function Offers() {
  return (
    <PageShell
      eyebrow="Offers"
      title="Promotions & packages"
      description="Offers advertised by the business — confirm current validity in-store before visiting."
    >
      <div className="grid gap-5 sm:grid-cols-2">
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
    </PageShell>
  );
}
