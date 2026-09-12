import { PageShell } from '../components/layout/PageShell';
import { Card } from '../components/ui/Card';
import { Icon } from '../components/ui/Icon';
import { businessProfile } from '../data/business';

export function Contact() {
  const b = businessProfile;

  return (
    <PageShell
      eyebrow="Contact"
      title="Get in touch"
      description="Visit in-store or reach out using the details below — all sourced from the business's public Instagram profile."
    >
      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <div className="flex items-center gap-3">
            <Icon name="pin" className="h-5 w-5 text-accent2" />
            <h3 className="font-display font-semibold">Location</h3>
          </div>
          <p className="mt-3 text-sm text-muted">
            {b.location.street.value}
            <br />
            {b.location.city.value}, {b.location.country.value}
          </p>
        </Card>
        <Card>
          <div className="flex items-center gap-3">
            <Icon name="phone" className="h-5 w-5 text-accent2" />
            <h3 className="font-display font-semibold">Phone</h3>
          </div>
          <div className="mt-3 space-y-1 text-sm text-muted">
            {b.contact.phones.map((p) => (
              <p key={p.value}>{p.value}</p>
            ))}
          </div>
        </Card>
        <Card className="sm:col-span-2">
          <div className="flex items-center gap-3">
            <Icon name="instagram" className="h-5 w-5 text-accent2" />
            <h3 className="font-display font-semibold">Instagram</h3>
          </div>
          <a
            href={b.contact.instagramUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-block text-sm text-accent2 hover:text-accent"
          >
            {b.identity.handle.value}
          </a>
        </Card>
      </div>
    </PageShell>
  );
}
