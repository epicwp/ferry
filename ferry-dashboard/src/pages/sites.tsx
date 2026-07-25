import { AppLayout } from '../layout';

export function SitesPage() {
  return (
    <AppLayout title="Sites" headerRight={<span className="mono" style={{ fontSize: 12, color: 'var(--faint)' }}>0 sites</span>}>
      <div />
    </AppLayout>
  );
}
