const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const db = require('./database');

// 46 Clear, unambiguous matches
const CLEAR_MATCHES = [
  { id: 23, name: "Tata Technologies", website: "https://www.tatatechnologies.com/", source: "https://www.tatatechnologies.com/corporate-social-responsibility/" },
  { id: 31, name: "Bitwise Solutions", website: "https://www.bitwiseglobal.com/", source: "https://www.bitwiseglobal.com/" },
  { id: 32, name: "Fulcrum Digital", website: "https://fulcrumdigital.com/", source: "https://fulcrumdigital.com/" },
  { id: 33, name: "Harbinger Systems", website: "https://www.harbingersystems.com/", source: "https://www.harbingersystems.com/" },
  { id: 34, name: "eQ Technologic", website: "https://www.eqtechnologic.com/", source: "https://www.eqtechnologic.com/" },
  { id: 50, name: "Xoriant", website: "https://www.xoriant.com/", source: "https://www.xoriant.com/" },
  { id: 53, name: "Saama Technologies", website: "https://www.saama.com/", source: "https://www.saama.com/" },
  { id: 55, name: "Tietoevry", website: "https://www.tietoevry.com/", source: "https://www.tietoevry.com/" },
  { id: 63, name: "Calsoft", website: "https://calsoftinc.com/", source: "https://calsoftinc.com/" },
  { id: 70, name: "Synechron", website: "https://www.synechron.com/", source: "https://www.synechron.com/" },
  { id: 72, name: "Amdocs", website: "https://www.amdocs.com/", source: "https://www.amdocs.com/" },
  { id: 73, name: "Hexaware Technologies", website: "https://www.hexaware.com/", source: "https://www.hexaware.com/investors/csr/" },
  { id: 75, name: "Virtusa", website: "https://www.virtusa.com/", source: "https://www.virtusa.com/" },
  { id: 76, name: "UST Global", website: "https://www.ust.com/", source: "https://www.ust.com/" },
  { id: 79, name: "Genpact", website: "https://www.genpact.com/", source: "https://www.genpact.com/about-us/sustainability" },
  { id: 80, name: "Teleperformance", website: "https://www.teleperformance.com/", source: "https://www.teleperformance.com/" },
  { id: 81, name: "Conduent", website: "https://www.conduent.com/", source: "https://www.conduent.com/" },
  { id: 82, name: "EXL Service", website: "https://www.exlservice.com/", source: "https://www.exlservice.com/sustainability" },
  { id: 88, name: "HCL Technologies", website: "https://www.hcltech.com/", source: "https://www.hcltech.com/sustainability" },
  { id: 92, name: "Paytm", website: "https://paytm.com/", source: "https://paytm.com/about-us/csr/" },
  { id: 93, name: "Newgen Software", website: "https://newgensoft.com/", source: "https://newgensoft.com/investor-relations/csr/" },
  { id: 94, name: "Nagarro", website: "https://www.nagarro.com/", source: "https://www.nagarro.com/en/responsible-business" },
  { id: 95, name: "Coforge", website: "https://www.coforge.com/", source: "https://www.coforge.com/investors/corporate-social-responsibility" },
  { id: 96, name: "RateGain", website: "https://rategain.com/", source: "https://rategain.com/investors/governance-policies/" },
  { id: 101, name: "IndiGo", website: "https://www.goindigo.in/", source: "https://www.goindigo.in/csr.html" },
  { id: 103, name: "Policybazaar", website: "https://www.policybazaar.com/", source: "https://www.policybazaar.com/legal-and-admin-policies/csr-policy/" },
  { id: 104, name: "Zomato", website: "https://www.zomato.com/", source: "https://www.zomato.com/investor-relations" },
  { id: 105, name: "OYO", website: "https://www.oyorooms.com/", source: "https://www.oyorooms.com/" },
  { id: 106, name: "Motherson Group", website: "https://www.motherson.com/", source: "https://www.motherson.com/sustainability" },
  { id: 111, name: "Havells India", website: "https://www.havells.com/", source: "https://www.havells.com/en/about-havells/corporate-social-responsibility.html" },
  { id: 112, name: "Orient Electric", website: "https://www.orientelectric.com/", source: "https://www.orientelectric.com/investors" },
  { id: 114, name: "Relaxo Footwears", website: "https://relaxofootwear.com/", source: "https://relaxofootwear.com/pages/social-responsibility" },
  { id: 123, name: "NBCC", website: "https://www.nbccindia.in/", source: "https://www.nbccindia.in/webEnglish/csr" },
  { id: 131, name: "IndiaMART", website: "https://www.indiamart.com/", source: "https://www.indiamart.com/corporate-social-responsibility.html" },
  { id: 133, name: "Lenskart", website: "https://www.lenskart.com/", source: "https://www.lenskart.com/" },
  { id: 134, name: "JK Cement", website: "https://www.jkcement.com/", source: "https://www.jkcement.com/csr" },
  { id: 137, name: "Ashok Leyland", website: "https://www.ashokleyland.com/", source: "https://www.ashokleyland.com/en/csr" },
  { id: 139, name: "Redington Limited", website: "https://redingtongroup.com/", source: "https://redingtongroup.com/csr/" },
  { id: 140, name: "Freshworks", website: "https://www.freshworks.com/", source: "https://www.freshworks.com/" },
  { id: 143, name: "Rane Holdings", website: "https://ranegroup.com/", source: "https://ranegroup.com/investors/csr/" },
  { id: 144, name: "Sundaram Finance", website: "https://www.sundaramfinance.in/", source: "https://www.sundaramfinance.in/corporate-social-responsibility" },
  { id: 145, name: "Cholamandalam Investment & Finance", website: "https://www.cholamandalam.com/", source: "https://www.cholamandalam.com/csr.aspx" },
  { id: 157, name: "TCS", website: "https://www.tcs.com/", source: "https://www.tcs.com/who-we-are/corporate-social-responsibility" },
  { id: 160, name: "TAFE", website: "https://www.tafe.com/", source: "https://www.tafe.com/csr/" },
  { id: 162, name: "TVS Supply Chain Solutions", website: "https://www.tvsscs.com/", source: "https://www.tvsscs.com/investors/csr/" },
  { id: 163, name: "Chennai Petroleum Corporation", website: "https://www.cpcl.co.in/", source: "https://www.cpcl.co.in/csr/" },
];

