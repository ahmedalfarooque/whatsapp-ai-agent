import { PageShell } from '../components/layout/PageShell';
import { VisualConcept } from '../components/ui/VisualConcept';

const concepts = [
  { title: 'Studio Product Photography', desc: 'Clean, single-light product shots for feed posts.' },
  { title: 'Workshop Environment', desc: 'Authentic fitting-bay scenes for behind-the-scenes content.' },
  { title: 'Vehicle Pairing', desc: 'Product shown alongside a modern vehicle silhouette.' },
  { title: 'Macro Detail', desc: 'Close-up texture and finish shots.' },
  { title: 'Before / After', desc: 'Split-frame upgrade comparisons.' },
  { title: 'Technical Presentation', desc: 'Clean, spec-forward layouts for detail-oriented buyers.' },
];

export function Gallery() {
  return (
    <PageShell
      eyebrow="Gallery"
      title="Original visual concepts"
      description="Generated compositions — not Instagram photos — showing the creative directions this brand can use."
    >
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {concepts.map((c, i) => (
          <div key={c.title} className="overflow-hidden rounded-2xl border border-line bg-panel">
            <div className="h-44">
              <VisualConcept seed={i} />
            </div>
            <div className="p-5">
              <h3 className="font-display font-semibold">{c.title}</h3>
              <p className="mt-1 text-sm text-muted">{c.desc}</p>
            </div>
          </div>
        ))}
      </div>
    </PageShell>
  );
}
