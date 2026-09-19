const readline = require('readline');
const { createCompanyResponse } = require('./researchService');

const terminal = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('========================================');
console.log('       CSR COMPANY RESEARCH TOOL');
console.log('========================================');

terminal.question('\nEnter company name: ', (companyName) => {
  const trimmedCompanyName = companyName.trim();

  if (!trimmedCompanyName) {
    console.log('Company name is required.');
    terminal.close();
    return;
  }

    // we send terminal input to node's createCompanyResponse (a common function to both the terminal and react later).
  const result = createCompanyResponse(trimmedCompanyName);
  console.log(`\n${result.researchOutput}`);
  terminal.close();
});