import React from 'react';
import { Dimensions, FlatList, View } from 'react-native';
import ZopBookingCard, { type ZopBookingData } from './ZopBookingCard';

export type ZopBookingSummary = ZopBookingData;

interface Props {
  bookings: ZopBookingSummary[];
  onCloseChat?: () => void;
}

/**
 * Horizontally swipeable list of the user's bookings, rendered in chat when
 * get_bookings returns a non-empty array. Each entry uses the same
 * ZopBookingCard the create-booking flow renders, so visual style stays
 * consistent across the app.
 */
export default function ZopBookingsList({ bookings, onCloseChat }: Props) {
  if (!bookings.length) return null;
  if (bookings.length === 1) {
    // Single booking → render full-width, no swipe.
    return <ZopBookingCard booking={bookings[0]} onCloseChat={onCloseChat} />;
  }

  const screenW = Dimensions.get('window').width;
  // Card matches the chat bubble width: screen minus sidebar + padding. Tuned
  // to leave a peek of the next card so users see swipeability.
  const cardW = Math.min(320, screenW - 90);

  return (
    <FlatList
      data={bookings}
      keyExtractor={(b) => b.id}
      horizontal
      showsHorizontalScrollIndicator={false}
      decelerationRate="fast"
      snapToInterval={cardW + GAP}
      snapToAlignment="start"
      contentContainerStyle={{ gap: GAP, paddingRight: 16 }}
      renderItem={({ item }) => (
        <View style={{ width: cardW }}>
          <ZopBookingCard booking={item} onCloseChat={onCloseChat} />
        </View>
      )}
    />
  );
}

const GAP = 10;
