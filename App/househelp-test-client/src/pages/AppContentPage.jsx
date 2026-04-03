import { useState } from 'react';
import { 
  getBanners, createBanner, 
  getScreens, updateScreen, 
  getServices, createService 
} from '../api/admin.api';
import ResponseViewer from '../components/ResponseViewer';
import LoadingSpinner from '../components/LoadingSpinner';

export default function AppContentPage() {
  const [tab, setTab] = useState('Banners'); // Banners, Screens, Services

  const [listState, setListState] = useState({ loading: false, data: null, status: null });
  const [createState, setCreateState] = useState({ loading: false, data: null, status: null });

  // Banner Form
  const [bTitle, setBTitle] = useState('Spring Cleaning');
  const [bSubtitle, setBSubtitle] = useState('20% off all deep cleaning');
  const [bImage, setBImage] = useState('https://images.unsplash.com/photo-1584622650111-993a426fbf0a');
  const [bAction, setBAction] = useState('deep-cleaning');
  const [bOrder, setBOrder] = useState('1');
  const [bActive, setBActive] = useState(true);

  // Screen Form
  const [sKey, setSKey] = useState('home');
  const [sContent, setSContent] = useState('{\n  "hero_title": "Welcome",\n  "hero_subtitle": "Find help instantly"\n}');

  // Service Form
  const [svName, setSvName] = useState('Deep Cleaning');
  const [svDesc, setSvDesc] = useState('Intense 4 hour scrub');
  const [svIcon, setSvIcon] = useState('sparkles');
  const [svPrice, setSvPrice] = useState('9900');
  const [svOrder, setSvOrder] = useState('1');
  const [svActive, setSvActive] = useState(true);

  const runList = async (apiFunc) => {
    setListState({ loading: true, data: null, status: null });
    try {
      const data = await apiFunc();
      setListState({ loading: false, data, status: 200 });
    } catch (err) {
      setListState({
        loading: false,
        data: err.response?.data || err.message,
        status: err.response?.status || 500
      });
    }
  };

  const handleCreateBanner = async () => {
    setCreateState({ loading: true, data: null, status: null });
    try {
      const data = await createBanner({
        title: bTitle,
        subtitle: bSubtitle,
        image_url: bImage,
        tap_action: bAction,
        display_order: parseInt(bOrder),
        is_active: bActive,
        starts_at: new Date().toISOString(),
        ends_at: new Date(Date.now() + 86400000 * 30).toISOString(),
      });
      setCreateState({ loading: false, data, status: 200 });
      runList(getBanners);
    } catch (err) {
      setCreateState({ loading: false, data: err.response?.data || err.message, status: err.response?.status || 500 });
    }
  };

  const handleSaveScreen = async () => {
    setCreateState({ loading: true, data: null, status: null });
    try {
      let parsed;
      try { parsed = JSON.parse(sContent); } catch (e) { throw new Error("Invalid JSON mapping"); }
      
      const data = await updateScreen(sKey, parsed);
      setCreateState({ loading: false, data, status: 200 });
      runList(getScreens);
    } catch (err) {
      setCreateState({ loading: false, data: err.response?.data || err.message, status: err.response?.status || 500 });
    }
  };

  const handleCreateService = async () => {
    setCreateState({ loading: true, data: null, status: null });
    try {
      const data = await createService({
        name: svName,
        description: svDesc,
        icon_url: svIcon,
        base_price_cents: parseInt(svPrice),
        display_order: parseInt(svOrder),
        is_active: svActive,
      });
      setCreateState({ loading: false, data, status: 200 });
      runList(getServices);
    } catch (err) {
      setCreateState({ loading: false, data: err.response?.data || err.message, status: err.response?.status || 500 });
    }
  };

  // Switch tabs
  const activateTab = (t) => {
    setTab(t);
    setListState({ loading: false, data: null, status: null });
    setCreateState({ loading: false, data: null, status: null });
  };

  return (
    <div className="space-y-6">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">App Content Manager</h1>
        <p className="text-gray-400">Server driven UI rendering components manager.</p>
      </div>

      <div className="flex space-x-1 border-b border-gray-800 mb-6">
        {['Banners', 'Screens', 'Services'].map((t) => (
          <button
            key={t}
            onClick={() => activateTab(t)}
            className={`px-4 py-2 font-medium text-sm transition-colors ${
              tab === t ? 'text-indigo-400 border-b-2 border-indigo-500' : 'text-gray-500 hover:text-gray-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Banners' && (
        <>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-white">All Banners</h2>
              <button onClick={() => runList(getBanners)} className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded text-sm transition-colors">Load Banners</button>
            </div>
            {listState.loading && <LoadingSpinner />}
            <ResponseViewer response={listState.data} statusCode={listState.status} />
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
            <h2 className="text-xl font-semibold text-white mb-4">Create Banner</h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div><label className="block text-sm text-gray-400 mb-1">Title</label><input type="text" value={bTitle} onChange={e=>setBTitle(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
              <div><label className="block text-sm text-gray-400 mb-1">Subtitle</label><input type="text" value={bSubtitle} onChange={e=>setBSubtitle(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
              <div><label className="block text-sm text-gray-400 mb-1">Image URL</label><input type="text" value={bImage} onChange={e=>setBImage(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
              <div><label className="block text-sm text-gray-400 mb-1">Tap Action</label><input type="text" value={bAction} onChange={e=>setBAction(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
              <div><label className="block text-sm text-gray-400 mb-1">Display Order</label><input type="number" value={bOrder} onChange={e=>setBOrder(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
              <div className="flex items-center"><input type="checkbox" checked={bActive} onChange={e=>setBActive(e.target.checked)} className="mr-2" /> <span className="text-white text-sm">Is Active</span></div>
            </div>
            <button onClick={handleCreateBanner} className="bg-green-600 hover:bg-green-700 text-white w-full py-2 rounded">POST /banners</button>
            {createState.loading && <LoadingSpinner />}
            <ResponseViewer response={createState.data} statusCode={createState.status} />
          </div>
        </>
      )}

      {tab === 'Screens' && (
        <>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-white">All Screens</h2>
              <button onClick={() => runList(getScreens)} className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded text-sm transition-colors">Load Screens</button>
            </div>
            {listState.loading && <LoadingSpinner />}
            <ResponseViewer response={listState.data} statusCode={listState.status} />
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
            <h2 className="text-xl font-semibold text-white mb-4">Update Screen Layout</h2>
            <div className="mb-4">
              <label className="block text-sm text-gray-400 mb-1">Screen Key</label>
              <input type="text" value={sKey} onChange={e=>setSKey(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white mb-4" />
              
              <label className="block text-sm text-gray-400 mb-1">Content JSON Mapping</label>
              <textarea value={sContent} onChange={e=>setSContent(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-green-400 font-mono text-sm h-32" />
            </div>
            <button onClick={handleSaveScreen} className="bg-green-600 hover:bg-green-700 text-white w-full py-2 rounded">PATCH /screens/:key</button>
            {createState.loading && <LoadingSpinner />}
            <ResponseViewer response={createState.data} statusCode={createState.status} />
          </div>
        </>
      )}

      {tab === 'Services' && (
        <>
          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-white">All Active Services Catalog</h2>
              <button onClick={() => runList(getServices)} className="bg-indigo-600 hover:bg-indigo-700 text-white py-2 px-4 rounded text-sm transition-colors">Load Catalog</button>
            </div>
            {listState.loading && <LoadingSpinner />}
            <ResponseViewer response={listState.data} statusCode={listState.status} />
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-6 shadow-sm mb-6">
            <h2 className="text-xl font-semibold text-white mb-4">Create Service Category</h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div><label className="block text-sm text-gray-400 mb-1">Name</label><input type="text" value={svName} onChange={e=>setSvName(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
              <div><label className="block text-sm text-gray-400 mb-1">Description</label><input type="text" value={svDesc} onChange={e=>setSvDesc(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
              <div><label className="block text-sm text-gray-400 mb-1">Base Price (cents)</label><input type=" नंबर" value={svPrice} onChange={e=>setSvPrice(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
              <div><label className="block text-sm text-gray-400 mb-1">Display Order</label><input type="number" value={svOrder} onChange={e=>setSvOrder(e.target.value)} className="w-full bg-gray-800 border-gray-700 rounded px-4 py-2 text-white" /></div>
            </div>
            <button onClick={handleCreateService} className="bg-green-600 hover:bg-green-700 text-white w-full py-2 rounded">POST /services</button>
            {createState.loading && <LoadingSpinner />}
            <ResponseViewer response={createState.data} statusCode={createState.status} />
          </div>
        </>
      )}

    </div>
  );
}
