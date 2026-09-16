// =====================================================================
// QA FIXTURE DATA -- TEST-ONLY, NOT PRODUCTION DATA.
//
// Deterministic, obviously-synthetic records used to visually and
// functionally QA the Stage 3 Admin table redesign (People/Accounts,
// Properties/Listings, Discounts/Accounts) without a live Firebase
// connection. Every name/email/phone/address below is invented for
// this purpose -- none of it corresponds to a real Darwesh user,
// property, or account. See qa-fixture/README.md for how this is
// wired into a Playwright run (qa-fixture/run-qa-screenshots.mjs) via
// fake Firebase/backend modules, never into the real admin.html or
// any production code path.
// =====================================================================

const DAY = 24 * 60 * 60;
const NOW = Math.floor(Date.now() / 1000);
const daysAgo = (n) => ({ seconds: NOW - n * DAY, nanoseconds: 0 });

export const QA_COMPANIES = [
  { id: 'qa-co-eaglepoint', name: 'Eaglepoint Realty (QA)' },
  { id: 'qa-co-sulav', name: 'Sulav Developments (QA)' },
  { id: 'qa-co-newroz', name: 'Newroz Estates (QA)' },
];

// -------------------------------------------------------------------
// People -> Accounts: 13 accounts across every role, verification
// state, and several cities.
// -------------------------------------------------------------------
export const QA_USERS = [
  { uid: 'qa-u-01', displayName: 'Rezan Ahmadi', email: 'rezan.ahmadi@example.test', role: 'admin', companyId: null, createdAt: daysAgo(410) },
  { uid: 'qa-u-02', displayName: 'Sara Kamal', email: 'sara.kamal@example.test', role: 'agent', companyId: 'qa-co-eaglepoint', createdAt: daysAgo(300) },
  { uid: 'qa-u-03', displayName: 'Dilan Faraj', email: 'dilan.faraj@example.test', role: 'agent', companyId: 'qa-co-eaglepoint', createdAt: daysAgo(250) },
  { uid: 'qa-u-04', displayName: 'Hana Rostam', email: 'hana.rostam@example.test', role: 'agent', companyId: 'qa-co-sulav', createdAt: daysAgo(190) },
  { uid: 'qa-u-05', displayName: 'Bnar Hussein', email: 'bnar.hussein@example.test', role: 'agent', companyId: 'qa-co-newroz', createdAt: daysAgo(140) },
  { uid: 'qa-u-06', displayName: 'Ayan Saleh', email: 'ayan.saleh@example.test', role: 'customer', companyId: null, createdAt: daysAgo(120) },
  { uid: 'qa-u-07', displayName: 'Lawin Qadir', email: 'lawin.qadir@example.test', role: 'customer', companyId: null, createdAt: daysAgo(95) },
  { uid: 'qa-u-08', displayName: 'Zhino Barzani', email: 'zhino.barzani@example.test', role: 'customer', companyId: null, createdAt: daysAgo(80) },
  { uid: 'qa-u-09', displayName: 'Karwan Nuri', email: 'karwan.nuri@example.test', role: 'customer', companyId: null, createdAt: daysAgo(60) },
  // Signed up asking for agent access, joining an existing company -- exercises the "Wants Agent Access" badge.
  { uid: 'qa-u-10', displayName: 'Nazdar Sami', email: 'nazdar.sami@example.test', role: 'customer', companyId: null, requestedRole: 'agent', requestedCompanyId: 'qa-co-sulav', requestedCompanyName: 'Sulav Developments (QA)', createdAt: daysAgo(40) },
  { uid: 'qa-u-11', displayName: 'Twana Jaza', email: 'twana.jaza@example.test', role: 'customer', companyId: null, createdAt: daysAgo(22) },
  { uid: 'qa-u-12', displayName: 'Shene Latif', email: 'shene.latif@example.test', role: 'agent', companyId: 'qa-co-newroz', createdAt: daysAgo(9) },
  { uid: 'qa-u-13', displayName: 'Aram Dosky', email: 'aram.dosky@example.test', role: 'customer', companyId: null, createdAt: daysAgo(2) },
];

