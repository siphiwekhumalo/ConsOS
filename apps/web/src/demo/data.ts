/**
 * SAMPLE DATA for modules whose backend is not built yet. Every screen that
 * uses this file shows a <PreviewBanner>. Never mix these values into real
 * records, exports or calculations.
 */

// ---------------------------------------------------------------- Finance & CVR
export const cvrMonthly = [
  { month: 'May', value: 18.2, cost: 16.9 },
  { month: 'Jun', value: 41.5, cost: 38.8 },
  { month: 'Jul', value: 66.0, cost: 62.4 },
  { month: 'Aug', value: 92.8, cost: 89.1 },
  { month: 'Sep', value: 121.4, cost: 118.6 },
  { month: 'Oct', value: 149.9, cost: 148.7 },
  { month: 'Nov', value: 171.3, cost: 172.9 },
];

export const cvrByCostCode = [
  { code: '100', name: 'Preliminaries & general', budget: 24.6, actual: 22.1, value: 23.8 },
  { code: '200', name: 'Earthworks', budget: 38.2, actual: 41.7, value: 37.9 },
  { code: '300', name: 'Concrete & formwork', budget: 61.4, actual: 58.2, value: 60.1 },
  { code: '400', name: 'Structural steel', budget: 44.9, actual: 29.6, value: 31.2 },
  { code: '500', name: 'Mechanical & conveyors', budget: 52.3, actual: 13.8, value: 14.6 },
  { code: '600', name: 'Electrical & instrumentation', budget: 21.7, actual: 7.5, value: 3.7 },
];

export const valuations = [
  { no: 'IPC 07', period: 'Oct 2026', gross: '23450000', retention: '1172500', status: 'certified' },
  { no: 'IPC 06', period: 'Sep 2026', gross: '28640000', retention: '1432000', status: 'paid' },
  { no: 'IPC 05', period: 'Aug 2026', gross: '26810000', retention: '1340500', status: 'paid' },
  { no: 'IPC 08', period: 'Nov 2026', gross: '21480000', retention: '1074000', status: 'draft' },
];

export const variations = [
  { ref: 'CE-014', title: 'Additional rock excavation at headgear foundations', form: 'NEC4 compensation event', value: '3840000', status: 'notified', daysLeft: 9 },
  { ref: 'VO-022', title: 'Revised conveyor transfer chute design', form: 'FIDIC variation', value: '1275000', status: 'quoted', daysLeft: 21 },
  { ref: 'CE-013', title: 'Late access to Shaft 4 bank area', form: 'NEC4 compensation event', value: '612000', status: 'agreed', daysLeft: null },
];

// ---------------------------------------------------------------- Payroll
export const payRun = {
  period: 'November 2026',
  employees: 1284,
  gross: '38214600',
  paye: '5132880',
  uif: '764292',
  sdl: '382146',
  eti: '214500',
  net: '31726194',
  status: 'awaiting approval',
};

export const workforce = [
  { group: 'Permanent staff', count: 312 },
  { group: 'Site contract labour', count: 846 },
  { group: 'Sub-contractor allocated', count: 126 },
];

export const councils = [
  { name: 'MEIBC', employees: 418, nextIncrease: '1 Jul 2027', status: 'compliant' },
  { name: 'BCCEI', employees: 602, nextIncrease: '1 Sep 2027', status: 'compliant' },
  { name: 'SAFCEC agreement', employees: 264, nextIncrease: '1 Mar 2027', status: 'review' },
];

export const filings = [
  { form: 'EMP201', period: 'Oct 2026', due: '7 Nov 2026', status: 'submitted' },
  { form: 'EMP201', period: 'Nov 2026', due: '7 Dec 2026', status: 'pending' },
  { form: 'EMP501', period: 'Interim 2026/27', due: '31 Oct 2026', status: 'submitted' },
  { form: 'IRP5', period: '2026/27 tax year', due: '31 May 2027', status: 'not started' },
];

