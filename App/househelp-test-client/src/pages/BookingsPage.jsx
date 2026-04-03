import { useState } from 'react';
import { createBooking, getBooking, listBookings } from '../api/booking.api';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

export default function BookingsPage() {
  const [createState, setCreateState] = useState({ loading: false, data: null, status: null });
  const [getState, setGetState] = useState({ loading: false, data: null, status: null });
  const [listState, setListState] = useState({ loading: false, data: null, status: null });

  // Create forms
  const [categoryId, setCategoryId] = useState('00000000-0000-0000-0000-000000000000');
  const [address, setAddress] = useState('123 Test Street');
  const [lat, setLat] = useState('12.9716');
  const [lng, setLng] = useState('77.5946');
  const [promo, setPromo] = useState('');

  // Get Form
  const [bookingId, setBookingId] = useState('');

  const runCall = async (apiFunc, setStateHandler, ...args) => {
    setStateHandler({ loading: true, data: null, status: null });
    try {
      const data = await apiFunc(...args);
      setStateHandler({ loading: false, data, status: 200 });
    } catch (err) {
      setStateHandler({
        loading: false,
        data: err.response?.data || err.message,
        status: err.response?.status || 500
      });
    }
  };

  const handleCreate = () => {
    const payload = {
      service_category_id: categoryId,
      address,
      lat: parseFloat(lat),
      lng: parseFloat(lng)
    };
    if (promo) payload.promo_code = promo;
    runCall(createBooking, setCreateState, payload);
  };

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Bookings Matrix</h1>
        <p className="text-gray-400">Tests booking endpoints leveraging your authorization context natively.</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-white mb-4">My Bookings List</h2>
          <button 
            onClick={() => runCall(listBookings, setListState)}
            disabled={listState.loading}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors disabled:opacity-50"
          >
            GET /api/v1/bookings
          </button>
        </div>
        {listState.loading && <LoadingSpinner />}
        <ResponseViewer response={listState.data} statusCode={listState.status} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <h2 className="text-xl font-semibold text-white mb-4">Get Booking by ID</h2>
        <div className="flex gap-4 items-end mb-4">
          <div className="flex-1">
            <label className="block text-sm font-medium text-gray-400 mb-1">Booking UUID</label>
            <input
              type="text"
              value={bookingId}
              onChange={(e) => setBookingId(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500"
            />
          </div>
          <button 
            onClick={() => runCall(getBooking, setGetState, bookingId)}
            disabled={getState.loading || !bookingId}
            className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded transition-colors disabled:opacity-50 h-[42px]"
          >
            Fetch Booking
          </button>
        </div>
        {getState.loading && <LoadingSpinner />}
        <ResponseViewer response={getState.data} statusCode={getState.status} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <h2 className="text-xl font-semibold text-white mb-4">Create New Booking</h2>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Service Category ID</label>
            <input type="text" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Address</label>
            <input type="text" value={address} onChange={(e) => setAddress(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">Lat</label>
              <input type="number" step="any" value={lat} onChange={(e) => setLat(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-400 mb-1">Lng</label>
              <input type="number" step="any" value={lng} onChange={(e) => setLng(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-400 mb-1">Promo Code (Optional)</label>
            <input type="text" value={promo} onChange={(e) => setPromo(e.target.value)} className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 text-white focus:outline-none focus:border-indigo-500" />
          </div>
        </div>
        <button 
          onClick={handleCreate}
          disabled={createState.loading}
          className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2 px-4 rounded transition-colors disabled:opacity-50"
        >
          POST /api/v1/bookings
        </button>
        {createState.loading && <LoadingSpinner />}
        <ResponseViewer response={createState.data} statusCode={createState.status} />
      </div>

    </div>
  );
}
