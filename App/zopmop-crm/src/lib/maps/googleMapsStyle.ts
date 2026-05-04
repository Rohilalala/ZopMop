// Dark Google Maps style tuned to the CRM design tokens (tailwind.config.ts):
//   bg=#0A0A0F  surface=#111118  surface-elevated=#1A1A24  border=#2A2A3A
//   text-secondary=#8888AA  text-muted=#4A4A6A
// Hide POI/transit clutter; keep roads (muted) and admin boundaries (subtle).
export const darkMapStyle: google.maps.MapTypeStyle[] = [
  { elementType: 'geometry', stylers: [{ color: '#0A0A0F' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8888AA' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#0A0A0F' }] },

  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ color: '#111118' }] },

  { featureType: 'transit', stylers: [{ visibility: 'off' }] },

  {
    featureType: 'administrative',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#2A2A3A' }, { weight: 0.5 }],
  },
  {
    featureType: 'administrative.country',
    elementType: 'geometry.stroke',
    stylers: [{ color: '#2A2A3A' }, { weight: 0.8 }],
  },
  {
    featureType: 'administrative.locality',
    elementType: 'labels.text.fill',
    stylers: [{ color: '#8888AA' }],
  },

  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#1A1A24' }] },
  { featureType: 'road', elementType: 'geometry.stroke', stylers: [{ color: '#111118' }] },
  { featureType: 'road', elementType: 'labels.text.fill', stylers: [{ color: '#4A4A6A' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#2A2A3A' }] },
  { featureType: 'road.highway', elementType: 'labels.text.fill', stylers: [{ color: '#8888AA' }] },

  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#0A0A0F' }] },
  { featureType: 'landscape.man_made', elementType: 'geometry', stylers: [{ color: '#111118' }] },

  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0B1226' }] },
  { featureType: 'water', elementType: 'labels.text.fill', stylers: [{ color: '#4A4A6A' }] },
];

// Single shared loader config — referenced everywhere we mount a map so the
// JS API only loads once across the app.
export const GOOGLE_MAPS_LIBRARIES: ('marker' | 'places')[] = ['marker'];