// ---------------------------------------------------------------- CRM & Bids
export const pipeline = [
  {
    stage: 'Pre-qualification',
    items: [
      { title: 'N2 Wild Coast — Section 3 bridges', client: 'SANRAL', value: '840000000', grade: '9CE', due: '28 Nov' },
      { title: 'Kusile ash dump extension', client: 'Eskom', value: '215000000', grade: '8CE', due: '4 Dec' },
    ],
  },
  {
    stage: 'Bid preparation',
    items: [
      { title: 'Saldanha iron ore berth rehab', client: 'Transnet', value: '462000000', grade: '9CE', due: '12 Dec' },
      { title: 'Rustenburg bulk water pipeline', client: 'Rustenburg LM', value: '128500000', grade: '7CE', due: '1 Dec' },
      { title: 'Mall of the North expansion', client: 'Private developer', value: '310000000', grade: '8GB', due: '15 Jan' },
    ],
  },
  {
    stage: 'Submitted',
    items: [{ title: 'Venetia underground — surface works', client: 'De Beers', value: '186000000', grade: '8CE', due: 'Award Q1' }],
  },
  {
    stage: 'Won',
    items: [{ title: 'Shaft 4 refurbishment', client: 'Platinum Mining Co.', value: '312000000', grade: '8CE', due: 'Active' }],
  },
];

export const jvPartners = [
  { name: 'Ukhozi Civils (Pty) Ltd', level: 1, blackOwned: '100%', equity: '30%', tender: 'Saldanha berth rehab' },
  { name: 'Masakhane Plant Hire', level: 2, blackOwned: '51%', equity: '15%', tender: 'Rustenburg pipeline' },
  { name: 'Thaba Engineering', level: 1, blackOwned: '74%', equity: '25%', tender: 'N2 Wild Coast' },
];

// ---------------------------------------------------------------- Estimating
export const unitRates = [
  { code: 'EW-101', item: 'Bulk excavation, soft material', unit: 'm³', rate: '85.50', region: 'Gauteng', updated: 'Oct 2026' },
  { code: 'EW-104', item: 'Bulk excavation, hard rock (blasting)', unit: 'm³', rate: '412.00', region: 'Limpopo', updated: 'Sep 2026' },
  { code: 'CO-220', item: '35 MPa concrete in foundations', unit: 'm³', rate: '2840.00', region: 'Gauteng', updated: 'Nov 2026' },
  { code: 'CO-310', item: 'High-yield reinforcement, Y16–Y25', unit: 't', rate: '21450.00', region: 'Gauteng', updated: 'Nov 2026' },
  { code: 'ST-405', item: 'Structural steel, fabricated & erected', unit: 't', rate: '48900.00', region: 'North West', updated: 'Aug 2026' },
  { code: 'RD-112', item: 'G5 imported fill, compacted 93% MOD AASHTO', unit: 'm³', rate: '210.00', region: 'Mpumalanga', updated: 'Oct 2026' },
];

export const takeoffs = [
  { drawing: 'S4-STR-201 Rev C', measured: 'Headgear foundations', items: 18, status: 'complete' },
  { drawing: 'S4-CIV-110 Rev B', measured: 'Bank area earthworks', items: 9, status: 'in progress' },
  { drawing: 'PP-MEC-450 Rev A', measured: 'Conveyor CV-03 supports', items: 0, status: 'queued' },
];

// ---------------------------------------------------------------- Procurement
export const requisitions = [
  { no: 'PR-2291', item: 'Y16 rebar — 42 t', project: 'DM-101', amount: '901000', step: 'Project manager', status: 'pending' },
  { no: 'PR-2290', item: 'Conveyor idlers (240 units)', project: 'DM-103', amount: '1386000', step: 'Director', status: 'pending' },
  { no: 'PR-2287', item: 'Diesel bulk delivery — 30 000 L', project: 'DM-104', amount: '668400', step: 'Approved', status: 'approved' },
  { no: 'PR-2284', item: 'Shutter ply & props hire', project: 'DM-101', amount: '142500', step: 'Approved', status: 'approved' },
];

export const matching = [
  { invoice: 'INV-88213', supplier: 'Steelcor Gauteng', po: 'PO-1844', grn: 'GRN-5521', amount: '901000', result: 'matched' },
  { invoice: 'INV-10471', supplier: 'Afrimat Aggregates', po: 'PO-1839', grn: 'GRN-5509', amount: '244380', result: 'qty variance' },
  { invoice: 'INV-3392', supplier: 'Bosveld Diesel', po: 'PO-1841', grn: '—', amount: '668400', result: 'missing GRN' },
];