// 42 Ambiguous matches left for manual review, with candidate websites recorded
const AMBIGUOUS_MATCHES = [
  { id: 19, name: "Barclays Global Service Centre", candidate: "https://www.barclays.in/", reason: "Captive Indian GSC entity of Barclays PLC" },
  { id: 22, name: "Dell EMC", candidate: "https://www.dell.com/", reason: "Historical merged entity now operating as Dell Technologies" },
  { id: 25, name: "Ansys Software", candidate: "https://www.ansys.com/", reason: "Indian development centre of Ansys Inc." },
  { id: 27, name: "AkzoNobel GBS", candidate: "https://www.akzonobel.com/", reason: "Global Business Services captive centre in Pune" },
  { id: 36, name: "IBM India", candidate: "https://www.ibm.com/in-en", reason: "Indian subsidiary of IBM; distinguish entity scope from IBM Global" },
  { id: 38, name: "Allied Cosmic Technologies", candidate: null, reason: "Local unlisted IT firm in Pune; official corporate site not confirmed" },
  { id: 41, name: "Capgemini", candidate: "https://www.capgemini.com/", reason: "Global parent entity; database also has separate Capgemini India row" },
  { id: 46, name: "HSBC Electronic Data Processing", candidate: "https://www.hsbc.co.in/", reason: "HSBC India captive electronic data processing unit" },
  { id: 47, name: "Oracle India", candidate: "https://www.oracle.com/in/", reason: "Indian subsidiary of Oracle Corporation" },
  { id: 49, name: "Flextronics (Flex)", candidate: "https://flex.com/", reason: "Flex Ltd multinational electronics manufacturing" },
  { id: 54, name: "Saba Software", candidate: "https://www.cornerstoneondemand.com/", reason: "Acquired software brand; now part of Cornerstone OnDemand" },
  { id: 56, name: "Vodafone Idea Technology", candidate: "https://www.myvi.in/", reason: "Technology division of Vodafone Idea Ltd (Vi)" },
  { id: 57, name: "Honeywell", candidate: "https://www.honeywell.com/", reason: "Global entity; separate Chennai branch exists in database" },
  { id: 58, name: "Veritas Technologies", candidate: "https://www.veritas.com/", reason: "Corporate domain; verify Indian CSR entity relationship" },
  { id: 60, name: "Seagate Technology", candidate: "https://www.seagate.com/", reason: "Global data storage multinational" },
  { id: 61, name: "Wolters Kluwer", candidate: "https://www.wolterskluwer.com/", reason: "Global professional publisher and tech provider" },
  { id: 62, name: "Symantec (Gen Digital)", candidate: "https://www.gendigital.com/", reason: "Brand transitioned to Gen Digital Inc." },
  { id: 64, name: "Whirlpool Global Consumer Design", candidate: "https://www.whirlpoolindia.com/", reason: "Design ER&D centre; verify relationship with Whirlpool of India Ltd" },
  { id: 68, name: "Atos / Eviden", candidate: "https://eviden.com/", reason: "Split brand identity between Atos and Eviden" },
  { id: 74, name: "DXC Technology", candidate: "https://dxc.com/", reason: "Global parent; separate DXC Technology India entry exists" },
  { id: 78, name: "PTC Software", candidate: "https://www.ptc.com/", reason: "Indian software centre of PTC Inc." },
  { id: 85, name: "Geometric (HCLTech)", candidate: "https://www.hcltech.com/", reason: "Acquired entity integrated into HCL Technologies" },
  { id: 86, name: "Siemens Healthineers", candidate: "https://www.siemens-healthineers.com/", reason: "Multinational healthcare tech entity" },
  { id: 89, name: "Adobe India", candidate: "https://www.adobe.com/in/", reason: "Indian subsidiary of Adobe Inc." },
  { id: 90, name: "Samsung India Electronics", candidate: "https://www.samsung.com/in/", reason: "Indian consumer electronics subsidiary of Samsung" },
  { id: 91, name: "Microsoft India", candidate: "https://www.microsoft.com/en-in", reason: "Indian subsidiary of Microsoft Corporation" },
  { id: 109, name: "JCB India", candidate: "https://www.jcb.com/en-in", reason: "Indian manufacturing subsidiary of JC Bamford Excavators" },
  { id: 132, name: "STMicroelectronics India", candidate: "https://www.st.com/", reason: "Indian design centre of STMicroelectronics" },
  { id: 152, name: "Capgemini India", candidate: "https://www.capgemini.com/in-en/", reason: "Indian operating entity of Capgemini Group" },
  { id: 153, name: "DXC Technology India", candidate: "https://dxc.com/", reason: "Indian operating entity of DXC Technology" },
  { id: 154, name: "SAP India", candidate: "https://www.sap.com/india/index.html", reason: "Indian subsidiary of SAP SE" },
  { id: 156, name: "Accenture India", candidate: "https://www.accenture.com/in-en", reason: "India operating entity; separate global Accenture exists in directory" },
  { id: 158, name: "Amazon India", candidate: "https://www.amazon.in/", reason: "Indian e-commerce and cloud subsidiary of Amazon" },
  { id: 164, name: "Indian Oil Corporation – Chennai", candidate: "https://iocl.com/", reason: "Regional branch office of Indian Oil Corporation Ltd" },
  { id: 167, name: "Larsen & Toubro – Chennai", candidate: "https://www.larsentoubro.com/", reason: "Regional Manapakkam office of Larsen & Toubro Ltd" },
  { id: 168, name: "Siemens India – Chennai", candidate: "https://www.siemens.com/in/en.html", reason: "Regional Chennai branch of Siemens Ltd India" },
  { id: 169, name: "Honeywell India – Chennai", candidate: "https://www.honeywell.com/in/en", reason: "Regional Chennai branch of Honeywell India" },
  { id: 170, name: "Cisco India – Chennai", candidate: "https://www.cisco.com/c/en_in/index.html", reason: "Regional Chennai office of Cisco Systems India" },
  { id: 171, name: "WayCool Foods", candidate: "https://waycool.in/", reason: "Private unlisted AgriTech startup; CSR reporting to be confirmed" },
  { id: 172, name: "Ather Energy – Chennai", candidate: "https://www.atherenergy.com/", reason: "Regional Chennai location of Ather Energy Pvt Ltd" },
  { id: 173, name: "Dalmia Bharat – Chennai", candidate: "https://www.dalmiabharat.com/", reason: "Regional Chennai office of Dalmia Bharat Ltd" },
  { id: 175, name: "Mu Sigma", candidate: "https://www.mu-sigma.com/", reason: "Private analytics provider; corporate website pending review" },
];

