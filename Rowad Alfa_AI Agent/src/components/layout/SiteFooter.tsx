import { Icon } from '../ui/Icon';
import { businessProfile } from '../../data/business';

export function SiteFooter() {
  const b = businessProfile;
  return (
    <footer className="border-t border-line bg-panel/40">
      <div className="mx-auto max-w-6xl px-5 py-12">
        <div className="grid gap-8 sm:grid-cols-3">
          <div>
            <p className="font-display text-lg font-bold text-ink">{b.identity.name.value}</p>
            <p className="mt-2 max-w-xs text-sm text-muted">{b.identity.tagline.value}</p>
          </div>
          <div className="space-y-2 text-sm text-muted">
            <p className="flex items-center gap-2">
              <Icon name="pin" className="h-4 w-4 text-accent2" />
              {b.location.street.value}, {b.location.city.value}, {b.location.country.value}
            </p>
            {b.contact.phones.map((p) => (
              <p key={p.value} className="flex items-center gap-2">
                <Icon name="phone" className="h-4 w-4 text-accent2" />
                {p.value}
              </p>
            ))}
          </div>
          <div className="text-sm">
            <a
              href={b.contact.instagramUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-muted hover:text-accent2"
            >
              <Icon name="instagram" className="h-4 w-4" />
              {b.identity.handle.value}
            </a>
          </div>
        </div>
        <p className="mt-10 text-xs text-muted/70">
          Business details sourced from the public Instagram profile above; presented here as the business's own
          claims, not independently verified.
        </p>
      </div>
    </footer>
  );
}
