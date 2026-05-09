import { BASE_URL } from './config';

export type DisputeReason =
  | 'service_quality'
  | 'helper_behavior'
  | 'late_arrival'
  | 'no_show'
  | 'property_damage'
  | 'payment_issue'
  | 'other';

export const DISPUTE_REASON_LABELS: Record<DisputeReason, string> = {
  service_quality:  'Poor service quality',
  helper_behavior:  'Helper behavior / professionalism',
  late_arrival:     'Helper arrived late',
  no_show:          'Helper did not arrive',
  property_damage:  'Property damage',
  payment_issue:    'Payment / pricing issue',
  other:            'Other',
};

export async function fileDispute(
  token: string,
  bookingId: string,
  reason: DisputeReason,
  description: string,
): Promise<{ id: string; message: string }> {
  const res = await fetch(`${BASE_URL}/disputes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ booking_id: bookingId, reason, description }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'Failed to file dispute');
  return body;
}
