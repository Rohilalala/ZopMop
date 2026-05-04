import React from 'react';
import Svg, { Rect, Circle, G, Line } from 'react-native-svg';

type Props = { size?: number };

export function IndiaFlag({ size = 20 }: Props) {
  const w = size * 1.5;
  const h = size;
  const stripe = h / 3;
  const wheelR = stripe * 0.42;
  const cx = w / 2;
  const cy = stripe + stripe / 2;

  const spokes = Array.from({ length: 24 }, (_, i) => {
    const angle = (i * Math.PI) / 12;
    return {
      x1: cx,
      y1: cy,
      x2: cx + Math.cos(angle) * wheelR,
      y2: cy + Math.sin(angle) * wheelR,
    };
  });

  return (
    <Svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <Rect x={0} y={0} width={w} height={stripe} fill="#FF9933" />
      <Rect x={0} y={stripe} width={w} height={stripe} fill="#FFFFFF" />
      <Rect x={0} y={stripe * 2} width={w} height={stripe} fill="#138808" />
      <G>
        {spokes.map((s, i) => (
          <Line
            key={i}
            x1={s.x1}
            y1={s.y1}
            x2={s.x2}
            y2={s.y2}
            stroke="#000080"
            strokeWidth={0.5}
          />
        ))}
        <Circle cx={cx} cy={cy} r={wheelR} stroke="#000080" strokeWidth={1} fill="none" />
        <Circle cx={cx} cy={cy} r={wheelR * 0.18} fill="#000080" />
      </G>
    </Svg>
  );
}