async function applyDomainResolutions() {
  console.log(`Confirming ${CLEAR_MATCHES.length} clear matches...`);
  for (const item of CLEAR_MATCHES) {
    const note = `Website verification: status=CONFIRMED; confidence=high; source=${item.source}; checked=2026-10-23.`;
    await db.getPool().query(
      `UPDATE companies
       SET official_website = ?,
           website_candidate = NULL,
           official_website_verified_at = NOW(),
           notes = ?
       WHERE id = ?`,
      [item.website, note, item.id]
    );
  }

  console.log(`Updating ${AMBIGUOUS_MATCHES.length} ambiguous matches for manual review...`);
  for (const item of AMBIGUOUS_MATCHES) {
    const note = `Website verification: status=MANUAL_REVIEW; confidence=unconfirmed; source=${item.candidate || 'none accepted'}; reason=${item.reason}; checked=2026-10-23.`;
    await db.getPool().query(
      `UPDATE companies
       SET official_website = NULL,
           website_candidate = ?,
           official_website_verified_at = NULL,
           notes = ?
       WHERE id = ?`,
      [item.candidate, note, item.id]
    );
  }

  const [summary] = await db.getPool().query(`
    SELECT
      COUNT(*) AS total_companies,
      SUM(CASE WHEN official_website IS NOT NULL AND official_website != '' AND official_website_verified_at IS NOT NULL THEN 1 ELSE 0 END) AS ready_to_research,
      SUM(CASE WHEN (official_website IS NULL OR official_website = '' OR official_website_verified_at IS NULL) AND (website_candidate IS NOT NULL AND website_candidate != '' OR notes LIKE '%MANUAL_REVIEW%') THEN 1 ELSE 0 END) AS needs_manual_review,
      SUM(CASE WHEN (official_website IS NULL OR official_website = '') AND (website_candidate IS NULL OR website_candidate = '') AND (notes NOT LIKE '%MANUAL_REVIEW%' OR notes IS NULL) THEN 1 ELSE 0 END) AS waiting_for_website
    FROM companies
  `);
  console.log('SUMMARY AFTER RESOLUTION:', summary[0]);
  await db.closePool();
}

applyDomainResolutions().catch(console.error);
