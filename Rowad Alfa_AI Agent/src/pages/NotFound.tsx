import { PageShell } from '../components/layout/PageShell';
import { Button } from '../components/ui/Button';

export function NotFound() {
  return (
    <PageShell eyebrow="404" title="Page not found" description="That page doesn't exist or has moved.">
      <Button to="/">Back to Home</Button>
    </PageShell>
  );
}
