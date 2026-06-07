// Lazy wrappers around the Monaco JSON editor. Importing these (instead of
// `./JsonEditor` directly) keeps the ~Mb editor bundle out of the initial
// paint chunk — it's only fetched when a panel that uses it actually mounts.
import { lazy, Suspense, type ComponentProps } from 'react';

import { Skeleton } from '@/components/ui';

const JsonEditor = lazy(() => import('./JsonEditor'));
const JsonViewer = lazy(() =>
  import('./JsonEditor').then((m) => ({ default: m.JsonViewer })),
);

function EditorFallback({ height }: { height?: number | string }) {
  return (
    <div style={{ height: height ?? 360 }}>
      <Skeleton className="rounded-xl h-full" />
    </div>
  );
}

export function LazyJsonEditor(props: ComponentProps<typeof JsonEditor>) {
  return (
    <Suspense fallback={<EditorFallback height={props.height} />}>
      <JsonEditor {...props} />
    </Suspense>
  );
}

export function LazyJsonViewer(props: ComponentProps<typeof JsonViewer>) {
  return (
    <Suspense fallback={<EditorFallback height={props.height} />}>
      <JsonViewer {...props} />
    </Suspense>
  );
}
