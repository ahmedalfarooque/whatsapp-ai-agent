import { Link } from 'react-router-dom';
import { Card } from '../ui/Card';
import { Icon } from '../ui/Icon';
import type { Service } from '../../data/types';

export function ServiceCard({ service }: { service: Service }) {
  return (
    <Card>
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-gradient text-base">
        <Icon name={service.icon} />
      </div>
      <h3 className="mt-4 font-display text-lg font-semibold text-ink">{service.name}</h3>
      <p className="mt-2 text-sm text-muted">{service.shortDescription}</p>
      <Link
        to={`/services/${service.slug}`}
        className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-accent2 hover:text-accent"
      >
        Learn more →
      </Link>
    </Card>
  );
}
