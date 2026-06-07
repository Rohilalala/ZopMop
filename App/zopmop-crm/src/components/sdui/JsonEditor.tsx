// Monaco-based JSON editor. Lazily loaded so the (heavy) editor bundle never
// lands in the initial paint chunk — callers import this via React.lazy and
// wrap it in <Suspense>. See `LazyJsonEditor` / `LazyJsonViewer` below for the
// ready-to-use wrappers.
import Editor, { type OnValidate } from '@monaco-editor/react';

const COMMON_OPTIONS = {
  minimap: { enabled: false },
  fontSize: 13,
  lineNumbers: 'on' as const,
  scrollBeyondLastLine: false,
  tabSize: 2,
  automaticLayout: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  // Surfaces Monaco's JSON syntax/schema markers so the caller can block
  // submit on parse errors. Fires with `true` when the document is valid.
  onValidate?: (ok: boolean) => void;
  height?: number | string;
};

// Editable JSON editor. Default export so it slots straight into React.lazy.
export default function JsonEditor({ value, onChange, onValidate, height = 360 }: Props) {
  const handleValidate: OnValidate = (markers) => {
    onValidate?.(markers.length === 0);
  };

  return (
    <div className="rounded-xl overflow-hidden border border-border">
      <Editor
        height={height}
        language="json"
        theme="vs-dark"
        value={value}
        onChange={(v) => onChange(v ?? '')}
        onValidate={handleValidate}
        options={COMMON_OPTIONS}
      />
    </div>
  );
}

// Read-only variant — used for the hydrated preview panel. Same chunk as the
// editor, so once either is loaded the other is free.
export function JsonViewer({ value, height = 420 }: { value: string; height?: number | string }) {
  return (
    <div className="rounded-xl overflow-hidden border border-border">
      <Editor
        height={height}
        language="json"
        theme="vs-dark"
        value={value}
        options={{ ...COMMON_OPTIONS, readOnly: true }}
      />
    </div>
  );
}
