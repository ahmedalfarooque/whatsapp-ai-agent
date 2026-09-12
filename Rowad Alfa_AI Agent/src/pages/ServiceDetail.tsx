import { Link, useParams } from 'react-router-dom';
import { PageShell } from '../components/layout/PageShell';
import { Card } from '../components/ui/Card';
import { Icon } from '../components/ui/Icon';
import { Button } from '../components/ui/Button';
import { services } from '../data/services';
import { NotFound } from './NotFound';

export function ServiceDetail() {
  const { slug } = useParams();
  const service = services.find((s) => s.slug === slug);

  if (!service) return <NotFound />;

  return (
    <PageShell eyebrow="Service" title={service.name} description={service.description}>
      <div className="grid gap-8 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-gradient text-base">
            <Icon name={service.icon} />
          </div>
          <h3 className="mt-4 font-display text-lg font-semibold">Benefits</h3>
          <ul className="mt-3 space-y-2 text-sm text-muted">
            {service.benefits.map((b) => (
              <li key={b} className="flex items-start gap-2">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent2" />
                {b}
              </li>
            ))}
          </ul>
        </Card>
        <Card className="lg:col-span-2">
          <h3 className="font-display text-lg font-semibold">Interested in this service?</h3>
          <p className="mt-2 text-sm text-muted">
            Contact us to check availability and pricing for {service.name.toLowerCase()}.
          </p>
          <div className="mt-6 flex gap-3">
            <Button to="/contact">Contact Us</Button>
            <Link to="/services" className="inline-flex items-center px-2 text-sm text-muted hover:text-ink">
              ← All services
            </Link>
          </div>
        </Card>
      </div>
    </PageShell>
  );
}
