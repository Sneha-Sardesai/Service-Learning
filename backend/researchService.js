const path = require('path');
const { execFileSync } = require('child_process');

// Calls python's researching engine and returns the researched info in json
function createCompanyResponse(companyName) {

// sending the user-entered company name to python so python can process it
  const researchScriptPath = path.join(__dirname, '..', 'research', 'research.py');
  const researchOutput = execFileSync('python', [researchScriptPath, companyName], {
    encoding: 'utf8',
  }).trim();

  // response to return
  return {
    companyName: companyName,
    researchOutput: researchOutput,
    location: '',
    industry: '',
    website: '',
    annualTurnover: '',
    csrSpending: '',
    csrFocusAreas: [],
    foundationDetails: '',
    contactDetails: '',
    email: '',
    reportLinks: [],
    remarks: '',
  };
}

module.exports = { createCompanyResponse };