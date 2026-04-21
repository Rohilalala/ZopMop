# Marketplace Analytics Design Addendum: Re-engagement KPIs

## Re-engagement Reminder KPI Cards

### Reminders Sent by Scenario (24h)

```sql
SELECT scenario, COUNT(*) AS sent
FROM reengagement_notifications
WHERE sent_at >= NOW() - INTERVAL '24 hours'
GROUP BY scenario
ORDER BY sent DESC;
```

### Mopping Drop-off Recovery (Booked within 24h after reminder)

```sql
SELECT
  COUNT(*) FILTER (WHERE b.id IS NOT NULL) AS recovered,
  COUNT(*) AS reminded
FROM reengagement_notifications r
LEFT JOIN bookings b
  ON b.customer_id = r.user_id
 AND b.created_at >= r.sent_at
 AND b.created_at < r.sent_at + INTERVAL '24 hours'
WHERE r.scenario = 'mopping_dropoff';
```

### Cart Abandonment Recovery (Booked within 24h after reminder)

```sql
SELECT
  COUNT(*) FILTER (WHERE b.id IS NOT NULL) AS recovered,
  COUNT(*) AS reminded
FROM reengagement_notifications r
LEFT JOIN bookings b
  ON b.customer_id = r.user_id
 AND b.created_at >= r.sent_at
 AND b.created_at < r.sent_at + INTERVAL '24 hours'
WHERE r.scenario = 'cart_abandonment';
```
