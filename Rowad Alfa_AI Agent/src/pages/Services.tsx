import { PageShell } from '../components/layout/PageShell';
import { ServiceCard } from '../components/service/ServiceCard';
import { services } from '../data/services';

export function Services() {
  return (
    <PageShell
      eyebrow="Services"
      title="Everything fitted, same visit"
      description="From audio installs to accessory fitting, every service below is performed in-store by the same team."
    >
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {services.map((s) => (
          <ServiceCard key={s.slug} service={s} />
        ))}
      </div>
    </PageShell>
  );
}
