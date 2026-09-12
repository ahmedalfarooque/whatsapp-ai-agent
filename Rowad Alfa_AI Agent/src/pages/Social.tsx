import { useState } from 'react';
import { PageShell } from '../components/layout/PageShell';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { contentLibrary, weeklyPlan } from '../data/contentLibrary';
import type { PlannerEntry } from '../data/types';

const statusTone: Record<PlannerEntry['status'], 'accent' | 'muted' | 'offer'> = {
  planned: 'muted',
  'in-progress': 'accent',
  ready: 'offer',
};

export function Social() {
  const [platformFilter, setPlatformFilter] = useState<'all' | PlannerEntry['platform']>('all');

  const filteredPlan =
    platformFilter === 'all' ? weeklyPlan : weeklyPlan.filter((entry) => entry.platform === platformFilter);

  return (
    <PageShell
      eyebrow="Social"
      title="Content library & weekly planner"
      description="Original creative concepts and a starter weekly schedule, derived from the business's real themes — client-side preview only, no backend scheduling is wired up yet."
    >
      <section>
        <h2 className="font-display text-xl font-semibold">Content library</h2>
        <div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {contentLibrary.map((item) => (
            <Card key={item.title}>
              <div className="flex items-center justify-between">
                <Badge tone="muted">{item.platform}</Badge>
                <span className="text-xs text-muted">{item.format}</span>
              </div>
              <h3 className="mt-3 font-display font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm text-muted">{item.visualConcept}</p>
              <p className="mt-2 text-xs text-muted/70">Copy direction: {item.copyDirection}</p>
              <p className="mt-3 text-xs font-mono uppercase tracking-wide text-accent2">{item.campaign}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-16">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="font-display text-xl font-semibold">Weekly planner</h2>
          <select
            value={platformFilter}
            onChange={(e) => setPlatformFilter(e.target.value as typeof platformFilter)}
            className="rounded-full border border-line bg-panel px-4 py-2 text-sm text-ink"
          >
            <option value="all">All platforms</option>
            <option value="Instagram">Instagram</option>
            <option value="Facebook">Facebook</option>
            <option value="Cross-platform">Cross-platform</option>
          </select>
        </div>

        <div className="mt-5 grid gap-3">
          {filteredPlan.map((entry) => (
            <div
              key={entry.day}
              className="grid gap-3 rounded-xl border border-line bg-panel px-5 py-4 md:grid-cols-[100px_110px_1fr_1fr_90px] md:items-center md:gap-4"
            >
              <div className="flex items-center justify-between md:contents">
                <p className="font-display font-semibold">{entry.day}</p>
                <p className="text-xs text-muted">{entry.platform}</p>
              </div>
              <div>
                <p className="text-sm text-ink">{entry.contentType}</p>
                <p className="text-xs text-muted">{entry.productOrService}</p>
              </div>
              <p className="text-xs text-muted">{entry.captionIdea}</p>
              <div className="md:justify-self-start">
                <Badge tone={statusTone[entry.status]}>{entry.status}</Badge>
              </div>
            </div>
          ))}
          {filteredPlan.length === 0 && (
            <p className="rounded-xl border border-dashed border-line px-5 py-8 text-center text-sm text-muted">
              No planned posts for this platform yet.
            </p>
          )}
        </div>
      </section>
    </PageShell>
  );
}
