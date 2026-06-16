// Hindi strings — default locale for the pro side. Customer-side strings
// stay English-only for now. Add new keys in BOTH hi.ts and en.ts —
// missing-key warnings in __DEV__ catch drift.

type LangDict = {
  common: Record<string, string>;
  dashboard: Record<string, string>;
  commit: Record<string, string>;
  zoneApproval: Record<string, string>;
  money: Record<string, string>;
  drift: Record<string, string>;
  cancel: Record<string, string>;
  tabs: Record<string, string>;
  jobs: {
    headerTitle: string;
    empty: { title: string; subtitle: string };
    loadErrorBody: string;
    sectionNewOffer: string;
    sectionActive: string;
    sectionToday: string;
    activeTap: string;
    completedSummary: string;
    newBadge: string;
    gotIt: string;
  };
  profile: Record<string, string>;
  language: Record<string, string>;
  jobDetail: Record<string, string>;
};

const hi: LangDict = {
  common: {
    cancel: 'रद्द करें',
    confirm: 'पक्का करें',
    ok: 'ठीक है',
    back: 'वापस',
    retry: 'फिर कोशिश करें',
    save: 'सेव करें',
    delete: 'हटाएं',
    edit: 'बदलें',
    loading: 'लोड हो रहा है...',
    error: 'कुछ गलत हुआ',
  },
  dashboard: {
    greeting: 'नमस्ते, {name}',
    nextShiftToday: 'अगली शिफ्ट: आज {start}',
    nextShiftTomorrow: 'अगली शिफ्ट: कल {start}',
    countdown: '{h}h {m}m बाकी',
    changeShift: 'शिफ्ट प्लान बदलें',
    cantChangeAfter3am: '3 बजे के बाद बदलाव नहीं हो सकता',
    goOnline: 'ऑनलाइन जाएं',
    goOnlineHelper: 'अपनी शिफ्ट शुरू करने के लिए ऑनलाइन जाएं',
    goOffline: 'ऑफलाइन जाएं',
    online: 'ऑनलाइन',
    onlineNowChip: 'अभी ऑनलाइन: {minutes}m',
    readyForBooking: 'किसी बुकिंग के लिए तैयार',
    activeJob: 'चालू जॉब',
    completeJob: 'जॉब पूरा करें',
    comingSoon: 'जल्द आ रहा है',
    noShiftToday: 'आज कोई शिफ्ट नहीं',
    planTomorrow: 'कल की शिफ्ट प्लान करें',
    absenceLogged: 'आज के लिए अनुपस्थिति दर्ज की गई। कल के लिए प्लान करें।',
    zoneVerificationPending: 'ज़ोन वेरिफिकेशन बाकी है',
    zoneVerificationSubtext: 'एडमिन की मंज़ूरी का इंतज़ार है। आपको सूचना भेजी जाएगी।',
    retryGoOnline: 'फिर ऑनलाइन जाएं',
    pendingBookingsTitle: '{n} बुकिंग अभी बाकी हैं',
    pendingBookingsBody: 'ऑफलाइन जाने से पहले इन्हें पूरा करें। इन्हें रद्द करने से आपकी सैलरी पर असर पड़ सकता है।',
    locationDenied: 'स्थान की अनुमति नहीं मिली',
  },
  commit: {
    title: 'शिफ्ट प्लान करें',
    fortnightLine: 'इस fortnight में: {hours} / 80 घंटे प्रतिबद्ध',
    addShift: '+ शिफ्ट जोड़ें',
    locked: 'लॉक्ड',
    today: 'आज',
    tomorrow: 'कल',
    pickStart: 'शुरू समय',
    pickEnd: 'खत्म समय',
    estimatedHours: 'अनुमानित घंटे: {h}',
    eightHourWarning: '8 घंटे से ज़्यादा काम आपकी सेहत के लिए ठीक नहीं है',
    save: 'सेव करें',
    overlapError: 'इस समय पहले से शिफ्ट है',
    endBeforeStart: 'खत्म समय शुरू समय के बाद होना चाहिए',
    deleteConfirm: 'इस शिफ्ट को हटाना है?',
  },
  zoneApproval: {
    title: 'आप ज़ोन के बाहर हैं',
    distanceLine: '{meters}m दूर अपने असाइन्ड एरिया से',
    callSupport: 'सपोर्ट को कॉल करें',
    uploadPhoto: 'फोटो अपलोड करके मंज़ूरी मांगें',
    captureSelfie: 'सेल्फी लें',
    submit: 'मंज़ूरी के लिए भेजें',
    waiting: 'मंज़ूरी का इंतज़ार है',
    waitingBody: 'एडमिन आपकी रिक्वेस्ट देख रहे हैं। मंज़ूरी मिलते ही आपको सूचना मिलेगी।',
    backToDashboard: 'डैशबोर्ड पर वापस',
    photoRequired: 'सेल्फी लेना ज़रूरी है',
    photoTooLarge: 'यह फोटो बहुत बड़ी है। बेहतर रोशनी में या थोड़ा पीछे हटकर दोबारा लें।',
    submitFailed: 'रिक्वेस्ट भेजने में दिक्कत हुई',
    rejected: 'आपकी ज़ोन अप्रूवल रिक्वेस्ट अस्वीकार कर दी गई।',
  },
  money: {
    title: 'पैसा',
    payoutLine: 'पेआउट {date} को प्रोसेस होगा',
    progressLine: '{current} / {target} घंटे ऑनलाइन',
    overtimeLine: '+ {hours} घंटे ओवरटाइम (₹90/hr)',
    onlinePay: 'ऑनलाइन pay (₹80 × {hours} घंटे)',
    overtimePay: 'ओवरटाइम (₹90 × {hours} घंटे)',
    jobPay: 'जॉब pay (₹80 × {hours} घंटे)',
    deductionsHeader: 'कटौती',
    absenceDeduction: 'अनुपस्थिति (3 बजे तक commit नहीं किया)',
    cancellationDeduction: 'Booking रद्द (5+ बार)',
    onlineChip: 'अभी ऑनलाइन: {minutes}m',
  },
  drift: {
    title: '⚠️ आप ज़ोन से बाहर हैं!',
    body: 'कृपया अपनी असाइन्ड लोकेशन पर वापस जाएं या ऑफलाइन हो जाएं।',
    acknowledge: 'ठीक है, वापस जा रहा हूं',
  },
  cancel: {
    title: 'Booking रद्द करें?',
    tier1Body: 'क्या आप यह booking रद्द करना चाहते हैं? यह आपकी {n}वीं cancellation है इस महीने में। बार-बार रद्द करने से आपकी सैलरी प्रभावित हो सकती है। 5वीं cancellation पर पैसा कटेगा।',
    tier4Body: '⚠️ सावधान — यह आपकी 4थी cancellation है इस महीने में। अगली बार रद्द करने पर ₹{penalty} काटा जाएगा। क्या आप फिर भी रद्द करना चाहते हैं?',
    tier5Body: '⚠️ यह आपकी 5वीं cancellation है। आपकी सैलरी से ₹{penalty} काटा जाएगा। क्या आप पक्का रद्द करना चाहते हैं?',
    confirm: 'हां, रद्द करें',
    keep: 'नहीं, रखें',
    penaltyToast: '₹{penalty} काटा गया है',
  },
  tabs: {
    home: 'होम',
    shift: 'शिफ्ट',
    jobs: 'काम',
    money: 'पैसा',
    profile: 'प्रोफाइल',
  },
  jobs: {
    headerTitle: 'आज की booking',
    empty: { title: 'अभी कोई booking नहीं', subtitle: 'बुकिंग आते ही यहाँ दिखेंगी' },
    loadErrorBody: 'काम लोड नहीं हो पाए। कनेक्शन जांचें और दोबारा try करें।',
    sectionNewOffer: 'नई booking',
    sectionActive: 'अभी का काम',
    sectionToday: 'आज की पूरी हुई',
    activeTap: 'विवरण देखें',
    completedSummary: '{count} सेवा · {minutes}min · ₹{earnings}',
    newBadge: 'नई',
    gotIt: 'समझ गया',
  },
  profile: {
    assignedArea: 'आपका असाइन्ड एरिया',
    noZone: 'कोई ज़ोन असाइन्ड नहीं',
    thisFortnight: 'इस fortnight',
    onlineHours: 'ऑनलाइन घंटे',
    totalEarnings: 'कुल कमाई',
    changeLanguage: 'भाषा बदलें',
    declareLeave: 'छुट्टी घोषित करें',
    leaveHistory: 'छुट्टी इतिहास',
    support: 'सपोर्ट',
    about: 'हमारे बारे में',
    logout: 'लॉग आउट',
    logoutConfirm: 'क्या आप वाकई लॉग आउट करना चाहते हैं?',
    version: 'वर्जन',
    employeeId: 'Employee ID',
  },
  language: {
    title: 'भाषा चुनें',
    titleEn: 'Choose Language',
    hindi: 'हिंदी',
    english: 'English',
    bangla: 'बांग्ला',
    hindiSubtitle: 'Hindi',
    englishSubtitle: 'अंग्रेज़ी',
    banglaSubtitle: 'Bangla',
    changed: 'भाषा बदल दी गई',
    confirmTitle: 'भाषा बदलें?',
    confirmBody: 'क्या आप वाकई ऐप की भाषा बदलना चाहते हैं?',
    confirmCta: 'हां, बदलें',
  },
  jobDetail: {
    headerStepAccepted: 'ग्राहक के पास जाएं',
    headerStepEnRoute: 'रास्ते में',
    headerStepArrived: 'पहुँच गए',
    headerStepInProgress: 'काम चल रहा है',
    headerStepCompleted: 'काम पूरा हुआ',
    navigate: 'Map',
    call: 'Call',
    onMyWay: 'जा रहा हूं',
    iveArrived: 'पहुँच गया',
    arrivedDisabled: 'ग्राहक की लोकेशन के पास पहुंचने पर बटन सक्रिय होगा',
    arrivedTooFarTitle: 'अभी आप ग्राहक की लोकेशन से दूर हैं',
    arrivedTooFarBody: 'पास जाकर फिर try करें।',
    startJob: 'काम शुरू करें',
    startConfirmTitle: 'काम शुरू करें?',
    startConfirmBody: 'क्या ग्राहक तैयार हैं? काम शुरू करते ही समय गिनना शुरू हो जाएगा।',
    finishJob: 'काम पूरा करें',
    finishConfirmTitle: 'काम खत्म करें?',
    finishConfirmBody: 'क्या आप काम खत्म करना चाहते हैं?',
    elapsedLabel: 'बीता समय',
    serviceStart: 'शुरू करें',
    serviceDone: 'Done',
    serviceSkip: 'Skip',
    serviceSkippedLabel: 'Skipped',
    serviceFallbackName: 'सेवा',
    skipReasonTitle: 'क्यों skip कर रहे हैं?',
    skipConfirmTitle: 'यह सेवा skip करें?',
    skipConfirmBody: 'इससे सेवा job से हमेशा के लिए हट जाएगी। इसे वापस नहीं किया जा सकता।',
    summaryDuration: 'कुल समय',
    summaryServices: 'सेवाएं',
    summaryEarnings: 'कमाई',
    awaitingRating: 'Customer के rating का इंतज़ार',
    customerNote: 'ग्राहक का संदेश',
    cancelJob: 'Booking रद्द करें',
    callUnavailable: 'Contact नहीं ले सकते अभी',
    callNetworkError: 'Network issue. कृपया दोबारा try करें',
    cancelledTitle: 'यह booking रद्द हो गई',
    cancelledBody: 'यह job अब आपको assign नहीं है।',
    backToJobs: 'Jobs पर वापस जाएं',
  },
};

export default hi;
export type Dict = LangDict;
