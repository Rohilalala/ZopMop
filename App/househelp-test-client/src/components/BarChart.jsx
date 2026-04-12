/**
 * Simple SVG bar chart. No external dependencies.
 * Props:
 *   data: [{ label: string, value: number, value2?: number }]
 *   height: number (default 160)
 *   color: tailwind color class for bars (default 'fill-indigo-500')
 *   color2: tailwind color class for second series (default 'fill-emerald-500')
 *   formatY: (value) => string
 */
export default function BarChart({
  data = [],
  height = 160,
  color = 'fill-indigo-500',
  color2 = 'fill-emerald-500',
  formatY = (v) => v,
}) {
  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-40 text-gray-600 text-sm">
        No data for this period
      </div>
    );
  }

  const allValues = data.flatMap(d => [d.value, d.value2 ?? 0]);
  const maxVal = Math.max(...allValues, 1);
  const BAR_W = 100 / data.length;
  const GAP = 0.3; // fraction of bar width as gap
  const dual = data.some(d => d.value2 !== undefined);

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 100 ${height + 20}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: height + 20 }}
      >
        {data.map((d, i) => {
          const barH = (d.value / maxVal) * height;
          const bar2H = dual ? ((d.value2 ?? 0) / maxVal) * height : 0;
          const x = i * BAR_W;
          const w = dual ? (BAR_W * (1 - GAP)) / 2 : BAR_W * (1 - GAP);
          const gapPx = (BAR_W * GAP) / 2;

          return (
            <g key={i}>
              {/* Primary bar */}
              <rect
                x={x + gapPx}
                y={height - barH}
                width={w}
                height={barH}
                rx="1"
                className={color}
                opacity="0.85"
              >
                <title>{d.label}: {formatY(d.value)}</title>
              </rect>
              {/* Secondary bar */}
              {dual && (
                <rect
                  x={x + gapPx + w}
                  y={height - bar2H}
                  width={w}
                  height={bar2H}
                  rx="1"
                  className={color2}
                  opacity="0.85"
                >
                  <title>{d.label}: {formatY(d.value2)}</title>
                </rect>
              )}
              {/* Label */}
              <text
                x={x + BAR_W / 2}
                y={height + 14}
                textAnchor="middle"
                fontSize="4"
                className="fill-gray-500"
              >
                {d.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