// -------------------------------------------------------------------
// Properties -> Listings: 17 listings across every property type,
// status, deal type, several cities, varied prices, some with a
// thumbnail (real local placeholder assets) and some without (the
// real "no photo available" fallback state every listing without an
// uploaded photo actually hits in production).
// -------------------------------------------------------------------
const PHOTO_A = '/images/services/properties.jpg';
const PHOTO_B = '/images/services/projects.jpg';

// publicLat/publicLng -- the same rounded, LOC-01-safe field every real
// public listing document carries (see js/darwesh-listing-access.js's
// publicPinOf()); map.html reads ONLY these two fields to plot a marker,
// never a precise coordinate. Approximate real Kurdistan-region city
// centers with a small per-listing jitter so same-city markers don't
// stack exactly on top of each other -- for QA rendering only, not
// claimed as real property locations.
export const QA_LISTINGS = [
  { id: 'qa-l-01', title: 'Riverside Family Villa', address: '14 Zanko Street', city: 'Erbil', dealType: 'sale', propertyType: 'villa', price: 285000, beds: 5, baths: 4, sqft: 4200, agentId: 'qa-u-02', agentName: 'Sara Kamal', status: 'active', verified: true, private: false, quickSale: false, img: PHOTO_A, publicLat: 36.191, publicLng: 44.009, createdAt: daysAgo(180), updatedAt: daysAgo(2) },
  { id: 'qa-l-02', title: 'Downtown Two-Bedroom Apartment', address: '52 Salim Street', city: 'Erbil', dealType: 'rent', propertyType: 'apartment', price: 650, beds: 2, baths: 1, sqft: 950, agentId: 'qa-u-02', agentName: 'Sara Kamal', status: 'active', verified: true, private: false, quickSale: false, img: null, publicLat: 36.205, publicLng: 44.021, createdAt: daysAgo(160), updatedAt: daysAgo(5) },
  { id: 'qa-l-03', title: 'Corner Retail Shop, Bazaar District', address: '9 Bazaar Road', city: 'Sulaymaniyah', dealType: 'rent', propertyType: 'shop', price: 900, beds: 0, baths: 1, sqft: 480, agentId: 'qa-u-04', agentName: 'Hana Rostam', status: 'active', verified: false, private: false, quickSale: false, img: null, publicLat: 35.561, publicLng: 45.433, createdAt: daysAgo(150), updatedAt: daysAgo(8) },
  { id: 'qa-l-04', title: 'Executive Office Suite', address: '3 Empire Tower', city: 'Sulaymaniyah', dealType: 'rent', propertyType: 'office', price: 1400, beds: 0, baths: 2, sqft: 1600, agentId: 'qa-u-04', agentName: 'Hana Rostam', status: 'active', verified: true, private: false, quickSale: false, img: PHOTO_B, publicLat: 35.570, publicLng: 45.445, createdAt: daysAgo(140), updatedAt: daysAgo(11) },
  { id: 'qa-l-05', title: 'Vacant Residential Plot', address: 'Plot 220, Masif Road', city: 'Duhok', dealType: 'sale', propertyType: 'land', price: 95000, beds: 0, baths: 0, sqft: 8000, agentId: 'qa-u-05', agentName: 'Bnar Hussein', status: 'active', verified: false, private: true, quickSale: false, img: null, publicLat: 36.867, publicLng: 42.989, createdAt: daysAgo(130), updatedAt: daysAgo(13) },
  { id: 'qa-l-06', title: 'Modern Studio near University', address: '77 Peshawa Street', city: 'Sulaymaniyah', dealType: 'rent', propertyType: 'apartment', price: 380, beds: 1, baths: 1, sqft: 520, agentId: 'qa-u-12', agentName: 'Shene Latif', status: 'active', verified: true, private: false, quickSale: false, img: PHOTO_A, publicLat: 35.553, publicLng: 45.420, createdAt: daysAgo(120), updatedAt: daysAgo(16) },
  { id: 'qa-l-07', title: 'Quick-Sale Semi-Detached House', address: '61 Gulan Street', city: 'Erbil', dealType: 'sale', propertyType: 'house', price: 132000, beds: 3, baths: 2, sqft: 1800, agentId: 'qa-u-03', agentName: 'Dilan Faraj', status: 'active', verified: true, private: false, quickSale: true, img: null, publicLat: 36.178, publicLng: 43.995, createdAt: daysAgo(110), updatedAt: daysAgo(1) },
  { id: 'qa-l-08', title: 'Commercial Ground Floor Unit', address: '18 Trade Center Rd', city: 'Kirkuk', dealType: 'sale', propertyType: 'commercialProperty', price: 210000, beds: 0, baths: 2, sqft: 2100, agentId: 'qa-u-05', agentName: 'Bnar Hussein', status: 'active', verified: false, private: false, quickSale: false, img: null, publicLat: 35.468, publicLng: 44.392, createdAt: daysAgo(100), updatedAt: daysAgo(20) },
  { id: 'qa-l-09', title: 'Mixed-Use Building, 4 Floors', address: '5 Freedom Avenue', city: 'Erbil', dealType: 'sale', propertyType: 'building', price: 610000, beds: 0, baths: 6, sqft: 9800, agentId: 'qa-u-02', agentName: 'Sara Kamal', status: 'active', verified: true, private: false, quickSale: false, img: PHOTO_B, publicLat: 36.199, publicLng: 44.030, createdAt: daysAgo(95), updatedAt: daysAgo(3) },
  { id: 'qa-l-10', title: 'Garden Apartment, Family Complex', address: '210 Malls Road', city: 'Duhok', dealType: 'rent', propertyType: 'apartment', price: 520, beds: 2, baths: 2, sqft: 1100, agentId: 'qa-u-05', agentName: 'Bnar Hussein', status: 'closed', verified: true, private: false, quickSale: false, img: null, publicLat: 36.875, publicLng: 42.995, createdAt: daysAgo(90), updatedAt: daysAgo(4) },
  { id: 'qa-l-11', title: 'Renovated Hilltop Villa', address: '3 Dream City', city: 'Erbil', dealType: 'sale', propertyType: 'villa', price: 340000, beds: 6, baths: 5, sqft: 5200, agentId: 'qa-u-03', agentName: 'Dilan Faraj', status: 'closed', verified: true, private: false, quickSale: false, img: PHOTO_A, publicLat: 36.210, publicLng: 43.998, createdAt: daysAgo(80), updatedAt: daysAgo(6) },
  { id: 'qa-l-12', title: 'Roadside Auto Shop', address: '44 Kirkuk Road', city: 'Kirkuk', dealType: 'rent', propertyType: 'shop', price: 700, beds: 0, baths: 1, sqft: 600, agentId: 'qa-u-12', agentName: 'Shene Latif', status: 'active', verified: false, private: false, quickSale: false, img: null, publicLat: 35.475, publicLng: 44.400, createdAt: daysAgo(70), updatedAt: daysAgo(9) },
  { id: 'qa-l-13', title: 'Agricultural Land Parcel', address: 'Route 12, Koya', city: 'Koya', dealType: 'sale', propertyType: 'land', price: 58000, beds: 0, baths: 0, sqft: 21000, agentId: 'qa-u-04', agentName: 'Hana Rostam', status: 'active', verified: false, private: false, quickSale: false, img: null, publicLat: 36.075, publicLng: 44.629, createdAt: daysAgo(60), updatedAt: daysAgo(14) },
  { id: 'qa-l-14', title: 'Serviced One-Bedroom Suite', address: '90 Italian Village', city: 'Erbil', dealType: 'rent', propertyType: 'apartment', price: 480, beds: 1, baths: 1, sqft: 680, agentId: 'qa-u-02', agentName: 'Sara Kamal', status: 'active', verified: true, private: false, quickSale: false, img: PHOTO_B, publicLat: 36.185, publicLng: 44.015, createdAt: daysAgo(45), updatedAt: daysAgo(2) },
  { id: 'qa-l-15', title: 'Boutique Office Floor', address: '6 Business Bay', city: 'Sulaymaniyah', dealType: 'sale', propertyType: 'office', price: 175000, beds: 0, baths: 3, sqft: 2400, agentId: 'qa-u-04', agentName: 'Hana Rostam', status: 'active', verified: true, private: false, quickSale: false, img: null, publicLat: 35.565, publicLng: 45.440, createdAt: daysAgo(30), updatedAt: daysAgo(1) },
  { id: 'qa-l-16', title: 'Family House with Courtyard', address: '27 Zakho Road', city: 'Zakho', dealType: 'sale', propertyType: 'house', price: 118000, beds: 4, baths: 2, sqft: 2000, agentId: 'qa-u-05', agentName: 'Bnar Hussein', status: 'active', verified: false, private: false, quickSale: false, img: null, publicLat: 37.144, publicLng: 42.688, createdAt: daysAgo(15), updatedAt: daysAgo(0) },
  { id: 'qa-l-17', title: 'Compact Rental Apartment', address: '5 University Street', city: 'Duhok', dealType: 'rent', propertyType: 'apartment', price: 300, beds: 1, baths: 1, sqft: 460, agentId: 'qa-u-12', agentName: 'Shene Latif', status: 'active', verified: false, private: false, quickSale: false, img: null, publicLat: 36.860, publicLng: 42.980, createdAt: daysAgo(5), updatedAt: daysAgo(0) },
];

