import { Construction } from 'lucide-react';
import { EmptyState, Card } from '@/components/ui';

// Placeholder for modules not yet implemented. Keeps navigation working
// without lying about what's available. Each module's eventual page will
// replace this in src/pages/<module>/.
export function StubPage({ name, description }: { name: string; description: string }) {
  return (
    <div className="p-6">
      <Card>
        <EmptyState
          icon={<Construction className="w-12 h-12" />}
          title={`${name} — coming soon`}
          body={description}
        />
      </Card>
    </div>
  );
}