export const bbbeeSpend = [
  { label: 'Level 1', value: 48.2 },
  { label: 'Level 2', value: 31.6 },
  { label: 'Level 3–4', value: 18.9 },
  { label: 'Level 5–8', value: 9.4 },
  { label: 'Non-compliant', value: 4.1 },
];

// ---------------------------------------------------------------- Field (RFIs — diary is live)
export const rfis = [
  { no: 'RFI-061', subject: 'Holding-down bolt clash on grid C/4', to: 'WSP (structural)', raised: '3 Nov', status: 'open', overdue: true },
  { no: 'RFI-060', subject: 'Confirm concrete grade for sump walls', to: 'Hatch (civil)', raised: '1 Nov', status: 'open', overdue: false },
  { no: 'SI-019', subject: 'Site instruction: relocate laydown area B', to: 'Engineer', raised: '29 Oct', status: 'actioned', overdue: false },
];

// ---------------------------------------------------------------- Fleet
export const plant = [
  { id: 'EX-07', name: 'CAT 349 excavator', project: 'DM-104', hours: 6, util: 82, fuel: '214', next: '42 h', status: 'running' },
  { id: 'DT-12', name: 'Bell B45E dump truck', project: 'DM-104', hours: 9, util: 91, fuel: '386', next: '8 h', status: 'service due' },
  { id: 'CR-03', name: 'Liebherr LTM 1100 crane', project: 'DM-101', hours: 4, util: 54, fuel: '96', next: '160 h', status: 'running' },
  { id: 'GR-02', name: 'CAT 140 grader', project: 'DM-104', hours: 0, util: 0, fuel: '0', next: '—', status: 'breakdown' },
  { id: 'LB-09', name: 'JCB 3CX TLB', project: 'DM-102', hours: 7, util: 76, fuel: '58', next: '310 h', status: 'running' },
];

export const utilisationTrend = [61, 64, 70, 68, 73, 77, 74, 79];

// ---------------------------------------------------------------- HSE
export const hseKpis = { ltiFreeDays: 214, ltifr: 0.18, trifr: 0.92, nearMisses30d: 23, inductions30d: 146 };

export const incidents = [
  { ref: 'NM-118', type: 'Near miss', title: 'Unsecured load at headgear lift', project: 'DM-101', severity: 'serious', status: 'investigating' },
  { ref: 'IN-042', type: 'Medical treatment', title: 'Hand laceration, rebar cutting', project: 'DM-102', severity: 'warning', status: 'RCA complete' },
  { ref: 'EN-007', type: 'Environmental', title: 'Hydraulic oil spill < 20 L', project: 'DM-104', severity: 'warning', status: 'closed' },
];

export const toolboxTalks = [
  { topic: 'Working at heights — harness inspection', project: 'DM-101', attendees: 38, date: '9 Nov' },
  { topic: 'Heat stress and hydration', project: 'DM-104', attendees: 24, date: '8 Nov' },
  { topic: 'Lock-out / tag-out on conveyors', project: 'DM-103', attendees: 17, date: '7 Nov' },
];

export const ncrs = [
  { ref: 'NCR-031', finding: 'Scaffold tags missing on level 3', due: '11 Nov', status: 'open' },
  { ref: 'NCR-030', finding: 'Fire extinguisher service overdue — workshop', due: '8 Nov', status: 'overdue' },
];

// ---------------------------------------------------------------- Client portal
export const portalMilestones = [
  { name: 'Site establishment', planned: 'Jun 2026', actual: 'Jun 2026', pct: 100, signoff: 'signed' },
  { name: 'Headgear foundations', planned: 'Sep 2026', actual: 'Oct 2026', pct: 100, signoff: 'awaiting signature' },
  { name: 'Winder house structure', planned: 'Dec 2026', actual: null, pct: 64, signoff: '—' },
  { name: 'Mechanical installation', planned: 'Apr 2027', actual: null, pct: 12, signoff: '—' },
  { name: 'Commissioning', planned: 'Jul 2027', actual: null, pct: 0, signoff: '—' },
];