// -------------------------------------------------------------------
// Discounts -> Accounts: 14 brokerage-fee accounts covering manual
// overrides at every preset percentage, a policy-derived discount, a
// disabled override, an account with no discount at all, and a
// spread of account types/cities. Shape matches what
// js/backend-api.js's listBrokerageAccounts()/getBrokerageAccount()
// return -- served here by qa-fixture's Playwright route stub, never
// by a real backend.
// -------------------------------------------------------------------
export const QA_BROKERAGE_ACCOUNTS = [
  { uid: 'qa-u-02', displayName: 'Sara Kamal', accountType: 'real_estate_agent', city: 'Erbil', verificationStatus: 'verified', discountPercent: 30, discountActive: true, effectiveDiscountPercent: 30, discountSource: 'override', policyName: null, policyId: null, discountUpdatedAt: daysAgo(2), discountUpdatedBy: 'Rezan Ahmadi', photoURL: null },
  { uid: 'qa-u-03', displayName: 'Dilan Faraj', accountType: 'real_estate_agent', city: 'Erbil', verificationStatus: 'verified', discountPercent: 20, discountActive: true, effectiveDiscountPercent: 20, discountSource: 'override', policyName: null, policyId: null, discountUpdatedAt: daysAgo(6), discountUpdatedBy: 'Rezan Ahmadi', photoURL: null },
  { uid: 'qa-u-04', displayName: 'Hana Rostam', accountType: 'real_estate_agent', city: 'Sulaymaniyah', verificationStatus: 'verified', discountPercent: 10, discountActive: true, effectiveDiscountPercent: 10, discountSource: 'override', policyName: null, policyId: null, discountUpdatedAt: daysAgo(11), discountUpdatedBy: 'Rezan Ahmadi', photoURL: null },
  { uid: 'qa-u-05', displayName: 'Bnar Hussein', accountType: 'real_estate_agent', city: 'Duhok', verificationStatus: 'pending', discountPercent: 5, discountActive: true, effectiveDiscountPercent: 5, discountSource: 'override', policyName: null, policyId: null, discountUpdatedAt: daysAgo(13), discountUpdatedBy: 'Rezan Ahmadi', photoURL: null },
  { uid: 'qa-u-12', displayName: 'Shene Latif', accountType: 'real_estate_agent', city: 'Duhok', verificationStatus: 'needs_review', discountPercent: null, discountActive: null, effectiveDiscountPercent: 15, discountSource: 'policy', policyName: 'New Agents -- First 90 Days', policyId: 'qa-pol-newagent', discountUpdatedAt: daysAgo(9), discountUpdatedBy: null, photoURL: null },
  { uid: 'qa-u-06', displayName: 'Ayan Saleh', accountType: 'individual_customer', city: 'Erbil', verificationStatus: 'unverified', discountPercent: null, discountActive: null, effectiveDiscountPercent: 0, discountSource: null, policyName: null, policyId: null, discountUpdatedAt: null, discountUpdatedBy: null, photoURL: null },
  { uid: 'qa-u-07', displayName: 'Lawin Qadir', accountType: 'individual_customer', city: 'Sulaymaniyah', verificationStatus: 'unverified', discountPercent: null, discountActive: null, effectiveDiscountPercent: 0, discountSource: null, policyName: null, policyId: null, discountUpdatedAt: null, discountUpdatedBy: null, photoURL: null },
  { uid: 'qa-u-14', displayName: 'Rawa Faris', accountType: 'office_owner', city: 'Erbil', verificationStatus: 'verified', discountPercent: 30, discountActive: false, effectiveDiscountPercent: 0, discountSource: 'override', policyName: null, policyId: null, discountUpdatedAt: daysAgo(25), discountUpdatedBy: 'Rezan Ahmadi', photoURL: null },
  { uid: 'qa-u-15', displayName: 'Barham Sadiq', accountType: 'org_owner_developer', city: 'Sulaymaniyah', verificationStatus: 'verified', discountPercent: 20, discountActive: true, effectiveDiscountPercent: 20, discountSource: 'override', policyName: null, policyId: null, discountUpdatedAt: daysAgo(18), discountUpdatedBy: 'Rezan Ahmadi', photoURL: null },
  { uid: 'qa-u-16', displayName: 'Chnar Kawa', accountType: 'professional_engineer', city: 'Erbil', verificationStatus: 'verified', discountPercent: null, discountActive: null, effectiveDiscountPercent: 10, discountSource: 'policy', policyName: 'Verified Professionals', policyId: 'qa-pol-verifiedpro', discountUpdatedAt: daysAgo(30), discountUpdatedBy: null, photoURL: null },
  { uid: 'qa-u-17', displayName: 'Halgurd Nawzad', accountType: 'real_estate_agent', city: 'Kirkuk', verificationStatus: 'rejected', discountPercent: null, discountActive: null, effectiveDiscountPercent: 0, discountSource: null, policyName: null, policyId: null, discountUpdatedAt: null, discountUpdatedBy: null, photoURL: null },
  { uid: 'qa-u-18', displayName: 'Sozan Ismail', accountType: 'office_owner', city: 'Duhok', verificationStatus: 'verified', discountPercent: 30, discountActive: true, effectiveDiscountPercent: 30, discountSource: 'override', policyName: null, policyId: null, discountUpdatedAt: daysAgo(1), discountUpdatedBy: 'Rezan Ahmadi', photoURL: null },
  { uid: 'qa-u-19', displayName: 'Fenk Rawand', accountType: 'individual_customer', city: 'Zakho', verificationStatus: 'unverified', discountPercent: null, discountActive: null, effectiveDiscountPercent: 0, discountSource: null, policyName: null, policyId: null, discountUpdatedAt: null, discountUpdatedBy: null, photoURL: null },
  { uid: 'qa-u-20', displayName: 'Payam Sarwar', accountType: 'real_estate_agent', city: 'Erbil', verificationStatus: 'verified', discountPercent: 10, discountActive: true, effectiveDiscountPercent: 10, discountSource: 'override', policyName: null, policyId: null, discountUpdatedAt: daysAgo(4), discountUpdatedBy: 'Rezan Ahmadi', photoURL: null },
];
