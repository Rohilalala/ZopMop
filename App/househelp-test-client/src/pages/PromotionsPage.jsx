import { useState } from 'react';
import { getPromotions, createPromotion, disablePromotion } from '../api/admin.api';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

export default function PromotionsPage() {
  const [listState, setListState] = useState({ loading: false, data: null, status: null });
  const [createState, setCreateState] = useState({ loading: false, data: null, status: null });

  const [code, setCode] = useState('FIRST20');
  const [discountType, setDiscountType] = useState('percent');
  const [discountValue, setDiscountValue] = useState('20');
  const [minOrder, setMinOrder] = useState('500');
  const [maxUses, setMaxUses] = useState('0'); // 0 = unlimited
  const [expiresInDays, setExpiresInDays] = useState('30');

  const runList = async () => {
    setListState({ loading: true, data: null, status: null });
    try {
      const data = await getPromotions();
      setListState({ loading: false, data, status: 200 });
    } catch (err) {
      setListState({
        loading: false,
        data: err.response?.data || err.message,
        status: err.response?.status || 500
      });
    }
  };

  const handleCreate = async () => {
    setCreateState({ loading: true, data: null, status: null });
    try {
      const expiresAt = new Date(Date.now() + parseInt(expiresInDays) * 86400000).toISOString();
      const payload = {
        code: code.toUpperCase(),
        discount_type: discountType,
        discount_value: parseInt(discountValue),
        min_order_cents: parseInt(minOrder),
        expires_at: expiresAt
      };
      if (parseInt(maxUses) > 0) payload.max_uses = parseInt(maxUses);

      const data = await createPromotion(payload);
      setCreateState({ loading: false, data, status: 200 });
      runList();
    } catch (err) {
      setCreateState({ loading: false, data: err.response?.data || err.message, status: err.response?.status || 500 });
    }
  };

  const handleDisable = async (id) => {
    try {
      await disablePromotion(id);
      runList();
    } catch (err) {
      alert("Failed to disable: " + (err.response?.data?.error || err.message));
    }
  };

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Promotions & Vouchers</h1>
        <p className="text-gray-400">Marketing team codes issuance module.</p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold text-white">Active Promo Codes</h2>
          <button onClick={runList} className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded text-sm transition-colors">Load Promotions</button>
        </div>

        {listState.status === 200 && listState.data?.promotions && (
          <div className="overflow-x-auto mb-4 border border-gray-800 rounded">
            <table className="w-full text-sm text-left text-gray-300">
              <thead className="text-xs text-gray-400 uppercase bg-gray-800">
                <tr>
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Discount</th>
                  <th className="px-4 py-3">Uses / Max</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {listState.data.promotions.map(p => (
                  <tr key={p.id} className="border-b border-gray-800 hover:bg-gray-800/50">
                    <td className="px-4 py-3 font-mono font-bold text-green-400">{p.code}</td>
                    <td className="px-4 py-3">{p.discount_type === 'percent' ? `${p.discount_value}%` : `₹${p.discount_value/100}`}</td>
                    <td className="px-4 py-3">{p.uses_count} / {p.max_uses === 0 ? '∞' : p.max_uses}</td>
                    <td className="px-4 py-3">{p.is_active ? 'Active' : 'Disabled'}</td>
                    <td className="px-4 py-3 text-right">
                       {p.is_active && (
                         <button onClick={() => handleDisable(p.id)} className="text-red-400 hover:underline hover:text-white text-xs">Disable</button>
                       )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {listState.loading && <LoadingSpinner />}
        <ResponseViewer response={listState.data} statusCode={listState.status} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
        <h2 className="text-xl font-semibold text-white mb-4">Mint New Promotion</h2>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div><label className="block text-sm text-gray-400 mb-1">Code</label><input type="text" value={code} onChange={e=>setCode(e.target.value)} className="w-full bg-gray-800 uppercase border-gray-700 rounded px-4 py-2 text-white font-mono" /></div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Discount Type</label>
            <select value={discountType} onChange={e=>setDiscountType(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white">
              <option value="percent">Percentage (%)</option>
              <option value="fixed">Fixed Amount (Cents/Rupees)</option>
            </select>
          </div>
          <div><label className="block text-sm text-gray-400 mb-1">Discount Value</label><input type="number" value={discountValue} onChange={e=>setDiscountValue(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
          <div><label className="block text-sm text-gray-400 mb-1">Min Order Values (cents)</label><input type="number" value={minOrder} onChange={e=>setMinOrder(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
          <div><label className="block text-sm text-gray-400 mb-1">Max Uses Overall (0 = inf)</label><input type="number" value={maxUses} onChange={e=>setMaxUses(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
          <div><label className="block text-sm text-gray-400 mb-1">Expires In (Days)</label><input type="number" value={expiresInDays} onChange={e=>setExpiresInDays(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
        </div>
        <button onClick={handleCreate} className="bg-green-600 hover:bg-green-700 text-white w-full py-2 rounded">MINT PROMOTION</button>
        {createState.loading && <LoadingSpinner />}
        <ResponseViewer response={createState.data} statusCode={createState.status} />
      </div>
    </div>
  );
}
